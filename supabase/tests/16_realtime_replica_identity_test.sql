-- Realtime DELETE propagation: reactions/comments must have REPLICA IDENTITY FULL
-- (issue #63). Root-cause guard, not a re-test of RLS.
--
-- These tables are in the `supabase_realtime` publication and the board
-- subscribes with `filter: household_id=eq.<id>` while their RLS SELECT policies
-- are household-scoped. A Postgres logical-replication DELETE only emits the
-- REPLICA-IDENTITY columns; with the DEFAULT identity that is the PK only, so the
-- DELETE image carries no `household_id` — Realtime evaluates the channel filter
-- AND RLS against that image, both miss, and the DELETE is dropped (un-react never
-- reaches other clients). Verified live on cloud during the P4 gate (ADR 0011).
--
-- REPLICA IDENTITY FULL makes DELETE carry the whole old row, so `household_id` is
-- present and the filter + RLS match. This is the exact gap that shipped because
-- the component test mocked the channel and only exercised INSERT; assert the
-- storage-layer property directly so a regression can't slip through again.
--
-- The same property is required of `proposals` and `slot_dishes` (issue #64,
-- ADR 0013), which join the publication in the same migration that makes the
-- board live for new ideas. `proposals` is scoped by `week_id=eq.<id>` on the
-- wire and `slot_dishes` DELETE is user-reachable today (tap-to-unslot), so a
-- PK-only change image would drop exactly the events #63 taught us about.
-- Publication membership is asserted here too: without it Postgres emits
-- NOTHING and the client shows "Live" while receiving zero changes — the silent
-- failure that shipped for the social tables in 20260625183220 and, for
-- `proposals`, all the way to the P4 family-validation gate (#64).
--
-- `relreplident` in pg_class: 'd' = default (PK), 'n' = nothing, 'f' = full,
-- 'i' = index. We require 'f' for all four live tables.
begin;
select plan(6);

select is(
  (select relreplident from pg_class where oid = 'public.reactions'::regclass),
  'f'::"char",
  'reactions has REPLICA IDENTITY FULL (DELETE carries household_id for Realtime filter + RLS)'
);

select is(
  (select relreplident from pg_class where oid = 'public.comments'::regclass),
  'f'::"char",
  'comments has REPLICA IDENTITY FULL (DELETE carries household_id for Realtime filter + RLS)'
);

-- Issue #64 / ADR 0013: a new proposal must reach an already-open board, which
-- needs BOTH the publication membership (events emitted at all) and FULL
-- identity (a DELETE/UPDATE old image that carries `week_id`, the column the
-- board's `proposals` channel filters on server-side).
select is(
  (select relreplident from pg_class where oid = 'public.proposals'::regclass),
  'f'::"char",
  'proposals has REPLICA IDENTITY FULL (DELETE carries week_id for Realtime filter + RLS)'
);

select ok(
  exists(
    select 1
    from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'proposals'
  ),
  'proposals is in the supabase_realtime publication (a new idea is delivered at all)'
);

-- `slot_dishes` rides the same migration deliberately (ADR 0013 §4): live
-- slotting (#209) then ships with no SQL and no second manual prod apply.
-- Tap-to-unslot hard-deletes a row, so FULL identity is load-bearing here today.
select is(
  (select relreplident from pg_class where oid = 'public.slot_dishes'::regclass),
  'f'::"char",
  'slot_dishes has REPLICA IDENTITY FULL (unslot DELETE carries its scope columns)'
);

select ok(
  exists(
    select 1
    from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'slot_dishes'
  ),
  'slot_dishes is in the supabase_realtime publication (live slotting needs no further SQL)'
);

select * from finish();
rollback;
