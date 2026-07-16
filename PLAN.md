# Dinner & Groceries — Plan

> **Status lives on the board, not here.** Live work status: `ghpm list` / GitHub Projects board #1
> (Backlog→Ready→In Progress→In Review→QA→Done). This file is durable context only — goal,
> architecture, milestone *strategy*, non-issue gates, env/setup. It must never mirror issue status
> (process-bus `evt-0002`, topic `plan-vs-board`). History: `PLAN.archive.*.md`, ADRs, `docs/retro/log.md`, git.

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
- **Security posture:** every household-scoped table carries `household_id` and is RLS-protected
  (FORCE RLS); cross-household access denied; identity derived from `auth.uid()` via a
  `SECURITY DEFINER` lookup helper (`search_path=''`); no service-role in app paths. RLS allow/deny
  is test-first (pgTAP) and a required CI check.
- Decisions of record: `docs/decisions/` (ADRs). Team board: GitHub Projects #1.

## Milestone Roadmap (strategy — not status; see the board for state)

### M0 — Scaffold & CI
- Next.js app skeleton, repo layout (`app/`, `lib/`, `components/`), Tailwind + shadcn.
- Supabase CLI + local stack; migration tooling; typed row generation.
- CI (GitHub Actions): lint + typecheck + Vitest per PR; Playwright wiring; Cloud Run deploy pipeline (stub OK).

### M1 — Free MVP loop (no paid AI)
- **Slice 1a — Identity:** households/members/invites schema + RLS; Google OAuth + `@supabase/ssr`; household create + invite/join + "join your family" state.
- **Slice 1b — Social loop (the validation slice):** weeks/slots/slot_dishes/dishes/proposals/reactions/comments + RLS; week board (lazy current week); manual dish proposals; emoji reactions; comments; Realtime; manual + nudge slotting (tap-to-slot). **⛳ GATE: stop and validate the loop with the family before building further.**
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
**Live status / what's next: `ghpm list` (board #1) — not mirrored here.** Milestone strategy is in the
roadmap above. The board column for each issue is authoritative; if anything below disagrees with the
board, the board wins.

**Production is LIVE.** The app is deployed on Cloud Run at
`https://dinner-and-groceries-nr55phmu6q-uc.a.run.app`, backed by the cloud Supabase prod project
(ref `wcbjuobzeursmomcoefw`); P0–P3 done and the prod Google OAuth round-trip is verified end-to-end.
Posture of record: ADRs 0009 (keyless-WIF/Cloud Run) + 0010 (cloud-Supabase-as-prod); bring-up steps in
`docs/runbooks/production-bringup.md`. **Next gate: P4/#54 — re-verify Realtime against *cloud* Supabase
(two-client live round-trip + cross-household isolation) before any kid uses prod.** Board #1 is
authoritative for status.

**Current milestone gate:** Slice 1b (the social loop) is built; the roadmap's **family-validation gate**
is now active — exercise the full loop live before building Slice 1c. Tracked on the board as the
pre-family live-verification smoke (two-client Realtime + full propose→react→comment→slot round-trip).
Rationale for not skipping it: the Slice 1a retro (6-23) — *deferring live verification on a foundation
slice produced compounding integration bugs*; 1b is the loop everything else hangs off.

### Environment & setup (durable gotchas)
- **Local dev (Google sign-in):** start the stack with creds via `npm run db:start` (sources `.env.local`
  via `scripts/supabase.sh`); needs a Google OAuth client (Authorized redirect URI
  `http://127.0.0.1:54321/auth/v1/callback`, test-users added) + `.env.local` with
  `SUPABASE_AUTH_EXTERNAL_GOOGLE_CLIENT_ID/_SECRET`. README "Google OAuth" has the full setup.
- **Cloud Run + Next.js standalone gotchas (learned in prod bring-up):**
  1. `NEXT_PUBLIC_*` must be supplied **both** as Docker build-args (client-bundle inlining at build) **and**
     as a Cloud Run runtime secret binding (server reads `process.env` *dynamically*). Only one ⇒ the browser
     client throws, or SSR 500s on every request. Guarded by `ci-deploy-env-wiring.test.ts`.
  2. Absolute redirects must derive their origin from `x-forwarded-host` (via `lib/http/request-origin.ts`),
     never `request.nextUrl.origin` — behind Cloud Run the latter is the container's internal `0.0.0.0:8080`.
- **Branch protection on `main`:** required checks **"Lint, typecheck, unit tests" + "Playwright smoke E2E"
  + "RLS pgTAP (Supabase)"**, strict, `enforce_admins: true`, force-push/deletion blocked. No required
  *review* (single GitHub identity makes it unsatisfiable — bot/App upgrade path is the fix). **Consequence:
  all changes route through PRs, including docs.**
- **Auto mode is NOT project-settable** (CC v2.1.142+): `defaultMode: "auto"` in `.claude/settings.json` is
  silently ignored (a repo can't self-grant auto). To use auto mode here, `Shift+Tab` each session or launch
  `claude --permission-mode auto`. Persistent-everywhere only via `~/.claude/settings.json`. The `allow` list
  in `.claude/settings.json` is still honored.

### Conventions
- Board ops go through the `ghpm` wrapper / `github-project-board` skill — never hand-roll `gh`/GraphQL.
- Command hygiene: no `cd`-compounds (use `git -C`); explicit `git add` paths.
- Persona agents are global + dispatchable. Things is **not** used for this project (board is the tracker).

### Blockers
- gh-pm scoped-PAT hardening pending (optional; board works on the keyring token now) — steps in
  `~/.claude/third-party-inventory.md`.
