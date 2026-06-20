# ADR 0007 — M0 + M1 backlog decomposition and grooming to Ready

- **Status:** Accepted
- **Date:** 2026-06-19
- **Decided by:** Product Owner (within guardrails, post-Kickoff per ADR 0006)

## Context

The Kickoff Gate opened (ADR 0006 — Jon said "start"). The PO decomposed `SPEC.md`
and the PLAN.md Milestone Roadmap (M0, M1) into GitHub issues with explicit acceptance
criteria, added them to Project board #1 in Backlog, and groomed the first buildable
work to Ready. No new scope was invented; every issue cites SPEC.md / PLAN.md / ADRs
0002–0004.

## Decision

### Issues filed (17 total)

- **M0 — Scaffold & CI** (3): #1 Next.js skeleton + repo layout + Tailwind/shadcn;
  #2 Supabase CLI + local stack + migrations + typed rows; #3 CI (lint/typecheck/Vitest
  per PR) + Playwright wiring + Cloud Run deploy stub.
- **M1 Slice 1a — Identity** (3): #4 schema (households/members/invites) + RLS;
  #5 Google OAuth + `@supabase/ssr` session; #6 household create + invite/join +
  "join your family" state.
- **M1 Slice 1b — Social loop** (4): #7 social/board schema + RLS; #8 week board
  (lazy current week) + manual proposals; #9 emoji reactions + comments + Realtime;
  #10 manual + nudge slotting (loop-validation gate).
- **M1 Slice 1c — Recipes (free)** (2): #11 ingredient normalization (`lib/`, TDD);
  #12 structured JSON-LD ingestion + SSRF-guarded fetch + manual editor (AI fallback
  stays M2 per ADR 0002 #2).
- **M1 Slice 1d — Grocery list** (3): #13 grocery schema + RLS; #14 roll-up + dedupe
  (`lib/`, TDD hard); #15 list UI (catalog/ad-hoc/have-it/check-off/complete-trip).
- **Cross-cutting analytics** (1): #16 events table + RLS + emission helper.
- **M1 Slice 1e — PO dashboard** (1): #17 owner-only dashboard.

### Splitting rationale

Slices were split into 2–4 issues only where units are independently testable
(schema+RLS vs. server-action behavior vs. UI; pure `lib/` logic vs. its persistence).
1a split per the explicit task guidance (schema+RLS / OAuth+session / create+invite+join).
1c and 1d isolate the riskiest pure-`lib/` logic (#11 normalizer, #14 roll-up/dedupe)
from their I/O so they can be strict test-first. Avoided over-fragmentation: 1b's board
and proposal action share one issue (#8); 1e stayed whole.

### Acceptance criteria & DoD

Each issue carries Given/When/Then or a checklist drawn from SPEC.md flows + the recorded
ADR defaults (ADR 0003 constants: Monday/TZ week boundary, badge ≥2 distinct reactions,
exact-name+unit dedupe with no conversion, merge-not-clobber, tap-to-slot). Domain/logic
and data-access issues call for **strict test-first** per TEAM.md TDD; security-relevant
issues (all RLS, OAuth/session, invite tokens, SSRF fetcher, events no-PII, owner-only
dashboard) require **non-author `security-review`** in their DoD.

### Grooming

Moved to **Ready** (first buildable work): M0 #1–#3 and Slice 1a #4–#6. Everything else
remains in **Backlog** with dependency links recorded as issue comments. 1a and the M0
toolchain are unblocked; later slices depend on 1a's RLS helper and the M0 stack.

## Consequences

- Devs can pull M0 (#1–#3) and Slice 1a (#4–#6) from Ready immediately (worktree-isolated).
- The events-table taxonomy is **locked to ADR 0004** in #16; per-feature emission is a
  line item in each feature slice's own PR, not a separate scope.
- The 1b slotting issue (#10) is the loop-validation gate — stop and validate with the
  family before grooming 1c/1d to Ready.
- No guardrail was crossed; no scope added or removed; data-model shape and hosting/cost
  posture unchanged.
