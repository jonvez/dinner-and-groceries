# ADR 0013 — Making the board live: proposals now, slotting next, one migration, server reconvergence for hydration

- **Status:** Accepted
- **Date:** 2026-09-15
- **Decided by:** Product Owner (within guardrails — no SPEC contradiction, no MVP scope change, no new
  dependency or cost). Reviewable and overridable by Jon.
- **Relates to:** #64 (new proposals appear live), #209 (live slotting — split out here), #63 +
  `20260721194820` (DELETE propagation / replica identity), #114 + PR #174 (server reconvergence),
  #44 + ADR 0008 (Realtime socket auth), #68 (prod migration automation), ADR 0011 (Realtime cloud gate).

## Context

The family-validation gate (#54) surfaced that a new dish proposal does not appear on another
member's open board until they reload, while reactions and comments do propagate live. #64 was filed
with a plausible diagnosis and an explicit list of unresolved design questions. Grooming re-verified
it against `main` @ 9daba83 and found the diagnosis right but incomplete, and the open questions
genuinely load-bearing:

1. The issue blamed the missing client-side subscription. The **deeper** cause is that
   `public.proposals` is not in the `supabase_realtime` publication at all
   (`20260625183220_realtime_publication.sql` adds only `reactions, comments`), so Postgres emits
   nothing for it. `slot_dishes` is likewise absent. **No client-side change can fix this.**
2. `proposals` is a raw prop, not client state (`app/board/proposal-pool.tsx:98,155–161`), so there is
   nowhere to merge a live row into — which is exactly why reactions/comments (held as state at
   `:125–130`) work and proposals do not.
3. Two further defects sit on the same code path: no channel is created at all when the week has zero
   proposals (`:185`), so the *first* proposal of a week could never arrive live even after a fix; and
   the subscription effect is keyed on the proposal-id list (`:283`), so every proposal tears the
   channel down and re-JOINs through a documented blind window (`:204–211`) — which gets much worse
   once proposals start arriving live.
4. The hydration question the issue raised is real: a `proposals` INSERT payload carries the table's
   own columns only, so **no dish title and no proposer name**. Both come from server-side joins
   (`app/board/page.tsx:78–98`).
5. The grocery list has already solved this class of problem twice, in two different ways. Without an
   explicit call, a developer would plausibly invent a third.

## Decision

### 1. Reuse both existing patterns; forbid a third

They are complementary, not alternatives:

- **Subscription shape** from `app/grocery/grocery-list.tsx:227–290` — one channel whose effect depends
  only on *stable* ids, rows held in local state seeded from server props by a signature-keyed
  `reconcileByPk` effect (`:175–213`).
- **Server reconvergence** from #114 / PR #174, already present at
  `app/board/proposal-pool.tsx:255–263` — on reconnect, `router.refresh()` and let the sig-keyed effect
  reconcile the authoritative props.

A **browser-client follow-up read is prohibited.** Auth cookies are httpOnly (ADR 0008); the browser
client has no session and `realtime.setAuth` authenticates only the socket, so such a read runs as
`anon`, RLS denies it, and the swallowed error blanks the board. That is #114, and the file header at
`proposal-pool.tsx:20–28` already says so.

### 2. Hydration: a `proposals` change is a trigger, not a payload to render

The handler calls `router.refresh()`; the server re-renders the fully-joined, RLS-scoped snapshot; the
sig-keyed effect reconciles it by PK. The alternative — denormalizing `title` onto `proposals` so the
payload could be rendered directly — was rejected: it turns a two-line publication migration into a
schema change with a sync obligation, for a table that sees a handful of rows per week. The rejected
third option (client-side fetch) is prohibited above. Cost of the chosen path is one server round trip
per proposal, comfortably inside the ~1–2s acceptance bar, and it structurally cannot render
"Untitled dish".

### 3. `slot_dishes` is out of #64 and becomes #209

The issue left this as "possibly". Decided: **no.** Slot propagation lives in a different component
(`app/board/board-grid.tsx`, a server component with no client state) and needs its own state-lifting,
binding and E2E. Folding it in roughly doubles #64 for no shared client code.

### 4. …but one migration covers both tables

The migration that lands with #64 sets `replica identity full` on `proposals` **and** `slot_dishes` and
adds both to the publication. Rationale: migrations do not auto-reach cloud prod (#68 is not done), so
each one costs a manual `supabase db push` that is easy to forget and has bitten this project
repeatedly. One apply for the whole live-board story beats two. #209 then ships with **no SQL at all**.

`replica identity full` is set **before** publication membership, per the reasoning already written into
`20260807160917_grocery_items_realtime.sql`: under the default identity a DELETE image is the PK alone,
so Realtime's server-side channel filter and RLS both miss and the event is silently dropped (the #63
bug class). `slot_dishes` DELETE is user-reachable today via tap-to-unslot; `proposals` DELETE is not
yet, and is covered anyway because the cost is one line.

### 5. Scope the `proposals` binding by `week_id`, not `household_id`

`week_id` is on the row and is the precise scope; RLS still enforces the household. This stops another
week's activity from refreshing the current page.

## Consequences

- **#64 needs a manual prod apply.** It is not done when it merges; it is done when the migration is
  live on cloud Supabase and verified. Written into the issue's Definition of Done.
- #64 grows beyond "add a subscription": proposals become state, the zero-proposal early return goes,
  and the subscription's dependencies are reduced to stable ids. That is the honest size of the fix,
  and two of the three were latent bugs that would have made a naive fix look broken.
- A proposal costs a server render on every other open client. Acceptable at this table's volume;
  revisit if the pool ever becomes high-churn.
- Adding `proposals`/`slot_dishes` to the publication widens Realtime exposure no further than SELECT
  already allows (household-scoped FORCEd RLS is evaluated per delivery), with the one accepted,
  already-documented residual: a DELETE event delivers a bare primary key without RLS evaluation. Same
  residual accepted for `reactions`/`comments`/`grocery_items`. Still requires the non-author
  `security-review` gate, since it is an exposure change.
- The "Live" / "Live updates paused" convention (`live && socketAuthed`, one channel, one status source)
  is preserved as an explicit acceptance criterion in both issues.

## Alternatives rejected

- **Denormalize `dish.title` onto `proposals`** so the payload renders directly — schema change plus a
  sync obligation, to save a cheap round trip on a low-churn table.
- **Client-side hydration fetch** — prohibited by ADR 0008 / #114 (anon read, RLS denial, blanked board).
- **Poll the board on an interval** — reintroduces the staleness Realtime exists to remove, and burns
  Free-tier requests on every open client.
- **Ship #64 and #209 together** — one big PR touching two components and the storage layer, for work
  two developers could otherwise sequence cleanly.
