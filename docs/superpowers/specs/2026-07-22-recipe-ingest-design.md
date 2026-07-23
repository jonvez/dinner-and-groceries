# Recipe ingestion (Slice 1c, unit 2 / #12) — design

> **Status:** design approved 2026-07-22 (Jon + agent brainstorm). Implementation is
> decomposed into five independently-merged bricks (12z, 12a, 12b, 12c, 12d); each gets
> its own just-in-time plan. This is the shared design of record for all five.

## Goal

Turn a pasted recipe URL into a reusable **library dish** with structured ingredients,
times, and image — or let a person add the same by hand — so getting an online recipe into
the plan is nearly effortless and **never a dead end**. Ingested dishes feed the grocery
list (Slice 1d) whether or not they are ever slotted onto the schedule.

## Scope & the deferred-AI line

**In scope (the free, structured path only):**
- Fetch a URL (SSRF-guarded — already shipped, `lib/http/safe-fetch.ts` #76).
- Extract a `schema.org/Recipe` JSON-LD block → title / image / ingredient lines / times.
- Normalize ingredient lines (already shipped, `lib/recipes/ingredient.ts` #11).
- Persist a `dishes` row + `ingredients` rows as the signed-in user (RLS in force).
- A manual "add by hand" editor that also serves as the extraction-failure fallback.
- A dedicated Recipes screen reached via new global navigation.

**Explicitly NOT in scope (deferred, do not build here):**
- **AI fallback** for pages with no clean JSON-LD (Claude `claude-haiku-4-5`) — that is **M2**
  (ADR 0002 #2, SPEC "Recipe Ingestion Mechanics" stage 2). When structured extraction finds
  nothing, we drop into the manual editor — we do **not** call an LLM.
- **Grocery integration** — "add these ingredients to the grocery list", and ad-hoc grocery
  items with no recipe, are **Slice 1d** (`grocery_items` does not exist yet). See Forward-notes.
- **Recipe search/typeahead** (#80), **hotkeys** (#81), **native mobile** (#82), **custom
  domain** (#83) — backlog.

## What already exists (build on, do not rebuild)

- **`lib/recipes/ingredient.ts` (#11):** `parseIngredient(raw) → {quantity, unit, name, rawText}`,
  plus `normalizeName`. Raw line in, structured out. No external food DB. Count items get
  `unit=null`. `raw_text` is always preserved.
- **`lib/http/safe-fetch.ts` (#76):** `safeFetchHtml(url, opts) → {ok, html, finalUrl} | {ok:false, reason}`.
  Node runtime; http/https only; blocks private/link-local/metadata IPs incl. post-redirect;
  size/timeout/redirect caps; DNS-rebinding-safe. **All recipe fetching MUST go through this.**
- **`dishes` table (social schema, #7):** already has `id, household_id, title, description,
  source_url, image_url, tags[], prep_minutes, cook_minutes, total_minutes, created_by,
  created_at`, `unique (id, household_id)`, FORCE RLS via `current_household_id()`. A dish is a
  standalone **library** entity — independent of weeks/slots/proposals. Ingestion writes here.
- **`lib/web/safe-url.ts`:** `safeHttpUrl(raw) → string | null` — scheme validation (rejects
  `javascript:`/`data:` etc.). Used today before storing `source_url`; we reuse it for the
  extracted `image_url` too.
- **Server-action pattern:** pure orchestration in `*-core.ts` (injected Supabase-like client,
  unit-tested without a DB) + a thin `actions.ts` that builds the real cookie-session client and
  resolves identity. Ingestion follows this exactly.

## Architecture: the decoupling that makes the wishlist free

Three concerns stay separate, mirroring the existing schema:

- **Library** — `dishes` + `ingredients` (this slice). A recipe you can reuse.
- **Schedule** — `weeks`/`slots`/`slot_dishes`/`proposals` (Slice 1b, shipped). What's planned.
- **Grocery** — `grocery_items` (Slice 1d, not built). What to buy.

Ingestion only ever writes to the **library**. Nothing ties a saved recipe to a week or a slot.
That is *why* "add a recipe's ingredients to the grocery list whether or not it's slotted" is a
pure Slice-1d feature with nothing to unwind — the coupling is deliberately absent.

## Decomposition (five bricks)

| Brick | Deliverable | Depends on | User-facing? |
|---|---|---|---|
| **12z** | app shell + global nav + empty `/recipes` route | — | yes (nav) |
| **12a** | JSON-LD recipe extractor (`lib/recipes/`, pure) | — | no |
| **12b** | `ingredients` table + RLS + pgTAP | — | no |
| **12c** | Recipes screen (fetch → edit → save) + ingest action | 12z, 12a, 12b | yes |
| **12d** | `/recipes` library-list view (deprioritizable) | 12z | yes |

12a and 12b are independent and parallelizable. 12c is the integration brick and the one that
carries a **non-author security review** (the persist/render path — see Security).

---

## 12z — app shell + global navigation

**Why its own brick:** the app is graduating from one screen (the board) to several; Slices 1d
(grocery) and 1e (dashboard) will hang off the same nav. Reviewing/merging the shell on its own
keeps 12c's UI PR focused and gives 1d/1e a ready-made home.

**Design:**
- A minimal global nav (persistent header or side rail) with links to **Board** and **Recipes**,
  with room to add **Grocery** and **Dashboard** later. Signed-in only; respects the existing
  auth/household gate (a not-yet-joined user still lands on "join your family", not the nav).
- A new empty route `app/recipes/page.tsx` that renders the shell + a placeholder ("Add a recipe
  — coming next"). No recipe logic yet.
- **YAGNI line:** enough nav to reach the screens, not a nav *framework* — no breadcrumbs, no
  nested menus, no active-route animation. Plain links, current-page indication, mobile-friendly.
- Follows existing layout/styling conventions (Tailwind + shadcn; match the board's shell).

**Testing:** component test — nav renders the expected links, marks the current route, and is
present on both `/board` and `/recipes`. No new server logic.

---

## 12a — JSON-LD recipe extractor

**Location:** `lib/recipes/recipe-jsonld.ts` (pure, framework-free, unit-tested against saved
HTML fixtures). **Takes HTML as a string** — deliberately decoupled from the fetcher so #77's
"paste/upload saved HTML" path is nearly free later.

**Public API (proposed):**
```ts
export type ExtractedRecipe = {
  title: string | null;
  imageUrl: string | null;
  ingredientLines: string[];      // raw lines, pre-normalization
  prepMinutes: number | null;
  cookMinutes: number | null;
  totalMinutes: number | null;
};
// Returns null when no schema.org/Recipe block is found (→ manual editor).
export function extractRecipeJsonLd(html: string): ExtractedRecipe | null;
```

**Shapes handled (MVP):**
- Every `<script type="application/ld+json">` block on the page (scan all, not just the first).
- Top-level: a single object, an **array** of objects, and the **`@graph`** wrapper.
- `@type` as a string **or** an array — match when it contains `"Recipe"`.
- Ingredients: `recipeIngredient`, falling back to legacy `ingredients`.
- Times: `prepTime` / `cookTime` / `totalTime` as ISO-8601 durations (e.g. `PT1H30M`) → minutes.
- `name` → title; `image` as a string, an object `{ url }`, or an array (take the first).
- Basic HTML-entity decode on extracted text (`&amp;`, `&frac12;`, numeric entities).
- Malformed JSON in one block is skipped, not fatal — try the next block.

**Explicitly skipped (MVP):**
- Microdata / RDFa (JSON-LD only).
- Nested `@type` resolution beyond `@graph`.
- Multiple recipes on one page — take the **first** `Recipe` found.
- Any network I/O (that is the fetcher's job; this function is pure).

**Testing:** fixtures in `lib/recipes/fixtures/` — at minimum: a mainstream single-object
Recipe, an `@graph`-wrapped page, an array-of-types page, a legacy `ingredients` page, a page
with no Recipe (→ `null`), a page with malformed JSON in one of two blocks, and a duration-only
fixture for the ISO-8601 → minutes conversion. Assert the extracted contract, not site markup.

---

## 12b — `ingredients` table + RLS + pgTAP

**New migration** following the ADR 0003 pattern exactly (denormalized `household_id`, composite
FK, FORCE RLS, four policies via `public.current_household_id()`):

```sql
create table public.ingredients (
  id           uuid primary key default gen_random_uuid(),
  household_id uuid not null,                       -- denormalized (ADR 0003)
  dish_id      uuid not null,
  name         text not null check (length(trim(name)) > 0),  -- display name (from parse)
  quantity     numeric,                             -- nullable: count items / unparseable
  unit         text,                                -- nullable
  raw_text     text not null,                       -- the original line — never lost
  position     integer not null default 0,          -- stable display order
  created_at   timestamptz not null default now(),
  foreign key (dish_id, household_id)
    references public.dishes (id, household_id) on delete cascade
);
create index ingredients_household_id_idx on public.ingredients (household_id);
create index ingredients_dish_id_idx      on public.ingredients (dish_id);

alter table public.ingredients enable row level security;
alter table public.ingredients force  row level security;
grant select, insert, update, delete on public.ingredients to authenticated;
-- four policies (select/insert/update/delete), each:
--   using/with check (household_id = public.current_household_id())
```

Notes:
- `quantity` is `numeric` so `1.5` / `0.5` survive (the parser yields `number | null`).
- `name` stores the parsed **display** form; `normalizeName` is applied later at grocery-dedupe
  time (1d), not at store time — we keep the readable name here.
- Delete cascades with the parent dish (deleting a dish removes its ingredient rows).

**pgTAP (required CI check):** same-household member can CRUD its ingredients; a second household
is denied select/insert/update/delete; FORCE RLS is on; ingredient rows cascade when the parent
dish is deleted; an insert whose `household_id` ≠ the caller's household is rejected by the
`with check`.

---

## 12c — Recipes screen + ingest action

The integration brick: wires 12z's route + 12a's extractor + #76's fetcher + #11's normalizer +
12b's table into the actual feature.

### Presentation — page vs modal (decide at 12c, does not affect 12z)

Jon leans **modal** for the add-a-recipe flow (mild preference, 2026-07-23). This is a 12c-time
decision and is **independent of 12z** — `/recipes` remains the Recipes screen (library list +
an "Add a recipe" affordance) either way. Tradeoff to resolve when planning 12c:
- **Page** (`/recipes/new` or inline on `/recipes`): simplest, deep-linkable, back-button- and
  mobile-friendly, no new dependency. The failure-drops-into-editor path is natural.
- **Modal:** feels lighter / keeps context, but an accessible dialog (focus-trap, escape,
  scroll-lock, focus restore, `role="dialog"`) realistically means adopting shadcn/Radix
  `Dialog` — **a new dependency → run `third-party-security-review`** (low-risk, likely passes).
  Confirm whether Radix is already in `package.json` before deciding.
- **Not consequential** to a future iOS app: native navigation is rebuilt with native primitives
  regardless; framework-free `lib/` + the API boundary + the data model are what future-proof it.

### Flow

```
/recipes
  ┌ Paste Recipe URL ─────────────┐  [Fetch recipe]
  └───────────────────────────────┘        │ server action (Node runtime)
                                            ▼
        safeFetchHtml(url)  →  extractRecipeJsonLd(html)  →  parseIngredient(line) per line
                                            │  (no DB write yet)
                                            ▼
   Editable preview (client state):
     Title*        [ Carnitas Tacos                 ]
     Image URL     [ https://…/tacos.jpg            ]   (thumbnail if present)
     Prep / Cook / Total (minutes)  [20] [90] [110]
     Ingredients (one editable raw-text line each, add/remove rows):
        [ 2 lb pork shoulder            ] (x)
        [ 1 tbsp ground cumin           ] (x)
        [ + add ingredient ]
                                            │ [Save to library]
                                            ▼
                        ONE dish insert + ONE ingredients insert([...])
                        (as the user, RLS in force) — no proposal, no slot
                                            ▼
                              ✅ saved, reusable from the board's "Propose again"
```

- **Fetch is preview-only** — nothing is persisted until **Save to library**, so an abandoned
  fetch leaves no orphan dish.
- **Ingredient editing = raw-text lines.** One text input per ingredient; **re-parsed via
  `parseIngredient` on Save** into `{quantity, unit, name, raw_text}`. Structured fields are
  derived, never surfaced for separate editing (per Jon's #11 stance — raw text is the source of
  truth). `position` = row order.
- **By-hand path:** don't paste a URL — just type a title and add ingredient rows, then Save.
  Satisfies the "manual add-by-hand independent of any URL" AC.
- **Extraction failure / partial:** the same editor renders with whatever we got (maybe just a
  title, maybe nothing) plus a clear "couldn't read that page — add it by hand" notice. **Never a
  dead end.** No AI call.

### Persistence semantics

- **Best-effort save** (matches the existing `proposeNewDish` precedent, which deliberately
  accepts the same seam): `insert dish` → `insert(ingredients[])`. The ingredients insert is a
  single statement (all-or-nothing). The only failure seam is dish-saved-then-ingredients-insert-
  fails → a titled dish with no ingredients: benign, editable, recoverable.
- **TODO (not built):** fold both writes into one `SECURITY INVOKER` Postgres function (RPC) for
  true atomicity if half-saved dishes ever actually bite. A plain invoker function keeps RLS in
  force and needs no service-role — the cost is added surface + DB-side (pgTAP) testing, so it is
  deferred, not adopted now.
- **No dedupe:** ingesting the same URL twice creates two dishes (same as propose-new today).
- `source_url` = the pasted URL (scheme-validated); `image_url` = the extracted image
  (scheme-validated); times from the editor.

### Security (this brick carries a non-author security review)

- **Fetch only via `safeFetchHtml`** — the action must not open its own socket / bypass the SSRF
  guard. The runtime is pinned to Node (`export const runtime = "nodejs"`).
- **Scheme-validate every stored URL** with `safeHttpUrl` before persist — both the pasted
  `source_url` *and* the extracted `image_url`. An attacker-controlled page can put
  `javascript:…` in JSON-LD `image`; unvalidated, that is stored XSS the moment it is rendered
  into an `<img src>` / `<a href>` (React 19 does not block dangerous URL schemes).
- Identity + household come from the verified session, never from form inputs. Title/URLs/times
  are untrusted input — validated server-side.
- Treat extracted text as untrusted content — it is rendered as text (React escapes it); we do
  not `dangerouslySetInnerHTML` any extracted field.

### Analytics

- Emit a **`recipe_ingested`** event (existing `events` table, pseudonymous `member_id`) on a
  successful **URL-sourced** save (SPEC event taxonomy). By-hand saves are not "ingested".

### Testing

- `*-core` orchestration: unit-tested with an injected fake client (success; fetch failure →
  fallback signal; extractor-null → fallback; unsafe `image_url` rejected/dropped; ingredient
  re-parse on save).
- Component: the editor renders extracted values, add/remove rows works, the by-hand path saves,
  the failure notice shows.
- QA verifies against saved fixtures + the failure fallback; security review over the
  persist/render path; PO accepts against the #12 acceptance criteria.

---

## 12d — `/recipes` library-list view

A read-only list of the household's saved dishes on `/recipes` (title, image thumbnail, times,
source link). Reads the existing `dishes` table (RLS-scoped). **Deprioritizable** — the board's
"Propose again" dropdown already covers reusing a dish, so this is a convenience view, not a
blocker for the slice. No new tables; component + a scoped select. (Search/typeahead over this
list is #80, post-MVP.)

---

## Error handling (SPEC "Error Handling")

| Case | Behavior |
|---|---|
| Extraction finds no Recipe | Manual editor, pre-filled with whatever was found (often just nothing) + "add by hand". No AI. |
| Fetch fails / times out / blocked (SSRF) / non-HTML | Clear "couldn't read that page" + the manual editor. Never a dead end. |
| Ingredients insert fails after dish saved | Benign: a titled dish with no ingredients, editable later (best-effort seam, accepted). |
| Unsafe extracted `image_url` | Dropped (stored as null) — the dish still saves; no broken/hostile link persisted. |

## Forward-notes for Slice 1d (write nothing now; honor later)

- **"Add these ingredients to the grocery list"** must work whether or not the dish is slotted —
  the library/schedule/grocery decoupling above makes this a pure 1d button with nothing to
  unwind (Jon, 2026-07-22).
- **Ad-hoc grocery items** with no recipe at all are also 1d.
- The 1d roll-up reads `ingredients.{quantity, unit, name}` and applies `normalizeName` + the ADR
  0003 dedupe rule (no unit conversion) at that point.

## Out of scope (restated)

AI extraction fallback (M2); grocery writes (1d); atomic ingest RPC (TODO); recipe search (#80);
hotkeys (#81); native mobile (#82); custom domain (#83); microdata/RDFa parsing; multi-recipe
pages; editing structured ingredient fields separately from raw text.
