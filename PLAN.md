# Dinner & Groceries — Plan

## Goal

Involve Jon's two teens (16, 13→14) in deciding, acquiring, and preparing household food.
MVP nails one loop: **collaborative weekly menu planning** (propose-and-react), async +
multi-device, with the grocery list flowing from the agreed menu. Health is *design gravity*,
never a scorecard. Full product design in `SPEC.md`; build process in `TEAM.md`.

## Architecture (see SPEC.md for detail)

- Single **Next.js** app (App Router, TS, Tailwind, shadcn/ui), PWA; deployed on **GCP Cloud Run**.
- **Supabase** — Postgres, Google OAuth, Realtime, RLS. Cloud project = prod; **local Supabase** for dev/CI.
- Domain logic framework-free in `lib/` (heavily unit-tested); thin server actions; feature-foldered UI.
- Recipe extraction: structured-first (schema.org/Recipe), **AI fallback (paid Anthropic) deferred to M2**.
- Decisions of record: `docs/decisions/` (ADRs). Team board: GitHub Projects #1.

## Milestone Roadmap

### M0 — Scaffold & CI
- Next.js app skeleton, repo layout (`app/`, `lib/`, `components/`), Tailwind + shadcn.
- Supabase CLI + local stack; migration tooling; typed row generation.
- CI (GitHub Actions): lint + typecheck + Vitest per PR; Playwright wiring; Cloud Run deploy pipeline (stub OK).

### M1 — Free MVP loop (no paid AI)
- **Slice 1a — Identity:** schema (households/members/invites) + RLS; Google OAuth + `@supabase/ssr`; household create + invite/join flow + "join your family" state.
- **Slice 1b — Social loop (the validation slice):** weeks/slots/slot_dishes/dishes/proposals/reactions/comments + RLS; week board (lazy current week); manual dish proposals; emoji reactions; comments; Realtime; manual + nudge slotting (tap-to-slot). **Stop and validate the loop with the family here.**
- **Slice 1c — Recipes (free):** structured JSON-LD ingestion + manual dish/ingredient editor; ingredient normalization (`lib/`, TDD); SSRF-guarded URL fetch.
- **Slice 1d — Grocery list:** catalog_items + grocery_items + RLS; roll-up/dedupe (riskiest logic, TDD hard); catalog reuse + ad-hoc items + have-it toggle; complete-trip + promotion.

### M2 — AI fallback + polish
- AI recipe fallback (Anthropic `claude-haiku-4-5-20251001`, tool-use + Zod contract, $10/mo cap).
- PWA polish (offline shell, install prompt); health-tag pick-list; drag-and-drop slotting.

### Post-MVP (deferred — see SPEC.md)
Cost tracking, outcome dashboards, private health log, leftovers, per-slot prep override,
school lunches, Apple sign-in + native app, marketplace, repurchase suggestions.

## Active Context

### Current Focus
Setup complete (repo, board #1, global persona agents, ADRs 0001–0003, settings allowlist).
Scoping gate done; Jon's batch decisions recorded in ADR 0002. **Next: PO files M1 issues to
the board (Backlog), moves Slice 1a to Ready; then M0 scaffold + Slice 1a begin.**

### Blockers
- None. (Anthropic key/budget only needed at M2.)

### Notes
- Custom persona agents load at next session start (written this session, not yet dispatchable here).
- Local-only family app; GitHub Projects is the team board (Things not used for this project).

---

## Session Log

### 2026-06-19
- Brainstormed product (SPEC.md) + build process (TEAM.md); both committed and exported to Google Docs.
- Created public repo `jonvez/dinner-and-groceries`, Project board #1 (6-stage workflow).
- Wrote 5 global persona agents (`~/.claude/agents/`), `.claude/settings.json` allowlist.
- Ran scoping gate (PO + Architect); recorded ADRs 0001 (baseline), 0002 (human decisions), 0003 (agent defaults).
- Updated SPEC.md data model (households.timezone/week_start_day, invites table).
- Wrote PLAN.md + milestone roadmap.
