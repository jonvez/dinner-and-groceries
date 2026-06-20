# Dinner & Groceries

Plan the family menu together — propose-and-react weekly menu planning, with the grocery
list flowing from the agreed menu. See [`SPEC.md`](./SPEC.md) for the product design,
[`PLAN.md`](./PLAN.md) for the roadmap, and [`TEAM.md`](./TEAM.md) for the build process.

## Stack

- **Next.js** (App Router, TypeScript) — single app, no separate API service
- **Tailwind CSS v4** (CSS-first config) + **shadcn/ui** (new-york style, neutral base)
- **Vitest** + React Testing Library for unit/component tests (TDD)
- Supabase (Postgres/Auth/Realtime/RLS) — _added in a later M0 issue_
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

## Repo layout

```
app/                 # Next.js App Router — routes, layouts, server actions
  layout.tsx
  page.tsx
  globals.css        # Tailwind v4 entry + shadcn theme tokens
lib/                 # Framework-free domain logic (heavily unit-tested)
  utils.ts           # cn() class-name helper
components/          # React UI
  ui/                # shadcn/ui primitives (generated; e.g. button.tsx)
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
