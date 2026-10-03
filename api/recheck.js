// POST /api/recheck : re-runs only the rules engine after the family applies a decision or edits the form.
// No Gemini call, so it does not use one of the 3 daily AI checks. Every request and its result is still
// stored in Supabase (table visit_rechecks), with a soft cap of 50 re-checks per visitor per day.
const crypto = require('crypto');
const { validate, analyse, ValidationError } = require('./_rules');
const { insertRecheck, countRecentRechecks } = require('./_supabase');

const RECHECK_CAP = 50;

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Use POST.' });
  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : req.body;
    const plan = validate(body);
    const visitorId = String(body.visitorId || '').slice(0, 64);
    if (visitorId.length < 8) return res.status(400).json({ error: 'Missing visitor id. Please reload the page.' });
    const visitorHash = crypto.createHash('sha256').update(`visitsaathi:${visitorId}`).digest('hex').slice(0, 32);

    const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
    if (await countRecentRechecks(visitorHash, since) >= RECHECK_CAP) {
      return res.status(429).json({ error: 'Too many re-checks today. Please come back tomorrow.' });
    }

    const result = analyse(plan);
    await insertRecheck({
      visitor_hash: visitorHash,
      change_label: String(body.changeLabel || '').slice(0, 200),
      input: { ...plan, notes: undefined, notes_present: Boolean(plan.notes) },   // roles and times only, never notes
      gap_stages: [...new Set(result.gaps.map((g) => g.code))],
      gap_count: result.gaps.length,
      output: JSON.stringify(result),
    });
    return res.status(200).json(result);
  } catch (e) {
    if (e instanceof ValidationError) return res.status(400).json({ error: e.message });
    console.error(e);
    return res.status(500).json({ error: 'Could not re-check the plan. Please try again.' });
  }
};
