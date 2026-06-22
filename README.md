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

## Repo layout

```
app/                 # Next.js App Router — routes, layouts, server actions
  layout.tsx
  page.tsx
  globals.css        # Tailwind v4 entry + shadcn theme tokens
lib/                 # Framework-free domain logic (heavily unit-tested)
  utils.ts           # cn() class-name helper
  database.types.ts  # generated Supabase row types (npm run db:types)
  supabase/          # RLS-scoped client helpers
    env.ts           # validated NEXT_PUBLIC_SUPABASE_* env reader
    client-options.ts # pure user-scoped (Bearer) client options
    server.ts        # createUserClient() — typed, RLS-enforced server client
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
