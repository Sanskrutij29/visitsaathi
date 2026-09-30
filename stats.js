// GET /api/stats : numbers computed from stored checks, shown on the page.
const { readStatsRows } = require('./_supabase');
const { STAGE_LABELS } = require('./_rules');

module.exports = async (req, res) => {
  try {
    const rows = await readStatsRows();
    const total = rows.length;
    const totalGaps = rows.reduce((s, r) => s + (r.gap_count || 0), 0);
    const counts = {};
    rows.forEach((r) => (r.gap_stages || []).forEach((g) => { counts[g] = (counts[g] || 0) + 1; }));
    const top = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json({
      checks: total,
      avgGaps: total ? Math.round((totalGaps / total) * 10) / 10 : 0,
      topGap: top ? { label: STAGE_LABELS[top[0]] || top[0], share: Math.round((top[1] / total) * 100) } : null,
    });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'Stats unavailable.' });
  }
};
