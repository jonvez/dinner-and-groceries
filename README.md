# Dinner & Groceries

Plan the family menu together — propose-and-react weekly menu planning, with the grocery
list flowing from the agreed menu. See [`SPEC.md`](./SPEC.md) for the product design,
[`PLAN.md`](./PLAN.md) for the roadmap, and [`TEAM.md`](./TEAM.md) for the build process.

## Stack

- **Next.js** (App Router, TypeScript) — single app, no separate API service
- **Tailwind CSS v4** (CSS-first config) + **shadcn/ui** (new-york style, neutral base)
- **Vitest** + React Testing Library for unit/component tests (TDD)
- **Supabase** (Postgres/Auth/Realtime/RLS) via the Supabase CLI — local
  Docker stack for dev/CI; one hosted project is prod (ADR 0002)
- Deploy: GCP Cloud Run + hosted Supabase — _later milestone_

## Getting started

```bash
npm install
npm run dev        # http://localhost:3000
```

## Scripts

| Script              | What it does                              |
| ------------------- | ----------------------------------------- |
| `npm run dev`       | Start the dev server                      |
| `npm run build`     | Production build                          |
| `npm run start`     | Serve the production build                |
| `npm run lint`      | ESLint (next/core-web-vitals + typescript)|
| `npm run typecheck` | `tsc --noEmit` (strict mode)              |
| `npm run test`      | Run the Vitest suite once                 |
| `npm run test:watch`| Vitest in watch mode                      |
| `npm run db:start`  | Start the local Supabase stack (Docker)   |
| `npm run db:stop`   | Stop the local Supabase stack             |
| `npm run db:status` | Print local Supabase URLs + keys          |
| `npm run db:reset`  | Recreate the DB and re-apply all migrations |
| `npm run db:migration` | Scaffold a new migration (`-- <name>`) |
| `npm run db:types`  | Regenerate `lib/database.types.ts` from the local DB |

## Supabase (local dev stack)

Local Supabase runs in Docker via the Supabase CLI (pinned as a devDependency).
The hosted Supabase project is **prod only** — no dev/test data goes there
(ADR 0002). All DDL lives in `supabase/migrations/*.sql`; **never edit schema
in the dashboard** (ADR 0003).

**Prereqs:** Docker running locally.

```bash
npm install               # installs the pinned supabase CLI
npm run db:start          # boots Postgres, Auth, Studio, ... (first run pulls images)
npm run db:status         # prints the local URL + anon key
cp .env.example .env.local   # then paste the values from db:status
```

**Migrations** (sole source of DDL):

```bash
npm run db:migration -- add_households   # scaffold supabase/migrations/<ts>_add_households.sql
# write your DDL, then:
npm run db:reset                         # drops + recreates + replays every migration
```

**Regenerate typed rows** after any schema change:

```bash
npm run db:reset      # apply latest migrations
npm run db:types      # writes lib/database.types.ts (check this file in)
```

**Data access is always RLS-scoped.** Build server-side queries through
`createUserClient(accessToken)` in [`lib/supabase/server.ts`](./lib/supabase/server.ts):
it runs as the **signed-in user** (Bearer token), never the service role
(ADR 0003). There is no service-role key in M0/M1.

## Authentication (Google OAuth + `@supabase/ssr`)

Each family member signs in as themselves via **Google OAuth** (the only
provider; Apple is post-MVP). Sessions are cookie-based via `@supabase/ssr` and
refreshed by Next.js middleware, so server-side data access always runs with the
user's access token and RLS stays in force (ADR 0003).

How the pieces fit:

| File | Role |
| ---- | ---- |
| [`middleware.ts`](./middleware.ts) | Next.js entry; runs on every matched route. |
| [`lib/supabase/middleware.ts`](./lib/supabase/middleware.ts) | `updateSession()` — refreshes the cookie session (`getUser()`, **verified**), looks up household membership, applies the routing decision. |
| [`lib/auth/routing.ts`](./lib/auth/routing.ts) | Pure auth-boundary decision: gate protected routes, route a **no-member** user to `/join`, bounce signed-in users off `/login`. Unit-tested. |
| [`lib/auth/redirect.ts`](./lib/auth/redirect.ts) | `safeRedirectPath()` — validates the OAuth `next` param (same-origin only) to prevent open redirects. Unit-tested. |
| [`lib/supabase/cookie-options.ts`](./lib/supabase/cookie-options.ts) | Cookie security policy: `httpOnly`, `sameSite=lax`, `secure` in prod, `path=/`. Unit-tested. |
| [`lib/supabase/server-component.ts`](./lib/supabase/server-component.ts) | `createServerComponentClient()` — RLS client wired to the request cookies, for Server Components / Actions / Route Handlers. |
| [`lib/supabase/browser.ts`](./lib/supabase/browser.ts) | Browser client used only to start the Google OAuth redirect. |
| [`app/login/`](./app/login) | Sign-in page + Google button. |
| [`app/auth/callback/route.ts`](./app/auth/callback/route.ts) | OAuth callback: exchanges the code for a session, redirects to the **validated** `next`. |
| [`app/auth/signout/route.ts`](./app/auth/signout/route.ts) | POST-only sign-out: clears the session cookies. |

