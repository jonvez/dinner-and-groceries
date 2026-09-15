# ADR 0014 — The PO dashboard: emit the events first, put the owner gate in RLS, defer the tag-mix panel

- **Status:** Accepted (one part escalated to Jon — see "Escalation")
- **Date:** 2026-09-15
- **Decided by:** Product Owner (within guardrails, except the tag-mix deferral, which touches a SPEC
  bullet and is escalated rather than silently decided).
- **Relates to:** #17 (the dashboard), #210 (event emission — split out here), #211 (tag-mix panel —
  split out here), #16 (events table + helper), ADR 0004 (analytics taxonomy, events-table-only),
  ADR 0012 ("we have it" is not a trip), #62 (verified-session member lookup), #68 (prod migrations).

## Context

#17 already had Given/When/Then acceptance criteria and looked ready to build. Grooming audited its
**inputs** against `main` @ 9daba83 and found two things that would have made it ship broken, plus a
security assumption that was wrong.

### 1. The dashboard has almost no data to read

`grep -rn "emitEvent" app lib components` returns exactly **one** production call site:
`app/recipes/new/actions.ts:80` (`recipe_ingested`). The events table, its RLS, the enum and the typed
helper all landed with #16 — and the migration's own WIRING NOTE says each feature slice emits its own
events "in that slice's own PR". **None of the feature slices did.** Every panel #17 describes
(adoption, per-member participation, trips) would have rendered empty.

The gap is systemic, not a one-off: a cross-cutting concern was correctly split into "build the
primitive" and "use the primitive in each slice", the primitive shipped, and the second half was never
tracked as work anywhere. It was invisible because nothing fails when an event is not emitted.

### 2. `events` is readable by every member, not just the owner

`events_select` (`20260707161759_events_schema.sql`) is
`using (household_id = public.current_household_id())` — **household-scoped, not owner-scoped**. A
route-level owner check alone would have been a UI curtain over an open door: any member, including
the teens, could read every event row straight through the Data API. For a feature whose entire premise
is "this exists for me alone", that is the wrong place to stop.

### 3. One panel cannot have data at all

SPEC asks for the health-tag distribution of slotted dishes. `dishes.tags` exists but **no production
code reads or writes it**, and the health-tag pick-list is scheduled for M2 (PLAN.md). Every dish in
the database has `tags = '{}'`.

## Decision

### 1. Split emission out and build it first — #210, Ready before #17

#210 wires `proposal_created`, `reaction_added`, `comment_added`, `slot_filled`, `grocery_list_built`,
`trip_completed`, `sign_in` and `session_start` at their existing server-action call sites, with fixed
payload shapes so the dashboard can rely on them. It needs no SQL (every type is already in the enum).
#17 is **blocked by it** and stays in Backlog until it merges. A dashboard whose panels render empty
teaches the wrong thing about the family and would be indistinguishable from a bug.

Two specifics worth recording:

- **`reaction_added` fires only when the toggle turns a reaction on.** Un-reacting emits nothing; there
  is no `reaction_removed` type and adding one is a migration plus an ADR amendment.
- **`sign_in` can only be emitted once a household exists.** `events.household_id` is `NOT NULL` and the
  INSERT policy checks it, so a first-time user at the OAuth callback has nothing to attribute the event
  to. Emit only when `current_household_id()` resolves; never fail the sign-in over analytics.

### 2. `session_start` is in scope; `screen_view` is not

Sessions are long-lived, so `sign_in` alone would under-count daily use to the point of uselessness and
the adoption panel would be near-empty — the same failure this split exists to prevent. `session_start`
is emitted once per browser session, guarded by `sessionStorage`. `screen_view` is deliberately not
emitted: no #17 panel needs it, and it is the one high-volume event in the taxonomy on a Free-tier
database. Recorded in code so the next reader does not file it as a bug.

### 3. The owner-only gate is RLS **and** a server check, not one or the other

- **RLS is the boundary:** `events_select` is replaced with
  `using (household_id = public.current_household_id() and public.is_household_owner())`, reusing the
  existing 1a `SECURITY DEFINER` helper — no new helper. `events_insert` stays household-scoped so every
  member still emits. Append-only is untouched.
- **The server check is the route behaviour:** `/dashboard` resolves the caller with
  `resolveCurrentMember` (which pins the lookup to the verified `auth.getUser()` id — the #62 lesson)
  and returns **404** for a non-owner. 404 rather than 403: a member who cannot have it should not learn
  it exists.

Proof is required in both places: pgTAP allow/deny in `supabase/tests/15_events_rls_test.sql` (owner
allowed, same-household non-owner denied, other-household denied, non-owner INSERT still allowed), a
server test for the route, and an authed Playwright check using the existing two-user fixture. Plus the
non-author `security-review` the Definition of Done requires.

**This means #17 carries a migration** and therefore a manual prod apply (#68 is not done). It is a
second apply on top of #64's — noted as a cost, not hidden.

### 4. No nav entry; the link lives in the owner-only region of Home

`components/app-nav.tsx` is a static, propless link list, so an owner-only tab would mean threading
`isOwner` through every page that renders it. It is also the wrong answer for the north star: a
"Dashboard" tab the teens can see but cannot open raises exactly the questions this feature must never
raise. The link goes next to the invite panel in `app/page.tsx`, which already computes `isOwner`.
`AppNav` is untouched — which also removes a file collision between the two developer tracks.

### 5. The tag-mix panel is deferred to #211

It is blocked on the M2 health-tag pick-list. When it unblocks, it aggregates from a `tags` array
carried in the `slot_filled` payload rather than joining `dishes` at read time — a tag snapshot at slot
time is the honest history, and re-tagging a dish later should not rewrite last month's numbers.
Aggregate only, never per-member, never per-child.

## Escalation

Deferring tag mix out of #17 touches a SPEC bullet that lists it as part of the MVP PO dashboard, which
is a guardrail. It is therefore **escalated to Jon**, not silently decided. The default recorded here is
"defer, because the input data cannot exist before M2". The alternative is to pull the health-tag
pick-list forward into M1 so the panel can ship with the dashboard. Flagged on #211.

## Consequences

- #17 is no longer the next thing built; #210 is. #17 gains a migration it did not previously have.
- The emission audit is a general lesson, logged to `docs/retro/log.md`: when a cross-cutting primitive
  is split from its per-slice adoption, the adoption half needs its own board item at the moment of the
  split, or it silently never happens.
- Tightening `events_select` is safe today because nothing else reads the table. Any future
  member-facing view over `events` would have to revisit this ADR.
- The dashboard's aggregation window is fixed at 30 days with no date picker; rich trends stay post-MVP
  per SPEC.
