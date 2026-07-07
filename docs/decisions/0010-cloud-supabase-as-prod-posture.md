# ADR 0010 — Cloud Supabase as production posture

- **Status:** Accepted
- **Date:** 2026-07-06
- **Decided by:** Jon (guardrail decisions on the #46 production decomposition)
- **Relates to:** ADR 0003 (RLS-always-in-force), ADR 0008 (Realtime socket auth), #46 (parent), #51 (P1 cloud Supabase), #54 (P4 Realtime-on-cloud gate). Runbook: `docs/runbooks/production-bringup.md` § P1.

## Context

Production needs a hosted Supabase project. The choices with cost/data-model/security
implications: which project (reuse dev vs a dedicated prod), which tier, how migrations
reach it, and how we guarantee RLS parity between the pgTAP-guarded local schema and the
cloud DB where real family data will live.

## Decision

- **A NEW, dedicated production Supabase project** — separate from local dev. `local
  Supabase = dev, cloud Supabase = prod`; **no staging** environment.
- Region **`us-central1`**, **Free tier**. Jon **explicitly accepts** the Free-tier
  tradeoffs for the family MVP: the **~7-day-idle project pausing** and the **Free-tier
  Realtime caps**. (A 4-person household that plans weekly meals may idle a project into a
  pause; Jon accepts the manual un-pause over paying for Pro.)
- **Migrations applied via `supabase db push`** — the *same* migrations CI applies locally
  via `supabase db reset`. RLS parity is therefore **by construction** (identical DDL),
  and **verified** by a **two-user cloud smoke** (each member sees only household-scoped
  rows). **pgTAP in CI remains the standing RLS guard**; the cloud smoke is a one-time
  confirmation that hosted behavior matches.
- **FORCE RLS** is confirmed on every household-scoped table on the cloud DB before real
  data lands.
- **No service-role key in any app path** (ADR 0003 invariant). Only the **anon** key and
  public URL are loaded into GCP **Secret Manager**, under the canonical names the pipeline
  already references: **`NEXT_PUBLIC_SUPABASE_URL`** and **`NEXT_PUBLIC_SUPABASE_ANON_KEY`**
  (this resolves the `ci.yml` "TODO: align secret names" comment to these names — no
  behavior change).

## Consequences

**Positive**
- Real family data lives in an isolated prod project, never entangled with throwaway dev
  data; blast radius of a dev mistake stays in dev.
- Zero hosting spend for the database (Free tier) — cost posture preserved.
- RLS parity is guaranteed by identical migrations and independently confirmed by the
  two-user smoke; the security bedrock (ADR 0003) carries to prod unchanged.
- Only public, client-inlined values (`NEXT_PUBLIC_*`) reach Secret Manager; the
  service-role key never leaves Supabase.

**Negative / residual risk**
- **Project pausing** after ~7 days idle: the app will be down until Jon un-pauses. Accepted
  for a family MVP; a launch-time reconsideration if usage becomes daily.
- **Free-tier Realtime caps** (concurrent connections / messages) could throttle the live
  loop. For 4 users this is expected to be fine, but it is exactly why **P4 re-verifies
  Realtime against the cloud project** before we trust it — hosted Realtime auth/JWKS and
  caps can differ from local (see ADR 0008).
- `db push` against prod is a privileged operation Jon runs manually; not in CI. Documented
  in the runbook to avoid drift.

**Alternatives considered**
- *Reuse the dev project as prod* — rejected; entangles real family data with dev churn and
  loses a clean environment boundary.
- *Supabase Pro (no pausing, higher Realtime caps)* — rejected on cost posture for the MVP;
  revisit only if pausing/caps actually bite in real use.
- *A staging project between dev and prod* — rejected as over-engineering for a 4-person
  app; `local = dev, cloud = prod` is sufficient.

## Follow-ups
- **P4 (#54) — Realtime-on-cloud GATE result will be recorded as a FUTURE ADR** (pass/fail
  + any hosted-specific Realtime config). It is intentionally **not pre-written** here.
- Reconsider tier if project pausing or Realtime caps degrade real family use.
