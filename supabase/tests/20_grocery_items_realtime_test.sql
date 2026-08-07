-- Realtime delivery for the shopping list: `grocery_items` must be IN the
-- `supabase_realtime` publication AND carry REPLICA IDENTITY FULL (issue #15,
-- slice 1d). Storage-layer guard, not a re-test of RLS (#13 covers that).
--
-- Why both assertions, and why at this layer:
--   * Publication membership is what makes Postgres emit change events at all.
--     Without it the `/grocery` client subscribes successfully and shows "Live"
--     while receiving NOTHING — the exact silent failure mode that shipped for
--     the social tables (20260625183220) and hid behind a mocked-channel test.
--   * REPLICA IDENTITY FULL is required because the list channel subscribes with
--     `filter: household_id=eq.<id>`, which Realtime evaluates SERVER-SIDE
--     against the replication change image. Logical replication emits only the
--     replica-identity columns for DELETE (and for the OLD image of an UPDATE);
--     under the DEFAULT identity that is the PK alone, so the image has no
--     `household_id`, the server-side filter can't match, and the event is
--     dropped. That is issue #63 all over again — "rebuild from menu" deletes
--     rows, and a dropped event would leave the other shopper's phone showing an
--     item that is no longer on the list. (FULL is not about the client seeing
--     `household_id` on a delete — the delivered DELETE payload is the PK only
--     either way.)
--
-- FULL widens no row CONTENT: Realtime authorizes INSERT/UPDATE deliveries
-- against the same household-scoped RLS via the subscriber's JWT. DELETE events
-- are NOT RLS-gated upstream, but they carry the primary key alone — an
-- accepted, documented residual (see the migration).
--
-- `relreplident` in pg_class: 'd' = default (PK), 'n' = nothing, 'f' = full,
-- 'i' = index. We require 'f'.
begin;
select plan(2);

select ok(
  exists(
    select 1
    from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'grocery_items'
  ),
  'grocery_items is in the supabase_realtime publication (live check-off is delivered at all)'
);

select is(
  (select relreplident from pg_class where oid = 'public.grocery_items'::regclass),
  'f'::"char",
  'grocery_items has REPLICA IDENTITY FULL (the DELETE/UPDATE old image carries household_id so Realtime''s server-side filter can match)'
);

select * from finish();
rollback;
