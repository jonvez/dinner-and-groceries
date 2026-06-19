# ADR 0003 — Technical & Product Baseline Defaults (agent-decided, within guardrails)

- **Status:** Accepted (Jon may override any item)
- **Date:** 2026-06-19
- **Decided by:** Product Owner + Architect within guardrails; surfaced to Jon for veto

## Context

Scoping-gate questions classified as decidable within guardrails. Recorded here as the
baseline the team builds on. Each may be revisited via a superseding ADR.

## Decisions

### Product / scope (PO)
- **First vertical slice:** household + Google auth + a single week board with manual dish
  proposals + emoji reactions. No recipe ingestion or grocery list in slice 1 — prove the
  social loop first.
- **Week creation:** lazy upsert on first board access (no scheduler). `UNIQUE(household_id, start_date)`.
- **Week boundary:** Monday start, household-local timezone (`households.timezone`/`week_start_day`).
- **"Ready to slot" nudge:** sort pool by positive-reaction count (desc), tiebreak most-recent;
  badge at ≥2 positive reactions from distinct members. Threshold is a tunable constant.
- **Reactions:** small fixed positive/neutral emoji palette (a single editable constant).
- **Slotting UI:** tap-to-slot / tap-to-unslot for MVP (reversibility is the requirement);
  drag-and-drop is post-MVP polish.
- **Ingredient dedupe:** exact match on normalized (trim/lowercase/collapse-ws/singularize)
  name + exact unit; **no unit conversion** in MVP; un-mergeable units listed separately;
  `raw_text` always preserved.
- **Duplicate slotting:** a dish slotted twice in a week rolls up twice (buy twice).
- **Past weeks:** remain accessible/editable, no lock; default landing = current/upcoming week.
- **Health tags:** manual, user-applied from a small suggested pick-list (`tags[]` stays free-text);
  no AI auto-tagging in MVP.
- **Multi-household correctness:** household-scoped RLS/queries built correctly (no switcher UI).

### Architecture (ARCH)
- **Migrations:** Supabase CLI migrations (`supabase/migrations/*.sql`) as the sole DDL source;
  no manual dashboard schema edits.
- **Data access:** `supabase-js` server-side with the **user's** access token (RLS always in
  force); `supabase gen types typescript`; service-role key reserved for the M2 extraction
  insert path and audited.
- **RLS:** `SECURITY DEFINER` household-lookup helper used in every policy; denormalize
  `household_id` onto hot child tables; per-table allow-same / deny-cross tests in DoD.
- **Auth:** `@supabase/ssr` cookie sessions + Next.js middleware; membership created explicitly
  (household creation → owner; or invite acceptance). Signed-in-without-member → join screen.
- **Realtime:** Postgres Changes on `reactions`/`comments`, filtered by `week_id`, RLS-gated;
  client always reconciles via fetch on (re)connect.
- **Optimistic writes:** reactions unique on `(proposal_id, member_id, kind)` (idempotent toggle);
  reconcile incoming events by primary key.
- **Repo layout:** single Next.js repo; framework-free domain logic in `lib/` (heavily unit-tested);
  thin server actions in `app/**/actions.ts`; UI in `components/`; feature-foldered for parallel devs.
- **Recipe URL fetch (M2):** Node runtime; allow only http/https + public DNS; block
  private/link-local/metadata ranges incl. post-redirect; cap size, timeout, redirect depth.
- **Anthropic contract (M2):** tool-use `input_schema`, re-validated with Zod before insert;
  model pinned `claude-haiku-4-5-20251001`; tests mock the API and assert the validated contract.
- **CI/deploy:** GitHub Actions — lint + typecheck + Vitest per PR; Playwright per PR against a
  local/ephemeral Supabase DB; Docker → Artifact Registry → Cloud Run on merge to main; secrets
  via GCP Secret Manager bound to the Cloud Run service.
- **Grocery re-roll-up on slot removal:** track provenance (`ingredient_id` + `edited` flag);
  remove auto-derived rows whose source dish is no longer slotted **only if untouched**; never
  delete have-it/checked/manually-edited rows. Surface "N added, M removed."

## Consequences

- These defaults are the contract for the first issues' acceptance criteria and tests.
- Anything marked M2 (extraction, Anthropic, service-role key) is out of the first milestone.
