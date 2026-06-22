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
- **Resolution (2026-06-22):** The root cause is structural — prefix allowlists *cannot* span compound commands (`|`/`;`/`&&`/`$()`); confirmed in the Claude Code docs. Researched best practices: Anthropic's purpose-built answer is **auto mode** (a classifier that decomposes compound commands and judges each segment by intent, not prefix-matching). Adopted `permissions.defaultMode: "auto"` — scoped **per-project** to this repo + `delivery-simulator` (committed `.claude/settings.json`), **not global**, to minimize the surface where prompts are relaxed. Deliberately rejected: the **sandbox** (breaks Docker + `gh` under macOS Seatbelt — trades prompt-friction for breakage), and **brittle force-push/`rm` deny rules** (would either over-block legit feature-branch force-push / temp cleanup, or give false confidence — the classifier distinguishes protected-vs-feature branches better). Accepted tradeoff: auto mode has ~17% classifier false-negative (it reduces prompts, it is not a safety guarantee); the global catastrophic deny rules + the classifier's block-and-retry recovery are the backstop. Needs a one-time in-app auto-mode opt-in to activate.
