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
