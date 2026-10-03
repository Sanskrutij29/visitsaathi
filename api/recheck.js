// POST /api/recheck : re-runs only the rules engine after the family applies a decision.
// No Gemini call and nothing stored, so it does not count toward the daily limit.
const { validate, analyse, ValidationError } = require('./_rules');

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Use POST.' });
  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : req.body;
    const plan = validate(body);
    return res.status(200).json(analyse(plan));
  } catch (e) {
    if (e instanceof ValidationError) return res.status(400).json({ error: e.message });
    console.error(e);
    return res.status(500).json({ error: 'Could not re-check the plan. Please try again.' });
  }
};
