# Running notes: what a real cook says about the software

**Status: running log, not decisions.** Started 2026-11-07 from the cilantro lime soup spike
(branch `spike/recipe-method-local`, local stack only). Each entry is something a real cook ran into,
and what it implies. Mirrored to a
[Google Doc](https://docs.google.com/document/d/1vPJTeT6sfpEif4Ny_O27NBLJgYCzWRqN2XEmdbtsGi8/edit).
This file is the source; the doc is for reading.

Relates to: `docs/briefs/2026-09-27-meal-planning-horizon-and-mcp.md` (MCP §3b, prep scheduling §9,
stored card + computed plan §10a), `docs/briefs/2026-10-02-recipe-card-worked-example.md`.

---

## 2026-11-07 — Cilantro lime soup (pork + chicken), shared pork butt with carnitas

### What the spike did
- The recipe was written into the local stack **through the API as a real household member**: anon
  key, a member session, RLS unchanged (`scripts/spike/write-recipe.ts`). No service role.
- The method went into `dishes.description`. The column already existed, but nothing wrote it or
  rendered it. The detail page renders it with a tiny markdown subset (`app/recipes/[id]/method.tsx`).
- A dev-only password sign-in (`/auth/dev-login`) replaces Google OAuth on localhost.

### MCP architecture
1. **"Act as a member" works with zero new security surface.** Brief option 3b-1 is confirmed in
   practice: RLS did all the scoping. The open problem is unchanged and is the real one: getting such
   a session to an MCP client in **prod**, where sign-in is Google-only. That needs a token exchange.
2. **There is no server-side recipe write API.** Save logic sits in form-coupled server actions plus
   `ingest-core`. The spike script had to duplicate the parsing and the inserts. An MCP tool must call
   a shared domain function, not reimplement it.
3. **Writes aren't atomic.** Dish then ingredients are two round-trips, so a failure halfway leaves a
   half-saved recipe. An MCP write path wants one call: an RPC, `security invoker` so RLS still applies.
4. **Idempotency needs a stable key.** The spike matched on title so re-runs update in place. An
   assistant that revises a recipe mid-cook, as happened here twice in an hour, needs an id it
   holds onto, plus upsert semantics.
5. **Revisions arrive during the cook.** Broth composition changed twice in an hour (stock turned out
   to be partly store-bought; Parmesan broth found in the freezer). This is evidence for brief §10a's
   "stored, until it changes" model, and for **versions over overwrite**.

### Data model gaps this recipe hit
- **Method / steps**: no home. Spiked into `description`.
- **Ingredient groups** (broth / braise / finish): the list is flat.
- **Cross-dish links**: the pork butt is split between this soup and carnitas, and the **bone moves
  from one dish to the other**. One purchase feeds two dishes, with a prep step (breaking down the
  butt) that belongs to neither. This is §9 prep scheduling, arriving from the ingredient side.
- **Decisions deferred to the cook**: "hold back 2 cups, decide by taste at step 2" is a branch in the
  method, not a quantity. A flat ingredient list can't express it.
- **Inventory as a planning input**: every broth decision was driven by what was in the freezer
  (homemade vs store-bought, which broths exist). Supports the "sweep as input" option in brief §3a.
- **Servings / yield**, and an **edit UI**: neither exists.

### What worked
- The ingredient parser handled all 18 lines correctly, including unicode fractions (½, ¾) and quarts.

### UX experiment: chronological cook mode (same cook, later)
Jon's outcome, verbatim intent: **minimal scrolling.** Never scroll up to find the quantity for the
step you're on, then back down, over and over. "Keep me right where I am on the page so I can
optimally scan to the next step."
- **One timeline across all of the recipe's components**, ordered by when things happen. Prep goes into
  the waiting time ("while the pork simmers: dice, juice, measure") instead of a mise-en-place list
  up front. Steps are numbered across the whole cook.
- **Ingredients sit inline in the step that uses them**, as amber chips with quantities. The full list
  is collapsed at the top as a shopping/gather view.
- **Tap a step to mark it done**; the next step glides to the middle of the screen. Progress persists
  per dish (localStorage). Optional screen wake lock.
- **Minimal content rule (Jon):** no "don't add X" lines, and no technique explanation that doesn't
  change an action. As short as possible, as clear as possible.

Software implications:
- **Ingredients ↔ steps is a missing relation.** Spiked as `[[text]]` tokens in the method. Done
  properly, a step references ingredient rows, which enables scaling, "what's left to add", and a
  derived shopping list.
- **The step order is a schedule, not an authored list.** Moving prep into the slack is exactly the
  backward-from-eat-time computation in brief §9. Here it was done by hand; a planner could generate
  it from step durations and dependencies.
- **Deferred decisions are steps** ("taste, then add the held-back 2 cups"). They belong in the
  timeline at the moment of decision, not in the ingredient list.
- **Cook mode is per-session state** (progress, wake lock). Separate from the stored recipe; arguably
  a "cook session" entity, which would also be where corrections and verdicts get recorded.

## 2026-11-11 — Getting the recipe into prod (and adding shrimp)

- **Locally, the recipe went in through the API as a member. Prod had to go in as `postgres`.** Prod
  sign-in is Google-only, so no assistant-usable member session exists. The write was a guarded SQL
  transaction through the Management API (`supabase db query --linked`), generated from the local
  rows and attributed to Jon's member id by hand. It bypasses RLS entirely. This is the MCP identity
  gap (brief §3b) in concrete form: the only prod write path available to an assistant today is
  the largest-blast-radius one.
- **Data shipped ahead of code.** Prod stores the method in `description`, but prod's detail page
  doesn't render it until the cook view merges. Schema-compatible either way.
- **Recipe revision after a cook:** the restaurant version has a handful of shrimp. Added as a
  slack-time prep step (peel while the pork simmers) and a last-2–3-min step. Another data point for
  "corrections attached to the recipe" (recipe-card brief, field 1).
- **Cook-mode discoverability:** Jon found tap-to-complete only by accident. The affordance needs a
  hint (e.g. first-step label "tap when done").

## 2026-11-11 — No-boil baked rigatoni (Food Lab), and the inventory arrives

- **Big recipe sites block automated fetches.** seriouseats.com returned HTTP 402 to curl and to the
  assistant's fetch tool; web.archive.org returned 429. Two mirror copies carried a **wrong sauce
  quantity** (6 cups vs the original 4). The correct recipe arrived only as Jon's browser
  print-to-PDF. Import needs a PDF / pasted-text fallback, not just URL + saved HTML (#77).
- **"Step 1: preheat" is an anti-pattern (Jon).** The oven is needed 15 min before a 30-min soak ends.
  The source lists it first; the timeline copied that. Some steps are **clock-triggered relative to
  another step's timer**, not sequence-triggered; their position in the list is only a guess about the
  cook's pace. → timed steps + cues (#274), and §9 scheduling at single-recipe scale.
- **Cook progress is keyed by step number,** so moving the oven step mid-cook scrambled saved progress.
  Steps need stable ids (#272).
- **The prod write was blocked by the assistant's permission classifier** until Jon ran it himself.
  Right outcome (a shared-resource write needs explicit approval each time), and more evidence that
  the MCP companion needs a member-scoped write path rather than postgres SQL.
- **The inventory exists** (Google Doc, 2026-11-11): freezer / fridge / pantry with quantities. Checking
  the recipe against it immediately surfaced gaps the doc doesn't cover (grated Parmesan vs rinds only;
  no red sauce; no fresh herbs; staples like eggs unlisted). An inventory needs either "staples assumed"
  or explicit staples, and condition notes ("very old, very frosty") are first-class data.
