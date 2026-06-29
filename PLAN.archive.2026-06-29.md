# Dinner & Groceries — PLAN archive (through 2026-06-29)

Narrative session history moved out of `PLAN.md` when it was slimmed to durable-context-only
(process-bus `evt-0002`, topic `plan-vs-board`: PLAN.md is not a status tracker — the board is the
single source of truth for status). Kept here for history; not auto-loaded. Authoritative records:
GitHub Projects board #1 (status), `docs/decisions/` (ADRs), `docs/retro/log.md` (retro), git history.

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

### 2026-06-23 → 06-25 (Slice 1a Identity + Slice 1b Social loop)
- **Slice 1a Identity — complete, verified live.** #4 identity schema + RLS (PR #27); #5 Google OAuth + `@supabase/ssr` (PR #32); #6 household create + invite/join + "join your family" (PR #33). Auth fixes #34/#35 resolved a chain of local-Google-sign-in integration bugs (browser-bundle env inlining, CI build env, supabase `.env.local` loading, redirect-URL allowlist, callback cookie propagation) that only surfaced in the live round-trip. Jon verified real Google sign-in → signed-in `/join` on 6-23. Retro 6-23: for auth/external-integration slices, don't defer live verification.
- **Slice 1b Social loop — merged** (#7 social/board schema + RLS `2581d06` · #8 week board + proposals `52e7990` · #9 reactions/comments/Realtime `c69e46e` · #10 tap-to-slot + nudge `cdd5633`). Board, `lib/social/*`, `lib/week/*`, social_schema migration, Realtime publication, RLS tests 06–14.

### 2026-06-29
- **Process correction (evt-0002):** discovered PLAN.md's Active Context was a stale status mirror — it said "Resume here → #7" while the board correctly showed all of Slice 1b Done-and-merged. Nearly rebuilt ~6,300 lines of merged work off the stale doc. Ratified + broadcast the `plan-vs-board` convention (board is the SoT for status; PLAN.md = durable context only). Slimmed this PLAN.md; archived this log.
