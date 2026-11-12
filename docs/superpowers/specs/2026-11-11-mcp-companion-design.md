# MCP companion: design

**Status:** approved by Jon in chat on 2026-11-11 ("approve all. do it."). Security-review-gated before
build: it adds a sign-in method to prod.
**Inputs:**
- Brief `docs/briefs/2026-09-27-meal-planning-horizon-and-mcp.md` (§3b identity, write semantics).
- The running notes `docs/briefs/2026-11-07-recipe-spike-software-notes.md`.
- The recipe write path from #272 (`save_recipe` RPC, `lib/recipes/save-recipe.ts`).

## Intent

Jon plans dinner in conversation with an assistant, and the assistant has no memory of what the
household has, cooked or planned. Today, getting a recipe into the app from a chat means hand-built SQL
run as `postgres`. It bypasses RLS, and Jon has to run it himself because a shared-resource write needs
his approval each time.

The companion is an MCP server through which an assistant reads the household's data and writes back
through the same rules the app uses: as **its own member of the household**, never as Jon, never as
`postgres`.

## Decisions (Jon's)

1. **The assistant gets its own member identity** (2026-11-11). Writes are attributed to it, and RLS
   applies unchanged.
2. **"In future this should be a pluggable model."** Each assistant install is a separate member
   identity, and nothing is hard-wired to one model or client. MCP is the plug.
3. **The household admin must approve the agent identity** before it can see anything.
4. **Laptop first** (Claude desktop / Claude Code); possibly the phone later.
5. **Sign-in: a password account that only the owner can create, with email sign-up disabled**
   (recommendation accepted 2026-11-11). Anonymous sign-in was rejected: enabling it lets anyone with
   the public anon key mint authenticated users, who could then call `create_household` and every RLS
   policy granted `to authenticated`.
6. **Meal planning starts with proposals** (the easier option: one `proposals` row, attributed via
   `proposed_by`, and the family reacts). Direct slot placement is a later tool.

## Goals

- **A local stdio MCP server** that Claude desktop and Claude Code can launch, which:
  - signs in as the assistant's own auth user (anon key + email/password, against prod or local by
    config);
  - keeps the session in the macOS Keychain;
  - refreshes the session itself.
- **An approval flow.** An assistant becomes a member only after the owner approves the identity that
  actually showed up.
- **v1 tools:**
  - Read: recipes, the week board including proposals, the grocery list.
  - Write: save a recipe, propose a dish for a week, add a grocery item.

  Every write goes through an existing domain function or RPC. No tool reimplements logic.
- **Attribution visible in the app:** an assistant member is labelled as an assistant wherever members
  appear.

## Non-goals (v1)

- **Hosted / remote MCP, and the phone.** That needs an OAuth 2.1 flow and is a separate design. The
  tool layer must not depend on stdio, so remote is only a new transport and auth adapter.
- **Delete tools.**
- **Direct slot placement.**
- **Inventory tools.** Inventory is not modelled yet (brief §3a).
- **Multi-household assistants.**

## Anti-goals

- **No service role, no `security definer` shortcuts for the assistant's data access, no `postgres`
  writes.** The assistant's data access is exactly a member's.
- **No second identity path RLS must learn about.** The assistant is a normal member row; only its
  *joining* is special.
- **Nothing the assistant can do that an ordinary member can't.** At the database it is a member, minus
  owner powers and minus invite visibility (R2). The tool surface is narrower still, but tools are not a
  security boundary.

## Identity and approval

### Account creation (once per install, by the owner)

1. The owner creates an auth user in the Supabase dashboard:
   - an email on a domain Jon controls (e.g. `claude-laptop@<jon's domain>`), so reset mail can't be
     intercepted;
   - a long random password;
   - email confirmed.
2. The owner stores the credentials in the macOS Keychain on the laptop (the setup command does
   this; see below).

