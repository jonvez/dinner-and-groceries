# Dinner & Groceries — Build Team & Process

_Date: 2026-06-19_

How we build the product in `SPEC.md`: a small team of persona subagents, coordinated
through a persistent board, working as independently as the harness reliably allows.

## Decisions (locked)

| Decision | Choice |
|----------|--------|
| Framework | **Native** — custom subagents + superpowers skills + ADR log + board. BMAD-inspired, not BMAD. |
| Async tracking | **GitHub Projects** (Issues + Kanban). Agents read/write via `gh`; visible from any browser/phone. |
| Scope authority | **Product Owner agent decides within guardrails**; every call logged as an ADR for later review/override. |
| Parallelism | Up to **2 developer agents** in parallel, isolated via git worktrees. |
| Security | **Review gate**, not a standing persona: `security-review` skill at PR/merge run by a **non-author** agent; security baked into ADRs + Definition of Done. Formalize a dedicated Security Reviewer only if the surface grows. |
| Reuse | **Global persona agents now** (`~/.claude/agents/`). Extract a reusable `build-team` skill only **after** this project *and* the parallel project yield learnings — discover, then extract. |
| Learnings | Keep a **running retro log** during the build + an **agent-run retro** at the end. Feeds the eventual skill extraction and is shareable across both projects. |
| TDD | **Test-first discipline.** Strict test-first for domain/logic/server-action code; UI may take a thin exploratory spike but ships with tests. Enforced in the Definition of Done; uses the `test-driven-development` skill. |
| Analytics | **Events-table-only** (Supabase), no GA4/third-party. Pseudonymous `member_id`. Usage + participation events from day one; **simple PO-only dashboard** in MVP. Never a kid-facing scorecard. |
| Kickoff | A formal **Kickoff Gate**: nothing builds feature code until Jon explicitly says **"start"** (recorded as an ADR). Separates planning from execution. |

## Personas

Each persona is a custom subagent with its **own tool allowlist** (front-loaded), scoped to
least-privilege per role. Personas live **globally** in `~/.claude/agents/<name>.md` so the
parallel project can use the same team; project-specific tweaks (if any) can override locally
in `.claude/agents/`.

| Persona | Responsibility | Tool scope (allowlist) |
|---------|----------------|------------------------|
| **Product Owner** (the "PM") | Owns spec→backlog, writes issues w/ acceptance criteria, accepts/rejects work, **makes scope decisions within guardrails**, logs ADRs | Read, `gh` (issues/projects), write to `docs/` + `docs/decisions/` |
| **Architect** | System/data-model design, structural reviews, tech decisions, authors ADRs | Read, write to `docs/`, `gh` (comment) |
| **Product Designer** | UX flows, wireframes, component/visual direction (uses `frontend-design` skill) | Read, write to `docs/design/`, Playwright (visual check), `gh` (comment) |
| **Developer A / B** | Implement issues TDD, in isolated worktrees; open PRs linked to issues | Read, Write, Edit, Bash, test runners, `gh` (PR/issue), worktree |
| **QA Engineer** | Writes/extends tests, runs suites, verifies acceptance criteria, files bug issues | Read, write to test dirs, Bash (run tests), Playwright (E2E), `gh` (issues) |
| **Orchestrator** (scrum-master = main session) | Assigns board items, enforces the scoping gate, dispatches personas, records status | All (coordination layer) |

## Governance

### Scoping gate (front-loaded, before any code)

1. PO + Architect produce an **open-questions list** from `SPEC.md`.
2. Jon answers the **high-stakes** questions in a single batch.
3. PO is **empowered to decide the rest** within the guardrails below.
4. Every decision (Jon's or PO's) is written to the **ADR log**.

### Guardrails (bounds on PO autonomy)

The PO may decide freely **unless** a choice would:
- contradict `SPEC.md` or one of Jon's batch answers,
- change MVP scope (add/remove a feature), data model shape, or hosting/cost posture,
- introduce a new paid service or external dependency.

Anything hitting a guardrail escalates to Jon.

### Decision log (ADRs)

- One file per decision: `docs/decisions/NNNN-short-title.md` (context → decision → consequences → who decided).
- Reviewable and overridable by Jon at any time. This is the durable record of "why."

### Security gate

- Security is a **gate, not a teammate**. At PR/merge, the `security-review` skill runs over the
  pending changes, executed by an agent that is **not the author** (independent scrutiny).
