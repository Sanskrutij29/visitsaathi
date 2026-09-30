// VisitSaathi rules engine: finds gaps in a hospital visit plan.
// Pure logic, no AI. Gemini only explains the result and drafts handovers.

const VISIT_TYPES = {
  consult: 'Consultation',
  consult_tests: 'Consultation with tests',
  scan_prep: 'Scan with preparation',
  day_procedure: 'Day procedure',
};
const ROLES = ['Sibling', 'Spouse', 'Other relative', 'Neighbour', 'Friend', 'Caregiver', 'Driver'];
const OWNER_TASKS = {
  documents: { label: 'Carrying the file and reports', stage: 'Before' },
  registration: { label: 'Registration at the hospital', stage: 'At the hospital' },
  pharmacy: { label: 'Pharmacy and billing', stage: 'At the hospital' },
  reports: { label: 'Collecting reports later', stage: 'After' },
  homeArrival: { label: 'Staying until they are inside at home', stage: 'Getting home' },
};
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

const toMin = (t) => { const [h, m] = t.split(':').map(Number); return h * 60 + m; };
const fmt = (m) => {
  const h = Math.floor(m / 60), mm = String(m % 60).padStart(2, '0');
  const h12 = ((h + 11) % 12) + 1;
  return `${h12}:${mm} ${h < 12 ? 'a.m.' : 'p.m.'}`;
};

class ValidationError extends Error {}

function validate(body) {
  const fail = (msg) => { throw new ValidationError(msg); };
  if (!body || typeof body !== 'object') fail('Missing input.');
  const { visitType, apptTime, finishEarliest, finishLatest, helpers, transportThere, transportBack, owners, notes } = body;
  if (!VISIT_TYPES[visitType]) fail('Choose a visit type.');
  for (const [k, v] of Object.entries({ apptTime, finishEarliest, finishLatest })) {
    if (!TIME_RE.test(v || '')) fail(`Enter a valid time for ${k}.`);
  }
  if (!(toMin(apptTime) < toMin(finishEarliest) && toMin(finishEarliest) <= toMin(finishLatest))) {
    fail('The finishing range must start after the appointment and the latest finish must not be before the earliest.');
  }
  if (!Array.isArray(helpers) || helpers.length < 1 || helpers.length > 3) fail('Add between one and three helpers.');
  const ids = new Set();
  const cleanHelpers = helpers.map((h, i) => {
    if (!ROLES.includes(h.role)) fail('Pick a role for each helper from the list.');
    if (!TIME_RE.test(h.from || '') || !TIME_RE.test(h.until || '')) fail('Enter times for each helper.');
    if (toMin(h.from) >= toMin(h.until)) fail(`The ${h.role.toLowerCase()}'s "until" time must be after "from".`);
    if (!['firm', 'tentative'].includes(h.commitment)) fail('Mark each helper as firm or tentative.');
    const id = `h${i + 1}`; ids.add(id);
    return { id, role: h.role, from: h.from, until: h.until, commitment: h.commitment };
  });
  const checkOwner = (o, extra = []) => (o === 'none' || ids.has(o) || extra.includes(o)) ? o : fail('Invalid owner selected.');
  const tr = (t, label) => {
    if (!t || typeof t !== 'object') fail(`Missing ${label}.`);
    const owner = checkOwner(t.owner, ['cab']);
    if (owner !== 'none' && !TIME_RE.test(t.time || '')) fail(`Enter a time for ${label}.`);
    return { owner, time: owner === 'none' ? null : t.time };
  };
  const cleanOwners = {};
  for (const k of Object.keys(OWNER_TASKS)) cleanOwners[k] = checkOwner((owners || {})[k] || 'none');
  const cleanNotes = typeof notes === 'string' ? notes.trim().slice(0, 300) : '';
  return {
    visitType, apptTime, finishEarliest, finishLatest,
    helpers: cleanHelpers,
    transportThere: tr(transportThere, 'transport there'),
    transportBack: tr(transportBack, 'transport home'),
    owners: cleanOwners,
    notes: cleanNotes,
  };
}

