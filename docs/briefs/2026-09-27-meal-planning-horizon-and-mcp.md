# Brief — extending the planning horizon, and exposing the app to an assistant

**Status: skeleton, for plan mode.** Captured 2026-09-27 from Jon. Nothing here is decided. The
options sections exist to be argued with tomorrow, not adopted.

---

## 1. The outcome Jon wants

> "Extend the horizon on meal planning beyond 2 hours from now to 4 or 5 days from now."

Today he plans dinner ad hoc, largely in the Claude app, tactically, about two hours out. That works
and is genuinely useful — which is the point: the assistant-shaped workflow already fits how he
thinks, it just has no memory of what the household owns, bought, or already ate.

The concrete workflow he described:

1. Pull the proteins, vegetables and fruit out of the fridge.
2. See what's there.
3. Plan meals around it.
4. Generate a grocery list from the **gaps**.

Note the direction of travel: today the app goes *menu → grocery list*. This workflow runs
*inventory → menu → grocery list for the remainder*. That inversion is the heart of the brief.

## 2. What already exists to stand on (verified today, not assumed)

| Capability | State | Where |
|---|---|---|
| Breakfast / lunch / dinner / snack | **Already modelled end-to-end** | `meal_type` enum (`20260625164006_social_schema.sql:40`); slot uniqueness is `(week_id, day_of_week, meal_type)`; `MEAL_TYPES` renders all four rows, dinner visually emphasised (`lib/week/labels.ts:26`, `app/board/board-grid.tsx:75`) |
| Week board, proposals, reactions, slotting | Shipped, and live across devices | slice 1b + dinner-and-groceries #64 |
| Dishes with parsed ingredients, recipe ingestion | Shipped | slice 1c |
| Grocery list built from the menu, aisles, staples catalog, trips | Shipped | slice 1d |
| "We have it" as a **pantry fact, not a purchase** | Shipped, and deliberately modelled that way | ADR 0012, `have_it` / `have_it_at` |
| Participation/usage events | Emitting since dinner-and-groceries #210 | `events` table |

**The most useful finding:** breakfast and lunch need no schema work. The comment in
`lib/week/labels.ts` says it outright — "Dinner-focused MVP, but the model + grid support the full
set so we're not boxed in." So Jon's meal-mode ambition is a *product* question (what does planning
breakfast even mean, and how is it different) rather than a data-model one.

**The second most useful:** `have_it` already encodes "we own this" separately from "we bought
this," and ADR 0012 was explicit that a pantry fact is not a purchase. That is the seed of an
inventory concept, deliberately planted.

## 3. The genuinely new pieces

### 3a. Inventory — the hard one

Nothing today models *what is in the fridge*. This is the piece that kills most pantry apps: an
explicit inventory is accurate right up until someone eats something without telling the app, and
then it is worse than nothing because it lies confidently.

Options to weigh (not ranked):
- **Explicit inventory**, maintained by the humans. Accurate, highest upkeep, fails quietly.
- **Inferred inventory** from trip history minus menus cooked. Zero upkeep, drifts, needs a
  consumption model that does not exist.
- **Ephemeral snapshot** — no persistent inventory at all; Jon (or an assistant) does a fridge sweep
  at planning time and the answer lives only in that week's plan. Cheapest, matches the workflow he
  actually described in step 1, and sidesteps drift entirely by never claiming to know between
  sessions.
- **Hybrid**: persistent for staples and long-life items (where drift is slow and `have_it` already
  half-solves it), ephemeral for fresh produce and proteins (where drift is fast).

Open question that decides a lot: **is the fridge sweep an input Jon performs, or a state the app
maintains?**

### 3b. An MCP surface — and its auth model is the crux

The idea: the app exposes an MCP server so an authorized assistant can read what the household has
and bought, and write proposals/menus/grocery items back. Read-from and write-to.

The hard part is not the tools, it is **identity**. The app's security boundary is RLS keyed to
`auth.uid()` through `SECURITY DEFINER` helpers (ADR 0003), and every table is household-scoped with
FORCE RLS. A browser gets there with a Google sign-in and an httpOnly cookie. An MCP client has
neither.

Options to weigh:
- **Supabase-issued session for a real member** (device-code or magic-link style exchange), so the
  assistant acts *as* Jon and RLS applies unchanged. Preserves the boundary exactly; needs a token
  exchange and storage story.
- **Scoped household token** mapped to a member row, checked by a `SECURITY DEFINER` helper. Simpler
  to issue; invents a second identity path that RLS must be taught about — a new security surface,
  and a non-author review gate.
- **Service-role key.** Named only to rule it out: ADR 0003 bans it in app paths, and this would be
  the largest possible blast radius.

Related open questions: where the server runs (a route in the existing Next.js app on Cloud Run, or
separate); whether writes are direct or land as *proposals* the family reacts to (the latter fits the
existing social loop and keeps kids in the decision, which is the north star); and what happens to
the events/analytics story when a non-human actor starts creating proposals.

### 3c. Meal modes have different horizons and intensities

Jon's ordering: **dinner > breakfast > lunch.** Not all three want the same planning treatment —
dinner is the decision that benefits from a week's runway; breakfast is closer to a standing pattern;
lunch is lightest. Nothing in the app expresses "this meal type is planned differently," and the
board currently renders all four rows identically apart from emphasis.

