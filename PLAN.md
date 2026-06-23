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

**M0 COMPLETE** (#1 Next 15 scaffold `f9646a8` · #2 Supabase local stack `f696928` · #3 CI `b474d7c`).
PO grooming pass applied user-story framing to M1 issues #4–#17 (personas from SPEC).

**Slice 1a Identity — COMPLETE.** The full loop (sign in → create/join household → shared space) works, verified live end-to-end:
- **#4** identity schema + RLS (PR #27) — security bedrock: FORCE RLS on all 3 tables, `SECURITY DEFINER` chokepoint
  (`search_path=''`), owner/member roles (no self-escalation), single-use expiring invites. Single-household-per-user
  (`unique(user_id)`) for MVP; multi-household is epic **#28**. `RLS pgTAP` CI job (34 → now 59 assertions).
- **#5** Google OAuth + `@supabase/ssr` session (PR #32) — verified-identity gating (`getUser`), allowlist open-redirect
  validation, httpOnly/lax cookies, fail-closed membership, no service-role.
- **#6** household create + invite/join + "join your family" (PR #33) — `SECURITY DEFINER` bootstrap (identity from
  `auth.uid()`), 192-bit CSPRNG invite tokens, atomic `consume_invite()` join.
- **Auth fixes #34/#35** — local Google sign-in had a chain of integration bugs (browser-bundle env inlining, CI build
  env, supabase `.env.local` loading, redirect-URL allowlist, callback cookie propagation) that only surfaced in the live
  round-trip. All fixed + regression-tested; **Jon verified real Google sign-in → signed-in `/join`** on 6-23. See retro 6-23.

**Local dev (Google sign-in):** start the stack with creds via `npm run db:start` (now sources `.env.local` via
`scripts/supabase.sh`); needs a Google OAuth client (Authorized redirect URI `http://127.0.0.1:54321/auth/v1/callback`,
test-users added) + `.env.local` with `SUPABASE_AUTH_EXTERNAL_GOOGLE_CLIENT_ID/_SECRET`. README "Google OAuth" has the full setup.

**Resume here → Slice 1b (the validation slice):** #7 social/board schema + RLS → #8 week board + proposals → #9 reactions/
comments/Realtime → #10 slotting. **Stop and validate the loop with the family after 1b.** (#24 — wire ephemeral Supabase
into the E2E — becomes relevant here for DB-backed E2E.)

**Branch protection on `main`:** required checks **"Lint, typecheck, unit tests" + "Playwright smoke E2E" + "RLS pgTAP (Supabase)"**,
strict, `enforce_admins: true`, force-push/deletion blocked. No required *review* (single GitHub identity makes it unsatisfiable —
retro 6-22 "single identity" + bot/App upgrade path). Consequence: **all changes route through PRs**, including these docs.

**Tracked follow-ups (Backlog):** #19 postcss re-check · #20 CSP/headers (M1) · #23 SHA/digest pinning · #24 ephemeral-Supabase
E2E wiring (Slice 1b) · #28 multi-household (`post-mvp` epic) · #29 households owner-gating (with #6).

### Blockers
- gh-pm scoped-PAT hardening pending (optional; board works on the keyring token now) — steps in `~/.claude/third-party-inventory.md`.

### Notes
- **Auto mode is NOT project-settable** (CC v2.1.142+): `defaultMode: "auto"` in `.claude/settings.json` is silently ignored (a repo can't self-grant auto). Removed it from settings. To use auto mode here, manually `Shift+Tab` into it each session (per-session, ephemeral; first time shows the opt-in prompt) or launch with `claude --permission-mode auto`. Persistent-everywhere only via `~/.claude/settings.json` (global). The `allow` list in `.claude/settings.json` is still honored.
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

### 2026-06-22 (cont. — M0 shipped)
- **Auto mode corrected:** project-level `defaultMode: "auto"` is silently ignored (CC v2.1.142+); removed the dead setting; activated auto mode this session via `Shift+Tab`. The classifier proved itself (blocked unrequested `gh issue create`). Retro logged.
- **#1 stack decision:** Jon pulled Next 16 → stable **15.5.19**; dev reworked PR #18, re-gated (QA + security PASS), squash-merged (`f9646a8`).
- **Fanned out 2 devs in parallel** → #2 Supabase (`f696928`) + #3 CI (`b474d7c`). Each independently QA-PASS + SECURITY-PASS; #21 hit a post-#22 merge conflict (package.json/lock/.gitignore), dev resolved as union + lockfile regen.
- **Branch protection ON** for `main` (required checks: verify + e2e; strict; enforce_admins). Closed QA-1 (the "blocks merge" gap). Required *review* not viable on a single GitHub identity — retro'd the bot/App upgrade path.
- **Follow-ups filed + boarded:** #19 (postcss re-check), #20 (CSP/headers M1), #23 (SHA/digest pinning), #24 (ephemeral-Supabase E2E wiring).
- **Retro:** added 3 entries — auto-mode activation reality, M1 issues lack user-story format (PO to fix at grooming), single-identity review constraint.
- **M0 done.** Next: PO grooming pass (user-story framing) → Slice 1a Identity #4–#6.
