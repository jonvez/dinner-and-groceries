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
-- `relreplident` in pg_class: 'd' = default (PK), 'n' = nothing, 'f' = full,
-- 'i' = index. We require 'f' for both social tables.
begin;
select plan(2);

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

select * from finish();
rollback;
