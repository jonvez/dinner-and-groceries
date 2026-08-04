# Recipes Epic — Autonomous Run Brief (2026-08-04)

The first run under the epic-level operating model: one kickoff (this brief), autonomous
execution of the remaining recipes stories, one acceptance at the end. Also our first
**cost baseline** measurement (see below).

## Epic goal (user terms)
A signed-in family member can add a recipe — by pasting a recipe URL that auto-extracts,
or by hand — save it to the household library, land on its own page, and see all their
saved recipes in a list.

## Acceptance criteria (Jon, 2026-08-04)
1. I can paste a recipe URL, get an editable extraction, **save it, and view it** (lands on `/recipes/{id}`).
2. Pasting a **video URL does not work as a recipe** — it yields no extraction and drops to the by-hand editor with a friendly notice (no crash, no garbage save). Explicit video detection is NOT built.
3. I can create a **minimal recipe with no URL — a title alone is sufficient** (zero ingredients allowed).
4. I can **manually add ingredient lines** to that by-hand recipe **at creation time** (the textarea works without a URL).
   - Out of scope → backlogged: editing ingredients on an ALREADY-SAVED recipe (**#89**); post-save "add another" shortcut (**#88**).

## Resource model (settled at kickoff — front-loaded so stories don't build against dead ends)
- `/recipes` — read-only library **list** (brick 12d)
- `/recipes/new` — **add** flow: URL-extract or by-hand → save → PRG redirect to the new recipe (brick 12c)
- `/recipes/{id}` — read-only recipe **detail** page (brick 12c; also 12d's link target)

## Stories, sequence, plans
| Order | Story | Plan | Security-relevant? |
|-------|-------|------|--------------------|
| 1 | **12c** recipes screen + ingest action + detail page | `docs/superpowers/plans/2026-07-23-recipe-ingest-12c-recipes-screen.md` (see its **Kickoff Resolutions** block — those override conflicting task text) | **YES** — SSRF fetch, stored-XSS on extracted URLs, cross-household detail read |
| 2 | **12d** library list | `docs/superpowers/plans/2026-07-23-recipe-ingest-12d-library-list.md` | No — RLS-scoped read-only list |

**Hard dependency:** 12d must be built/merged AFTER 12c (shared `app/recipes/page.tsx`; 12d replaces 12c's interim add-link). Sequential, not parallel.

## Gate model for this run (automated; human only at acceptance)
- Per story: TDD build (developer, isolated worktree, durable report file) → synchronous task-review gate.
- **12c only:** synchronous non-author RLS/security gate — must verify: URL fetch goes only through `safeFetchHtml`; `javascript:`/`data:` image & source URLs are dropped via `safeHttpUrl` before persist; no `dangerouslySetInnerHTML`; `/recipes/{id}` returns nothing for another household's id (RLS); no service-role.
- CI green (Lint/typecheck/unit + Playwright E2E + RLS pgTAP) before each merge.
- Auto-merge each PR (both low prod-risk) per the delegated-merge decision; clean up worktree/branch; keep `main` synced.
- Escalate to Jon only on BLOCKED / real ambiguity / scope change / a story I'd tag prod-risky.
- **Acceptance (Jon, async):** the merged epic checked against the 4 ACs above.

## Cost baseline note
This run starts from a freshly `/session-end`-ed + compacted session so we can gauge the
relative token cost of an epic-sized autonomous run. Caveat: the dominant cost is the
subagent fan-out (fresh-context builds + review gates), which compaction does NOT reduce —
so the number is a decent relative baseline, but most of it is builds+gates, not main-loop
context. Report total run cost at acceptance.
