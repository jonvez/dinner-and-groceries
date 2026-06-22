-- Migration: identity_schema (slice 1a)
--
-- The identity bedrock every later slice's RLS depends on: households,
-- members, invites + the household-scoping RLS that makes the whole app a
-- single private, household-scoped space (SPEC "Auth / household model" +
-- "Data Model"; ADR 0003 RLS section).
--
-- Security design (ADR 0003):
--   * `supabase/migrations/*.sql` is the SOLE source of DDL.
--   * All app data access runs as the signed-in user (anon/authenticated
--     role + their JWT); there is no service-role usage in M0/M1, so RLS is
--     always in force. Every table here has RLS enabled + FORCEd.
--   * A `SECURITY DEFINER` helper, `public.current_household_id()`, returns
--     the caller's household. Because it is SECURITY DEFINER it reads
--     `members` with RLS bypassed, so policies ON `members` can call it
--     WITHOUT triggering RLS recursion (a policy that selects the same table
--     it protects would otherwise recurse infinitely). Every identity policy
--     scopes via this one helper — the single chokepoint for household
--     isolation.

-- ===========================================================================
-- Enum: member role (owner | member) — SPEC "Roles, minimal".
-- ===========================================================================
create type public.member_role as enum ('owner', 'member');

-- ===========================================================================
-- Tables
-- ===========================================================================

-- The family unit; everything scopes to this.
create table public.households (
  id             uuid primary key default gen_random_uuid(),
  name           text not null check (length(trim(name)) > 0),
  -- The auth user who created the household (the initial owner). Not a FK to
  -- a member (members reference households, not vice-versa) to avoid a cycle;
  -- it points at auth.users.
  owner_id       uuid not null references auth.users (id) on delete restrict,
  timezone       text not null default 'America/Los_Angeles',
  -- ISO weekday the planning week starts on (1 = Monday, per ADR 0003).
  week_start_day smallint not null default 1 check (week_start_day between 0 and 6),
  created_at     timestamptz not null default now()
);

-- Links Supabase auth users to a household. (household_id, user_id) is unique:
-- a given user appears at most once per household.
create table public.members (
  id           uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households (id) on delete cascade,
  user_id      uuid not null references auth.users (id) on delete cascade,
  display_name text not null check (length(trim(display_name)) > 0),
  role         public.member_role not null default 'member',
  avatar       text,
  created_at   timestamptz not null default now(),
  unique (household_id, user_id)
);

create index members_household_id_idx on public.members (household_id);
create index members_user_id_idx on public.members (user_id);

-- Single-use, expiring invite links/short codes for joining a household.
create table public.invites (
  id           uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households (id) on delete cascade,
  token        text not null unique check (length(trim(token)) > 0),
  created_by   uuid not null references auth.users (id) on delete restrict,
  expires_at   timestamptz not null default (now() + interval '7 days'),
  consumed_at  timestamptz,
  consumed_by  uuid references auth.users (id) on delete set null,
  created_at   timestamptz not null default now(),
  -- consumed_at and consumed_by are set together or not at all.
  check (
    (consumed_at is null and consumed_by is null)
    or (consumed_at is not null and consumed_by is not null)
  )
);

create index invites_household_id_idx on public.invites (household_id);

-- ===========================================================================
-- SECURITY DEFINER helpers (the single household-scoping chokepoint).
-- ===========================================================================

-- The household the calling user belongs to, or NULL if they belong to none.
-- SECURITY DEFINER => runs as the function owner and bypasses RLS on
-- `members`, which is what lets policies ON `members` call it without
-- recursing. `search_path` is pinned empty + schema-qualified names to keep
-- the definer-rights function from being hijacked by a caller search_path.
create function public.current_household_id()
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select household_id
  from public.members
  where user_id = (select auth.uid())
  limit 1;
$$;

-- Whether the calling user is the OWNER of their household. Used by the
-- owner-only policies (invite create/delete, member removal).
create function public.is_household_owner()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.members
    where user_id = (select auth.uid())
      and role = 'owner'
  );
$$;

-- Consume an invite as part of joining a household. SECURITY DEFINER because
-- the joining user is not yet a member (so RLS would hide the invite from
-- them) and must atomically validate + stamp the row. Rejects expired or
-- already-consumed tokens at the data layer (single-use + expiry). Returns
-- the household_id the (now-consumed) invite grants access to.
create function public.consume_invite(p_token text)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_household_id uuid;
  v_uid uuid := (select auth.uid());
