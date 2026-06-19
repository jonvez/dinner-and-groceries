# ADR 0004 — Analytics, TDD discipline, and the Kickoff Gate

- **Status:** Accepted
- **Date:** 2026-06-19
- **Decided by:** Jon (human), with PO/architect input

## Context

Three additions raised before kickoff: a formal TDD stance, a formal project "start" ceremony,
and analytics instrumentation to track outcome progress.

## Decision

### 1. Test-Driven Development (process)
Test-first is the discipline. **Strict test-first** for domain logic, data-access/server
actions, and the riskiest code (ingredient parsing, roll-up/dedupe, RLS scoping, week math).
**UI** may take a thin exploratory spike but ships with tests. Enforced in the Definition of
Done; developers use the `test-driven-development` skill. Already reflected in `SPEC.md`
testing strategy and the `developer` agent.

### 2. Kickoff Gate (process)
A project flips from planning to execution only when Jon explicitly says **"start."** That is
recorded as a kickoff ADR and is the sole trigger for feature implementation. Pre-flight
checklist and ceremony documented in `TEAM.md`.

### 3. Analytics & outcome tracking (scope)
**Events-table-only** in Supabase — **no GA4 / no third-party.** Rationale: for a 4-person
invite-only app, GA4's strengths (traffic, acquisition, scale) don't apply, and a custom PO
dashboard is far easier on relational event data than on GA4. Consolidating to one queryable,
privacy-contained table loses nothing that matters here **provided usage events are
instrumented too** (not just participation events).
- New `events` table (id, household_id, member_id nullable, event_type, payload jsonb, created_at).
- Pseudonymous attribution to app `member_id`, never Google identity/PII.
- Taxonomy spans **usage** (`app_open`/`session_start`, `screen_view`, `sign_in`) and
  **participation** (`proposal_created`, `reaction_added`, `comment_added`, `slot_filled`,
  `grocery_list_built`, `trip_completed`, `recipe_ingested`); health-tag distribution aggregate-only.
- **Simple PO-only dashboard in MVP**; rich trend analysis post-MVP.
- **Boundary:** no kid-facing metrics or scorecards — consistent with the north star.

## Consequences

- `SPEC.md` updated: `events` table, Analytics & Outcome Tracking section, scope moves.
- Event emission is cross-cutting in M1 (emit as features land); the PO dashboard is an M1-tail slice.
- `member_id` is nullable on events to allow pre-membership usage events (e.g., sign_in before join).
- No external analytics dependency or GA4 setup work.
