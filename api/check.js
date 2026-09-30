// POST /api/check : runs the Visit Gap Check.
// 1) validate fixed inputs  2) rules find gaps  3) Gemini writes summary + handovers
// 4) store the exchange in Supabase  5) return the result.
const crypto = require('crypto');
const { validate, analyse, ValidationError, VISIT_TYPES, OWNER_TASKS, fmt, toMin } = require('./_rules');
const { insertCheck, countRecent } = require('./_supabase');

const MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash-lite';
const MAX_OUTPUT_TOKENS = 600;
const DAILY_CAP = 3;
const MEDICAL_REFUSAL = "VisitSaathi only helps with visit logistics, so I can't advise on symptoms, medicines or doses. Please ask the treating doctor, or call emergency services if it is urgent.";
const MEDICAL_RE = /\b(dose|dosage|dosing|mg|tablet|tablets|pill|pills|medicine|medicines|medication|insulin|symptom|symptoms|pain|fever|bleeding|dizzy|dizziness|chest|breathless|breathing|diagnos\w*|prescri\w*|side effect\w*|blood pressure|sugar level)\b/i;

const SYSTEM_PROMPT = `You are the plan writer inside VisitSaathi, a tool that helps adult children coordinate an elderly parent's planned hospital visit with relatives, neighbours, drivers or caregivers.
A rules engine has already checked the plan. You receive its JSON: the visit, the helpers (by role only), assigned tasks, and the gaps it found.

Write:
1. "summary": at most 60 words in plain, warm English saying how covered the visit is and the one or two most important open gaps. Do not list every gap.
2. "handovers": one short message (at most 60 words) for each helper role in the input, written to that person, covering only the tasks and times assigned to them in the input. If the helper is tentative, start with "Draft, pending your confirmation:". End with "Still open: ..." if any gap affects them.
3. "notes_response": respond to the family's notes in at most 40 words, only about logistics. If notes are empty, return an empty string.

Rules you must never break:
- Never invent people, bookings, cabs, times, phone numbers, addresses, hospital names or instructions that are not in the input.
- Never say a gap is solved unless the input shows it assigned. Unresolved gaps stay unresolved.
- Never give medical advice. If the notes mention symptoms, medicines, doses, diagnoses or treatment, set notes_response to exactly: "${MEDICAL_REFUSAL}"
- If the notes ask for anything unrelated to hospital visit logistics, say you can only help with visit logistics.
- Return only JSON matching the schema.`;

const SCHEMA = {
  type: 'OBJECT',
  properties: {
    summary: { type: 'STRING' },
    handovers: { type: 'ARRAY', items: { type: 'OBJECT', properties: { role: { type: 'STRING' }, message: { type: 'STRING' } }, required: ['role', 'message'] } },
    notes_response: { type: 'STRING' },
  },
  required: ['summary', 'handovers', 'notes_response'],
};

function describeForModel(plan, result) {
  const role = (id) => id === 'cab' ? 'cab' : id === 'none' ? 'not assigned' : plan.helpers.find((h) => h.id === id).role;
  const tasks = {};
  for (const [k, meta] of Object.entries(OWNER_TASKS)) tasks[meta.label] = role(plan.owners[k]);
  return {
    visit: {
      type: VISIT_TYPES[plan.visitType],
      appointment: fmt(toMin(plan.apptTime)),
      possible_finish: `${fmt(toMin(plan.finishEarliest))} to ${fmt(toMin(plan.finishLatest))}`,
    },
    helpers: plan.helpers.map((h) => ({ role: h.role, available: `${fmt(toMin(h.from))} to ${fmt(toMin(h.until))}`, commitment: h.commitment })),
    transport_there: plan.transportThere.owner === 'none' ? 'not arranged' : `${role(plan.transportThere.owner)} at ${fmt(toMin(plan.transportThere.time))}`,
    transport_home: plan.transportBack.owner === 'none' ? 'not arranged' : `${role(plan.transportBack.owner)} at ${fmt(toMin(plan.transportBack.time))}`,
    tasks,
    gaps: result.gaps.map((g) => `${g.title}. ${g.detail}`),
    notes: plan.notes,
  };
}

