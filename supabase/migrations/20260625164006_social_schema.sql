-- Migration: social_schema (slice 1b, issue #7)
--
-- The data foundation for the social planning loop (SPEC "Data Model" +
-- "Deliberate modeling choices"; ADR 0003). Serves #8 (week board), #9
-- (reactions/comments/Realtime) and #10 (slotting). Pure schema + RLS — the
-- user-facing capabilities live in those sibling issues.
--
-- Tables: dishes, weeks, slots, slot_dishes, proposals, reactions, comments.
--
-- Security / modeling design of record:
--   * Every table is RLS enabled + FORCEd and scoped through the SINGLE 1a
--     chokepoint `public.current_household_id()` (SECURITY DEFINER). We REUSE
--     that helper — no new helper is introduced.
--   * `household_id` is DENORMALIZED onto every child table (slots, slot_dishes,
--     proposals, reactions, comments) so each RLS policy is a DIRECT
--     `household_id = public.current_household_id()` check — never a join through
--     the parent (ADR 0003 RLS section).
--   * To keep that denormalized `household_id` honest, children reference their
--     parent via a COMPOSITE foreign key `(parent_id, household_id) ->
--     parent(id, household_id)`. FK checks bypass RLS, so without this a client
--     could (within their own household) tag a child row to a parent in another
--     household; the composite FK makes a cross-household parent link impossible
--     and guarantees a child's household_id always equals its parent's. This
--     requires a `unique (id, household_id)` on each parent (added below; `id`
--     is already unique, so this only enables the composite reference).
--   * All members share the household's data (board, library, list), so the
--     social tables use simple household-scoped policies for SELECT/INSERT/
--     UPDATE/DELETE (anyone in the household can propose, react, comment, slot).
--     Per-author edit/delete restrictions are deliberately NOT modeled here —
--     SPEC treats this as shared family data; tightening is a later concern.
--   * `dishes` (reusable library) and `proposals` (this-week pool) are DISTINCT:
--     recycling a dish = a new `proposals` row pointing at an existing `dishes`
--     row. `slot_dishes` composes MANY dishes into one slot. `tags[]` on dishes
--     is free-text (no taxonomy table — ADR 0003).

-- ===========================================================================
-- Enum: meal occasion. Dinner-focused MVP, but the model supports the full set
-- so we're not boxed in (SPEC "Weekly menu board").
-- ===========================================================================
create type public.meal_type as enum ('breakfast', 'lunch', 'dinner', 'snack');

-- ===========================================================================
-- Enable the composite (id, household_id) reference target on members FIRST,
-- so the reactions FK below can bind a reactor to the same household. (members
-- already has pk(id) + unique(user_id); this adds the composite key. It must
-- exist before any table references it.)
-- ===========================================================================
alter table public.members add constraint members_id_household_id_key
  unique (id, household_id);

-- ===========================================================================
-- dishes — the reusable dish LIBRARY (one preparable component: spaghetti,
-- salad, sauce). Top-level: household_id references households directly.
-- ===========================================================================
create table public.dishes (
  id            uuid primary key default gen_random_uuid(),
  household_id  uuid not null references public.households (id) on delete cascade,
  title         text not null check (length(trim(title)) > 0),
  description   text,
  source_url    text,
  image_url     text,
  -- Free-text tags (health/other). No taxonomy table until it earns its keep.
  tags          text[] not null default '{}',
  prep_minutes  integer check (prep_minutes  is null or prep_minutes  >= 0),
  cook_minutes  integer check (cook_minutes  is null or cook_minutes  >= 0),
  total_minutes integer check (total_minutes is null or total_minutes >= 0),
  -- Who added it. Members can come and go; keep the dish if they leave.
  created_by    uuid,
  created_at    timestamptz not null default now(),
  -- Composite attribution FK: the creator must be in the SAME household as the
  -- dish (parity with reactions.member_id). On member delete, null ONLY
  -- created_by (PG15+ column-list SET NULL) so the NOT NULL household_id and
  -- the dish itself survive.
  foreign key (created_by, household_id)
    references public.members (id, household_id) on delete set null (created_by),
  -- Enables the composite (id, household_id) FK references from children.
  unique (id, household_id)
);

create index dishes_household_id_idx on public.dishes (household_id);

-- ===========================================================================
-- weeks — a planning week. Lazy upsert on first board access (ADR 0003), so
-- UNIQUE(household_id, start_date) makes that idempotent (one row per week).
-- ===========================================================================
create table public.weeks (
  id           uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households (id) on delete cascade,
  start_date   date not null,
  created_at   timestamptz not null default now(),
  unique (household_id, start_date),
  -- Enables the composite (id, household_id) FK references from children.
  unique (id, household_id)
);

create index weeks_household_id_idx on public.weeks (household_id);

-- ===========================================================================
-- slots — a meal occasion on the board (e.g. Tuesday dinner). Child of weeks;
-- household_id denormalized + composite FK back to the parent week.
-- ===========================================================================
create table public.slots (
  id           uuid primary key default gen_random_uuid(),
  household_id uuid not null,
  week_id      uuid not null,
  meal_type    public.meal_type not null,
  day_of_week  smallint not null check (day_of_week between 0 and 6),
  position     integer not null default 0,
  created_at   timestamptz not null default now(),
  foreign key (week_id, household_id)
    references public.weeks (id, household_id) on delete cascade,
  -- Enables the composite (id, household_id) FK references from slot_dishes.
  unique (id, household_id)
);

create index slots_household_id_idx on public.slots (household_id);
create index slots_week_id_idx on public.slots (week_id);

-- ===========================================================================
-- slot_dishes — composes MANY dishes into one slot/meal (spaghetti + salad).
-- Child of both slots and dishes; household_id denormalized + composite FKs to
-- both parents. `prep_minutes_override` is RESERVED (post-MVP, no UI) for the
-- "sauce already made" per-occasion case (SPEC out-of-scope list).
-- ===========================================================================
create table public.slot_dishes (
  id                    uuid primary key default gen_random_uuid(),
  household_id          uuid not null,
  slot_id               uuid not null,
  dish_id               uuid not null,
  position              integer not null default 0,
  prep_minutes_override integer check (prep_minutes_override is null or prep_minutes_override >= 0),
  created_at            timestamptz not null default now(),
  foreign key (slot_id, household_id)
    references public.slots (id, household_id) on delete cascade,
  foreign key (dish_id, household_id)
    references public.dishes (id, household_id) on delete cascade
);

create index slot_dishes_household_id_idx on public.slot_dishes (household_id);
create index slot_dishes_slot_id_idx on public.slot_dishes (slot_id);
create index slot_dishes_dish_id_idx on public.slot_dishes (dish_id);

-- ===========================================================================
-- proposals — a dish put forward for THIS week's pool. Distinct from dishes:
-- recycling = a new proposal pointing at an existing dish. Child of weeks and
-- dishes; household_id denormalized + composite FKs to both parents.
-- ===========================================================================
create table public.proposals (
  id           uuid primary key default gen_random_uuid(),
  household_id uuid not null,
  week_id      uuid not null,
  dish_id      uuid not null,
  -- Who proposed it. Keep the proposal if the member leaves.
  proposed_by  uuid,
  note         text,
  created_at   timestamptz not null default now(),
  foreign key (week_id, household_id)
    references public.weeks (id, household_id) on delete cascade,
  foreign key (dish_id, household_id)
    references public.dishes (id, household_id) on delete cascade,
  -- Composite attribution FK: the proposer must be in the SAME household. On
  -- member delete, null ONLY proposed_by so the proposal + household_id survive.
  foreign key (proposed_by, household_id)
    references public.members (id, household_id) on delete set null (proposed_by),
  -- Enables the composite (id, household_id) FK references from reactions/comments.
  unique (id, household_id)
);

create index proposals_household_id_idx on public.proposals (household_id);
create index proposals_week_id_idx on public.proposals (week_id);
create index proposals_dish_id_idx on public.proposals (dish_id);

-- ===========================================================================
-- reactions — a social signal (emoji) on a proposal. Child of proposals;
-- household_id denormalized + composite FK to the parent proposal AND to the
-- reacting member (so a reactor is always in the same household). UNIQUE
-- (proposal_id, member_id, kind) makes a reaction toggle idempotent (ADR 0003).
-- ===========================================================================
create table public.reactions (
  id           uuid primary key default gen_random_uuid(),
  household_id uuid not null,
  proposal_id  uuid not null,
  member_id    uuid not null,
  kind         text not null check (length(trim(kind)) > 0),
  created_at   timestamptz not null default now(),
  foreign key (proposal_id, household_id)
    references public.proposals (id, household_id) on delete cascade,
  foreign key (member_id, household_id)
    references public.members (id, household_id) on delete cascade,
  unique (proposal_id, member_id, kind)
);

create index reactions_household_id_idx on public.reactions (household_id);
create index reactions_proposal_id_idx on public.reactions (proposal_id);
create index reactions_member_id_idx on public.reactions (member_id);

-- ===========================================================================
-- comments — discussion on a proposal. Child of proposals; household_id
-- denormalized + composite FK to the parent proposal. member_id is nullable
-- (keep the discussion if the author leaves).
-- ===========================================================================
create table public.comments (
  id           uuid primary key default gen_random_uuid(),
  household_id uuid not null,
  proposal_id  uuid not null,
  member_id    uuid,
  body         text not null check (length(trim(body)) > 0),
  created_at   timestamptz not null default now(),
  foreign key (proposal_id, household_id)
    references public.proposals (id, household_id) on delete cascade,
  -- Composite attribution FK: the author must be in the SAME household. On
  -- member delete, null ONLY member_id so the comment + household_id survive.
  foreign key (member_id, household_id)
    references public.members (id, household_id) on delete set null (member_id)
);

create index comments_household_id_idx on public.comments (household_id);
create index comments_proposal_id_idx on public.comments (proposal_id);
create index comments_member_id_idx on public.comments (member_id);

-- ===========================================================================
-- Table privileges for the Data API roles (auto-expose is disabled in
-- config.toml, so new tables are NOT auto-granted — grant explicitly, mirroring
-- the 1a identity migration). `anon` gets nothing: the whole app is private to
-- authenticated household members. RLS (below) decides WHICH rows; these grants
-- decide whether the role may touch the table at all.
-- ===========================================================================
grant select, insert, update, delete on public.dishes      to authenticated;
grant select, insert, update, delete on public.weeks       to authenticated;
grant select, insert, update, delete on public.slots       to authenticated;
grant select, insert, update, delete on public.slot_dishes to authenticated;
grant select, insert, update, delete on public.proposals   to authenticated;
grant select, insert, update, delete on public.reactions   to authenticated;
grant select, insert, update, delete on public.comments    to authenticated;

-- ===========================================================================
-- Row Level Security — enable + FORCE on every table (owner not exempt;
-- defense in depth, matching 1a).
-- ===========================================================================
alter table public.dishes      enable row level security;
alter table public.dishes      force  row level security;
alter table public.weeks       enable row level security;
alter table public.weeks       force  row level security;
alter table public.slots       enable row level security;
alter table public.slots       force  row level security;
alter table public.slot_dishes enable row level security;
alter table public.slot_dishes force  row level security;
alter table public.proposals   enable row level security;
alter table public.proposals   force  row level security;
alter table public.reactions   enable row level security;
alter table public.reactions   force  row level security;
alter table public.comments    enable row level security;
alter table public.comments    force  row level security;

-- ---------------------------------------------------------------------------
-- Policies. Every table is shared household data: any authenticated member of
-- the household may read and write its rows. Each policy is a DIRECT
-- `household_id = public.current_household_id()` check (ADR 0003 — denormalized
-- household_id, no parent join). UPDATE policies repeat the check in WITH CHECK
-- so a row can't be moved to another household.
-- ---------------------------------------------------------------------------

-- ---- dishes ----
create policy dishes_select on public.dishes
  for select to authenticated
  using (household_id = public.current_household_id());
create policy dishes_insert on public.dishes
  for insert to authenticated
  with check (household_id = public.current_household_id());
create policy dishes_update on public.dishes
  for update to authenticated
  using (household_id = public.current_household_id())
  with check (household_id = public.current_household_id());
create policy dishes_delete on public.dishes
  for delete to authenticated
  using (household_id = public.current_household_id());

-- ---- weeks ----
create policy weeks_select on public.weeks
  for select to authenticated
  using (household_id = public.current_household_id());
create policy weeks_insert on public.weeks
  for insert to authenticated
  with check (household_id = public.current_household_id());
create policy weeks_update on public.weeks
  for update to authenticated
  using (household_id = public.current_household_id())
  with check (household_id = public.current_household_id());
create policy weeks_delete on public.weeks
  for delete to authenticated
  using (household_id = public.current_household_id());

-- ---- slots ----
create policy slots_select on public.slots
  for select to authenticated
  using (household_id = public.current_household_id());
create policy slots_insert on public.slots
  for insert to authenticated
  with check (household_id = public.current_household_id());
create policy slots_update on public.slots
  for update to authenticated
  using (household_id = public.current_household_id())
  with check (household_id = public.current_household_id());
create policy slots_delete on public.slots
  for delete to authenticated
  using (household_id = public.current_household_id());

-- ---- slot_dishes ----
create policy slot_dishes_select on public.slot_dishes
  for select to authenticated
  using (household_id = public.current_household_id());
create policy slot_dishes_insert on public.slot_dishes
  for insert to authenticated
  with check (household_id = public.current_household_id());
create policy slot_dishes_update on public.slot_dishes
  for update to authenticated
  using (household_id = public.current_household_id())
  with check (household_id = public.current_household_id());
create policy slot_dishes_delete on public.slot_dishes
  for delete to authenticated
  using (household_id = public.current_household_id());

-- ---- proposals ----
create policy proposals_select on public.proposals
  for select to authenticated
  using (household_id = public.current_household_id());
create policy proposals_insert on public.proposals
  for insert to authenticated
  with check (household_id = public.current_household_id());
create policy proposals_update on public.proposals
  for update to authenticated
  using (household_id = public.current_household_id())
  with check (household_id = public.current_household_id());
create policy proposals_delete on public.proposals
  for delete to authenticated
  using (household_id = public.current_household_id());

-- ---- reactions ----
create policy reactions_select on public.reactions
  for select to authenticated
  using (household_id = public.current_household_id());
create policy reactions_insert on public.reactions
  for insert to authenticated
  with check (household_id = public.current_household_id());
create policy reactions_update on public.reactions
  for update to authenticated
  using (household_id = public.current_household_id())
  with check (household_id = public.current_household_id());
create policy reactions_delete on public.reactions
  for delete to authenticated
  using (household_id = public.current_household_id());

-- ---- comments ----
create policy comments_select on public.comments
  for select to authenticated
  using (household_id = public.current_household_id());
create policy comments_insert on public.comments
  for insert to authenticated
  with check (household_id = public.current_household_id());
create policy comments_update on public.comments
  for update to authenticated
  using (household_id = public.current_household_id())
  with check (household_id = public.current_household_id());
create policy comments_delete on public.comments
  for delete to authenticated
  using (household_id = public.current_household_id());
