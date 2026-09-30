# VisitSaathi

Spot the gaps in your parent's hospital visit before the day.

VisitSaathi is a product concept for adult children who coordinate a parent's
hospital visits from another city. The live Visit Gap Check lets a visitor enter
a visit plan (by role, not name) and get back the gaps, the decisions to make,
and a draft handover for each helper.

## How it works
- `index.html`: landing page, gap check form, results and live counter
- `api/check.js`: Vercel serverless function. Validates input, runs the rules
  engine, asks Gemini for a plain-language summary and handovers, stores the
  exchange in Supabase, enforces 3 checks per visitor per day
- `api/stats.js`: reads stored checks and returns the numbers shown on the page
- `api/_rules.js`: rules that find timing gaps and unassigned steps (no AI)
- `supabase.sql`: table definition

## Environment variables (set in Vercel, never in code)
- `GEMINI_API_KEY`
- `SUPABASE_URL`
- `SUPABASE_SERVICE_KEY`

## Guardrails
- Logistics only: medical questions in notes get a fixed refusal (prompt rule plus a server-side check)
- Gemini may not invent helpers, bookings or times; unresolved gaps stay unresolved
- No names, ages or health data stored; notes are never stored

Built with AI-assisted coding (Claude) for the GenAI Across Tasks assignment.
Logistics support only. Not a medical service.
