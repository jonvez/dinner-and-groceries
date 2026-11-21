# MCP companion v1: implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A local stdio MCP server through which an AI assistant, signed in as its own owner-approved
household member, reads and writes recipes, week proposals and groceries under the app's normal RLS.

**Architecture:**
- **Database.** Assistant identity lives in the database: assistant-kind invites, an `app_metadata`
  marker on assistant auth users, an `assistant_requests` table, and three definer RPCs
  (request / approve / deny).
- **App.** Gains a `/household` screen (members + badge, owner approve/deny/remove) and drops
  assistants from the family dashboard.
- **MCP server.** `mcp/` is a separate npm package that runs the repo's TypeScript cores directly
  under Node type-stripping plus a small path-alias loader. Its tools are thin wrappers over the
  existing domain functions.

**Tech stack:**
- Next.js 16.4.3 App Router, with Supabase (Postgres + RLS + pgTAP) and supabase-js 2.118.0.
- Vitest 5 and Playwright 1.64.
- Node ≥ 22.18, `@modelcontextprotocol/sdk` 1.32.2, and zod.

**Spec:** `docs/superpowers/specs/2026-11-11-mcp-companion-design.md`. The "Builder-check
resolutions" section overrides the body.

## Global constraints

- **Migrations are expand-only** (ADR 0015): they auto-apply to prod before deploy, and the old
  container must work against the new schema.
  - `alter type public.member_role add value 'assistant'` goes in its **own** migration file.
- **Every new SQL function:**
  - `set search_path = ''` and `revoke all … from public`;
  - `grant execute … to authenticated` only if a client calls it directly;
  - `security definer` only where this plan says so.
- **Raw Postgres or PostgREST error text is never shown** to a user or returned from a tool. Map it
  to a friendly message.
- **No service-role key** in app code, the MCP server, or anything committed. The only exceptions:
  - the local-stack test setup (Task 7's E2E helper and Task 13's integration test);
  - both read the key from env.
- **MCP dependency hardening:**
  - `@modelcontextprotocol/sdk` pinned **exactly** `1.32.2` in `mcp/package.json`;
  - its own `mcp/package-lock.json`, installed with `npm ci --ignore-scripts --prefix mcp`;
  - `mcp/` is listed in `.dockerignore` and excluded from the root `tsconfig.json`, so it never
    enters the Next build or the production image.
- **Secrets** (assistant password, refresh token, session) live only in the macOS Keychain via
  `/usr/bin/security`.
  - They go in on **stdin** (`security -i`), never argv.
  - They are never logged and never written to disk.
  - The MCP server writes logs to stderr only, since stdout is the protocol.