async function callGemini(payload) {
  if (process.env.MOCK_GEMINI === '1') return mockGemini(payload);
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error('GEMINI_API_KEY is missing.');
  const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
      contents: [{ role: 'user', parts: [{ text: JSON.stringify(payload) }] }],
      generationConfig: { maxOutputTokens: MAX_OUTPUT_TOKENS, temperature: 0.3, responseMimeType: 'application/json', responseSchema: SCHEMA },
    }),
  });
  const data = await r.json();
  if (!r.ok) throw new Error(`Gemini error ${r.status}: ${JSON.stringify(data).slice(0, 300)}`);
  const text = (data.candidates?.[0]?.content?.parts || []).map((p) => p.text || '').join('');
  let parsed;
  try { parsed = JSON.parse(text); } catch { parsed = { summary: text.slice(0, 400), handovers: [], notes_response: '' }; }
  return { ...parsed, usage: { input: data.usageMetadata?.promptTokenCount || 0, output: data.usageMetadata?.candidatesTokenCount || 0 } };
}

// Local testing only: never active unless MOCK_GEMINI=1 is set.
function mockGemini(p) {
  return {
    summary: `[mock] ${p.gaps.length ? `${p.gaps.length} gap(s) found. Most important: ${p.gaps[0]}` : 'Every stage has an owner.'}`,
    handovers: p.helpers.map((h) => ({ role: h.role, message: `${h.commitment === 'tentative' ? 'Draft, pending your confirmation: ' : ''}[mock] You are available ${h.available}.` })),
    notes_response: p.notes ? '[mock] Noted for the plan.' : '',
    usage: { input: 0, output: 0 },
  };
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Use POST.' });
  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : req.body;
    const plan = validate(body);

    const visitorId = String(body.visitorId || '').slice(0, 64);
    if (visitorId.length < 8) return res.status(400).json({ error: 'Missing visitor id. Please reload the page.' });
    const visitorHash = crypto.createHash('sha256').update(`visitsaathi:${visitorId}`).digest('hex').slice(0, 32);
    const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
    const used = await countRecent(visitorHash, since);
    if (used >= DAILY_CAP) {
      return res.status(429).json({ error: `You've used your ${DAILY_CAP} free checks for today. Please come back tomorrow.`, remaining: 0 });
    }

    const result = analyse(plan);
    const payload = describeForModel(plan, result);
    const ai = await callGemini(payload);

    const medicalNote = plan.notes && MEDICAL_RE.test(plan.notes);
    if (medicalNote) ai.notes_response = MEDICAL_REFUSAL; // server-side backstop for the guardrail

    await insertCheck({
      visitor_hash: visitorHash,
      visit_type: plan.visitType,
      input: { ...payload, notes: undefined, notes_present: Boolean(plan.notes) },
      gap_stages: [...new Set(result.gaps.map((g) => g.code))],
      gap_count: result.gaps.length,
      output: JSON.stringify({ summary: ai.summary, handovers: ai.handovers, notes_response: ai.notes_response }),
      guardrail_triggered: Boolean(medicalNote),
      model: process.env.MOCK_GEMINI === '1' ? 'mock' : MODEL,
      input_tokens: ai.usage.input,
      output_tokens: ai.usage.output,
    });

    return res.status(200).json({
      summary: ai.summary,
      gaps: result.gaps,
      decisions: result.decisions,
      handovers: ai.handovers,
      notes_response: ai.notes_response,
      remaining: DAILY_CAP - used - 1,
    });
  } catch (e) {
    if (e instanceof ValidationError) return res.status(400).json({ error: e.message });
    console.error(e);
    return res.status(500).json({ error: 'Something went wrong while checking the plan. Please try again.' });
  }
};
