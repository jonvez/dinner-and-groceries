# ADR 0006 — Kickoff (planning → execution)

- **Status:** Accepted
- **Date:** 2026-06-19
- **Decided by:** Jon (human) — explicit **"start"**

## Context

Per `TEAM.md`, the project has a single formal moment that flips it from **planning** to
**execution**: the Kickoff Gate. No agent writes feature code before it. This ADR records that
declaration.

## Decision

Jon said **"start."** Pre-flight is green:

- [x] Setup complete (repo, board #1, global persona agents, settings, ADRs 0001–0005, retro log)
- [x] Scoping gate closed (decisions in ADRs 0002–0004)
- [x] Persona agents dispatchable (confirmed this session)
- [x] Board #1 on the native 6-column Status field; board ops via the `github-project-board` skill (`ghpm`)

Execution is authorized to begin: **M0 (Scaffold & CI)** and **M1 Slice 1a (Identity)**.

## Consequences

- The Product Owner files the M0 + M1 backlog as GitHub issues (with acceptance criteria) on
  board #1, all in **Backlog**, then grooms **Slice 1a → Ready** (and the M0 scaffold work, its
  prerequisite). Developers pull only from **Ready**.
- The orchestrator may now dispatch personas to implement. Everything lands as commits / PRs /
  ADRs against the Definition of Done in `TEAM.md`.
- Before "start," the team only planned, groomed, and designed. That phase is now closed.