**Prod auth config:**
- Email **sign-in** enabled.
- **Email sign-up disabled.** This is Supabase's per-provider switch (`[auth.email] enable_signup =
  false`), distinct from the global one, so Google sign-up for new humans is unaffected.
- Mirror both in `supabase/config.toml`.

**Verify in review:**
- New Google users can still sign up.
- `signUp` with email/password is refused.
- Google-created users cannot be signed into with a password: they have none, and reset email goes to
  their own inbox.

### Joining a household (owner approves the identity that actually showed up)

1. **The owner creates an invite** in the existing invite panel. That gives the target household, and
   it is the owner's first act.
2. **The setup command signs in as the assistant user and calls a new RPC**
   `request_assistant_membership(p_token text, p_display_name text)`:
   - `security definer`, `search_path=''`, granted to `authenticated` only.
   - It consumes the invite (reusing `consume_invite`: single-use, expiry).
   - It inserts a row into a new `assistant_requests` table:
     `(id, household_id, user_id, display_name, requested_at, decided_at, decided_by, decision)`.
   - It does **not** create a member row.
   - It refuses if the caller already belongs to a household or already has a pending request.
3. **The owner sees the pending request** in the app ("Claude (laptop) wants to join as an
   assistant"), with **Approve** / **Deny**.
   - **Approve** calls `approve_assistant_request(p_request_id uuid)`: `security definer`, owner-only via
     `is_household_owner()` and the same household. It creates the member row with `role = 'assistant'`
     and stamps the decision.
   - **Deny** stamps the decision. Nothing else.

**Why approval is separate from the invite:** whoever holds an invite token can redeem it. Approval
binds membership to the identity that actually redeemed it, not to the token.

Until approval, `current_household_id()` returns null for the assistant, so RLS shows it nothing. No
change to `current_household_id()` is needed.

### Role

`alter type public.member_role add value 'assistant'`, in its own migration: a new enum value can't be
used in the same transaction that adds it.

An assistant member is excluded from owner powers:
- `is_household_owner()` already checks `role = 'owner'`.
- `members.role` is not updatable: the column grant is `update (display_name, avatar)` only. The review
  must re-verify that an assistant can't promote itself.

**Revocation:** the owner deletes the member row (the existing `members_delete` policy is owner-only).
The auth user can also be banned in the dashboard.

### `requests` RLS

`assistant_requests`:
- FORCE RLS.
- Select: the owner of the household (all requests), and the requester (its own row).
- No direct insert, update or delete grants. All writes go through the two RPCs.

### Every place that renders members

Show an "Assistant" badge for `role = 'assistant'`. Proposals and recipes already carry the member id,
so attribution follows.

## The server

- **Location:** `mcp/` in this repo (a TypeScript entrypoint). It imports the domain functions directly
  from `lib/`. *(call)* That keeps one copy of the write logic. The builder decides how to run TS with
  the `@/` path aliases (a build step vs a loader), with no new runtime dependency beyond the MCP SDK if
  avoidable.
- **Dependency:** `@modelcontextprotocol/sdk`. Reviewed 2026-11-11: **Accept-with-hardening, LOW**
  (`~/.claude/third-party-inventory.md`). Required hardening:
  - pin exactly `1.32.2`;
  - install it in a **separate `mcp/` package**, with its own `package.json` and lockfile, so it never
    enters the Next.js production image;
  - `npm ci --ignore-scripts`.

  The SDK's transitive tree (express, hono…) is for HTTP transports we don't use.
- **Config:** env or args select the target (`local` | `prod`):
  - the Supabase URL and anon key (public values);
  - the Keychain service name.

  The password and refresh token are read from and written to the Keychain via
  `/usr/bin/security`. They are never written to disk in plaintext and never logged.
- **Session:** supabase-js `signInWithPassword` on first run. After that it restores the stored session
  and refreshes. A refresh failure falls back to signing in with the password.
- **Setup command** (`mcp/setup`, run once by Jon):
  1. Prompts for the email, the password and the invite link.
  2. Stores the credentials in the Keychain.
  3. Calls `request_assistant_membership`.
  4. Prints "Ask the household owner to approve '<name>' in the app".
- **Client registration:** document the Claude desktop / Claude Code config snippet in
  `docs/runbooks/mcp-companion.md`.

## Tools (v1)

Every tool runs as the assistant member through the RLS-scoped supabase-js client.

| Tool | Kind | Backed by |
|---|---|---|
| `list_recipes(query?)` | read | `dishes` select, title ilike, most recent first, capped |
| `get_recipe(id)` | read | `loadRecipeDetail`-equivalent, plus the method serialized back to the markdown authoring format (`## phase` / `N. step` / `- note`) and the ingredients with `## Section` lines, so the assistant can revise and round-trip it. Add `serializeMethod` / `serializeIngredients` beside `parseMethod`, with a round-trip property test. |
| `save_recipe(id?, title, ingredients_text, method_text, servings?, source_url?, times?, tags?)` | write | `saveRecipe` (stable step ids, caps, URL scrub). With an `id`, it updates or fails; it never duplicates. |
| `get_week(start_date?)` | read | the week's slots/dishes and its proposals with reactions (reuse the board's loaders where they're pure) |
| `propose_dish(week_start, dish_id, note?)` | write | insert into `proposals` (`proposed_by` = the caller's member id from the session, never from tool input). Reuse the board's propose action core if one exists. |
| `get_grocery_list(week_start?)` | read | the grocery loaders |
| `add_grocery_item(name, quantity?, week_start?)` | write | the grocery add-item core (same parsing and sections as the app's form) |

**Tool rules:**
- Inputs are validated with zod (already a dependency).
- Errors are returned as tool errors with the domain's friendly messages; raw Postgres errors are never
  passed through.
- Every write's result includes the id and a link to the page in the app.

**Prompt-injection posture.** An assistant reading a recipe page or PDF may be steered by its content.
Mitigations:
- no delete tools;
- every write is household-scoped and attributed;
- recipe updates require an explicit id;
- `save_recipe` cannot touch another dish's steps (the L1 fix in #277);
- the owner can revoke the member at any time.

## Analytics

Superseded: see R4 under "Builder-check resolutions". Events are emitted only from Server Actions, not
from the cores.

## Testing

- **pgTAP:**
  - `request_assistant_membership`:
    - consumes the invite;
    - creates no member;
    - refuses a caller who already has a household or a pending request.
  - `approve_assistant_request`:
    - only the owner of the same household can call it;
    - a non-owner gets an error;
    - another household's request is invisible.
  - The approved member has `role = 'assistant'`.
  - The assistant can't update its role, create invites, or delete members.
  - `assistant_requests` RLS.
  - anon has no execute on the RPCs.
- **Vitest:**
  - each tool handler against injected clients;
  - Keychain access behind an interface, with a fake in tests;
  - the serializer round-trip.
- **An integration test against the local stack:**
  1. create the assistant user via the local admin API, **in test setup only**;
  2. owner invite → request → approve;
  3. run the tools as the assistant;
  4. assert RLS isolation from a second household.
- **E2E:** the owner sees a pending request and approves it, and the member list shows the badge.

## Rollout

1. **Migration(s)**, expand-only:
   - the enum value;
   - `assistant_requests`;
   - the two RPCs.
2. **The UI:** pending requests, plus the member badge.
3. **The MCP server, the setup command, and the runbook.**
4. **Prod auth config change.** Turn email **sign-up** off in the Supabase dashboard. Email sign-in is
   already on (see R6).
   - **Never** use `supabase config push`: `config.toml` carries localhost `site_url`/redirects and
     would overwrite prod.
   - It's **only after the security review passes**.
5. **Jon** creates the assistant user, runs setup, approves in the app, and registers the server in
   Claude desktop / Claude Code.

## Left to the builder

- How TS with path aliases runs under the MCP launcher.
- The exact tool argument shapes beyond the table.
- How much of the board/grocery loaders can be reused as-is vs. extracted.
- UI placement of pending requests (near the existing invite panel is the obvious spot).

## Builder-check resolutions (2026-11-11)

A fresh reviewer checked this design against `origin/main` (e8792bb). These resolutions override
anything above that conflicts with them.

**R1. Assistant invites and assistant accounts are marked and enforced in the database.** *(call:
without this, Jon's approval requirement is meaningless)*
- **`invites.kind`** is `'member' | 'assistant'`, default `'member'`, which is expand-safe.
  - The existing `accept_invite` refuses `kind = 'assistant'`.
  - `request_assistant_membership` accepts only `kind = 'assistant'`.
  - The invite panel gets a separate "Connect an assistant" control.
- **An assistant account is an auth user whose `raw_app_meta_data` has `"kind": "assistant"`.** The
  owner sets this in the dashboard; it's not user-editable.
  - `request_assistant_membership` requires the marker.
  - `accept_invite` and `create_household` refuse callers that carry it.
  - So an assistant can never become an owner or a plain member, and a human can never take the
    assistant path.
- **Tests:** pgTAP for all six combinations.

**R2. Database-level restriction of assistants: hide invites, otherwise member-level.** *(Jon, 2026-11-12)*
- **Decided:** `invites_select` is narrowed so an assistant member can't read any invite row (and so
  never sees a token). New predicate: `household_id = current_household_id() and not
  public.is_household_assistant()`, where `is_household_assistant()` is a `stable`, `security definer`,
  `search_path=''` helper mirroring `is_household_owner()`. Expand-safe: no assistant exists until this
  ships, so the live app's behaviour is unchanged. `invites_insert` is already owner-only.
- **Accepted residual risk (for the security review):** otherwise an approved assistant has exactly a
  member's data access. It can update or delete any dish, proposal, slot, grocery item, section or
  comment, and update `households`. On the laptop, Claude Code can read the Keychain item and call
  PostgREST directly, so "no delete tools" limits a well-behaved client but is **not** a boundary.
  Mitigations: attribution (`created_by`, events), the owner's Remove control (R3), and dashboard ban.
- **Revisit** when recipes have history (#275), so a bad edit can be undone; tighter row-ownership rules
  (no update/delete on rows the assistant didn't create) were considered and deferred as a much larger
  migration across most tables.
- **Tests:** pgTAP: an assistant selects zero invite rows; a member and the owner still see them.

**R3. v1 includes a minimal household members screen.** *(call)*
- It lists the members, with an "Assistant" badge.
- The owner-only part shows pending assistant requests (Approve / Deny) and a Remove control per member.
- Without it, revocation means SQL as `postgres`, the path this design exists to remove.
- The E2E covers approve → badge → remove.

**R4. Analytics.** *(call)*
- MCP write tools emit the same events the matching Server Actions emit (via `emitEvent`), so the event
  log stays complete and attributed to the assistant member.
- The owner dashboard's family-participation roster **excludes** `role = 'assistant'` members. The
  dashboard measures family adoption, and an assistant would inflate it.
- Assistant activity can be its own line later.

**R5. The approval card shows a fact the caller can't choose:** the requester's auth email, captured
inside the `security definer` RPC from `auth.users`. *(call)* This doesn't conflict with the privacy
stance: it's the assistant account's address, on Jon's domain, shown only to the owner. Human emails
are never shown.

**R6. Prod auth today** (read from the public `/auth/v1/settings` on 2026-11-11):

| Setting | Value |
|---|---|
| `email` provider | **enabled** |
| `disable_signup` | false |
| `mailer_autoconfirm` | false |
| `anonymous_users` | false |
| `google` | true |

- So email/password sign-up is **already open** in prod, gated by email confirmation. Rollout step 4
  therefore *closes* a surface rather than adding one.
- No app flow uses email sign-up: humans sign in with Google, and the E2E password users are
  local-only.

**R7. Domain functions live in both `lib/` and `app/`:**
- `proposeExistingDish` is in `app/board/actions-core.ts`;
- `resolveActor` / `resolveWeekId` are in `app/board/actor.ts`;
- `addAdHocItem` is in `app/grocery/mutations-core.ts`;
- `loadGroceryList` is in `app/grocery/list-core.ts`;
- `loadRecipeDetail` is in `app/recipes/[id]/detail-core.ts`;
- the board reads for proposals and members are inline in `app/board/page.tsx`.

The MCP server may import from `app/` cores where they are pure. It extracts a pure week loader from
`app/board/page.tsx` rather than duplicating its queries.