- Security requirements live in the architect's ADRs and the Definition of Done: RLS tested,
  secrets in env (never in code), input validation on the URL fetcher / recipe ingestion.
- Escalate a dedicated **Security Reviewer** persona only if the surface grows (multi-household,
  marketplace, payments).

### Test-Driven Development

- **Strict test-first** for domain logic, data-access/server actions, and the riskiest code
  (ingredient parsing, roll-up/dedupe, RLS household-scoping, week-boundary math): write a
  failing test that encodes the acceptance criteria, watch it fail, implement, refactor.
- **UI** may take a thin exploratory spike before the test lands, but ships *with* tests.
- Developers use the `test-driven-development` skill. No implementation is "done" without
  tests written first and passing — verified by QA, not asserted.

### Definition of Done (per issue)

- Acceptance criteria met; **tests written first (TDD)** and passing; lint/typecheck clean;
  PR linked to the issue; QA verified; **`security-review` passed (non-author) for
  security-relevant changes**; PO accepted.

### Retro & learnings log

- A **running record** at `docs/retro/log.md`: anyone (agent or Jon) appends retro-worthy
  observations *as they happen* — friction, surprises, what the process got right/wrong.
- An **agent-run retro** after each build milestone synthesizes the log into concrete
  process changes.
- This log is the **input to the eventual `build-team` skill** and is comparable across this
  project and the parallel one.

## Kickoff Gate (the formal "start")

A project has a single, explicit moment that flips it from **planning** to **execution**.
No agent writes feature code before it.

**Pre-flight (all must be green):**
- [ ] Setup complete (repo, board, agents, settings, ADRs, retro log)
- [ ] Scoping gate closed (open questions resolved; decisions in ADRs)
- [ ] Jon's outstanding scope/process/logistics questions answered
- [ ] Session restarted so the real persona agents are dispatchable

**The ceremony:** Jon raises any final questions (scope, process, restarts, anything). When
satisfied, Jon says **"start."** That declaration is recorded as a kickoff ADR
(`docs/decisions/NNNN-kickoff.md`) and is the *only* trigger that lets the orchestrator begin
M0 / Slice 1a. Before "start," the team only plans, grooms, and designs — never implements features.

## Board (GitHub Projects)

Columns map to handoffs: **Backlog → Ready → In Progress → In Review → QA → Done.**
- **Operate the board with the `github-project-board` skill** (`gh pm list` / `move <#> --status <col>` / `intake`); per-project config in `.gh-pm.yml`. Don't hand-roll `gh`/GraphQL for board ops.
- PO grooms Backlog → Ready (issues with acceptance criteria).
- Devs pull from Ready → In Progress, open PRs → In Review.
- QA moves In Review → QA → Done (or back with a bug issue).
- Jon watches the board async; PRs and ADRs answer "why/what's the status."

## Front-loaded permissions

Two layers, both configured once up front:
1. **Per-agent tools** — in each `.claude/agents/<name>.md` frontmatter (table above).
2. **Project permission allowlist** — `.claude/settings.json` `permissions.allow` for the
   safe, high-frequency commands (`gh`, test runners, `git`, package manager) so agents don't
   stall on prompts mid-run. Destructive/outbound actions stay gated.

## Orchestration model (the honest version)

Subagents are **session-scoped workers, not daemons**; durable state is **git + the board**.
- **Primary loop:** orchestrated sessions — Jon kicks off, orchestrator dispatches personas
  through the board, work lands as commits/PRs/ADRs, Jon returns and resumes.
- **Parallel:** 2 dev agents concurrently via worktrees (no file collisions).
- **Optional autonomy:** a tightly-scoped `/schedule` routine (e.g., nightly "advance the top
  Ready item") if Jon wants between-session progress — added later, not at the start.

## Setup checklist (one-time, before build)

- [ ] GitHub repo created + pushed; GitHub Project board with the 6 columns
- [ ] `~/.claude/agents/*.md` (global) for the 6 personas with scoped tool allowlists
- [ ] `.claude/settings.json` permission allowlist (front-loaded)
- [ ] `docs/decisions/` ADR directory + `0001` recording these process decisions
- [ ] `docs/retro/log.md` started (running learnings record)
- [ ] Scoping gate run: open-questions list → Jon's batch answers → ADRs
- [ ] `SPEC.md` decomposed into Ready issues with acceptance criteria
