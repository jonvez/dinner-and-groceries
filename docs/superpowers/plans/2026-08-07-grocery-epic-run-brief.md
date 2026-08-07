# Grocery Epic — Autonomous Run Brief (2026-08-07)

Slice 1d, run under the epic-level operating model: one kickoff (this brief) → autonomous
execution of the three grocery stories → one acceptance at the end. Second cost-baseline
measurement (fresh compacted session — see below).

## Epic goal (user terms)
The week's agreed menu rolls up into **one combined grocery list** the family shops from —
merging (never clobbering) their manual edits — plus a reusable catalog of staples, an
"we already have it" toggle, live check-off at the store across phones, and a "complete
trip" that promotes new ad-hoc items into the staples catalog.

## Proposed acceptance criteria (Jon confirms/edits at kickoff)
1. **The list builds from the menu.** From a week with slotted dishes, I get one combined
   grocery list; same-name + same-unit ingredients are summed into one row; un-mergeable
   units are listed separately (no unit conversion). **Quantity and unit are optional** — an
   unquantified item (just a name, e.g. "eggs") is valid on the list.
2. **My edits survive a re-roll-up.** After I change the menu and rebuild, the list *merges*:
   have-it / checked / manually-edited rows are never deleted or overwritten; it tells me
   "N added, M removed." Auto-rows whose dish was unslotted disappear **only if untouched**.
3. **Staples + ad-hoc.** I can add a catalog staple in one tap and type an ad-hoc item;
   both land on the list. Nothing here mutates dishes/recipes.
4. **We shop it together, live.** Two of us at the store: one checks an item, the other sees
   it checked live; "we already have it" de-emphasizes without deleting.
5. **Complete the trip.** Finishing archives checked items and offers new ad-hoc items for
   promotion into the staples catalog.
6. **Privacy holds.** Everything is household-scoped — another household can't read or write
   our grocery list or catalog (RLS allow/deny tested).

## Stories, sequence, security
Fully **sequential** — each depends on the prior (shared tables + the roll-up contract):

| Order | Story | Deliverable | Security gate? |
|-------|-------|-------------|----------------|
| 1 | **#13** schema + RLS | `catalog_items` + `grocery_items` tables, FORCE RLS, allow/deny pgTAP | **YES** — new household-scoped tables, cross-household deny |
| 2 | **#14** roll-up/dedupe | pure `lib/grocery/` merge engine + thin `buildGroceryList(weekId)` server action | **Light** — folded into task review: writes run under RLS, no service-role |
| 3 | **#15** shopping-list UI | catalog reuse, ad-hoc add, have-it, live check-off (Realtime), complete-trip + promotion | **YES** — cross-household writes, Realtime channel scoping, promotion server action |

**Hard dependency:** 13 → 14 → 15. #14 needs #13's tables; #15 needs both #13's tables and
#14's roll-up contract. No parallelism.

## Cross-story architecture (settled once — so no story builds against a dead end)
- **Data model:** exactly the two tables in #13's scope. No cost/price columns (out of MVP
  scope per SPEC.md). `catalog_items` keeps `added_count`/`last_added_at` (feeds future
  repurchase suggestions — stored, not surfaced).
- **Three-feeder `grocery_items`:** a row is dish-derived (`ingredient_id` set), catalog
  (`catalog_item_id` set), or ad-hoc (both null). This shape is the contract between all three.
- **Roll-up contract (#14 produces, #15 consumes):** a pure module `lib/grocery/rollup.ts`
  exporting the merge/dedupe/removal logic (deduped by normalized-name + exact unit per ADR
  0003; provenance via `ingredient_id` + an `edited` flag), plus a thin server action
  `buildGroceryList(weekId)` that persists the result and returns `{ added, removed }`. #15's
  "rebuild list" button calls that action; it renders `grocery_items` and never touches dishes.
- **Quantity + unit are OPTIONAL** (`grocery_items.quantity` and `.unit` both nullable). Dedupe
  key is normalized-name + unit, where **an empty unit is itself a key** — two unit-less "eggs"
  rows merge. When merging quantities: **sum only the present values; a null contributes
  nothing and is never coerced to 1**; if every merged row is quantity-null, the result stays
  unquantified (name only). A null unit never merges with a non-null unit (still un-mergeable).
- **Realtime:** reuse the 1b per-week channel pattern for live check-off on `grocery_items`
  (established + cloud-gated, ADR 0011) — no new socket-auth surface.
- **Provenance/edit rules of record:** ADR 0003 (merge-not-clobber; untouched-only removal;
  never delete have-it/checked/edited). #14 is the riskiest logic → strict test-first.

## Plan reconciliation
No story plans exist for 1d yet. **On approval, step 1 is to write the three story plans**
(writing-plans) — #13, #14, #15 — folding this brief's architecture decisions into the task
bodies so each is self-consistent before any dispatch. Then autonomous execution.

## Autonomy boundary
All three are **low prod-risk**: additive migrations (new tables, same pattern as 1a/1b/1c),
no auth change, no cross-tenant loosening, Realtime reuse of an already-gated surface. So the
full run auto-merges each PR after its gates + CI, keeps `main` synced, and returns to Jon
only at acceptance. Escalate only on BLOCKED / genuine ambiguity the brief doesn't cover /
scope change / a story I'd newly tag prod-risky.

## Gate model (automated; human only at acceptance)
- Per story: TDD build (developer, isolated worktree, durable report file, named `i<issue>-dev`)
  → synchronous task-review gate (verdict to a durable file, evt-0005).
- **#13 + #15:** synchronous non-author RLS/security gate (durable file) before merge.
  #13: FORCE RLS on both tables, cross-household deny, no service-role. #15: promotion +
  check-off server actions write only within the caller's household; Realtime channel is
  household/week-scoped; no service-role.
- **#14:** RLS/no-service-role check folded into the task review (light).
- CI green (Lint/typecheck/unit + Playwright E2E + RLS pgTAP) before each merge; auto-merge;
  clean up worktree/branch.
- **Acceptance (Jon, async):** the merged epic checked against the ACs above, incl. a live
  two-client check-off smoke and a real roll-up from a slotted week.

## Cost baseline note
**Kickoff baseline captured 2026-08-07 via `/cost`** (cumulative session figure — this is the
*anchor*, not the epic's spend; the epic's cost = the delta to the acceptance reading):
- **Total cost: $320.43** · API duration 7h 53m · opus-4-8 output 1.8M tok (cum), cache-read 327.1M.

At acceptance, read `/cost` again; **grocery-epic cost = (acceptance total) − $320.43**. Valid
ONLY if this run stays pure — no unrelated work between here and acceptance. Restart-proof proxy
if the delta is contaminated: ~9 subagent dispatches for a 3-story epic (~200k output tok/story-
with-gates). Log both the $ delta and the proxy to the Build-Team Epic Cost Log at acceptance.