function analyse(plan) {
  const appt = toMin(plan.apptTime), early = toMin(plan.finishEarliest), late = toMin(plan.finishLatest);
  const H = Object.fromEntries(plan.helpers.map((h) => [h.id, { ...h, f: toMin(h.from), u: toMin(h.until) }]));
  const name = (id) => id === 'cab' ? 'cab' : id === 'none' ? 'nobody' : `the ${H[id].role.toLowerCase()}`;
  const availableAt = (id, t) => id === 'cab' || (H[id] && H[id].f <= t && t < H[id].u);
  const companions = Object.values(H).filter((h) => h.role !== 'Driver');
  const gaps = [];
  const decisions = [];

  // 1. Someone with the parent from the appointment until the latest possible finish.
  const uncovered = [], tentativeOnly = [];
  let cur = null, curT = null;
  for (let t = appt; t < late; t++) {
    const firm = companions.some((h) => h.commitment === 'firm' && h.f <= t && t < h.u);
    const any = companions.some((h) => h.f <= t && t < h.u);
    if (!any) { if (!cur) cur = [t, t + 1]; else cur[1] = t + 1; } else if (cur) { uncovered.push(cur); cur = null; }
    if (any && !firm) { if (!curT) curT = [t, t + 1]; else curT[1] = t + 1; } else if (curT) { tentativeOnly.push(curT); curT = null; }
  }
  if (cur) uncovered.push(cur);
  if (curT) tentativeOnly.push(curT);

  uncovered.forEach(([a, b]) => {
    const withinExpected = b <= early;
    gaps.push({
      code: 'accompaniment', stage: 'At the hospital', severity: 'high',
      title: `${fmt(a)} to ${fmt(b)}: nobody with your parent`,
      detail: withinExpected
        ? 'This falls within the expected visit time, before the earliest finish.'
        : 'This only happens if the visit runs late, but nobody entered is available then.',
    });
    const opts = [];
    companions.forEach((h) => {
      if (h.u > a && h.u < b) opts.push(`Ask the ${h.role.toLowerCase()} to stay until ${fmt(b)} (entered: until ${fmt(h.u)})`);
      else if (h.f > a && h.f < b) opts.push(`Ask the ${h.role.toLowerCase()} to come by ${fmt(a)} (entered: from ${fmt(h.f)})`);
    });
    if (plan.transportBack.owner !== 'none' && toMin(plan.transportBack.time) < b) {
      opts.push(`Move the return trip to ${fmt(b)} or later (does not cover the gap on its own)`);
    }
    decisions.push({
      question: `Who covers ${fmt(a)} to ${fmt(b)}?`,
      options: opts.length ? opts : ['No one you entered can cover this. Add another helper, or choose an appointment that is likely to end earlier.'],
    });
  });
  tentativeOnly.forEach(([a, b]) => {
    const who = companions.filter((h) => h.commitment === 'tentative' && h.f < b && h.u > a).map((h) => h.role.toLowerCase());
    gaps.push({
      code: 'tentative', stage: 'At the hospital', severity: 'medium',
      title: `${fmt(a)} to ${fmt(b)}: covered only by tentative help`,
      detail: `Only the ${who.join(' and ')} (tentative) is with your parent here.`,
    });
    decisions.push({ question: `Can the ${who.join(' or ')} confirm ${fmt(a)} to ${fmt(b)}?`, options: ['Confirm and mark as firm', 'Find a firm backup for this window'] });
  });

  // 2. Transport there.
  if (plan.transportThere.owner === 'none') {
    gaps.push({ code: 'transport_there', stage: 'Getting there', severity: 'high', title: 'No transport to the hospital', detail: 'Nobody is assigned to take your parent to the appointment.' });
  } else {
    const t = toMin(plan.transportThere.time);
    if (t >= appt) gaps.push({ code: 'transport_there', stage: 'Getting there', severity: 'high', title: 'Pickup is at or after the appointment time', detail: `Pickup is ${fmt(t)} but the appointment is ${fmt(appt)}.` });
    if (plan.transportThere.owner !== 'cab' && !availableAt(plan.transportThere.owner, t)) {
      gaps.push({ code: 'transport_there', stage: 'Getting there', severity: 'high', title: `${cap(name(plan.transportThere.owner))} is not free at pickup time`, detail: `Pickup is ${fmt(t)}, outside their entered hours.` });
    }
  }

  // 3. Transport home.
  if (plan.transportBack.owner === 'none') {
    gaps.push({ code: 'transport_back', stage: 'Getting home', severity: 'high', title: 'No transport home', detail: 'Nobody is assigned to bring your parent home.' });
    const drivers = Object.values(H).filter((h) => h.u > early);
    decisions.push({ question: 'How does your parent get home?', options: drivers.length ? drivers.map((h) => `The ${h.role.toLowerCase()} (free until ${fmt(h.u)})`).concat(['Book a cab for after the latest finish']) : ['Book a cab for after the latest finish'] });
  } else {
    const t = toMin(plan.transportBack.time);
    if (t < late) gaps.push({ code: 'transport_back', stage: 'Getting home', severity: 'medium', title: 'Return trip may arrive before the visit ends', detail: `Return is at ${fmt(t)}, but the visit could run until ${fmt(late)}.` });
    if (plan.transportBack.owner !== 'cab' && !availableAt(plan.transportBack.owner, t)) {
      gaps.push({ code: 'transport_back', stage: 'Getting home', severity: 'high', title: `${cap(name(plan.transportBack.owner))} is not free for the return trip`, detail: `Return is at ${fmt(t)}, outside their entered hours.` });
    }
  }

  // 4. Task owners.
  const retT = plan.transportBack.owner !== 'none' ? Math.max(toMin(plan.transportBack.time), late) : late;
  const needAt = { documents: appt, registration: appt, pharmacy: early, reports: null, homeArrival: retT };
  for (const [k, meta] of Object.entries(OWNER_TASKS)) {
    const o = plan.owners[k];
    if (o === 'none') {
      gaps.push({ code: k, stage: meta.stage, severity: k === 'homeArrival' ? 'high' : 'medium', title: `${meta.label}: no owner`, detail: 'Nobody is assigned to this step.' });
    } else if (needAt[k] !== null && !availableAt(o, needAt[k])) {
      gaps.push({ code: k, stage: meta.stage, severity: 'medium', title: `${meta.label}: ${name(o)} may not be free`, detail: `Needed around ${fmt(needAt[k])}, outside their entered hours.` });
    }
  }

  gaps.forEach((g) => { g.detail = g.detail.replace(/\.\.+$/, '.'); });
  const order = { high: 0, medium: 1 };
  gaps.sort((x, y) => order[x.severity] - order[y.severity]);
  return { gaps, decisions: decisions.slice(0, 4) };
}

function cap(s) { return s.charAt(0).toUpperCase() + s.slice(1); }

const STAGE_LABELS = {
  accompaniment: 'Someone with them during the visit', tentative: 'Tentative help', transport_there: 'Getting there',
  transport_back: 'Getting home', documents: 'Carrying documents', registration: 'Registration',
  pharmacy: 'Pharmacy and billing', reports: 'Reports collection', homeArrival: 'Staying until home',
};

module.exports = { validate, analyse, ValidationError, VISIT_TYPES, OWNER_TASKS, STAGE_LABELS, fmt, toMin };
