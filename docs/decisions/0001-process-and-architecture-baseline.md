# ADR 0001 — Process & Architecture Baseline

- **Status:** Accepted
- **Date:** 2026-06-19
- **Decided by:** Jon (human) via brainstorming session

## Context

New project to involve Jon's two teens (16, 13→14) in deciding, acquiring, and preparing
household food. Primary loop: collaborative weekly menu planning (propose-and-react). See
`SPEC.md` for the full product design and `TEAM.md` for the build process.

## Decision

**Product (see `SPEC.md`):**
- North star: family deciding meals together; health as *design gravity*, never a tracked scorecard.
- MVP loop: propose-and-react weekly menu planning, async + multi-device; grocery list flows from the menu.
- Domain: `dishes` (reusable library) composed many-per-`slot`; recipes ingested from URLs.
- Stack: single Next.js app (App Router, TS, Tailwind, shadcn/ui, PWA) + Supabase (Postgres/Auth/Realtime/RLS); Google OAuth.
- Recipe extraction: structured-first (schema.org/Recipe), AI fallback via a stateless Anthropic Messages API call (`claude-haiku-4-5`).
- Hosting: GCP Cloud Run (existing GCE VM as fallback). Not Vercel.

**Process (see `TEAM.md`):**
- Native subagent personas (PO, architect, designer, 2 devs, QA) + superpowers skills. Not BMAD.
- Tracking: GitHub Projects (Issues + Kanban): Backlog → Ready → In Progress → In Review → QA → Done.
- Scope authority: Product Owner decides within written guardrails; all decisions logged as ADRs.
- Security: independent review *gate* (`security-review` skill, non-author) + security in ADRs/DoD. No standing security persona for MVP.
- Reuse: persona agents are global (`~/.claude/agents/`); extract a `build-team` skill only after this project + a parallel project yield learnings.
- Learnings: running retro log at `docs/retro/log.md` + agent-run retro per milestone.

## Consequences

- Fast iteration on the unproven interaction model; small, legible codebase suitable for building *with* the kids.
- GitHub Projects becomes the team's execution board (distinct from Jon's personal task system, which is not used for this project).
- The Project board requires the `gh` `project` scope (refreshed once, out of band).
- Post-MVP backlog (deferred): cost tracking, outcome dashboards, private health log, leftovers, per-slot prep override, school lunches, Apple sign-in + native app, marketplace.
