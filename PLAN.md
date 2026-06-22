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
- **Cross-cutting — analytics:** `events` table + RLS; emit usage + participation events as each feature lands (events-table-only, pseudonymous `member_id`, no GA4).
- **Slice 1e — PO dashboard:** simple you-only dashboard reading the events table (adoption, per-member participation, trips, tag mix).

### M2 — AI fallback + polish
- AI recipe fallback (Anthropic `claude-haiku-4-5-20251001`, tool-use + Zod contract, $10/mo cap).
- PWA polish (offline shell, install prompt); health-tag pick-list; drag-and-drop slotting.

### Post-MVP (deferred — see SPEC.md)
Cost tracking, outcome dashboards, private health log, leftovers, per-slot prep override,
school lunches, Apple sign-in + native app, marketplace, repurchase suggestions.

## Active Context

### Current Focus
**Kickoff done** (ADR 0006). PO groomed SPEC/PLAN → 17 issues on board #1 (ADR 0007): Ready =
M0 scaffold #1–#3 + Slice 1a Identity #4–#6; #7–#17 in Backlog. See the board via the
`github-project-board` skill (`ghpm list`).

**Resume here →** PR #18 (M0 #1, Next.js scaffold) is **In Review** — built clean (7 tests green;
lint/typecheck/build pass) on a deliberately bleeding-edge stack (**Next 16 / React 19 / Tailwind 4**).
Next: (1) Jon's call on that stack; (2) QA (non-author) + `security-review` (one open item: a moderate
postcss advisory bundled transitively inside Next); (3) merge #1 → **fan out 2 devs** on #2 (Supabase)
+ #3 (CI); Slice 1a (#4–#6) follows once Supabase lands.

### Blockers
- **Accept the auto-mode opt-in** this restart to activate `permissions.defaultMode: "auto"` (set in `.claude/settings.json` — kills the compound-command permission prompts).
- gh-pm scoped-PAT hardening pending (optional; board works on the keyring token now) — steps in `~/.claude/third-party-inventory.md`.

### Notes
- Persona agents are global + dispatchable. Board = GitHub Projects #1 (native 6-column Status field; no Stage field). Things not used for this project.
- Board ops go through the `ghpm` wrapper / `github-project-board` skill — never hand-roll `gh`/GraphQL. Mind command hygiene (no `cd`-compounds → `git -C`; explicit `git add` paths).

---

## Session Log

### 2026-06-19
- Brainstormed product (SPEC.md) + build process (TEAM.md); both committed and exported to Google Docs.
- Created public repo `jonvez/dinner-and-groceries`, Project board #1 (6-stage workflow).
- Wrote 5 global persona agents (`~/.claude/agents/`), `.claude/settings.json` allowlist.
- Ran scoping gate (PO + Architect); recorded ADRs 0001 (baseline), 0002 (human decisions), 0003 (agent defaults).
- Updated SPEC.md data model (households.timezone/week_start_day, invites table).
- Wrote PLAN.md + milestone roadmap.

### 2026-06-22
- **Kickoff** (ADR 0006); PO groomed SPEC/PLAN → 17 issues (ADR 0007). Ready = M0 #1–3 + Slice 1a #4–6.
- Dev delivered **PR #18** (M0 #1 — Next.js scaffold; Next 16 / React 19 / Tailwind 4; 7 tests green) → In Review.
- Stood up shared tooling (cross-project w/ delivery-simulator): adopted `gh-pm` + `ghpm` wrapper + `github-project-board` skill (ADR 0005); global third-party security rule + `third-party-security-review` skill + inventory (gh-pm verdict MEDIUM, scoped-PAT pending); `things` skill + allowlist; **auto mode** enabled per-project (permission-prompt fix); command-hygiene → MemPalace (rig/feedback).
- Board #1 migrated to native 6-column Status field (dropped the redundant Stage field).
