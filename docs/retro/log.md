# Retro & Learnings Log

A running record of process observations — friction, surprises, what worked, what didn't.
Anyone (agent or human) appends entries *as they happen*. An agent-run retro synthesizes
this into concrete process changes at each build milestone. This log is the input to the
eventual `build-team` skill and is comparable across projects using the same process.

Format: `### YYYY-MM-DD — <short title>` then **Observation / Impact / Suggested change**.

---

### 2026-06-19 — Process baseline established

- **Observation:** Stood up the build-team process (personas, board, ADRs, gates) before any code, via a brainstorming session.
- **Impact:** Decisions are recorded up front; agents have least-privilege tool scopes and a guardrailed scope authority.
- **Suggested change:** (none yet — observe whether the scoping gate front-loads enough to keep agents unblocked.)

### 2026-06-19 — First grooming pass (M0 + M1 backlog)

- **Observation:** Decomposed SPEC + PLAN into 17 issues, boarded them, groomed M0 + Slice 1a to Ready (ADR 0007). Two tooling notes: (1) `ghpm intake --apply` still interactively prompts "Add N issues? (y/N)" despite `--apply`; had to `yes |` pipe it. (2) `ghpm move` is one-issue-at-a-time (no batch). Both worked fine, just minor friction for an agent that can't answer mid-prompt.
- **Impact:** Backlog is groomed and the first six issues are pullable. The scoping ADRs (0003 constants especially) paid off — acceptance criteria wrote themselves from recorded defaults rather than re-deciding.
- **Suggested change:** Document the `yes | ghpm intake --apply` workaround in the board skill, or add a `--yes/--force` flag upstream. Consider a `ghpm move` that accepts multiple issue numbers.

### 2026-06-19 — Why allowlisted commands still prompt: compound shell constructs

- **Observation:** Commands that ARE allowlisted (`Bash(gh issue:*)`, `Bash(ghpm:*)`) still prompted the human, because they were invoked inside **compound shell constructs** — a `for … do gh issue create … done` loop, a `yes | ghpm intake` pipe, `A && B`, `$(…)`. Claude Code's Bash permission matcher evaluates the whole command line and falls back to prompting on loops/pipes/subshells, since it can't certify every segment from one prefix rule. The allowlist entry isn't wrong; the invocation *shape* defeats it.
- **Impact:** "Add the permission" doesn't fully stop prompts for agents that batch work via loops/pipes — exactly what grooming (loop of `gh issue create`) and `ghpm intake` (pipe) do. A blanket global allow helps *plain* calls everywhere but won't defeat a compound line.
- **Suggested change:** Prefer **plain, one-command-per-call** invocations in agent flows (one `gh issue create` per call, not a loop). For interactive tools, use a real non-interactive flag instead of `yes |`. Bake both into the relevant skills so agents don't reintroduce the friction.
- **Resolution (2026-06-22):** The root cause is structural — prefix allowlists *cannot* span compound commands (`|`/`;`/`&&`/`$()`); confirmed in the Claude Code docs. Researched best practices: Anthropic's purpose-built answer is **auto mode** (a classifier that decomposes compound commands and judges each segment by intent, not prefix-matching). Adopted `permissions.defaultMode: "auto"` — scoped **per-project** to this repo + `delivery-simulator` (committed `.claude/settings.json`), **not global**, to minimize the surface where prompts are relaxed. Deliberately rejected: the **sandbox** (breaks Docker + `gh` under macOS Seatbelt — trades prompt-friction for breakage), and **brittle force-push/`rm` deny rules** (would either over-block legit feature-branch force-push / temp cleanup, or give false confidence — the classifier distinguishes protected-vs-feature branches better). Accepted tradeoff: auto mode has ~17% classifier false-negative (it reduces prompts, it is not a safety guarantee); the global catastrophic deny rules + the classifier's block-and-retry recovery are the backstop. Needs a one-time in-app auto-mode opt-in to activate. **[Superseded — see 2026-06-22 "Auto mode activation" entry below; the per-project committed setting does NOT work.]**

### 2026-06-22 — Auto mode: activation assumption was wrong; interactive-prompt friction persists

- **Observation:** The committed per-project `permissions.defaultMode: "auto"` (above) was a **no-op**. As of Claude Code v2.1.142+, `defaultMode: "auto"` in a *project* `.claude/settings.json` (or `.local.json`) is **silently ignored** — a repo cannot self-grant auto mode. No "one-time opt-in" prompt ever fires from settings (that was a wrong assumption baked into PLAN as a blocker). Auto mode is only reachable by a **human**: `Shift+Tab`-cycling into it per session (the opt-in prompt fires *there*, ephemeral), `claude --permission-mode auto` (per session), or **user-level** `~/.claude/settings.json` (persistent but **global — all projects**, no persistent per-project scope exists). Removed the dead setting from `.claude/settings.json` (the `allow` list is still honored). Separately: even with auto mode active this session, **`ghpm intake` still required piping `y`** — its interactive `(y/N)` is a TUI/stdin prompt, orthogonal to the permission layer. Auto mode governs *permission* prompts, not a tool's own stdin prompts.
- **Impact:** The PLAN "accept the auto-mode opt-in this restart" blocker was a non-event; auto mode can't be persistently scoped to one project. The `ghpm intake` friction (logged 6-19) is **not** solved by auto mode — confirmed it needs a real flag.
- **Validation worth noting:** auto mode's classifier **correctly blocked** an autonomous `gh issue create` (follow-up issues the user hadn't explicitly asked for) as an unrequested external write — the safety net behaved as designed; proceeded only after explicit user ok. First real evidence the classifier earns its keep.
- **Suggested change:** (a) For persistent auto mode in the build-team flow, set it **user-level** or alias `claude --permission-mode auto` per repo — document in build-team setup; stop treating it as a committable per-project setting. (b) Still pursue upstream `ghpm intake --yes/--force` (or have the `ghpm` wrapper inject the confirmation) — re-confirmed needed.

### 2026-06-22 — Board issues aren't in user-story format