Worth deciding tomorrow: is this *per-meal-type planning policy* (defaults, cadence, how far out), or
just UI emphasis?

### 3d. Prep cooking and longer-horizon cooking

Batch/prep cooking spans slots — one Sunday session feeding three dinners. The schema models a slot
as `(week, day, meal)`, which has no room for "this cook event serves those three." SPEC already
lists **leftovers** and **per-slot prep override** as post-MVP; this is the same territory arriving
from a different direction.

### 3e. Cadence and where scheduling lives

Jon wants a recurring planning rhythm, "possibly into the app itself, but with interconnectivity to
other task tracking tools I use."

Direct tension with his own systems-of-record rule (`CLAUDE.md`: Things owns Jon's tasks; no
duplicative systems of record). So the question is not "should the app have a scheduler" but **what
belongs where**: the app owns the menu and the list; Things owns Jon's tasks; something has to
trigger the weekly planning session without the two systems both claiming it.

## 4. Parked deliberately

**Productization.** Jon raised it and explicitly put it in the background. Recorded here so it is not
re-litigated tomorrow: not a factor in this design, but a reason not to paint into a corner
(household-scoped RLS and a per-household MCP identity are already multi-tenant-shaped, which is
convenient and should stay that way without being designed *for* it).

## 5. What tomorrow's plan mode should probably settle, in order

1. **Inventory**: sweep-as-input vs app-maintained state (3a). Everything downstream depends on it.
2. **MCP identity** (3b). Security-review-gated; the rest of the MCP design is easy by comparison.
3. **Write semantics**: does the assistant propose (family reacts) or place directly?
4. **Scope of the first slice** — almost certainly *not* all of: inventory, MCP, meal modes, prep
   cooking and scheduling. Which one delivers the 4–5 day horizon soonest on its own?
5. Meal-mode policy (3c) and cadence/Things split (3e) — probably later slices.

## 6. Questions for Jon that the brief cannot answer

- When you do the fridge sweep, do you want to *tell* the assistant what you see, or do you want the
  app to have been tracking it?
- Should an assistant-generated menu appear as proposals the kids can react to, or as a finished
  plan? (North star says the kids are in the decision; convenience says otherwise.)
- Is the 4–5 day horizon a *planning* horizon or a *shopping* horizon — one trip covering the span,
  or rolling?
- Breakfast and lunch: real planning, or just visibility of a standing pattern?

---

*Next: plan mode, 2026-09-28 or later. This file is the input, not the output.*

---

## 7. Seed data — what is actually in the house, 2026-09-27

Captured verbatim from Jon the evening this brief was written, for two purposes: planning *this*
week for real, and serving as the worked example the design has to handle on a repeating basis.

**Proteins on hand**
- 3.5 lb St. Louis-style pork ribs — his instinct: an Asian-style spare ribs preparation.
- 1 lb bacon — the kids like spaghetti carbonara.

**Leftovers / breakfast-leaning**
- Oatmeal, strawberries, leftover waffles. Mostly for Jon. The waffles and strawberries "might play
  to varying degrees" with the kids.

**Lunch patterns, by person**
- Younger kid: peanut butter and Nutella sandwich, usual.
- Older kid: udon with sesame and black vinegar sauce and chives — **fresh chives are in the house,
  so this is live for this week.**
- Household rotation: tomato soup with a small pasta (fideo, ditalini or orzo); grilled cheese
  sometimes.

**Snacks:** a whole separate conversation, explicitly a future iteration.

### Why this section changes a design question

The brief's §3c framed meal modes as differing by *horizon and intensity* — dinner planned furthest
out, then breakfast, then lunch. The seed data shows a second axis that is arguably stronger:

**Dinner is a shared meal. Breakfast and lunch are individual.**

Jon's breakfast is not the kids' breakfast; the younger kid's lunch is not the older kid's lunch. In
his words, "there is a differential between what I like to eat for breakfast and what my kids like to
eat for breakfast … and that should also factor into the productization plan."

Today's data model has no per-member preference concept at all — dishes, proposals and slots are
household-scoped, which is exactly right for the dinner loop the MVP was built around. Applying the
dinner model to breakfast and lunch would produce a household breakfast nobody wants.

Open questions this raises for the spec session:
- Is a per-person preference a **profile** (durable: "the younger one eats PB+Nutella"), a **pattern**
  (observed: what actually got eaten), or just **per-person slots** on the existing board?
- Does the north star — kids participate in deciding — even apply to lunch, or is lunch a
  *provisioning* problem (make sure the ingredients exist) rather than a *deciding* one?
- If breakfast and lunch are largely standing patterns, is the useful output a menu at all, or a
  **restock list** derived from patterns? That would make the grocery list, not the board, the
  primary surface for two of the three meals.

### The two horizons Jon is holding at once

Worth stating plainly, because they pull in different directions and the session should not conflate
them:
1. **This week, concretely.** Ribs, bacon, chives, leftovers — plan it, and generate the gap list.
2. **The repeating capability.** What does the app do, every week, without a human assembling the
   context by hand?

The first is doable tonight with no app changes at all. The second is the actual project. The first
is most valuable as evidence for the second — it shows what inputs the assistant needed, where they
came from, and which of them the app already knows.