- **The badge copy is exactly `Assistant`.**
- **`supabase/config.toml` keeps email sign-up enabled.** *(planner's call, deviating from the
  spec's "mirror in config.toml")*
  - The local E2E seed signs users up with email/password (`e2e/support/seed.ts`), so disabling it
    locally breaks CI.
  - Prod's toggle is a dashboard change documented in the runbook.
  - Never run `supabase config push`.
- **Git:**
  - a feature branch per PR, never `main`;
  - explicit `git add <paths>`, never `-A`;
  - conventional commits;
  - author email `3476020+jonvez@users.noreply.github.com`.
- **Regenerate types** after any migration: `npm run db:types` (local stack up).
- **PR slicing:**
  - **PR 1** = Tasks 1–2 (DB);
  - **PR 2** = Tasks 3–7 (app);
  - **PR 3** = Tasks 8–14 (MCP).

  Each PR gets a non-author security review before merge. PR 1's migrations reach prod on merge.

## Review focus

The tests for each item below are added in the owning task.

1. **A setup run with the wrong invite** must fail clearly **without burning the invite**:
   - a member-kind invite;
   - an expired or consumed invite;
   - a typo.

   So `request_assistant_membership` checks `kind` *before* `consume_invite`. *(Task 2)*
2. **A double-clicked Approve, or Approve after Deny,** must not create two members or flip a
   decision. A second decision raises "already decided". *(Task 2)*
3. **An assistant whose membership was removed,** or whose refresh token was revoked or expired, must
   get one actionable message ("not an approved member… ask the owner" / "run setup again"). It must
   never get a stack trace or raw auth error. *(Tasks 9, 11)*
4. **A missing Keychain item, a locked keychain or a `security` failure** yields "Run setup first"
   and never echoes the value it was trying to store. *(Task 9)*
5. **`save_recipe` with an id from another household, or a nonexistent id,** answers "No recipe with
   that id in this household." It does not create a new dish or leak the P0002 text. *(Task 12)*

---

## PR 1: database

### Task 1: Assistant markers on invites and accounts (R1)

**Files:**
- Create: `supabase/migrations/20261112120000_member_role_assistant.sql`
- Create: `supabase/migrations/20261112120100_assistant_markers.sql`
- Create: `supabase/tests/27_assistant_markers_test.sql`
- Modify: `app/join/actions-core.ts` (`generateInvite`), `app/join/actions-core.test.ts`
- Modify: `lib/database.types.ts` (regenerated)

**Interfaces:**
- Produces:
  - **SQL:**
    - `public.member_role` gains `'assistant'`;
    - `public.invites.kind text not null default 'member' check (kind in ('member','assistant'))`;
    - `public.is_assistant_account() returns boolean`: `stable`, `security definer`, **not** granted
      to anyone (it's called only from definer RPCs). True iff
      `auth.users.raw_app_meta_data->>'kind' = 'assistant'` for `auth.uid()`.
  - **TS:**
    `generateInvite(supabase, { householdId, createdBy, kind?: "member" | "assistant", mintToken? })`.
    `kind` defaults to `"member"` and is written to `invites.kind`.

- [ ] **Step 1: Write the failing pgTAP tests in `27_assistant_markers_test.sql`.**
  - Follow `05_household_bootstrap_test.sql` for impersonation.
  - Create the assistant user by inserting into `auth.users` with
    `raw_app_meta_data = '{"provider":"email","kind":"assistant"}'`.
  - The six R1 combinations:
    - human + member invite → `accept_invite` succeeds (`lives_ok`);
    - human + assistant invite → `accept_invite` `throws_ok` `22023`, and the invite's `consumed_at`
      is still null afterwards;
    - assistant account + member invite → `accept_invite` `throws_ok` `42501`;
    - assistant account + assistant invite → `accept_invite` `throws_ok` `42501`;
    - assistant account → `create_household` `throws_ok` `42501`;
    - human → `create_household` `lives_ok`.
  - Plus:
    - `has_column('invites','kind')`;
    - the default is `'member'`;
    - the check rejects `'robot'` (`23514`);
    - `is_assistant_account` is not executable by `authenticated` (`function_privs_are` or
      `throws_ok '42501'`).
- [ ] **Step 2: Run `npx supabase test db --local`.** Expected: 27 fails (no column or function).
- [ ] **Step 3: Write the two migrations.**
  - `…120000` is only the `alter type … add value 'assistant'`.
  - `…120100` contains:
    - the column;
    - `is_assistant_account()`;
    - `create or replace` of `accept_invite` and `create_household` (same signatures; the existing
      grants persist).
  - Their new guards:
    - the caller is an assistant account → `raise … using errcode = '42501'`, in both functions,
      first after the auth check;
    - `accept_invite`: the token's invite has `kind = 'assistant'` → raise `22023`
      `'accept_invite: invalid token'`. This runs **before** `consume_invite`.
- [ ] **Step 4: Run `npx supabase db reset --local && npx supabase test db --local`.** Expected: all
  pass, including the existing `05`/`03`/`04` tests.
- [ ] **Step 5: Update `generateInvite` and regenerate types.**
  - Write a failing vitest in `app/join/actions-core.test.ts`: `generateInvite(..., { kind:
    "assistant" })` inserts `kind: "assistant"`; omitted → `kind: "member"`.
  - Add the `kind` param.
  - Run `npm run db:types`, then `npm test -- app/join`. Expected: PASS.
- [ ] **Step 6: Commit** (`feat(db): assistant invite kind and account marker`), with the files
  above.

### Task 2: Assistant requests, approval RPCs, invites hidden from assistants (identity flow, R2, R5)

**Files:**
- Create: `supabase/migrations/20261112120200_assistant_requests.sql`
- Create: `supabase/tests/28_assistant_requests_test.sql`
- Modify: `supabase/tests/21_table_grants_test.sql` and `23_default_privileges_test.sql`, only if
  they enumerate tables and need the new one
- Modify: `lib/database.types.ts`

**Interfaces:**
- Consumes: Task 1's `is_assistant_account()`, `invites.kind`, and the enum value.
- Produces:
  - **The table:**
    ```
    public.assistant_requests(
      id uuid pk default gen_random_uuid(),
      household_id uuid not null → households on delete cascade,
      user_id uuid not null → auth.users on delete cascade,
      display_name text not null check (length(trim(display_name)) between 1 and 60),
      requester_email text,
      requested_at timestamptz not null default now(),
      decision text check (decision in ('approved','denied')),
      decided_at timestamptz,
      decided_by uuid → auth.users on delete set null,
      check ((decision is null) = (decided_at is null)))
    ```
    - A unique partial index on `(user_id) where decision is null`.
    - FORCE RLS.
    - Select policy: `(household_id = current_household_id() and is_household_owner()) or user_id =
      auth.uid()`.
    - `grant select` to `authenticated` only; no insert/update/delete grants.
  - **`public.is_household_assistant() returns boolean`:** `stable`, `security definer`, granted to
    `authenticated`. It mirrors `is_household_owner()` with `role = 'assistant'`.
  - **`invites_select`** is recreated as `household_id = current_household_id() and not
    is_household_assistant()`.
  - **The RPCs:** all `security definer`, `revoke … from public`, `grant execute … to authenticated`.

    | Signature | Returns | Error codes |
    |---|---|---|
    | `request_assistant_membership(p_token text, p_display_name text)` | the request id (`uuid`) | `28000`, `42501`, `23505`, `22023` |
    | `approve_assistant_request(p_request_id uuid)` | the new `members.id` (`uuid`) | `28000`, `P0002`, `42501`, `22023` |
    | `deny_assistant_request(p_request_id uuid)` | `void` | `28000`, `P0002`, `42501`, `22023` |

  - **The order of checks in `request_assistant_membership`:**
    1. authenticated, else `28000`;
    2. `is_assistant_account()`, else `42501`;
    3. not already a member, else `23505`;
    4. no pending request, else `23505`;
    5. a trimmed display name of 1–60 characters, else `22023`;
    6. the invite exists with `kind = 'assistant'`, else `22023` `invalid token`, **before
       consuming**;
    7. `consume_invite(p_token)`;
    8. insert, with `requester_email` from `auth.users.email`.
  - **Approve/deny:**
    1. lock the request `for update`, where `household_id = current_household_id()`; a missing row
       raises `P0002` (this also hides other households);
    2. `is_household_owner()`, else `42501`;
    3. `decision is null`, else `22023 'already decided'`;
    4. approve inserts `members(household_id, user_id, display_name, role='assistant')`, then stamps
       `decision`, `decided_at` and `decided_by`. Deny only stamps.

- [ ] **Step 1: Write the failing pgTAP tests in `28_assistant_requests_test.sql`.**
  - **request:**
    - consumes the invite;
    - creates no `members` row;
    - the request row carries `requester_email`;
    - a second call with a new invite → `23505` (pending);
    - a caller who is already a member → `23505`;
    - a human caller → `42501`;
    - a member-kind invite → `22023`, **and that invite is still unconsumed** (Review focus 1);
    - an expired invite → `22023`;
    - a 61-character name → `22023`.
  - **approve:**
    - the owner succeeds, and a `members` row exists with `role = 'assistant'`;
    - approving again → `22023` (Review focus 2);
    - deny after approve → `22023`;
    - a plain member calling it → `42501`;
    - an owner of another household → `P0002`.
  - **deny:**
    - stamps `denied`;
    - no member;
    - the assistant can then request again with a fresh invite.
  - **Once the assistant is a member:**
    - `select count(*) from invites` = 0 for the assistant, while the owner and a member still see
      their rows (R2);
    - the assistant `update members set role='owner'` on its own row is denied (column grant);
    - `insert into invites` → `42501`;
    - `delete from members` affects 0 rows.
  - **`assistant_requests` RLS:**
    - the owner sees all requests;
    - the requester sees only its own;
    - a plain member sees none;
    - an `insert` attempt → `42501`.
  - **anon** has no execute on the three RPCs.
- [ ] **Step 2: Run `npx supabase test db --local`.** Expected: 28 fails.
- [ ] **Step 3: Write the migration** to the interface above.
- [ ] **Step 4: Run `npx supabase db reset --local && npx supabase test db --local`.** Expected: all
  pass, including `21`/`23` (extend them if they enumerate tables), then `npm run db:types`.
- [ ] **Step 5: Commit** (`feat(db): assistant membership requests with owner approval`).
- [ ] **Step 6: Open PR 1** (Tasks 1–2) and dispatch the non-author security review against it, then
  merge on green and an approving review.

---

## PR 2: app

### Task 3: Dashboard excludes assistants (R4)

**Files:**
- Modify: `lib/analytics/dashboard.ts` (`loadDashboardSummary`)
- Test: `lib/analytics/dashboard.test.ts`

**Interfaces:**
- Produces: `loadDashboardSummary` selects `members(id, display_name, role)`. Before calling
  `summarizeDashboard`, it drops:
  - members with `role = 'assistant'`, from the roster;
  - **every event whose `member_id` is an assistant's**, from the events.

  Without the second drop, the existing rule "a member_id not on the roster counts toward the
  totals" would still count assistant activity.

- [ ] **Step 1: Failing test.** `loadDashboardSummary` with a fake client returning:
  - members `[owner, teen, {id:"a1", role:"assistant"}]`;
  - events including two `proposal_created` events by `a1`.

  Assert that `a1` is absent from participation, and that the totals equal the totals computed
  without `a1`'s events.
- [ ] **Step 2: Run `npm test -- lib/analytics/dashboard`.** Expected: FAIL.
- [ ] **Step 3: Implement the filter.**
- [ ] **Step 4: Run it again.** Expected: PASS.
- [ ] **Step 5: Commit** (`feat(dashboard): leave assistants out of family participation`).

### Task 4: Pure week loader and the board badge

**Files:**
- Create: `app/board/week-core.ts`, `app/board/week-core.test.ts`
- Modify:
  - `app/board/page.tsx` (sections 4–5 become one `loadWeekBoard` call);
  - `app/board/proposal-pool.tsx`;
  - `app/board/board-grid.tsx`.

  The types move out of the `.tsx` files, which re-export them. The proposer badge renders.
- Create: `components/assistant-badge.tsx`

**Interfaces:**
- Produces:
  - `export type ProposalView` (the existing fields plus `proposerIsAssistant: boolean`) and
    `export type SlottedDishView`, moved into `week-core.ts`.
  - `export type MemberView = { id: string; displayName: string; userId: string; role: "owner" |
    "member" | "assistant" }`.
  - `export type WeekBoard = { proposals: ProposalView[]; slotted: SlottedDishView[]; members:
    MemberView[]; reactions: ReactionRow[]; comments: CommentRow[] }`. `ReactionRow` and
    `CommentRow` are imported as types from where they're defined today.
  - `export async function loadWeekBoard(supabase: Pick<DbClient, "from">, weekId: string):
    Promise<WeekBoard>`, with exactly today's queries, plus `role` on the proposer join and on the
    members select.
  - `export function AssistantBadge(): JSX.Element`: a small pill with the text `Assistant`.

- [ ] **Step 1: Failing test in `week-core.test.ts`.**
  - With a fake client: a proposal whose proposer has `role: "assistant"` → `proposerIsAssistant ===
    true`.
  - Reactions and comments are fetched only when proposals exist: an empty pool makes zero calls to
    `reactions`.
- [ ] **Step 2: Run `npm test -- app/board/week-core`.** Expected: FAIL.
- [ ] **Step 3: Implement `loadWeekBoard`** and switch `page.tsx` to it.
- [ ] **Step 4: Add the badge** to the proposer line in `proposal-pool.tsx`.
- [ ] **Step 5: Run the gates.** `npm test && npm run typecheck && npm run lint`. Expected: green.
  The existing board E2E covers the refactor in CI.
- [ ] **Step 6: Commit** (`refactor(board): extract loadWeekBoard; badge assistant proposers`).

### Task 5: Household core (members, requests, approve/deny/remove)

**Files:**
- Create: `app/household/household-core.ts`, `app/household/household-core.test.ts`
- Modify: `app/grocery/actions.ts` → move `MAX_NAME_LENGTH` (200) and `MAX_UNIT_LENGTH` (40) into
  `app/grocery/mutations-core.ts`, exported as `MAX_ITEM_NAME_LENGTH` and `MAX_ITEM_UNIT_LENGTH`
  (Task 12 needs them). The action imports them.

**Interfaces:**
- Consumes:
  - `MemberView` (Task 4);
  - Task 2's RPCs and `assistant_requests`.
- Produces:
  - `export type HouseholdView = { members: MemberView[]; pending: PendingRequest[] }`
  - `export type PendingRequest = { id: string; displayName: string; requesterEmail: string | null;
    requestedAt: string }`
  - `export async function loadHousehold(supabase: Pick<DbClient,"from">):
    Promise<HouseholdView>`. Members are ordered owner first, then by name. `pending` is
    `assistant_requests where decision is null`, oldest first (RLS returns none to non-owners).
  - `export async function approveRequest(supabase: Pick<DbClient,"rpc">, requestId: string):
    Promise<ActionResult<{ memberId: string }>>`
  - `export async function denyRequest(supabase: Pick<DbClient,"rpc">, requestId: string):
    Promise<ActionResult<{}>>`
  - `export async function removeMember(supabase: Pick<DbClient,"from">, input: { memberId: string;
    selfMemberId: string }): Promise<ActionResult<{}>>`. It refuses `memberId === selfMemberId` with
    "You can't remove yourself." It deletes with `.select("id")`, and 0 rows →
    "Couldn't remove that member."
  - `ActionResult` comes from `app/join/actions-core.ts`. Error copy:
    - approve/deny `22023` → "That request was already decided.";
    - otherwise → "Couldn't update that request. Reload and try again.".

- [ ] **Step 1: Failing tests** for each function against fake clients:
  - the ordering;
  - the self-removal refusal;
  - the 0-row removal;
  - the `22023` mapping;
  - no raw error text in any `error`.
- [ ] **Step 2: Run `npm test -- app/household`.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run it again.** Expected: PASS.
- [ ] **Step 5: Commit** (`feat(household): members and assistant-request core`).

### Task 6: `/household` screen and the "Connect an assistant" control (R3)

**Files:**
- Create:
  - `app/household/page.tsx`;
  - `app/household/actions.ts` (`approveRequestAction`, `denyRequestAction`, `removeMemberAction`,
    each `(prev, formData)` with a hidden id; each re-resolves the caller via `resolveActor`, then
    `revalidatePath("/household")`);
  - `app/household/pending-requests.tsx`;
  - `app/household/members-list.tsx`.
- Modify:
  - `app/page.tsx` (add a "Household members" link to `/household` for every member);
  - `app/invite-panel.tsx`;
  - `app/join/actions.ts` (add `generateAssistantInviteAction`, the same as `generateInviteAction`
    but with `kind: "assistant"`).

**Interfaces:**
- Consumes:
  - Task 5's `loadHousehold`, `approveRequest`, `denyRequest` and `removeMember`;
  - Task 4's `AssistantBadge`;
  - Task 1's `generateInvite({ kind })`.

**Screen contents:**
- Everyone sees the member list (name, plus the `AssistantBadge` for assistants).
- Owners additionally see:
  - a "Pending assistants" list, where each card shows the display name, the requester email and
    the time, with **Approve** / **Deny**;
  - a **Remove** button on every member row except their own.
- The invite panel gains a second, visually secondary button, **"Connect an assistant"**. Its link is
  labelled "Paste this into the assistant's setup command".
- Copy for an empty pending list: none (the section is hidden).

- [ ] **Step 1: Write a render test `app/household/page.test.tsx`,** mirroring `app/page.test.tsx`'s
  approach.
  - An owner view with one pending request shows the name, the email, Approve and Deny.
  - A non-owner view shows no Approve/Deny/Remove.
  - The owner's own row has no Remove.
- [ ] **Step 2: Run it.** Expected: FAIL.
- [ ] **Step 3: Implement the page, actions and panel button.**
- [ ] **Step 4: Run the gates.** `npm test && npm run typecheck && npm run lint`. Expected: green.
- [ ] **Step 5: Commit** (`feat(household): members screen with assistant approval and removal`).

### Task 7: E2E: approve → badge → remove

**Files:**
- Create: `e2e/support/assistant.ts`
  - `export async function seedAssistantRequest(opts: { url: string; anonKey: string;
    serviceRoleKey: string; ownerStorageState…; inviteToken: string; displayName: string }):
    Promise<{ email: string }>`.
  - It signs up a password user, marks it with `auth.admin.updateUserById(id, { app_metadata: {
    kind: "assistant" } })`, signs in again, and calls `request_assistant_membership`.
  - The header comment states that it's local-stack-only and that this is the **only** service-role
    use in e2e.
- Create: `e2e/authed/household.spec.ts`
- Modify: `.github/workflows/ci.yml`, e2e job. Export `E2E_SUPABASE_SERVICE_ROLE_KEY` from
  `npx supabase status -o env`. Use whichever of `SERVICE_ROLE_KEY` / `SECRET_KEY` the pinned CLI
  emits; check locally with `npx supabase status -o env | cut -d= -f1`.

- [ ] **Step 1: Write the spec.**
  1. The owner creates an assistant invite via the UI button and reads the URL from `#invite-url`.
  2. The helper seeds a request named "Claude (e2e)".
  3. The owner opens `/household`, sees "Claude (e2e)" and the helper's email, and clicks Approve.
  4. The member list shows "Claude (e2e)" with the text `Assistant`.
  5. The owner clicks Remove on that row, and the row disappears.
- [ ] **Step 2: Run it locally** (`npm run test:e2e -- household`, with the local stack and dev
  server per `playwright.config.ts`). Expected: PASS. (It was red before Tasks 5–6 existed: this is
  their acceptance test.)
- [ ] **Step 3: Commit** (`test(e2e): assistant approval and removal`).
- [ ] **Step 4: Open PR 2** (Tasks 3–7) with the security review, then merge on green.

---

## PR 3: MCP server

### Task 8: `mcp/` package, TS loader, build isolation, CI wiring

**Files:**
- Create:
  - `mcp/package.json`: `"private": true`, `"type": "module"`, `"engines": { "node": ">=22.18" }`,
    with dependencies pinned exactly: `@modelcontextprotocol/sdk` `1.32.2`, and `zod` at the version
    the SDK's lockfile resolves.
  - `mcp/package-lock.json`;
  - `mcp/tsconfig.json`, which extends `../tsconfig.json`, sets `include: ["**/*.ts", "../lib/**/*.ts",
    "../app/**/*-core.ts", "../app/board/actor.ts"]`, and sets `compilerOptions.paths` `{"@/*":
    ["../*"]}`;
  - `mcp/alias-loader.mjs`;
  - `mcp/register.mjs`;
  - `mcp/loader.test.ts`.
- Modify:
  - `tsconfig.json`: `exclude` adds `"mcp"`;
  - `package.json`: `typecheck` becomes `tsc --noEmit && tsc --noEmit -p mcp`;
  - `.dockerignore`: add `mcp`;
  - `.github/workflows/ci.yml`:
    - add `npm ci --ignore-scripts --prefix mcp` after `npm ci` in the verify and e2e jobs;
    - add `mcp/` to the docs-only path filter so an MCP-only PR runs the full gates.
- Modify: `~/.claude/third-party-inventory.md`, if the resolved zod version isn't already covered by
  the SDK row (note it there).

**Interfaces:**
- Produces: the launch command, used by Task 14's runbook:
  `node --import <repo>/mcp/register.mjs <repo>/mcp/<entry>.ts`.
  - `register.mjs` calls `module.register("./alias-loader.mjs", import.meta.url)`.
  - The `resolve` hook:
    - maps `@/x` → `<repoRoot>/x`;
    - for relative or aliased specifiers with no extension, tries `.ts`, then `/index.ts`;
    - returns `format: "module-typescript"` for `.ts` files under the repo root, so cores under the
      untyped root `package.json` load as ESM.

- [ ] **Step 1: Failing test `mcp/loader.test.ts`** (`// @vitest-environment node`). It spawns `node
  --import ./mcp/register.mjs -e` with an inline script that dynamically imports every module Tasks
  11–12 depend on:
  - `@/lib/recipes/save-recipe`, `@/lib/recipes/method-parse`;
  - `@/app/board/actor`, `@/app/board/actions-core`, `@/app/board/week-core`;
  - `@/app/grocery/mutations-core`, `@/app/grocery/list-core`;
  - `@/app/recipes/[id]/detail-core`;
  - `@/lib/analytics/events`, `@/lib/week/open-week`.

  It asserts exit code 0 and that stderr has no `ERR_`.
- [ ] **Step 2: Run `npm test -- mcp/loader`.** Expected: FAIL.
- [ ] **Step 3: Implement the files above.** Then run `npm ci --ignore-scripts --prefix mcp`.
- [ ] **Step 4: Run the loader test and the build.**
  - `npm test -- mcp/loader && npm run typecheck`. Expected: PASS.
  - `npm run build`. Expected: Next ignores `mcp/`.
  - If a core fails under type-stripping (a type-only import without `type`), fix that import in the
    core.
- [ ] **Step 5: Commit** (`build(mcp): isolated MCP package with TS path-alias loader`).

### Task 9: Secret store and assistant session client

**Files:**
- Create:
  - `mcp/config.ts`;
  - `mcp/secret-store.ts` and its test;
  - `mcp/client.ts` and its test.

**Interfaces:**
- Produces:
  - `export type McpConfig = { supabaseUrl: string; anonKey: string; appUrl: string;
    keychainService: string }`, and `export function readConfig(env = process.env): McpConfig`.
    - Required: `DG_SUPABASE_URL`, `DG_SUPABASE_ANON_KEY`, `DG_APP_URL`.
    - `DG_KEYCHAIN_SERVICE` defaults to `dinner-and-groceries-mcp`.
    - It throws listing the missing names, never the values.
  - `export interface SecretStore { get(account: string): Promise<string | null>; set(account:
    string, value: string): Promise<void>; delete(account: string): Promise<void> }`
  - `export class KeychainStore implements SecretStore`:
    - `constructor(service: string, run = execFile-based runner)`;
    - `set` pipes `add-generic-password -U -s <svc> -a <acct> -w <base64(value)>` into
      `/usr/bin/security -i` on **stdin**;
    - `get` runs `find-generic-password -s -a -w` and base64-decodes; exit code 44 → `null`, other
      non-zero → throw `KeychainError("Keychain unavailable")`;
    - the accounts used are `email`, `password` and `session`.
  - `export class MemoryStore implements SecretStore`, used in tests.
  - `export async function createAssistantClient(config: McpConfig, store: SecretStore):
    Promise<DbClient>`:
    - supabase-js `createClient<Database>` with `auth: { storage: <adapter over store, account
      "session">, storageKey: "session", persistSession: true, autoRefreshToken: true,
      detectSessionInUrl: false }`;
    - after `getSession()`, if there's no session or `getUser()` errors, it signs in with the stored
      email/password;
    - missing credentials → throw `SetupRequiredError("Run the setup command first: see
      docs/runbooks/mcp-companion.md")`;
    - a sign-in failure → throw `SetupRequiredError("The assistant's sign-in was refused; run setup
      again")`.

- [ ] **Step 1: Failing tests** (`// @vitest-environment node`).
  - **`KeychainStore` with an injected fake runner:**
    - `set` passes the secret only on stdin: assert the argv contains no part of the value;
    - `get` round-trips base64;
    - exit 44 → `null`;
    - exit 51 → `KeychainError`, whose message excludes the account value (Review focus 4).
  - **`createAssistantClient` with an injected `createClient` fake:**
    - a stored session is used with no sign-in;
    - a failed refresh (`getUser` error) → `signInWithPassword` with the stored credentials;
    - missing credentials → `SetupRequiredError` (Review focus 3).
  - **`readConfig`:** missing vars are named in the error.
- [ ] **Step 2: Run `npm test -- mcp/`.** Expected: FAIL.
- [ ] **Step 3: Implement.** `createAssistantClient` takes an optional third param
  `deps = { createClient }` for injection.
- [ ] **Step 4: Run it again.** Expected: PASS.
- [ ] **Step 5: Commit** (`feat(mcp): keychain secret store and assistant session`).

### Task 10: Method and ingredient serializers (round trip)

**Files:**
- Modify: `lib/recipes/method-parse.ts`, `lib/recipes/method-parse.test.ts`
- Modify: `lib/recipes/save-recipe.ts` (`serializeIngredients` sits beside
  `parseIngredientSections`), and its test.

**Interfaces:**
- Produces:
  - `export function serializeMethod(phases: readonly { title: string; intro: readonly string[];
    steps: readonly { body: string; notes: readonly string[] }[] }[]): string`.
    - A titled phase is written as `## title`, then its intro lines, then `N. body` with its `- note`
      lines.
    - Step numbers run across the whole method.
    - Phases are separated by a blank line, and an untitled first phase has no header.
    - **An intro line that would reparse as a header, step or note** (`/^## /`, `/^\d+\.\s/`,
      `/^[-*]\s/`) is written as `- <line>`. Intro is emitted before the phase's first step, so it
      reparses as intro.
  - `export function serializeIngredients(groups: readonly { section: string | null; lines: readonly
    string[] }[]): string`. A `## Section` line is written before each sectioned group. An
    ungrouped group that follows a sectioned one is written under `## Other`, since the parser can't
    return to "no section".

- [ ] **Step 1: Failing tests.**
  - **Round-trip property:** for ~200 methods generated with a seeded PRNG (phases, intros, steps,
    notes, drawn from a vocabulary that includes the tricky prefixes `"1. "`, `"- "`, `"## "`,
    `"* "`, `"[[x]]"` and `"**y**"`), `parseMethod(serializeMethod(parseMethod(src)))` deep-equals
    `parseMethod(src)`.
  - **Fixtures:** the soup and rigatoni fixtures in `lib/recipes/fixtures` round-trip.
  - **`serializeIngredients`:** a round-trip through `parseIngredientSections` preserves lines and
    sections; `[{A}, {null}]` yields the null group under `## Other`.
- [ ] **Step 2: Run `npm test -- lib/recipes`.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run it again.** Expected: PASS.
- [ ] **Step 5: Commit** (`feat(recipes): serialize method and ingredients back to authoring text`).

### Task 11: Tool framework and read tools

**Files:**
- Create:
  - `mcp/tools/types.ts`, `mcp/tools/context.ts`;
  - `mcp/tools/read-tools.ts`, `mcp/tools/read-tools.test.ts`.

**Interfaces:**
- Consumes:
  - `resolveActor`/`Actor`/`resolveWeekId` (`app/board/actor.ts`);
  - `loadWeekSettings` and `currentWeekStart`;
  - `loadWeekBoard` (Task 4);
  - `loadRecipeDetail`;
  - `loadGroceryList`;
  - `serializeMethod`/`serializeIngredients` (Task 10).
- Produces:
  - `export type ToolContext = { supabase: DbClient; actor: Actor; appUrl: string }`
  - `export type ToolResult<T> = { ok: true; data: T } | { ok: false; error: string }`
  - `export type ToolDef<S extends z.ZodRawShape> = { name: string; description: string;
    inputSchema: S; handler: (ctx: ToolContext, input: z.infer<z.ZodObject<S>>) =>
    Promise<ToolResult<unknown>> }`
  - `export const NOT_A_MEMBER = "This assistant isn't an approved member of a household. Ask the
    household owner to approve it on the Household page."`
  - `export async function buildContext(supabase: DbClient, appUrl: string): Promise<ToolResult<ToolContext>>`
    resolves the actor **per call**, so a removed assistant fails at once. A null actor →
    `NOT_A_MEMBER`.
  - **`READ_TOOLS: ToolDef[]`:**
    - **`list_recipes`** `{ query?: string(max 100), limit?: int 1..50 = 20 }` →
      `{ recipes: { id, title }[] }`. Most recent first, title `ilike`, with `%`, `_` and `\`
      escaped.
    - **`get_recipe`** `{ id: uuid }` → `{ id, title, servings, sourceUrl, prepMinutes, cookMinutes,
      totalMinutes, ingredientsText, methodText, url: appUrl + "/recipes/" + id }`. A null detail →
      `"No recipe with that id in this household."`
    - **`get_week`** `{ week_start?: ISO date }` → `{ weekStart, url: appUrl + "/board?week=" +
      weekStart, slots: { day, meal, dishId, title }[], proposals: { id, dishId, title, note,
      proposer, proposerIsAssistant, reactions: Record<kind, number>, comments: { author, body }[]
      }[] }`. The default week is `currentWeekStart(now, timezone, weekStartDay)`, and the week is
      resolved with `resolveWeekId`.
    - **`get_grocery_list`** `{}` → `{ url: appUrl + "/grocery", sections: { name, items: { name,
      quantity, unit, checked, haveIt }[] }[] }`, built from `loadGroceryList` in the section order.

- [ ] **Step 1: Failing tests** with fake supabase clients:
  - each tool's output shape;
  - `list_recipes("50%_off")` escapes to `50\%\_off`;
  - `get_recipe` on an unknown id gives the friendly error;
  - `buildContext` with no membership gives `NOT_A_MEMBER` (Review focus 3);
  - a client returning `{ error: { message: "relation … does not exist" } }` never surfaces that
    text.
- [ ] **Step 2: Run `npm test -- mcp/tools`.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run it again.** Expected: PASS.
- [ ] **Step 5: Commit** (`feat(mcp): read tools`).

### Task 12: Write tools with event parity

**Files:**
- Create: `mcp/tools/write-tools.ts`, `mcp/tools/write-tools.test.ts`

**Interfaces:**
- Consumes:
  - `saveRecipe`;
  - `safeHttpUrl` (`lib/web/safe-url.ts`);
  - `proposeExistingDish`;
  - `addAdHocItem`;
  - `MAX_ITEM_NAME_LENGTH`/`MAX_ITEM_UNIT_LENGTH` (Task 5);
  - `emitEvent`;
  - `loadRecipeDetail`;
  - `resolveWeekId`.
- Produces **`WRITE_TOOLS: ToolDef[]`:**
  - **`save_recipe`** `{ id?: uuid, title: string(1..200), ingredients_text: string,
    method_text: string, servings?: string(max 100), source_url?: string, prep_minutes?,
    cook_minutes?, total_minutes?: int 0..1440, tags?: string[] }`.
    - With an `id`, it first runs `loadRecipeDetail(id)`; null → `"No recipe with that id in this
      household."` and **no write** (Review focus 5).
    - Then it calls `saveRecipe`.
    - On a **create**, when `safeHttpUrl(source_url)` is non-null, it emits `recipe_ingested` `{
      dishId }`, matching `saveIngestedDishAction`.
    - It returns `{ id, url }`.
  - **`propose_dish`** `{ dish_id: uuid, week_start?: ISO date, note?: string(max 500) }`.
    - It calls `proposeExistingDish` with `proposedBy: ctx.actor.memberId`; there's no input field
      for it.
    - It emits `proposal_created` `{ proposalId, dishId, weekId }`, matching `app/board/actions.ts`.
    - It returns `{ proposalId, url }`.
  - **`add_grocery_item`** `{ name: string(1..MAX_ITEM_NAME_LENGTH), quantity?: number > 0,
    unit?: string(max MAX_ITEM_UNIT_LENGTH), week_start?: ISO date }`.
    - It calls `addAdHocItem`. No event (the action emits none).
    - It returns `{ name, url: appUrl + "/grocery" }`.
    - *(planner's call: `addAdHocItem` returns no id, and changing the shared core for a tool echo
      isn't worth it.)*

- [ ] **Step 1: Failing tests** with fakes:
  - **`save_recipe`:**
    - with a foreign id → the friendly error, and `rpc("save_recipe")` is never called;
    - a create with `https://x.test/r` → one `recipe_ingested` event;
    - a create with `javascript:alert(1)` → no event;
    - an update → no event.
  - **`propose_dish`:** the insert carries `proposed_by = actor.memberId`, even if the input smuggles
    a `proposed_by` key (zod strips unknown keys); one `proposal_created` event.
  - **`add_grocery_item`:** a 201-character name is rejected by the schema.
- [ ] **Step 2: Run `npm test -- mcp/tools`.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run it again.** Expected: PASS.
- [ ] **Step 5: Commit** (`feat(mcp): write tools for recipes, proposals and groceries`).

### Task 13: Server entry, setup command, local-stack integration test

**Files:**
- Create:
  - `mcp/register-tools.ts`, `mcp/register-tools.test.ts`;
  - `mcp/server.ts`;
  - `mcp/setup.ts`;
  - `mcp/integration.test.ts`.
- Modify: `.github/workflows/ci.yml`, e2e job. After `db reset`, add a step that runs
  `DG_INTEGRATION=1 npx vitest run mcp/integration.test.ts`, with `DG_SUPABASE_URL`,
  `DG_SUPABASE_ANON_KEY` and `DG_SUPABASE_SERVICE_ROLE_KEY` from `supabase status -o env`.

**Interfaces:**
- Consumes: Tasks 9, 11 and 12.
- Produces:
  - **`export function registerTools(server: Pick<McpServer, "registerTool">, tools: ToolDef[],
    getContext: () => Promise<ToolResult<ToolContext>>): void`.**
    - `ok` → `{ content: [{ type: "text", text: JSON.stringify(data) }] }`.
    - An error, or any thrown error → `{ isError: true, content: [{ type: "text", text: error }] }`.
      A throw maps to `"Something went wrong talking to the app. Try again."`, and its detail goes
      to **stderr**.
  - **`mcp/server.ts`:**
    1. `readConfig` → `KeychainStore` → `createAssistantClient`;
    2. `new McpServer({ name: "dinner-and-groceries", version: "0.1.0" })`;
    3. `registerTools` (READ + WRITE);
    4. `StdioServerTransport`.

    A `SetupRequiredError` at startup still starts the server. Every tool then returns that message,
    so the user sees it in their client.
  - **`mcp/setup.ts`:**
    1. Prompts with `node:readline/promises` for:
       - the email;
       - the password (echo muted);
       - the invite link (→ `parseInviteToken` on its last path segment);
       - the display name (default `Claude (laptop)`).
    2. Stores the email and password in the Keychain.
    3. Calls `createAssistantClient`, then `rpc("request_assistant_membership")`.
    4. Prints `Ask the household owner to approve '<name>' on the Household page.`
    5. Maps the RPC codes to plain sentences:
       - `22023` → "That invite link is invalid, expired, used, or not an assistant invite. Ask the
         owner for a new 'Connect an assistant' link.";
       - `23505` → "This assistant already belongs to a household or has a request waiting.";
       - `42501` → "This account isn't marked as an assistant. See the runbook."

- [ ] **Step 1: Failing tests.**
  - **`register-tools.test.ts`,** with a fake server recording its registrations:
    - an ok result → a text payload;
    - an error result → `isError`;
    - a throwing handler → the generic message, never the thrown message.
  - **`integration.test.ts`:** skipped unless `DG_INTEGRATION === "1"`. Against the local stack:
    1. The owner signs up → `createHousehold` → `generateInvite({ kind: "assistant" })`.
    2. The assistant signs up; the admin client sets `app_metadata.kind = "assistant"`; the assistant
       signs in again → `request_assistant_membership`.
    3. The owner `approve_assistant_request`.
    4. A second household with its own dish.
    5. As the assistant, through `buildContext` + the tool handlers:
       - `save_recipe` (create), then `get_recipe` round-trips the method text;
       - `propose_dish` for this week, then `get_week` lists it with `proposerIsAssistant: true`;
       - `add_grocery_item`, then `get_grocery_list` contains it;
       - `get_recipe` on the second household's dish → the friendly not-found error;
       - `list_recipes` excludes it;
       - a direct `select` on `invites` returns 0 rows.
    6. After the owner deletes the assistant's member row, the next `buildContext` → `NOT_A_MEMBER`.
- [ ] **Step 2: Run both.**
  - `npm test -- mcp/register-tools`: FAIL.
  - The integration test, with the local stack and env set: FAIL.
- [ ] **Step 3: Implement** `register-tools.ts`, `server.ts` and `setup.ts`.
- [ ] **Step 4: Run both again.** Expected: PASS.
- [ ] **Step 5: Smoke the real server over stdio.** Pipe an `initialize`, then a `tools/list`
  JSON-RPC request, into `node --import ./mcp/register.mjs mcp/server.ts`, with local env and a
  test Keychain service name. Expected: seven tools listed. Delete the test Keychain items
  afterwards (`security delete-generic-password -s <svc> -a <acct>` for each account).
- [ ] **Step 6: Commit** (`feat(mcp): stdio server, setup command, integration test`).

### Task 14: Runbook

**Files:**
- Create: `docs/runbooks/mcp-companion.md`
- Modify: `supabase/config.toml`: a comment only, by `[auth.email] enable_signup`, saying prod has it
  **off** via the dashboard and that local keeps it on for the E2E seed.

**Runbook sections, in order:**
1. **What it is and the trust model:** member-level data access minus invites (R2), plus the residual
   risk, quoted from the spec.
2. **Create the assistant user,** by the owner in the Supabase dashboard:
   - Add user, with an email on Jon's domain, a long random password, and auto-confirm;
   - then, in the SQL editor, the one-off
     `update auth.users set raw_app_meta_data = raw_app_meta_data || '{"kind":"assistant"}' where
     email = '<that email>';`
3. **Install:** root `npm ci`, then `npm ci --ignore-scripts --prefix mcp`. Node ≥ 22.18.
4. **"Connect an assistant"** on the home page → copy the link → run `node --import
   <repo>/mcp/register.mjs <repo>/mcp/setup.ts` with the `DG_*` env → approve on `/household`.
5. **Register the server:**
   - the `claude mcp add` command;
   - a Claude desktop `claude_desktop_config.json` snippet;
   - both with absolute paths and the `DG_*` env. The anon key and URL are public.
6. **Revoke:** Remove on `/household`, then optionally ban the user in the dashboard and run
   `security delete-generic-password` for the three accounts.
7. **Prod auth change:** turn **email sign-up off** in Dashboard → Authentication → Providers →
   Email. Do this only after the security review passes. Never `supabase config push`. Then verify:
   - a `signUp` with email/password is refused;
   - Google sign-in still works for a new user.

- [ ] **Step 1: Write the runbook.** Then run every command in sections 3–5 against the local stack
  and correct anything that doesn't work as written.
- [ ] **Step 2: Commit** (`docs(mcp): companion runbook`).
- [ ] **Step 3: Open PR 3** (Tasks 8–14), with the non-author security review covering:
  - the Keychain handling;
  - the loader;
  - the tool error mapping;
  - the R2 residual risk.

  Merge on green.

## After merge (Jon, not tasks)

1. Flip prod email sign-up off (runbook §7).
2. Create the assistant user and set its marker (§2).
3. Run setup and approve (§4).
4. Register the server in Claude Code and Claude desktop (§5).
