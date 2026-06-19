# ADR 0005 — Board Tooling: adopt `gh-pm`

- **Status:** Accepted
- **Date:** 2026-06-19
- **Decided by:** Jon (human)

## Context

Operating the GitHub Projects v2 board (reading items, moving issues across columns, setting up
the 6-column Status field) was being hand-rolled as `gh api graphql` + `python3` one-liners —
brittle, and it spawned stale permission-allowlist entries. The board is core to the build-team
process (`TEAM.md`), so the whole team (PO/dev/QA + orchestrator) needs a reliable way to drive it.
This is shared tooling with the parallel project `delivery-simulator` (its ADR 0004).

## Decision

Adopt the **`gh-pm`** GitHub CLI extension (`yahsan2/gh-pm`) for everyday board ops, wrapped by a
global **`github-project-board`** skill that documents the team conventions and the one operation
`gh-pm` lacks. Rejected alternatives: building a bespoke Node CLI (re-implements an actively
maintained tool); `heaths/gh-projects` (stale, weaker).

- Everyday ops: `gh pm list` (read), `gh pm move <#> --status <col>` (move by name), `gh pm intake`
  (add issues to the board). Per-project config in committed `.gh-pm.yml`.
- Issue *creation* stays `gh issue create`.
- The rare 6-column setup on a new board stays a documented GraphQL recipe in the skill (`gh-pm`
  can't edit field options).
- `Bash(gh pm:*)` added to the project allowlist.
- Every persona agent now reads its project's `TEAM.md` first, which points at the skill — so
  group-wide instructions broadcast through `TEAM.md` (no per-agent churn).

## Consequences

- **New external dev dependency:** `gh-pm` (free, Go, installed via `gh extension install`). This is
  process/tooling, not a product runtime or paid service; recorded here per the `TEAM.md`
  "new external dependency" guardrail.
- Caveats discovered by running it (documented in the skill): `gh pm init` mis-detects an `org` for
  **user-owned** boards (omit `org`, set `number`, hand-map status values); it invents a `Priority`
  field this board lacks (strip it); keyring auth works (no `GH_TOKEN`).
- Board #1's `.gh-pm.yml` is committed; columns live on the built-in **Status** field (no separate
  "Stage" field — see this session's board cleanup).