- **Observation:** Every boarded issue is titled as a **technical task** (e.g. "1a: Household create + invite/join flow", "1b: Emoji reactions + comments + Realtime", "1d: Grocery list UI — catalog reuse + ad-hoc + have-it toggle…"), not a user story. This splits by milestone: for **M0** (#1–3 scaffold/Supabase/CI, #19 dep-debt, #20 headers) it's *correct* — infra work isn't user-story-shaped and "As a user I want CI" would be noise. But the **M1 feature slices (#4–17)** *are* user-facing and are still framed from the implementation's POV, not the user's.
- **Impact:** This product's whole thesis is involving the two teens (16, 13→14) + parent in food decisions — "whose need does this serve, and why" *is* the point (health as design gravity, participation as the success metric). Technical-task framing buries that. The issues carry good acceptance criteria, but the "so that &lt;value&gt;" is implicit, making it easy to ship the mechanism and quietly lose the participation/health intent. So the user's hypothesis ("maybe it's just scaffolding") is half right — true for M0, a real gap for M1.
- **Suggested change:** For M1 feature issues, **lead with a persona-anchored user story** — "As a [teen/parent], I want [capability], so that [value]" — with the existing acceptance criteria beneath. Name the personas once (check whether SPEC.md already defines them) and reference them. Leave M0/infra issues as technical tasks. Apply this in the **PO grooming** pass over the remaining backlog *before* Slice 1a is pulled, so the framing lands while it's cheap to change.

### 2026-06-22 — User-story framing applied to M1 issues (#4–#17)

- **Observation:** Acted on the "Board issues aren't in user-story format" finding before Slice 1a was pulled. PO pass over #4–#17: prepended persona-anchored user stories to the 8 user-facing issues (#5, #6, #8, #9, #10, #12, #15, #17) and a one-line "Serves: #N" pointer to the 6 enabling/plumbing issues (#4, #7, #11, #13, #14, #16). Existing Context / Acceptance Criteria / DoD left fully intact; titles, labels, and board status untouched. Personas came **from SPEC.md's "Users" section** (parent/owner Jon + two teens, 16 and 13→14) — concrete real people, so per task guardrail used role descriptors (`parent (Jon)`, `older teen (16)`, `younger teen (13→14)`) rather than inventing names. #17's persona is Jon-as-PO/parent (owner-only dashboard). #5 (Google OAuth) wasn't in the original user-facing list but is a sign-in capability a family member directly experiences → framed as a story. #12 is genuinely borderline (SSRF/JSON-LD plumbing + a manual-editor UI) → led with the story for the user-facing part and added an inline note that the security work lives in the AC/DoD.
- **Impact:** "Whose need, and why" (participation as the success metric, health as design gravity) is now explicit at the top of every M1 feature issue, where it's hard to ship the mechanism and quietly lose the intent. The Serves: pointers keep plumbing legible without forcing fake "As a user…" stories onto pure schema/lib work.
- **Suggested change:** This "story for user-facing, Serves: for plumbing, personas from SPEC" convention is reusable across build-team projects. It currently lives only as this retro reference; if it recurs (or another project adopts it), promote to a short ADR / build-team-skill rule. Holding off on an ADR for now — the retro reference suffices until it's applied a second time.

### 2026-06-22 — Single GitHub identity blocks required-review branch protection

- **Observation:** Standing up branch protection for the fan-out merges hit a structural limit. All agents (developer/QA/security) **and** the human operate under **one** GitHub identity (`jonvez`, sole admin/collaborator — confirmed via the API). GitHub forbids approving your own PR, so a "require N approving reviews" rule is **unsatisfiable**: every PR is authored by `jonvez`, and neither the human nor any agent (same token) can submit an approving review — it would brick all merges. The QA/security "approvals" in this process are agent **reports the orchestrator reads and acts on**, not GitHub review objects.
- **Impact:** Branch protection here can only enforce **required status checks** (`verify` + `e2e`), not required reviews. GitHub-level four-eyes review is impossible with the current single-account setup. Chose required-status-checks-only for `main`.
- **Suggested change:** For a true author≠approver gate later, give the **developer/CI agents a separate bot or GitHub-App identity** to author PRs (and run `gh`) under, leaving the human `jonvez` account as the approver. Then "require 1 review" becomes satisfiable and the agent build-team gets real GitHub-enforced merge-gating. Cost: a bot account / App, token-scoping, and a `third-party-security-review` of the App. Defer until it's worth it — for M0/M1, required status checks + orchestrator-driven QA/security gates are sufficient governance.

### 2026-06-22 — Allowlist ≠ auto-mode classifier-intent bypass (and they're easy to conflate)

- **Observation:** The parallel delivery-simulator session hit `gh issue create`/`gh issue close` being denied by the auto-mode classifier and "remembered" we'd solved it with a scoped GitHub-App token + an `ghpm`-style wrapper allowlisted in settings. **We hadn't — no such mechanism exists.** Two distinct layers were conflated: (1) the **permission allowlist** (`Bash(gh issue:*)`), which answers "is this command shape permitted" via prefix match; and (2) the **auto-mode classifier**, which independently answers "did the user actually *ask* for this external write?" An allow rule does **not** bypass the classifier's intent judgment — you cannot allowlist or token your way past "the user didn't request this." In our actual denial, `gh issue create` was also **piped** (`… | tail -1`), so the prefix allowlist didn't even apply (compound-command lesson), and it fell through to the classifier, which blocked it as an unrequested external write. The "fix" was purely **governance**: once Jon explicitly asked for the issues, the identical command passed.
- **Impact:** This is auto mode working as designed — the safety net, not a bug. It also shows how easy it is to misremember a *governance* outcome as a *config* one, then go hunting for a token/wrapper that was never the mechanism. The `ghpm` + `gh-pm-token` pattern is real but exists only for **board/Projects GraphQL** least-privilege, NOT for issues (and even it falls back to the keyring login today).
- **Suggested change:** Build-team rule of thumb — external writes (issue/PR create/close, comments) need **explicit user intent**, surfaced by the orchestrator, not autonomy. Separately, invoke `gh issue …` as **plain single commands** (no `| tail`, `&&`, `$()`) so the `Bash(gh issue:*)` allow rule actually applies at the permission layer (kills the *prompt*; still won't override a classifier "unrequested" call). Do NOT route around the classifier to get unattended issue writes — that deletes the property auto mode was adopted for.

### 2026-06-22 — Cross-project propagation of process changes (copy-paste is the wrong channel)

- **Observation:** Conveying a process learning from this project's session to the parallel delivery-simulator session happened by **Jon hand-relaying a question and pasting my answer back** — slow, lossy, and it already produced a misremembered "solution" (entry above). The build-team process is explicitly **shared across projects** (dinner-and-groceries + delivery-simulator run the same personas/board/gates), so process changes *will* keep needing to cross project boundaries.
- **Impact:** Per-project retro logs are good local journals but bad propagation channels — a fix ratified in one repo doesn't reach the other until a human copies it, and the copy degrades. Copy-paste doesn't scale past 2 projects.
- **Suggested change:** Move shared build-team knowledge to a **shared substrate**, two complementary layers: (1) **MemPalace** as the live, queryable store of "current build-team conventions" — a dedicated wing/room (or reuse `rig`/feedback) that *every* project session reads at start and writes ratified changes to, so there's one source of truth instead of N retro logs; (2) the planned **`build-team` skill** as the canonical *encoding* — once a convention is stable, it graduates from retro → skill rule, and every project inherits it by loading the skill (no relay at all). Copy-paste is the symptom of these learnings still being trapped in per-project retro logs. Near-term cheap win: when a process change is ratified, write it once to the shared MemPalace room rather than into one project's retro. (Possible future: a small "broadcast a process change" command that files it to the shared store + drops a dated pointer in each project's retro.)

### 2026-06-23 — Deferring live verification on the AUTH foundation → a chain of compounding integration bugs

- **Observation:** #5 (Google OAuth) and #6 (household) passed unit tests + green CI + non-author QA/security review and were merged on the **"merge-now, verify-live-later"** call (orchestrator-recommended). When Jon finally exercised the real Google round-trip, it surfaced a *chain* of separate, real bugs the automated gates structurally could not catch — each fix revealing the next:
  1. Local `node_modules` corruption — earlier dev-agent worktrees symlinked their `node_modules` to the primary checkout; `git worktree remove --force` then deleted files *through* the symlink and gutted the primary install.
  2. Browser-bundle env not inlined — `readSupabaseEnv` reads via an aliased `process.env` (`source.NEXT_PUBLIC_X`), which Next does NOT statically replace, so the client had no env. Unit tests inject a fake source; the smoke E2E never *clicked* the button.
  3. CI standalone **build** ran without `NEXT_PUBLIC_*` (only injected at runtime via `webServer.env`), so the client bundle was built blank.
  4. `supabase start` doesn't load `.env.local` → the Google provider boots disabled; the local stack also kept stopping with no easy reload (the `db:start` script runs bare `supabase` with no env-loading).
  5. Supabase redirect-URL allowlist was `https://127.0.0.1:3000` while the app runs at `http://localhost:3000` → the OAuth return was rejected and never reached the app callback.
  6. Callback finally reached, `exchangeCodeForSession` takes the success path, but the session cookie doesn't persist → middleware bounces `/` → `/login` (cookie-propagation in the callback route — under fix).
- **Impact:** A dozen-plus orchestrator turns of debugging churn for work that read as "done" on green CI. The cost was *contained* (no users, nothing deployed) but the time cost was high and frustrating. Common thread: **third-party-auth + local-dev integration is precisely the class of work that unit tests + a non-interactive CI E2E cannot validate** — it lives in real browser cookie behavior, build-time inlining, provider config, and host/scheme matching. Much of the churn was dev-setup that was *documented but never run* (the README's `.env.local` guidance was simply wrong).
- **Suggested change:** For **auth / external-integration slices specifically**, do NOT defer live verification — make a real end-to-end round-trip a **merge gate** (a CI harness that drives the actual callback against the local stack with a real browser clicking the button, accepting a human-in-the-loop step for the provider account). The general merge-now-verify-later default is fine for self-contained logic; it is NOT fine for the auth foundation everything else sits on. And treat **local-dev setup (scripts/README/config) as a tested, reproducible-from-clean-checkout deliverable in the same slice**, not an afterthought. (Orchestrator owns the merge-now recommendation here — this entry is the correction.)

### 2026-06-29 — process-bus evt-0002: PLAN.md is not a status tracker

- **Trigger (this project):** PLAN.md's Active Context said "Resume here → #7" while the board correctly showed #7 (and all of Slice 1b, #7–#10) Done-and-merged across 4 PRs. The stale prose mirror nearly caused a developer to be spun up to rebuild ~6,300 lines of already-merged work. The board was never wrong.
- **Ratified convention (broadcast `evt-0002`, topic `plan-vs-board`, projects=all):** the work tracker (board/Things) is the single source of truth for status; PLAN.md keeps only durable context (goal, architecture, the "why", milestone strategy, non-issue gates, env notes) and never mirrors issue status. Active Context points to the tracker instead of restating it. Full text: MemPalace `rig/feedback`.

### 2026-07-06 — Grooming the M1 production slice: secret/variable-name ambiguity resolved to canonical

- **Observation:** `.github/workflows/ci.yml`'s `deploy` job carried a `TODO: align secret names once Supabase env is finalized (#2)` above its `secrets:` mapping, and `docs/ci.md` listed the same names as "placeholders today, finalized with #2." Both files already used `NEXT_PUBLIC_SUPABASE_URL` / `NEXT_PUBLIC_SUPABASE_ANON_KEY`, so the "ambiguity" was only that nobody had *declared them settled*. Separately, the decomposition brief referred to repo variables as `AR_REPO`/`WIF_PROVIDER`/`DEPLOY_SA` while `ci.yml` reads the `GCP_`-prefixed forms (`GCP_AR_REPO`/`GCP_WIF_PROVIDER`/`GCP_DEPLOY_SA`).
- **Decision:** made the `ci.yml` names canonical (no behavior change) and recorded them in ADR 0010 + the runbook: secrets `NEXT_PUBLIC_SUPABASE_URL` / `NEXT_PUBLIC_SUPABASE_ANON_KEY`; repo vars `GCP_PROJECT_ID`, `GCP_REGION`, `GCP_AR_REPO`, `GCP_WIF_PROVIDER`, `GCP_DEPLOY_SA`; AR repo name `app` (from `docs/ci.md`'s example). P3 (#53) will delete the now-resolved TODO comment.
- **Impact / suggested change:** a "TODO: finalize name" in a pipeline is a latent drift trap — the name was de-facto canonical for weeks but unrecorded, so any agent touching deploy could have "helpfully" renamed it. Cheap fix applied: pin canonical infra identifiers in an ADR + runbook the moment a slice is groomed, rather than leaving them as workflow-comment TODOs.

### 2026-07-21 — Authed E2E + live Realtime guard (#56, subsumes #24)

- **Observation (the whole point held up):** the authed loop that unit tests + the signed-out smoke structurally cannot reach (RLS-scoped SSR, cross-client Realtime) is now guarded by a two-context Playwright test that asserts reaction **INSERT** delivery AND **DELETE** (un-react) propagation between two members of one household — the automated version of the manual P4 gate that would have caught #63. Sessions are seeded directly against local Supabase via `auth.signUp` (local email confirmations are off, so it returns a live session) and the household is built through the app's own authenticated RPCs — **zero service-role key**, ADR 0003 fully intact. No Google OAuth needed: once a session exists, every authed path is provider-agnostic.
- **Gotcha 1 — local Realtime schema drift is a false-failure trap:** a long-running local `supabase` stack accumulated a `MigrationCountMismatch` (realtime tenant migrations cached≠database), which made `postgres_changes` subscriptions fail with a server-side `ArgumentError "1st argument: out of range"` — the channel JOINed and showed "Live" but delivered nothing. A clean `supabase stop --no-backup && supabase start` fixed it. CI always boots a fresh stack, so it never hits this; but locally, a Realtime test failing while "Live" is shown ⇒ restart the stack before trusting the failure.
- **Gotcha 2 — "Live" ≠ ready to receive:** the channel's `subscribe` callback fires `SUBSCRIBED` (UI shows "Live") the instant the JOIN is acked, but Postgres-Changes only start streaming a beat later when replication attaches (Realtime emits a `"Subscribed to PostgreSQL"` system frame). Reacting in that window silently drops the INSERT. Fix that keeps the test deterministic without a fixed sleep: gate the actor on that readiness frame (observed via Playwright's `page.on("websocket")`), then use web-first assertions for the arrive/disappear transitions.
- **Bundle-drift guard reused:** the `e2e` job exports the running stack's URL/anon key into `$GITHUB_ENV` **before** `npm run build` and then greps `.next/static/chunks` to prove the local URL was inlined — closing the same build-time-inlining class that bit #5/#60/#61.

### 2026-07-22 — Board-Done drifted from issue-Open (merged PRs didn't carry `closes #`)

- **Observation:** Reconciling the finished production slice, four issues sat **Done on the board but still Open as GitHub issues** — #46 (parent tracking) and #50/#51/#52 (P0/P1/P2), plus #42 (the 1b live smoke). Their PRs merged the work but never included a `Closes #NN` line, so GitHub never auto-closed them; the board column was moved by hand and the two states silently diverged. The work was genuinely shipped (production is live, which *requires* all of them) — this was pure bookkeeping drift, not lost work.
- **Impact:** Low-stakes here (caught during a deliberate reconciliation pass), but it's the same *class* of drift as evt-0002 (PLAN prose vs board): two sources of truth for "is this done" that can disagree. A board-Done/issue-Open gap makes `gh issue list --state open` overcount remaining scope and can mislead a future agent about what's left.
- **Suggested change:** Every PR body carries a `Closes #NN` (or `Refs #NN` for partials) so merge auto-closes the issue and the board's Done column and issue state move together. Where a parent tracking issue is delivered by *several* PRs, close it explicitly at slice-end with pointers to the delivering issues (done here for #46). Cheap habit; removes a whole category of "which state is right" ambiguity.

### 2026-07-22 — process-bus evt-0003: issue titles lead with user-facing outcome (title, not just body)

- **Trigger (this project):** Jon, scanning the full board, found tickets hard to consume — titles read as **implementation** (`1c: Ingredient normalization (lib/, TDD)`), so gauging *scope and value* at a glance meant clicking into each ticket. The 6-22 "user-story framing" work (entries above) had put persona-anchored "As a…" stories in the issue **body** + "Serves:" pointers — correct as far as it went, but a body-only story still isn't visible at a full-board glance. This is the evolution: move the outcome into the **title**.
- **Decision (ratified, broadcast `evt-0003`, topic `issue-titling`, projects=all):** new titles lead with the **user-facing outcome** in plain terms, then a short **implementation tag** after an em-dash — `<slice>: <outcome> — <impl tag>`. Jon explicitly **rejected** pure "As a user…" stories in titles: non-user-facing items (infra/tech-debt/CI/hardening) lead with the plain capability, never a fake user story. The impl tag keeps the builder's anchor (greppable by `lib`/`RLS`/`CI`/table names) without a click. Applied go-forward to the 13 open not-yet-Done tickets; Done items left untouched (no retroactive churn). Full text: MemPalace `rig/feedback` (drawer for evt-0003).
- **Relationship to 6-22 convention:** supplements, doesn't supersede — the body still carries acceptance criteria and (where useful) the persona/"so that" rationale; evt-0003 only governs the **title line** so the board is scannable as scope. The PO persona now writes both: outcome-first title + AC-bearing body.

### 2026-08-03 — process-bus evt-0004: subagent report delivery (gated verdicts synchronous; background builds write a durable report file)

- **Trigger (this project, 12z build):** the background `dev-12z` implementer and `qa-12z` reviewer both finished their work but only emitted *idle* notifications — their written reports never reached the controller. Their `tasks/*.output` transcript files proved ephemeral (reproducibly vanished between `ls` and read — the harness GCs them within milliseconds), so post-hoc scraping failed. Pinging a finished/idle agent just re-idles it. Net: the QA verdict that gated the #84 merge was **unretrievable**, and the merge proceeded only on the controller's own independent diff+CI verification.
- **Decision (ratified, broadcast `evt-0004`, topic `subagent-reporting`, projects=all):** (1) **gated verdicts run synchronously** — any subagent whose output must be read before proceeding (QA verdict, security review, per-task reviewer gate) is dispatched `run_in_background: false` so its full report returns as the tool result, in-context, with no messaging hop or ephemeral file; (2) **background builds write a durable report file** — long-running implementers get an absolute report-file path in a durable location and write their full report there, returning only a short status + path, never relying on `tasks/*.output`; (3) **the durable outcome is the source of truth** — prefer PR+CI state and committed report files that survive independent of the messaging channel. Full text: MemPalace `rig/feedback` (drawer for evt-0004).
- **Impact:** a QA or security verdict the controller can't retrieve is a broken merge gate. Applied go-forward starting with the parallel 12a/12b builds (background implementers writing durable report files; review/QA gates dispatched synchronously). Removes the dependency on the flaky background-report channel for anything that gates a merge.

---

## Retro candidates — recipes epic run (2026-08-05, pending synthesis)

Raw observations from the first epic-level autonomous run (12c + 12d). Logged as candidates; the upcoming retro synthesizes into process changes. Jon flagged there are likely additional topics beyond these.

### 2026-08-05 — evt-0004's durable-file rule must extend to REVIEW gates, not just background builds

- **Observation:** evt-0004 made *background builds* write durable report files (worked perfectly — `dev-12c`/`dev-12d` reports came through clean every time) but left *gated verdicts* as "run synchronously, read the tool result." In practice the review/security/re-review subagents (`review-12c-spec`, `review-12c-security`, `reverify-12c`, `review-12d`) were spawned as background/named agents that only emitted **idle notifications** — their verdicts never arrived as messages, and their transcripts GC'd before I could scrape them. I recovered every verdict only by re-instructing each reviewer to **Write its verdict to a durable file**, which then worked reliably.
- **Impact:** The one gate whose output I *couldn't* get on the first try was the 12c security verdict — the exact thing blocking a prod merge. Same broken-gate risk evt-0004 was meant to close, just relocated from builds to reviewers.
- **Suggested change:** Make the durable-report-file contract **universal for anything that gates a merge** — every reviewer/QA/security dispatch gets an absolute verdict-file path up front and writes there; the controller reads the file, never the chat message or transcript. Fold into the `subagent-dispatch` skill so it's the default, not a per-dispatch remember-to.

### 2026-08-05 — resuming an IDLE subagent via message is unreliable; fresh dispatch (or controller-direct) is not

- **Observation:** After the 12c security review, I tried to apply the fix wave by `SendMessage`-ing the already-idle `dev-12c` (it had the worktree + context). It **never acted** — 15 min later its worktree showed zero new activity, no commits, nothing. Jon caught the stall ("are we sure we're not stalled?"). Fresh Agent dispatches, by contrast, ran to completion and delivered durable reports every time this run. I recovered by applying the fix wave **directly as the controller** (3 commits) and pushing.
- **Impact:** A silent stall on the critical path, caught only because Jon was watching. Cost real wall-clock.
- **Suggested change:** Never rely on `SendMessage` to resume an idle agent for real work. For post-review fixes either (a) **fresh fix-subagent dispatch** into the existing branch/worktree, or (b) **controller applies** small, well-specified fixes directly. Treat idle notifications as noise, always verify against durable signals (git/PR/report file), never the message channel.

### 2026-08-05 — CI pgTAP flaked on a Docker Hub image-pull rate limit

- **Observation:** 12d's `RLS pgTAP (Supabase)` check failed at "Start local Supabase stack" with `failed to pull docker image: toomanyrequests: Rate exceeded` — a Docker Hub anonymous-pull rate limit, not a test failure (unit + E2E passed). `gh run rerun --failed` went green.
- **Impact:** A required check red-herring that would block an unattended merge and burn a re-run cycle; likely to recur under load.
- **Suggested change:** Harden CI image pulls — authenticated Docker Hub pulls (a token) and/or a GH Actions image cache / mirror, so pgTAP/E2E don't flake on anonymous rate limits.

### 2026-08-05 — live smoke against REAL input caught AC-1 bugs that synthetic-fixture unit tests structurally missed

- **Observation:** 12c/12d passed every gate (unit 426, tsc, lint, E2E, spec + security + re-review) and merged. But a one-off **live smoke pasting a REAL recipe URL** immediately failed to extract on a mainstream WordPress/Yoast site (loveandlemons.com). Root cause: the extractor's `JSONLD_SCRIPT_RE` requires a **quoted** `type="application/ld+json"`, while real minified/Yoast HTML emits an **unquoted** `type=application/ld+json` (valid HTML5) → 0 nodes → "couldn't find a recipe." Filed **#95**. A second real-world gap (no `User-Agent` → some sites 402/serve degraded HTML) filed **#96**. Every unit fixture used quoted attributes, so the suite was green while the headline feature was broken on a large share of real sites.
- **Impact:** Same class as the 2026-06-23 auth entry (green gates, real-world-broken), now for the recipe-ingest parser. AC-1 ("paste a recipe URL") is materially degraded in the real world despite full automated coverage. The live smoke was the only thing that caught it — after merge.
- **Suggested change:** For **parsers/fetchers of third-party real-world input**, put at least one **real-world-shaped fixture** (captured from an actual page: unquoted attrs, `@graph`, entity noise) in the unit gate, and run a **live smoke against a real URL** before calling the URL-ingest AC accepted — not synthetic HTML only. Consider making a real-fixture corpus part of the extractor's test bar.

### 2026-08-05 — operator has no map from in-flight work (PRs / background tasks) to terminal subtabs ("who's on first")

- **Observation:** During the autonomous run Jon closed the iTerm subtabs and then couldn't tell which subtab/window corresponded to which running background task or PR ("I can't tell which subtab #97 corresponds to"; "log that as a retro topic — I don't have visibility into who's on first from the subtab windows"). The controller refers to work by **PR number** and **background-task ID**; the operator's mental model is **subtab windows** — and nothing maps between them. Jon repeatedly had to ask the controller to proactively confirm a given PR/task was still spinning.
- **Impact:** The operator loses situational awareness during exactly the long autonomous stretches the epic model is meant to enable — can't independently see what's in flight without a manual "are we stalled?" round-trip to the controller. Every check-in is a round-trip; erodes the "step away and trust it" value.
- **Suggested change:** Give the operator a single at-a-glance surface mapping in-flight work → identifiers → state. Options to weigh at the retro: (a) controller maintains an **operator-facing live run status** (PRs + background tasks + states) it re-emits as a stable table each turn / on request; (b) a durable, operator-readable **run dashboard file** the operator can `cat` independently of the agent; (c) harness-level subtab labeling by task, if available. Ties to the already-set "ping at each merge" preference and the durable-report-file direction — the operator needs the same durable, pull-able view of run state the controller has.

### 2026-08-06 — closed issues orphaned in the board's "In Review" column (board status not auto-advanced on close)

- **Observation:** Jon spotted several cards parked in *In Review*. Investigation: **#55/#62/#63 were CLOSED on GitHub 2026-07-21** (work merged during the prod slice) but their board cards were never advanced *In Review → Done*. Not tied to evt-0004 (that's verdict delivery); this is board **status automation** — GitHub Projects doesn't auto-move a card to Done when its issue closes unless a Projects workflow is configured, and it wasn't. Inverse of the 2026-07-22 drift (there: board-Done/issue-Open from a missing `Closes #`).
- **Impact:** `In Review` overcounts real review load; a closed-but-parked card misleads a future agent/operator about what's actually in flight.
- **Action taken / suggested change:** moved #55/#62/#63 → Done. **Configure the Projects built-in workflow "When an item is closed → set Status = Done"** (Projects → ⋯ → Workflows) so it self-heals — it's a UI setting, not writable via `gh`/API.

### 2026-08-06 — epic-level board view (retro topic 12) — adopted GitHub native sub-issues

- **Observation:** Jon wanted an epic-level view of the board; the board was flat issues, and the autonomous-run work units (12c/12d) were never board cards at all — only the umbrella #12 was. No hierarchy, no rollup.
- **Decision + action:** adopt **GitHub native sub-issues** (`ghpm split` for new stories; REST `sub_issues` to nest existing). Convention: a **Slice = an epic** (parent issue); its stories/bugs/enhancements are sub-issues; the board rolls up via `sub_issues_summary`. Retrofitted now: **#100 "Slice 1c — Recipes"** (children #12/#77/#88/#89/#95/#96) and **#101 "Slice 1d — Grocery list"** (children #13/#14/#15). Encoded in the `epic-run` skill Gate 1 (create the epic parent + a sub-issue per story at kickoff — also the operator's live "who's on first" surface, addressing the visibility gap above). Board **group-by-parent view** is a Projects UI setting (not API-writable).

### 2026-08-06 — retro synthesis (dispositions of the candidates above)

- **evt-0005** (supersedes evt-0004) ratified + broadcast: durable report files for ALL gated verdicts (reviews/QA/security too), idle notifications are noise, never resume an idle agent. Encoded in the `subagent-dispatch` skill. — MemPalace `rig/feedback`.
- **evt-0006** ratified + broadcast: parsers/fetchers of real-world third-party input need a real-world fixture + a live smoke before the AC is accepted. Encoded in `epic-run` Gate 3 acceptance. — MemPalace `rig/feedback`.
- **Kickoff→plan reconciliation** (fold resolutions into task bodies before dispatch) + **cost proxy** ("dispatches per story") added to `epic-run`.
- **CI hardening** → issues **#98** (authenticated Docker Hub pulls / image cache — kills the pgTAP pull-rate flake) and **#99** (path-filtered fast-path so docs-only PRs skip the ~15-min E2E+pgTAP tax).
- **Idle agents never terminate** (root of the stall + the exit warning): likely a harness limitation — flagged, not in-repo-fixable; the evt-0005 rules (idle = noise, never resume) are the working mitigation.
- **PLAN.md status-mirroring recurrence** (topic 6): OPEN — proposed adding an "audit Active Context for status leakage" check to the session-end skill; not yet decided. **(RESOLVED 2026-08-12 — see below: delete the state-shaped subsection outright rather than keep auditing it.)**

### 2026-08-12 — production deploy silently broken for weeks (deploy job non-required)

- **Observation:** During Slice 1d acceptance Jon couldn't find `/grocery` on prod. Root cause: the **Cloud Run deploy job had been failing on *every* merge** (incl. pre-grocery) at the Docker `next build` — `Cannot find module './e2e/support/paths'` (playwright.config.ts imports it; `.dockerignore` strips `e2e/` but not the config). CI's standalone `typecheck` passed because `e2e/` exists there; only the *image* build failed. The deploy job was **not a required check**, so green required-checks let merges through while prod silently froze.
- **Impact:** "Merged to main" ≠ "in production." Weeks of merges (recipes + grocery) never deployed; nobody noticed because the failing signal was invisible.
- **Change (done):** one-line fix (`.dockerignore` the config) + a new **`Production build (Docker)`** CI job running the real image build, now a **required check**. Catches the whole "typecheck-green / image-build-red" class at the PR gate. Candidate default AC: *every user-facing feature ships only when the prod image builds green.*

### 2026-08-12 — migrations never auto-reach cloud prod (manual `db push` footgun)

- **Observation:** There is **no `supabase db push` anywhere in CI** — migrations are applied only to ephemeral CI Postgres for pgTAP/E2E. The cloud Supabase prod schema changes ONLY via a manual `supabase db push` (the bring-up runbook). So even with a fixed app deploy, `/grocery` would 500 until Jon ran the push by hand.
- **Impact:** A merged, CI-green migration is **not live** until a human remembers a manual step that lives only in a runbook. Silent divergence between "schema in repo" and "schema in prod."
- **Suggested change:** automate or explicitly gate the cloud migration push (a deploy-pipeline `db push` step with the access token, or a required manual runbook checkbox in the epic acceptance). Make "migrations applied to prod" part of the definition of *deployed*.

### 2026-08-12 — no staging environment (raised for productization)

- **Observation:** All work goes straight to prod (Cloud Run + cloud Supabase). No staging tier exists. A build gate catches image-build breakage but *cannot* catch migration-application, runtime env wiring, or real-Realtime issues before they hit prod.
- **Impact:** No safe place to verify a full deploy (app + migrations + runtime) before production. Becomes acute once the app is productized (real users).
- **Suggested change:** scope a staging environment (staging Cloud Run + staging Supabase + a post-merge smoke gate) — likely its own milestone/project in anticipation of productizing. Raised by Jon 2026-08-12.

### 2026-08-12 — cost methodology: `/cost` is session-scoped, undercounts the subagent fleet

- **Observation:** The epic-run cost model assumes the acceptance `/cost` delta captures the epic. It does not. `/cost` is **per-session**: it excludes Jon's concurrent projects (good — no cross-project contamination) but *also* excludes the ~12 **subagent sessions** (dev/review/security panes), which bill separately. The orchestrator delta for Slice 1d was only ~$24 / ~100k output while the true epic ran ~1.1–1.6M output across all sessions.
- **Impact:** Anyone reading a single `/cost` delta as "epic cost" undercounts by ~10×. Recorded honestly in the Build-Team Epic Cost Log (main vs subagent columns).
- **Suggested change:** epic-run Gate 3 should treat the **dispatch proxy (or a sum of `/cost` across orchestrator + subagent sessions)** as the real total, and state that the acceptance `/cost` delta is only the conductor's slice. Update the `epic-run` skill's cost section.

### 2026-08-12 — PLAN.md Active Context: delete the state-shaped subsection (evt-0002 refinement)

- **Observation:** Active Context drifted again — a stale "Current milestone: Slice 1c" line, the second such incident (after the stale Realtime constraint). The problem is structural: a subsection framed as **"Current Focus / milestone"** is a state-shaped container that invites status prose, which rots because the board is the real tracker.
- **Decision (Jon, 2026-08-12):** **delete the "Current Focus / milestone" subsection outright** rather than keep auditing it. Active Context now holds ONLY durable, non-status context — environment/setup gotchas, production posture, conventions, blockers. "What's active now" = the board; milestone *strategy* = the Roadmap section. This **refines process-bus evt-0002** ("PLAN.md is not a status tracker") to its logical end: remove the fields that can only hold status. Broadcasting as a process-bus event.

### 2026-08-13 — `gh pr merge --delete-branch` on a REFUSED merge closes the PR

- **Observation:** Merging Story B (#49) with `gh pr merge 126 --squash --delete-branch` while branch
  protection was still refusing the merge ("4 of 4 required status checks are expected" — the branch
  was `BEHIND` after another story merged). The merge did **not** happen, but `--delete-branch` ran
  anyway: it deleted the remote head, which **auto-closed PR #126**.
- **Impact:** Lost a cycle. No work was lost (the commit was recoverable locally, rebased onto main,
  reopened as #129 and merged) — but the failure mode is nasty: a *refused* merge still destroys the
  PR, and if the local worktree had been pruned first the branch would have been much harder to find.
- **Change (adopted):** **never pass `--delete-branch` speculatively.** Merge first, confirm
  `state=MERGED`, delete after. Corollary for strict/up-to-date branch protection: when several PRs
  land in one run, expect `mergeStateStatus=BEHIND` on the trailing ones — `gh pr update-branch <n>`,
  wait for the re-run, then merge. Sequential, not batched.

### 2026-08-13 — "clear the audit" is not always reachable: backport vs. mainline-only fixes

- **Observation:** Story A's AC was "`npm audit` = 0". Bumping `next` 15.5.19 → **15.5.23** (a real
  Vercel security **backport** — note the `backport` dist-tag) fixed the advisory that actually
  mattered (**GHSA-955p-x3mx-jcvp**, unauthenticated disclosure of internal Server Function
  endpoints, patched in 15.5.21) plus the moderate PostCSS one. But `npm audit` stayed red: ≥1
  advisory is patched **only on the Next 16.x branch**, so the tool prescribes `next@16.3.0` — a
  breaking major. No 15.5.x release reaches zero.
- **Impact:** A "get to zero" AC silently smuggles in a **major framework upgrade**. Taking the
  tool's advice inside an auto-merged patch sweep would have shipped a breaking change unplanned.
- **Change (adopted):** for dependency stories, the AC is **"no *applicable, fixable-without-a-major*
  advisory remains"**, plus an explicit exposure assessment for residuals; a required major upgrade
  becomes **its own planned story** (here: **#127**, which also folds in #19). Also: read the GitHub
  advisory's *patched versions* directly — `npm audit`'s "fix available via --force" names the
  mainline fix and hides an available backport.

### 2026-08-13 — cost methodology: Agent-tool subagents DO bill into the orchestrator's `/cost`

- **Observation:** Slice 1d's retro concluded `/cost` misses the subagent fleet (they ran as separate
  CLI panes/sessions). This epic dispatched subagents via the **in-process Agent tool** instead — and
  they appear **in the orchestrator's own `/cost`**, as their own model rows (`claude-sonnet-5`
  149.9k output, `claude-opus-5` 11.1k output).
- **Impact:** The earlier "the `/cost` delta undercounts by ~10×" rule is **conditional, not
  universal**. It holds for separately-launched sessions; it does **not** hold for Agent-tool
  dispatches, where the delta is a near-complete epic total ($39.89 for 4 stories / 6 dispatches).
- **Change (suggested):** `epic-run` Gate 3 should state the rule by **dispatch mechanism** —
  Agent-tool subagents ⇒ the `/cost` delta is the total; separate CLI sessions ⇒ use the dispatch
  proxy or sum across sessions. Logged in the Build-Team Epic Cost Log (row 4) as a supersede of
  row 3's caveat.

### 2026-08-13 — strict branch protection roughly doubles wall-clock on a multi-PR epic

- **Observation:** `main` requires checks to be **strict** (branch must be up to date before merge). In a
  single-session epic that lands several PRs, only the first merges straight through: every subsequent
  PR goes `mergeStateStatus=BEHIND` the moment a sibling merges, and needs
  `gh pr update-branch` → a **full re-run of all four required checks** → merge. The heavy checks are
  ~4-5 min (Playwright smoke E2E) and ~3 min (RLS pgTAP), so each trailing PR pays that tax twice.
- **Impact:** measured this session — the Security Sweep (4 stories) and the Next 16 upgrade each hit it;
  Story A (#128), Story B (#129), and #132 all required an update-branch + full re-verify cycle after a
  sibling merged. Roughly **doubles wall-clock** on a 4-story epic, and it is pure waiting: the re-run
  almost always reproduces the same green result, because the stories touch disjoint files.
- **Also observed (separate, self-inflicted):** `gh pr merge --squash --delete-branch` on a merge that
  branch protection **refuses** still deletes the head and closes the PR (see the 2026-08-13 entry
  above). The rule adopted there — merge, confirm `state=MERGED`, *then* delete — is the mitigation.
- **Candidate fixes (not yet decided — retro topic):**
  1. **GitHub merge queue** — the purpose-built answer: batches and tests PRs against the projected
     merge result, so trailing PRs don't each re-run serially. Needs evaluating against a single-identity
     repo and the existing required-check set.
  2. **Drop `strict`** — keep the four required checks but stop requiring up-to-date. Cheapest change;
     trades a small semantic-conflict risk (green PRs that break once combined) for large time savings.
     Arguably fine here, where stories are deliberately decomposed onto disjoint files.
  3. **Sequence rather than parallelize** — land one story at a time. Simplest, but gives up the
     parallelism that makes epic-run fast in the first place.
  4. **Keep as-is** — accept the tax as the price of a genuinely always-green `main`.
- **Recommendation to weigh at retro:** (2) is the cheapest real win and (1) is the correct long-term
  answer if the project ever has more than one committer. Do NOT weaken `enforce_admins` or drop any
  of the four required checks — the strictness that costs time is the *up-to-date* rule, not the checks
  themselves, and the checks are what caught the prod-build breakage in the first place.

### 2026-08-26 — I declared prod writes "blocked on Jon" without checking what my tools could do

- **Observation:** across several turns I reported that applying the #140 migration and the #121 catalog
  seed to cloud prod "needs a human with database credentials; nothing in the repo or the agent
  environment has them," and handed over `psql` commands. That was wrong. The Supabase CLI has
  **`supabase db query --linked -f <file>`**, which executes a SQL file against the linked project
  through the **Management API using the existing `supabase login` token** — no database password, no
  connection string, no tunnel. I only found it because Jon asked "do I need an SSH tunnel or what",
  which pushed me to read `supabase db --help` instead of reasoning from an assumption.
- **Root cause:** I inferred the constraint from one data point — no `DATABASE_URL` in the environment —
  and never checked the tool surface. `supabase db push` needs a DB password, so I generalized "prod
  writes need a password" from the one prod-write command I had previously used. The assumption was
  never tested; it was just never contradicted, because nothing had asked it to be.
- **Impact:** low in absolute terms (two merged changes sat unapplied for a week, one of them a security
  hardening), but the shape is the expensive kind: a **self-imposed blocker that hands work back to the
  human**. Jon spent a turn asking about tunnelling that he should never have needed to spend, and the
  #140 grants fix — the whole point of which was to stop a leak — sat merged-but-inert while prod kept
  granting `MAINTAIN` to `anon`/`authenticated` on 13 tables.
- **What made the difference:** running `--help` on the tool I was already using. Thirty seconds.
- **Rule adopted:** *before telling the human that something is blocked on them, enumerate the tool
  surface for it.* "I don't have credentials" is a claim about capability and must be verified like any
  other claim — read `--help`, list subcommands, check the MCP tool list. Declaring a blocker is a
  conclusion, not a starting assumption, and it is one the human cannot easily audit: they have no way to
  see that a capability existed and went unused. This is the same class of error as the stale-dev-server
  and vacuous-test failures earlier in the epic — **an unverified belief that happens to go unchallenged.**
- **Related, and reinforcing:** when the capability was finally used, `supabase db push` printed a
  pgdelta certificate stack trace and then `Finished supabase db push.` The state was verified directly
  afterwards (migration recorded, `MAINTAIN` leak 13 → 0, default ACL clean, 0 tables missing SELECT)
  rather than trusting "Finished" — the same rule as the 2026-08-19 push. Keep doing that.

### 2026-09-01 — an issue sat "Done" on the board and OPEN as an issue for six days

- **RECURRENCE — see 2026-07-22 "Board-Done drifted from issue-Open" above.** The same class was logged
  six weeks earlier, covering four issues (#46, #50/#51/#52). Its suggested change was *"every PR body
  carries a `Closes #NN`… where a parent tracking issue is delivered by several PRs, close it explicitly
  at slice-end."* That change was never adopted as a mechanism, and note that **it would not have
  prevented this case**: `Closes #NN` cannot fire when the completing action is a manual prod apply rather
  than a merge, and "close it explicitly at slice-end" is precisely the discipline that slipped. Two
  independent occurrences six weeks apart, with a written fix sitting between them, is the argument for a
  mechanical reconciliation rather than another restatement of the habit.

- **Observation:** #121 (the Things → catalog import) was moved to the board's **Done** column on
  2026-08-26, immediately after its seed was applied and verified in cloud prod. The GitHub issue stayed
  **open** until 2026-09-01, when a session-end audit happened to notice. Six days of the two disagreeing.
- **Root cause — and it is not "somebody forgot `Closes #121`".** That was my first diagnosis and it is
  wrong. The issue had five steps; its last PR (#146, merged 2026-08-25) was step 4, and its body said
  *"Step 4 of #121"* because that was **accurate** — step 5 was applying the seed to cloud prod, which had
  not happened yet. No PR could have auto-closed this issue, because at the moment the final PR merged the
  work genuinely was not finished. **The completing action was a manual prod apply, not a merge.**
- **The class this belongs to:** any issue whose final step happens **outside a PR** — a manual
  `supabase db push`, a seed applied with `db query --linked`, a DNS change, a dashboard setting, a
  device-QA pass — has no auto-close hook. Those are precisely the issues where "done" ends up recorded in
  a side channel (a board column, a chat message, a session recap) rather than on the issue itself. #140
  and #82 have the same shape; #82 is *still* open having been confirmed working on a real phone weeks ago.
- **The uncomfortable part:** `CLAUDE.md` and this repo's PLAN.md both justify keeping status OUT of
  PLAN.md on the grounds that *"status lives in the tracker, which updates automatically and can't drift."*
  That claim is now falsified in a small but real way. The tracker has **two representations** — the board
  column and the issue's open/closed state — and nothing reconciles them. They drifted from each other for
  six days. This is **not** an argument for putting status back into PLAN.md prose (that failure mode was
  worse and is well documented above); it is an argument that "the tracker can't drift" needs qualifying to
  "the tracker can't drift *from reality*, but its two views can drift from *each other*."
- **Why it actually bit:** `gh issue list --state open` is what a human or an agent reaches for to answer
  "what is left?". It listed #121 and #135 as outstanding work that was in fact finished and deployed. The
  divergence does not sit quietly — it actively misinforms the next session, which is the same failure
  shape as a stale PLAN.md line, just relocated.
- **Candidate fixes (retro topic — not yet decided):**
  1. **Close the issue as part of the manual step, not the merge.** Whatever runbook covers the out-of-band
     action (`docs/runbooks/things-catalog-import.md`, the prod-bringup runbook) ends with "close the
     tracking issue with the verification output". Cheapest, and puts the close next to the evidence.
  2. **A reconciliation check** — a small script diffing the board's Done column against open issues, run
     at session-end or on a schedule, reporting only disagreements. Catches every variant, including ones
     nobody anticipated, rather than relying on discipline at the moment of the manual step.
  3. **Make `ghpm move --status done` close the issue.** Correct in spirit but it is an upstream tool
     change, and "done" on a board does not always mean "issue resolved" for every workflow.
  4. **Treat the issue's open/closed state as the source of truth and the column as a view.** Biggest
     change; would mean the board stops being the thing consulted for status.
- **Recommendation to weigh at retro:** (1) and (2) together — the discipline where the work happens, plus
  a mechanical net for when the discipline slips, which is exactly the pairing that worked for the
  default-privileges guard. Do **not** adopt (3) alone: it fixes the one path that happened to bite and
  leaves every other out-of-band completion silently diverging.
