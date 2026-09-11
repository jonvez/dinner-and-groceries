# ADR 0012 — "We have it" removes the item: its own stamp, no time scope, cleared by the next trip

- **Status:** Accepted
- **Date:** 2026-09-09
- **Decided by:** Product Owner + Jon (the three decisions below were settled with the PO on
  2026-09-06 and 2026-09-07, recorded here at implementation time)
- **Relates to:** #171 (the change this ADR records), ADR 0003 (dedupe/roll-up rules and the
  RLS posture this stays inside), #13/#14/#15 (the grocery slice), #17 (the trip-history
  dashboard this protects), #135 (grocery sections epic).

## Context

Getting an item you already own off the shopping list took three actions: tap **"We have it"**,
tick the item's checkbox, then tap **Complete trip**. The last two are extraneous — "we have it"
already says everything. `setHaveIt` wrote `have_it: true` and nothing else; the row stayed
rendered (greyed, struck through) and only dropped out of the "(N to get)" count. Because the
active list is `purchased_at is null` and only `completeTrip` stamps `purchased_at` (and only for
`checked` rows), a have-it row that was never also checked stayed on the list forever.

Making one tap remove the row raises three questions that cannot be answered by the UI alone.

## Decision

### 1. "Removed" is its OWN timestamp — `have_it_at`, never `purchased_at`

The claim gets a dedicated nullable `have_it_at timestamptz` (migration
`20260909120000_grocery_items_have_it_at.sql`). Reusing `purchased_at` would have cost no
migration and been wrong twice over: it would write a **phantom purchase** into the trip history
the dashboard (#17) will read, and it would feed `completeTrip`'s staples-promotion offer — the
app would propose adding to your staples an item you never bought. "We have it" is a pantry fact,
not a purchase. The migration is accepted as the price of saying so honestly.

The `have_it` boolean stays. It is what the planner's protection rule reads; `have_it_at` is what
the shopping-list read excludes on. `setHaveIt` writes both in ONE statement, so "hidden from the
list" and "still claiming its dedupe key" become true at the same instant.

Existing `have_it` rows on active lists are backfilled with a stamp: the family has already said
they have those, and the whole point of this change is that saying so takes the item off the list.

### 2. The list is DECOUPLED FROM TIME — the row stays visible to the roll-up planner

There is no guarantee when a shopping trip happens, so the suppression is never scoped to a week
or any other calendar boundary ("suppress for the rest of the week" was explicitly rejected).

Concretely, and this is the sharp edge: a have-it row **stays in `grocery_items`, un-purchased,
and remains visible to the roll-up planner** (`lib/grocery/rollup.ts` via `rollup-core.ts`, whose
read filters on `purchased_at` only). It therefore keeps CLAIMING its dedupe key, and a
"Rebuild from menu" cannot insert a shadow duplicate of the very item the family just said they
already had — the duplicate the roll-up exists to prevent (ADR 0003).

Hiding a row from the display and removing it from the planner's `existing` set are two different
things. Only the first is wanted. `loadGroceryList` — and nothing else — applies
`have_it_at is null`.

### 3. A claim ends on the next COMPLETED TRIP

`completeTrip` clears every outstanding claim (`have_it = false, have_it_at = null`) as a
**second effect** of the same action. This honors the decoupling — trips happen whenever they
happen — while still giving the claim a natural reset, so a staple the family uses up reappears
on the list instead of being suppressed forever.

That second statement is deliberately separate from the archive: the cleared rows are **not**
stamped `purchased_at`, are **not** counted in `archived`, and are **not** offered as
staples-promotion candidates. Nothing was bought. It is best-effort (the archive has already
committed, so failing the whole action would tell the shopper a trip that happened did not, and a
re-tap would archive nothing and lose the promotion prompt); a claim that fails to clear clears on
the next trip.

Rejected: *"persists until explicitly undone"* (a used-up staple silently never returns) and
*"clears when next slotted by a menu"* (that defeats the suppression outright).

### Undo

Removal on a single tap in a noisy store needs a way back. The removal is optimistic (and rolls
back if the write fails), and the notice (`data-testid="grocery-notice"`) carries an **Undo** that
calls the same mutation inverted. Because the row was never deleted, it comes back with its aisle,
quantity and unit intact — nothing is reconstructed. The other phone follows over Realtime: a row
arriving with `have_it_at` set is treated as a removal, and an undone claim arrives as an ordinary
UPDATE that `mergeChange` upserts back by PK.

## Consequences

- **Migration required.** `have_it_at` ships in the PR; applying it to the cloud project is a
  separate human step (migrations do not auto-reach prod).
- **Two columns must move together.** `have_it` and `have_it_at` are only ever written in the same
  statement (`setHaveIt`, and the trip's clear). A future writer that sets one without the other
  would either hide a row from the planner's protection or strand it off the list — the unit tests
  in `mutations-core.test.ts` and `trip-core.test.ts` pin both payloads exactly.
- **The `(N to get)` count now falls because the item is gone**, not because it is filtered out of
  the count while still rendered.
- **RLS surface is unchanged.** Every policy on `grocery_items` is row-level on `household_id`
  with no column-level grants, so the new column is inside the existing allow/deny matrix by
  construction. `supabase/tests/19_grocery_items_rls_test.sql` was extended to prove it
  (allow-same stamp, deny-cross stamp, and "a claim leaves `purchased_at` null") rather than
  assume it.
- **Trip history stays clean**, which is what #17 will read.
