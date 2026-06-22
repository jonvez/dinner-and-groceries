-- Migration: household_bootstrap (slice 1a, issue #6)
--
-- Completes the identity loop: a signed-in user creates OR joins a household.
--
-- Why SECURITY DEFINER bootstraps (the #4 deferral):
--   The identity schema (#4) deliberately left NO INSERT policy on `households`
--   or `members`. RLS policies on those tables scope via
--   `public.current_household_id()`, which resolves the caller's household FROM
--   their `members` row. A brand-new user has no member row yet, so any
--   self-referential INSERT policy (`with check (household_id =
--   current_household_id())`) can never be satisfied for the very first row --
--   it is a chicken-and-egg. Creation must therefore happen through definer-
--   rights functions that run as the function owner (RLS-exempt) and write the
--   first household + member rows atomically, while still deriving identity from
--   `auth.uid()` (never a client-supplied user id) and enforcing the same
--   invariants the policies would.
--
-- Security hardening applied to BOTH functions (matches #4's helpers):
--   * SECURITY DEFINER + `set search_path = ''` so a malicious caller
--     search_path cannot shadow the schema-qualified objects we reference.
--   * Every object fully schema-qualified (public.*, auth.uid()).
--   * `revoke all ... from public` then `grant execute ... to authenticated`:
--     anon can never call these; only a signed-in user can.
--   * Identity comes from `auth.uid()` inside the function -- the client cannot
--     forge which user becomes the owner/member.
--   * The MVP single-household invariant (`members.unique(user_id)`) is enforced
--     defensively here too (explicit pre-check) so the caller gets a clear error
--     instead of a raw unique-violation, and so accept_invite fails BEFORE it
--     would consume a single-use invite.

-- ===========================================================================
-- create_household(name, display_name) -> household_id
-- Atomically creates a household and the caller's OWNER member row. The caller
-- must be authenticated and must NOT already belong to a household.
-- ===========================================================================
create function public.create_household(
  p_name text,
  p_display_name text
)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
  v_household_id uuid;
begin
  if v_uid is null then
    raise exception 'create_household: not authenticated'
      using errcode = '28000';
  end if;

  -- Enforce the single-household invariant with a clear error (the table also
  -- has unique(user_id), but we want a friendly message, not a raw 23505).
  if exists (select 1 from public.members where user_id = v_uid) then
    raise exception 'create_household: user already belongs to a household'
      using errcode = '23505';
  end if;

  -- The household. owner_id is the caller (never client-supplied).
  insert into public.households (name, owner_id)
  values (p_name, v_uid)
  returning id into v_household_id;

  -- The caller's OWNER member row in that household.
  insert into public.members (household_id, user_id, display_name, role)
  values (v_household_id, v_uid, p_display_name, 'owner');

  return v_household_id;
end;
$$;

-- ===========================================================================
-- accept_invite(token, display_name) -> household_id
-- Joins the household an invite grants, as a `member`. Reuses #4's
-- consume_invite() for the single-use + expiry + atomic-stamp logic, then
-- creates the member row in the SAME transaction (so a failure to create the
-- member rolls back the consumption -- the invite is never silently burned).
-- ===========================================================================
create function public.accept_invite(
  p_token text,
  p_display_name text
)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
  v_household_id uuid;
begin
  if v_uid is null then
    raise exception 'accept_invite: not authenticated'
      using errcode = '28000';
  end if;

  -- Guard BEFORE consuming: a user who already belongs to a household must not
  -- burn someone else's single-use invite. Fail first, leave the invite valid.
  if exists (select 1 from public.members where user_id = v_uid) then
    raise exception 'accept_invite: user already belongs to a household'
      using errcode = '23505';
  end if;

  -- Reuse the audited single-use/expiry path from #4. It validates (not
  -- expired, not already consumed, exists), stamps consumed_at/consumed_by, and
  -- returns the household_id -- or raises, which aborts this transaction.
  v_household_id := public.consume_invite(p_token);

  -- Create the joiner's member row (role defaults to 'member').
  insert into public.members (household_id, user_id, display_name, role)
  values (v_household_id, v_uid, p_display_name, 'member');

  return v_household_id;
end;
$$;

-- Lock both bootstraps down: authenticated-only, never anon/public.
revoke all on function public.create_household(text, text) from public;
revoke all on function public.accept_invite(text, text) from public;
grant execute on function public.create_household(text, text) to authenticated;
grant execute on function public.accept_invite(text, text) to authenticated;