begin
  if v_uid is null then
    raise exception 'consume_invite: not authenticated'
      using errcode = '28000';
  end if;

  -- Lock the row so two concurrent joins can't both consume a single-use
  -- token. FOR UPDATE serializes them; the second sees consumed_at set.
  select household_id into v_household_id
  from public.invites
  where token = p_token
  for update;

  if v_household_id is null then
    raise exception 'consume_invite: invalid token'
      using errcode = '22023';
  end if;

  if exists (
    select 1 from public.invites
    where token = p_token and consumed_at is not null
  ) then
    raise exception 'consume_invite: token already consumed'
      using errcode = '22023';
  end if;

  if exists (
    select 1 from public.invites
    where token = p_token and expires_at <= now()
  ) then
    raise exception 'consume_invite: token expired'
      using errcode = '22023';
  end if;

  update public.invites
  set consumed_at = now(),
      consumed_by = v_uid
  where token = p_token;

  return v_household_id;
end;
$$;

-- Lock the helpers down: only authenticated users may call them (never anon).
revoke all on function public.current_household_id() from public;
revoke all on function public.is_household_owner() from public;
revoke all on function public.consume_invite(text) from public;
grant execute on function public.current_household_id() to authenticated;
grant execute on function public.is_household_owner() to authenticated;
grant execute on function public.consume_invite(text) to authenticated;

-- ===========================================================================
-- Table privileges for the Data API roles.
-- ===========================================================================
-- RLS decides WHICH ROWS a role may touch; table-level GRANTs decide whether
-- the role may touch the table at all. With auto-expose disabled (config.toml),
-- new tables are not auto-granted, so we grant explicitly. `anon` gets nothing
-- (the whole app is private to authenticated household members). No table-level
-- INSERT/UPDATE on invites: those happen only through the SECURITY DEFINER
-- functions, so we keep the surface minimal (SELECT + owner-gated INSERT/DELETE
-- via policy still require the grant below).
grant select, insert, update, delete on public.households to authenticated;
grant select, insert, update, delete on public.members to authenticated;
grant select, insert, delete on public.invites to authenticated;

-- ===========================================================================
-- Row Level Security
-- ===========================================================================
-- Enable + FORCE so even a table owner is subject to policy (defense in
-- depth; we never want an accidental owner-context query to leak across
-- households).
alter table public.households enable row level security;
alter table public.households force row level security;
alter table public.members enable row level security;
alter table public.members force row level security;
alter table public.invites enable row level security;
alter table public.invites force row level security;

-- ---- households -----------------------------------------------------------
-- Members of a household can see + edit it. No INSERT policy here: household
-- creation is a SECURITY DEFINER bootstrap (the auth slice) — a brand-new
-- user has no household yet, so a self-referential INSERT policy can't work.
create policy households_select on public.households
  for select to authenticated
  using (id = public.current_household_id());

create policy households_update on public.households
  for update to authenticated
  using (id = public.current_household_id())
  with check (id = public.current_household_id());

-- ---- members --------------------------------------------------------------
-- Everyone in the household can read all members. Calling current_household_id()
-- here is safe (no recursion) precisely because the helper is SECURITY DEFINER.
create policy members_select on public.members
  for select to authenticated
  using (household_id = public.current_household_id());

-- A member may update their own row (e.g. display_name / avatar) and an owner
-- may update any member in their household.
create policy members_update on public.members
  for update to authenticated
  using (
    household_id = public.current_household_id()
    and (user_id = (select auth.uid()) or public.is_household_owner())
  )
  with check (
    household_id = public.current_household_id()
    and (user_id = (select auth.uid()) or public.is_household_owner())
  );

-- Only an owner may remove a member, and only within their own household.
create policy members_delete on public.members
  for delete to authenticated
  using (
    household_id = public.current_household_id()
    and public.is_household_owner()
  );

-- ---- invites --------------------------------------------------------------
-- Household members can see their household's invites (e.g. to show pending
-- invite links).
create policy invites_select on public.invites
  for select to authenticated
  using (household_id = public.current_household_id());

-- Only an owner may create invites, and only for their own household.
create policy invites_insert on public.invites
  for insert to authenticated
  with check (
    household_id = public.current_household_id()
    and public.is_household_owner()
  );

-- Only an owner may delete (revoke) invites in their household.
create policy invites_delete on public.invites
  for delete to authenticated
  using (
    household_id = public.current_household_id()
    and public.is_household_owner()
  );

-- NOTE: there is deliberately no UPDATE policy on invites. Consumption is a
-- single, audited path through public.consume_invite() (SECURITY DEFINER);
-- direct UPDATEs by clients are not allowed, so consumed_at/consumed_by
-- cannot be forged or reset from the data API.