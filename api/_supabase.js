// Minimal Supabase REST client using fetch. Keys come only from Vercel environment variables.

function headers(extra = {}) {
  const key = process.env.SUPABASE_SERVICE_KEY;
  const h = { apikey: key, 'Content-Type': 'application/json', ...extra };
  // Legacy service_role keys are JWTs and go in Authorization too; new sb_secret_ keys only need apikey.
  if (key && key.startsWith('eyJ')) h.Authorization = `Bearer ${key}`;
  return h;
}

function base() {
  const url = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
  if (!url || !process.env.SUPABASE_SERVICE_KEY) throw new Error('Supabase environment variables are missing.');
  return `${url}/rest/v1`;
}

async function insertCheck(row) {
  const r = await fetch(`${base()}/visit_checks`, { method: 'POST', headers: headers({ Prefer: 'return=minimal' }), body: JSON.stringify(row) });
  if (!r.ok) throw new Error(`Supabase insert failed: ${r.status} ${await r.text()}`);
}

async function countRecent(visitorHash, sinceIso) {
  const q = `visitor_hash=eq.${encodeURIComponent(visitorHash)}&created_at=gte.${encodeURIComponent(sinceIso)}&select=id`;
  const r = await fetch(`${base()}/visit_checks?${q}`, { headers: headers() });
  if (!r.ok) throw new Error(`Supabase count failed: ${r.status}`);
  return (await r.json()).length;
}

async function readStatsRows() {
  const r = await fetch(`${base()}/visit_checks?select=gap_count,gap_stages&order=created_at.desc&limit=2000`, { headers: headers() });
  if (!r.ok) throw new Error(`Supabase read failed: ${r.status}`);
  return r.json();
}

module.exports = { insertCheck, countRecent, readStatsRows };
