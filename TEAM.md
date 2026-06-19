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

## Personas

Each persona is a custom subagent in `.claude/agents/<name>.md` with its **own tool allowlist**
(front-loaded). Tools are scoped to least-privilege per role.

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

### Definition of Done (per issue)

- Acceptance criteria met; tests written first and passing; lint/typecheck clean;
  PR linked to the issue; QA verified; PO accepted.

## Board (GitHub Projects)

Columns map to handoffs: **Backlog → Ready → In Progress → In Review → QA → Done.**
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
- [ ] `.claude/agents/*.md` for the 6 personas with scoped tool allowlists
- [ ] `.claude/settings.json` permission allowlist (front-loaded)
- [ ] `docs/decisions/` ADR directory + `0001` recording these process decisions
- [ ] Scoping gate run: open-questions list → Jon's batch answers → ADRs
- [ ] `SPEC.md` decomposed into Ready issues with acceptance criteria
