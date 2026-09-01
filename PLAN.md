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

> **Durable context only** — environment, setup gotchas, production posture, conventions, blockers.
> **No "current focus" / milestone / status prose lives here** — it drifts, and this section has bitten us
> twice (a stale Realtime constraint, then a stale "current milestone"). "What's active now" = `ghpm list`
> / board #1; milestone *strategy* lives in the Roadmap section above. (Refines process-bus evt-0002.)

### Production
Deployed on Cloud Run (`https://dinner-and-groceries-nr55phmu6q-uc.a.run.app`), backed by the cloud
Supabase prod project (ref `wcbjuobzeursmomcoefw`, Free tier). Posture of record: ADRs 0009
(keyless-WIF/Cloud Run) + 0010 (cloud-Supabase-as-prod) + 0011 (Realtime verified live two-client on
cloud — conditional PASS, 2026-07-21); bring-up in `docs/runbooks/production-bringup.md`.
- **Migrations do NOT auto-reach cloud prod.** CI applies migrations only to ephemeral CI Postgres; the
  cloud Supabase schema changes ONLY via a manual `supabase db push` (login → link `--project-ref
  wcbjuobzeursmomcoefw` → push). A merged migration is NOT live until that runs — a real footgun.
- **Applying SQL to cloud prod needs no database password.** `npx supabase db query --linked -f <file>`
  runs a SQL file against the linked project through the **Management API on the existing
  `supabase login` token** — no connection string, no tunnel. (`db push` is the one that wants the DB
  password.) Verified over that transport: `begin;` / `do $$ … $$` / `commit;` all execute, and a
  `raise exception` propagates and exits non-zero — so a script's own transactional guards stay real
  rather than being silently swallowed. Worth knowing before concluding a prod write is blocked on a
  credential nobody has.
- **The prod deploy build is a required check** (`Production build (Docker)`): it runs the real image
  `next build`, catching prod-only breakage the standalone typecheck misses (e.g. a `.dockerignore`-excluded
  import). A red deploy = stale prod — don't let it go silently red.

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
  + "RLS pgTAP (Supabase)" + "Production build (Docker)"**, strict, `enforce_admins: true`,
  force-push/deletion blocked. No required
  *review* (single GitHub identity makes it unsatisfiable — bot/App upgrade path is the fix). **Consequence:
  all changes route through PRs, including docs** — but **docs-only PRs fast-path** the heavy gates (#99): a
  `changes` job detects a docs-only diff (every path a `.md` or under `docs/`) and the prod-build/pgTAP/E2E
  jobs skip their work while still reporting success, so a docs PR merges in under a minute instead of ~10.
- **The `supabase` CLI is pinned at 2.107.0 — do not bump it without reading #164.** Under 2.116.0 the
  LOCAL stack loses role isolation and five pgTAP guards fail: `anon` can execute the `SECURITY DEFINER`
  bootstraps (`create_household`, `accept_invite`) that `household_bootstrap.sql` explicitly revoked from
  public, `anon` can SELECT from 13 public tables, and a non-owner member can self-promote to owner. The
  same schema passes on 2.107.0, so this is the CLI's role provisioning, not our migrations. **Cloud prod
  is unaffected** — it does not care which CLI runs locally — but RLS pgTAP is a required check and is what
  makes ADR 0003's "RLS is the security boundary" claim verifiable, so the bump stays blocked.
- **Stop the local Supabase stack when you finish working** — `npm run db:stop`. It is ELEVEN containers
  behind a 4 GB Docker VM reservation, and nothing restarts or reaps it, so it silently stays up for days
  across sessions (observed: 3–11 days continuous, spanning days nobody touched this project). On a 16 GB
  machine that is the single largest process, and it contributes to macOS jetsam sweeps that kill hundreds
  of processes daily — including the MCP servers Claude sessions depend on, which is one cause of the
  MemPalace disconnects that need `/mcp reconnect`. Stopping it is free: local data is preserved in a
  Docker volume, `npm run db:start` restores it, and the stack is only needed for `db:reset`, pgTAP, and
  the authed Playwright suite. Prod is cloud Supabase, so nothing user-facing depends on it being up.
  Reclaim is gradual (the VM balloon returns pages over ~30s), and container-stop alone leaves Docker
  Desktop's own VM overhead — quit Docker Desktop too for the full amount, at the cost of an admin
  password prompt next start.
- **Auto mode is NOT project-settable** (CC v2.1.142+): `defaultMode: "auto"` in `.claude/settings.json` is
  silently ignored (a repo can't self-grant auto). To use auto mode here, `Shift+Tab` each session or launch
  `claude --permission-mode auto`. Persistent-everywhere only via `~/.claude/settings.json`. The `allow` list
  in `.claude/settings.json` is still honored.

### Conventions
- Board ops go through the `ghpm` wrapper / `github-project-board` skill — never hand-roll `gh`/GraphQL.
- Command hygiene: no `cd`-compounds (use `git -C`); explicit `git add` paths.
- Dependency upgrades go through the **`deps-refresh` skill**, which reads the committed
  `.deps-refresh.yml` (`tier: product`). Never hand-roll one: the tier means any NEW package in the lock
  diff — even dev-only — stops the pass for a `third-party-security-review`, and expensive gates must be
  green before merge.
- Persona agents are global + dispatchable. Things is **not** used for this project (board is the tracker).

### Blockers
- gh-pm scoped-PAT hardening pending (optional; board works on the keyring token now) — steps in
  `~/.claude/third-party-inventory.md`.
