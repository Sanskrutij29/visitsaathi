-- Run this once in Supabase: SQL Editor > New query > paste > Run.
-- Stores every Visit Gap Check request and response. No names, ages or health data:
-- helpers are stored by role only, and free-text notes are never stored.

create table if not exists public.visit_checks (
  id bigint generated always as identity primary key,
  created_at timestamptz not null default now(),
  visitor_hash text not null,          -- hashed random browser id, used for the 3-per-day cap
  visit_type text not null,
  input jsonb not null,                -- visit times, helper roles and hours, task owners
  gap_stages text[] not null default '{}',
  gap_count int not null default 0,
  output text,                         -- Gemini summary, handovers and notes response
  guardrail_triggered boolean not null default false,
  model text,
  input_tokens int,
  output_tokens int
);

create index if not exists visit_checks_visitor_idx on public.visit_checks (visitor_hash, created_at);

-- Lock the table down: only the server (service key) can read or write.
alter table public.visit_checks enable row level security;
