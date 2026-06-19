# ADR 0002 — Scoping Gate: Human Decisions

- **Status:** Accepted
- **Date:** 2026-06-19
- **Decided by:** Jon (human), batch-answered after the PO + Architect scoping gate

## Context

Before implementation, the Product Owner and Architect produced open-questions lists from
`SPEC.md`. Four questions hit the guardrails (data-model shape, hosting/cost, paid dependency)
and were escalated to Jon. These are his answers.

## Decision

1. **Supabase environments:** One hosted Supabase project (Jon's account, free tier) for
   **prod**; **local Supabase via CLI/Docker** for dev & CI. No dev/test data in the cloud project.

2. **Recipe ingestion sequencing:** Milestone 1 builds the **free structured (schema.org/Recipe
   JSON-LD) path + manual add-by-hand**. The **AI fallback (paid Anthropic key) is deferred to
   Milestone 2**, after the propose-and-react social loop is validated.

3. **Anthropic API funding:** Use Jon's **existing Anthropic API account** with a **~$10/month
   soft cap + alerting**. Volume is a few recipes/week (cents of real spend).

4. **Additive schema changes — approved:**
   - `households.timezone` + `households.week_start_day` (correct week boundaries).
   - `invites` table (id, household_id, token, created_by, expires_at, consumed_at, consumed_by)
     for single-use, expiring join links/short codes.
   `SPEC.md` data model updated accordingly.

## Consequences

- CI must support a local/ephemeral Supabase DB for migration + RLS tests.
- The AI extraction route, `ANTHROPIC_API_KEY`, and budget alerting are Milestone-2 work, not Milestone-1.
- Week-boundary logic reads `households.timezone`/`week_start_day` (default Monday start, Jon's local TZ).
- The join flow is backed by the `invites` table (single-use, expiring).
