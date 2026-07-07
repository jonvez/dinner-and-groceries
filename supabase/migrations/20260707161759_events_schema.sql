-- Migration: events_schema (issue #16)
--
-- Cross-cutting analytics plumbing (ADR 0004 #3; SPEC "Analytics & Outcome
-- Tracking"). Lands the append-only `events` table + RLS + the taxonomy enum.
-- The typed server-side emission helper lives in `lib/analytics/events.ts`.
--
-- WIRING NOTE (scope boundary): this issue lands ONLY the table, RLS, and the
-- helper. It does NOT wire per-feature emission. Each feature slice emits its
-- own events in that slice's own PR once this helper exists (#8 week board,
-- #9 reactions/comments, #10 slotting, #12, #15). Do not add per-feature emit
-- calls here.
--
-- Security / modeling design of record (mirrors social_schema, ADR 0003):
--   * `household_id` is DENORMALIZED so each RLS policy is a DIRECT
--     `household_id = public.current_household_id()` check — the SINGLE 1a
--     SECURITY DEFINER chokepoint. No new helper is introduced.
--   * `member_id` is NULLABLE for pre-membership usage events (e.g. `sign_in`
--     before a household is joined; ADR 0004 consequences). It uses the same
--     composite attribution FK the social tables use — `(member_id, household_id)
--     -> members(id, household_id)` — so an attributed event's member is always
--     in the SAME household, and on member delete only member_id is nulled
--     (the event + its household_id survive; append-only history is preserved).
--   * `event_type` is constrained to the FIXED ADR 0004 taxonomy via a Postgres
--     enum (idiomatic here — social_schema uses an enum for meal_type). Adding a
--     new event type is a deliberate migration + ADR change, never ad hoc.
--   * APPEND-ONLY for clients: only SELECT and INSERT policies exist, and only
--     SELECT + INSERT are granted to `authenticated`. There is deliberately NO
--     update and NO delete policy AND no update/delete grant, so a client can
--     neither mutate nor delete an emitted event. FORCE RLS keeps the owner
--     non-exempt too. (Defense in depth: the missing privilege fails the write
--     before RLS is even consulted.)
--   * NO Google identity / PII is ever stored: attribution is the pseudonymous
--     app `member_id` only. The emission helper's typed surface carries no
--     email/sub field (ADR 0004: "never Google identity/PII").

-- ===========================================================================
-- Enum: the analytics event taxonomy of record (ADR 0004 #3). Spans usage
-- (session_start, screen_view, sign_in) and participation (proposal_created,
-- reaction_added, comment_added, slot_filled, grocery_list_built,
-- trip_completed, recipe_ingested). ADR lists app_open/session_start as
-- synonyms — we standardize on session_start.
-- ===========================================================================
create type public.event_type as enum (
  -- usage
  'session_start',
  'screen_view',
  'sign_in',
  -- participation
  'proposal_created',
  'reaction_added',
  'comment_added',
  'slot_filled',
  'grocery_list_built',
  'trip_completed',
  'recipe_ingested'
);

-- ===========================================================================
-- events — append-only analytics log. Top-level household_id references
-- households directly; member_id is the OPTIONAL pseudonymous attribution.
-- ===========================================================================
create table public.events (
  id           uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households (id) on delete cascade,
  -- Pseudonymous app member attribution. NULLABLE: pre-membership usage events
  -- (sign_in before joining). Composite FK keeps an attributed member in the
  -- SAME household; on member delete, null ONLY member_id so the event survives.
  member_id    uuid,
  event_type   public.event_type not null,
  payload      jsonb not null default '{}',
  created_at   timestamptz not null default now(),
  foreign key (member_id, household_id)
    references public.members (id, household_id) on delete set null (member_id)
);

create index events_household_id_idx on public.events (household_id);

-- ===========================================================================
-- Table privileges (auto-expose is disabled in config.toml, so grant
-- explicitly). Append-only: SELECT + INSERT ONLY — no UPDATE/DELETE grant, so
-- clients cannot mutate or delete an emitted event even before RLS is checked.
-- `anon` gets nothing (the whole app is private to authenticated members).
-- ===========================================================================
grant select, insert on public.events to authenticated;

-- ===========================================================================
-- Row Level Security — enable + FORCE (owner not exempt; defense in depth).
-- ===========================================================================
alter table public.events enable row level security;
alter table public.events force  row level security;

-- ---------------------------------------------------------------------------
-- Policies. Household-scoped SELECT + INSERT only — DIRECT
-- `household_id = public.current_household_id()` check (ADR 0003). NO update and
-- NO delete policy: append-only. With FORCE RLS + no permissive UPDATE/DELETE
-- policy (and no UPDATE/DELETE privilege), clients cannot change history.
-- ---------------------------------------------------------------------------
create policy events_select on public.events
  for select to authenticated
  using (household_id = public.current_household_id());
create policy events_insert on public.events
  for insert to authenticated
  with check (household_id = public.current_household_id());
