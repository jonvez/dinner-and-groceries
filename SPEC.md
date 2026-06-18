# Dinner & Groceries — MVP Design Spec

_Date: 2026-06-18_

## North Star

> Get the family deciding meals together — with the menu quietly pulling toward food
> that makes everyone (especially the migraine-prone son) feel better — in a tool
> low-friction enough that teens actually keep using it.

The stated outcomes (adoption, shopping together, deciding what we eat) are
*instrumental*. The real end is **better, more connected eating as a family**. Health
is a real driver but is expressed as **design gravity**, never as a tracked scorecard —
surveillance and teen adoption are at war.

### Users

A household of ~4: Jon (parent/owner) + two teens (16, and 13→14 in ~2 months).
Advanced readers, own devices, both already cook (younger *with* Jon; older *for himself*).
Adoption hinges on the tool being genuinely useful and feeling like *theirs*, not a
parental chore-tracker.

### The one loop the MVP must nail

**Collaborative weekly menu planning** via a **propose-and-react** model, async and
multi-device. The grocery list flows *out of* the agreed menu.

## Scope

### In scope (MVP)

- Household + individual member identity (Google OAuth sign-in)
- **Weekly menu board** with slots by meal type (dinner-focused; model supports
  breakfast/lunch/snack so we're not boxed in)
- **Meal idea pool**: anyone proposes a meal for the week; others react (emoji) and comment
- **Manual + nudge slotting**: a person deliberately slots a proposal onto a day;
  popular proposals float up / get a "ready to slot" badge (reactions guide, never auto-place)
- **Reusable meal library**: every meal proposed/made is saved and can be **recycled**
  into future weeks ("propose again")
- **Reusable purchasables catalog** (`catalog_items`): standalone, non-meal items
  (kombucha, staples) re-added to a list in one tap — the grocery list is **not meal-centric**
- **Recipe ingestion**: paste a URL → extract title/image/ingredients → becomes a reusable meal
- **Grocery list generated from the agreed menu** + catalog items + ad-hoc items;
  deduped, with a "we already have it" toggle and live check-off at the store
- **Light, neutral health tags** on meals (protein-forward, veg-forward, low-sodium, etc.) —
  informative, never scored

### Explicitly out of scope (post-MVP)

- Cost tracking / price data / spending dashboards
- Outcome dashboards ("tracking against desired outcomes")
- **Private health/"how did I feel?" log** (high-value, opt-in, son-controlled) — flagged as
  the top post-MVP candidate
- **Leftovers** (likely a carry-forward slot type referencing a prior meal without re-buying)
- School lunches (older son just finished school; revisit in fall)
- Apple sign-in + native mobile app (Expo/React Native) — bundled with the eventual
  Apple Developer account
- Store/provider data, CSA discovery, two-sided marketplace
- "You usually buy this" repurchase suggestions (catalog already records `added_count`/`last_added_at` to enable this later)

## Architecture

- **Single Next.js app** (App Router, TypeScript, Tailwind, shadcn/ui), installable as a **PWA**
  — mobile-friendly now; native app is a known post-MVP step
- **Supabase**: Postgres (data), Auth (Google OAuth), Realtime (live reactions/comments),
  Row-Level Security (one household; members share data)
- **No separate API service** — Next.js server actions + route handlers
- **Recipe extraction**: a server route (structured-first, AI fallback — see below)
- **Deploy**: Vercel (web) + Supabase (hosted)

Rationale: validates the unproven interaction model fast, gives real-time social feel cheaply,
keeps the codebase small and legible — which matters for building it *with* the kids.

### Auth / household model

- One **Household** (Jon's). Each person signs in as **themselves** (individual identity is
  what makes reactions/comments meaningful — a shared login would kill the social loop).
- All members see/edit the same shared data (board, library, grocery list); RLS scopes
  everything to the household.
- **Roles, minimal:** `owner` (invite/remove members) vs `member` (everything else).
- **Joining:** owner creates the household, invites via link/short code; invitee signs in
  with Google and lands in the household.
- **Sign-in:** Google OAuth in MVP (free, low-friction, kids already have Google accounts).
  Apple OAuth post-MVP (needs paid Apple Developer account).

## Data Model

| Table | Key columns | Purpose |
|-------|-------------|---------|
| `households` | id, name, owner_id, created_at | The family unit; everything scopes to this |
| `members` | id, household_id, user_id, display_name, role (`owner`/`member`), avatar | Links Supabase auth users to a household |
| `meals` | id, household_id, title, description, source_url, image_url, tags[], created_by | Reusable **meal library** — every idea ever proposed |
| `ingredients` | id, meal_id, name, quantity, unit, raw_text | Ingredients belonging to a meal |
| `weeks` | id, household_id, start_date | A planning week |
| `slots` | id, week_id, meal_id (nullable), meal_type, day_of_week, position | Where a meal lands on the board |
| `proposals` | id, week_id, meal_id, proposed_by, note | A meal put forward for *this* week's pool |
| `reactions` | id, proposal_id, member_id, kind (emoji) | Social signal on a proposal |
| `comments` | id, proposal_id, member_id, body, created_at | Discussion on a proposal |
| `catalog_items` | id, household_id, name, default_unit, category, last_added_at, added_count | Reusable purchasables independent of meals (kombucha, staples) |
| `grocery_items` | id, week_id, name, quantity, unit, ingredient_id (nullable), catalog_item_id (nullable), have_it (bool), checked (bool), sort_order | The week's list |

### Deliberate modeling choices

- **`meals` vs `proposals` are separate.** A meal is a permanent, reusable library entry; a
  proposal is "put this meal forward for *this week*." Recycling a past meal = a new proposal
  pointing at an existing `meals` row. No duplication.
- **Reactions/comments hang off `proposals`, not `meals`** — you react to "carnitas *this
  week*"; a meal can be proposed across many weeks without tangling history.
- **Grocery list has three feeders, none mandatory:**
  - From a meal — `ingredient_id` set (rolled up from a slotted meal)
  - From the catalog — `catalog_item_id` set (re-added known purchasable in one tap)
  - Ad-hoc — both null (typed fresh); on "complete trip" can be **promoted** into `catalog_items`
- **`grocery_items` is its own editable table** — dedupe, toggle have-it, check off without
  mutating recipes.
- **`tags[]`** is a plain text array for now (no taxonomy table until it earns its keep).
- Everything carries `household_id` (directly or via parent) for RLS.

## Core User Flows

### Flow A — Plan the week (async + real-time)

1. The upcoming week auto-exists; future weeks can be opened.
2. Anyone adds a **proposal** — a brand-new meal (title + optional recipe URL) or by
   **recycling** an existing library meal ("propose again").
3. Proposals appear in a shared pool; others **react** and **comment**; Supabase Realtime
   pushes updates live.
4. **Manual + nudge slotting:** popular proposals float up / get a "ready to slot" badge;
   a person deliberately slots one into a day + meal-type on the grid.
5. Slotting is reversible — drag out, swap, re-slot.

### Flow B — Build the grocery list from the menu

1. From a planned week: **"Build grocery list."**
2. Ingredients from all slotted meals roll up, **deduped by name+unit** (matching units
   sum; un-mergeable units listed separately).
3. Editable view: toggle **"we already have it,"** add **catalog items** in a tap, type
   **ad-hoc** items.
4. Re-running roll-up after slot changes **merges** (never clobbers manual edits); surfaces
   "N items added."

### Flow C — Shop (live, on phones)

1. At the store, open the week's list; check items off (synced live across people).
2. **"Complete trip"** archives checked items; ad-hoc items offered for **promotion** into
   the catalog.

### Flow D — Recipe ingestion

Paste URL on a proposal/meal → server extracts title/image/ingredients → creates a `meals`
row + `ingredients` rows → immediately reusable and feeds grocery roll-up. (Mechanics below.)

## Recipe Ingestion Mechanics

Two-stage, structured-first then AI fallback:

1. **Structured data (free, instant).** Fetch the page; look for a `schema.org/Recipe`
   JSON-LD block (how sites earn Google recipe cards). Pull title, image, ingredient lines.
   Covers most mainstream recipe sites at zero AI cost.
2. **AI fallback (robust long tail).** No clean structured data → send page content to
   **Claude (`claude-haiku-4-5`)** to return a structured recipe. Volume is tiny (a few
   recipes/week); dial up to Sonnet only if quality demands.

**Ingredient normalization runs on both paths.** Even JSON-LD yields raw strings
("1½ cups all-purpose flour"); parse into `{quantity, unit, name, raw_text}`. Always keep
`raw_text` so nothing is lost; every line is user-correctable.

**Guardrails:** personal/family use only (no republishing scraped content); a manual
"add by hand" path always exists; extraction failure drops into the manual editor with
whatever we got — never a dead end.

This is a deliberately small, legible, *magical* feature — a good thing for the kids to see
working and later tinker with.

## Error Handling

- **Extraction fails/times out** → show title (if any) + manual ingredient editor pre-filled
  with raw text. Best-effort, not load-bearing.
- **Bad/unreachable URL** → clear "couldn't read that page" + "add by hand."
- **Realtime drops** → board still works via normal fetches; reactions/comments reconcile on
  reconnect. Realtime is an enhancement, not required for correctness.
- **Grocery roll-up conflicts** → merge, never clobber; surface "N items added."
- **Auth/household edge cases** → invited-but-not-yet-joined user lands on "join your family,"
  not a broken empty app.

## Testing Strategy (TDD)

| Layer | Tool | What we test |
|-------|------|--------------|
| Ingredient parsing & roll-up/dedupe | Vitest | "1½ cups flour" → structured; merge rules; unit handling. Riskiest logic, tested hard. |
| Recipe extraction | Vitest | JSON-LD parsing vs saved HTML fixtures; AI path mocked (assert the contract, not the model). |
| Server actions / data access | Vitest | Household scoping/RLS; proposal→slot→grocery flows. |
| Components | Vitest + React Testing Library | Board interactions, reactions, list editing. |
| Critical E2E | Playwright | Propose → react → slot → build list → check off → complete trip. |

Tests written before implementation per global rules.

## Build-With-Kids Workflow (long-shot outcome, made concrete)

Not a feature — a way of working. Bake in a lightweight feature-request practice: the kids
describe a want in plain language; Jon brings it into a session where it's built together,
small and legible, one thing at a time. The small-files / clear-boundaries design exists
partly *for this* — so a 13- and 16-year-old can read a piece and see how it works. Stack
kept approachable (one app, TypeScript, no exotic infra) so "I want a spicy 🌶️ tag on meals"
is genuinely a 20-minute thing to do together.

## Tech Stack Summary

- **Frontend/app:** Next.js (App Router), TypeScript, Tailwind, shadcn/ui, PWA
- **Backend:** Supabase — Postgres, Auth (Google OAuth), Realtime, RLS; Next.js server actions
- **AI:** Claude `claude-haiku-4-5` for recipe extraction fallback + ingredient normalization
- **Testing:** Vitest (unit/integration), React Testing Library, Playwright (E2E), TDD
- **Deploy:** Vercel + Supabase
