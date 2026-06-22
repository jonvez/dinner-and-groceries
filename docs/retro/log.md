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

### 2026-06-22 — Single GitHub identity blocks required-review branch protection

- **Observation:** Standing up branch protection for the fan-out merges hit a structural limit. All agents (developer/QA/security) **and** the human operate under **one** GitHub identity (`jonvez`, sole admin/collaborator — confirmed via the API). GitHub forbids approving your own PR, so a "require N approving reviews" rule is **unsatisfiable**: every PR is authored by `jonvez`, and neither the human nor any agent (same token) can submit an approving review — it would brick all merges. The QA/security "approvals" in this process are agent **reports the orchestrator reads and acts on**, not GitHub review objects.
- **Impact:** Branch protection here can only enforce **required status checks** (`verify` + `e2e`), not required reviews. GitHub-level four-eyes review is impossible with the current single-account setup. Chose required-status-checks-only for `main`.
- **Suggested change:** For a true author≠approver gate later, give the **developer/CI agents a separate bot or GitHub-App identity** to author PRs (and run `gh`) under, leaving the human `jonvez` account as the approver. Then "require 1 review" becomes satisfiable and the agent build-team gets real GitHub-enforced merge-gating. Cost: a bot account / App, token-scoping, and a `third-party-security-review` of the App. Defer until it's worth it — for M0/M1, required status checks + orchestrator-driven QA/security gates are sufficient governance.