The access/refresh tokens live in **httpOnly** cookies — they are never exposed
to the client JS bundle. No service-role key appears anywhere on this path.

### Google OAuth setup (one-time, human config)

A live Google round-trip needs a real **Google Cloud OAuth client** plus the
Supabase Google provider config. Local sign-in cannot complete without these.

1. **Google Cloud Console → APIs & Services → Credentials → Create OAuth client ID**
   (application type **Web application**).
2. Set the **Authorized redirect URI** to the Supabase Auth callback (NOT the
   app's own route — Supabase redirects to the app afterward):
   - Local: `http://127.0.0.1:54321/auth/v1/callback`
   - Prod: `https://<project-ref>.supabase.co/auth/v1/callback`
3. Copy the **Client ID** and **Client secret** into `.env.local`:
   ```bash
   SUPABASE_AUTH_EXTERNAL_GOOGLE_CLIENT_ID=...apps.googleusercontent.com
   SUPABASE_AUTH_EXTERNAL_GOOGLE_SECRET=...
   ```
   These names are wired into `supabase/config.toml`'s `[auth.external.google]`
   via `env()` (see [`.env.example`](./.env.example)). They are read by the
   Supabase Auth server, **not** the Next.js bundle.
4. Restart the stack so the CLI picks them up: `npm run db:stop && npm run db:start`.

**Prod:** put the same two values in **GCP Secret Manager** and bind them to the
hosted Supabase project; never commit real secrets.

## Repo layout

```
middleware.ts        # Next.js middleware entry -> updateSession() (auth gate)
app/                 # Next.js App Router — routes, layouts, server actions
  layout.tsx
  page.tsx           # protected home (RLS read of the member's profile)
  globals.css        # Tailwind v4 entry + shadcn theme tokens
  login/             # sign-in page + Google OAuth button
  join/              # no-member join placeholder (#6 fills the screen)
  auth/
    callback/route.ts # OAuth callback — code exchange + validated redirect
    signout/route.ts  # POST sign-out — clears session cookies
lib/                 # Framework-free domain logic (heavily unit-tested)
  utils.ts           # cn() class-name helper
  database.types.ts  # generated Supabase row types (npm run db:types)
  auth/              # framework-free auth-boundary logic (TDD)
    redirect.ts      # safeRedirectPath() — open-redirect defense
    routing.ts       # resolveAuthRoute() — session/no-member gating decision
  supabase/          # RLS-scoped client helpers
    env.ts           # validated NEXT_PUBLIC_SUPABASE_* env reader
    client-options.ts # pure user-scoped (Bearer) client options
    cookie-options.ts # auth-cookie security policy (httpOnly/sameSite/secure)
    server.ts        # createUserClient() — typed, RLS-enforced server client
    server-component.ts # createServerComponentClient() — cookie-session client
    browser.ts       # createClient() — browser client (starts OAuth)
    middleware.ts    # updateSession() — refresh session + apply routing
    membership.ts    # userHasMember() — no-member boundary lookup
components/          # React UI
  ui/                # shadcn/ui primitives (generated; e.g. button.tsx)
supabase/            # Supabase CLI config + migrations (sole DDL source)
  config.toml        # local stack config (project_id, ports, auth, ...)
  migrations/        # *.sql — the ONLY place schema is defined (ADR 0003)
docs/                # ADRs (docs/decisions), retro log, design notes
```

### Conventions (per ADR 0003)

- **`lib/` is framework-free.** Domain logic (ingredient parsing, roll-up/dedupe,
  week-boundary math) lives here as plain TypeScript and is **tested hard** — no React,
  no Next, no Supabase imports. This is the riskiest code; it gets the most tests.
- **Server actions are thin** and live beside their route as `app/**/actions.ts`. They
  validate input and call into `lib/`; they don't hold business logic.
- **UI is feature-foldered.** A feature's components live together under
  `components/<feature>/` (e.g. `components/board/`, `components/grocery/`), so two
  developers can work in parallel without colliding. Shared shadcn primitives stay in
  `components/ui/`.
- **Co-located tests.** `*.test.ts(x)` sits next to the file it covers (e.g.
  `lib/utils.test.ts`, `components/ui/button.test.tsx`). Tests are written first (TDD).

## Tests

```bash
npm run test
```

Vitest runs in a jsdom environment with React Testing Library and
`@testing-library/jest-dom` matchers (see `vitest.config.ts` / `vitest.setup.ts`).

## Adding shadcn/ui components

```bash
npx shadcn@latest add <component>
```

Config lives in `components.json` (new-york style, neutral base color, CSS variables).
Generated primitives land in `components/ui/`.
