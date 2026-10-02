# Recipe card — worked example: Asian-glazed St. Louis ribs

**Purpose: this is a design artifact, not app content.** It is the 2026-09-30 rib cook written up as
the recipe card we don't yet have, so the spec session can argue about *what a card must hold* against
something concrete rather than in the abstract. The fields that earn their place here are the ones a
recipe website does not have.

---

## Asian-glazed St. Louis ribs

**Serves** 3–4 · **Active** ~40 min · **Total** 4 hr · **Equipment** oven, 1 sheet pan, small saucepan
**Cooked** 2026-09-30 (Jon + both kids) · **Verdict: 3/5 — fix before repeating (see Corrections)**

### Ingredients

**Ribs**
- 3.5 lb St. Louis-cut pork ribs
- 2 tbsp brown sugar
- 1 tbsp kosher salt *(Diamond Crystal; 2 tsp if Morton)*
- 2 tsp five-spice
- 1 tsp black pepper
- 1 tsp garlic powder *(optional)*

**Glaze** *(see Corrections — this is the version that was too sweet and too salty)*
- ⅓ cup soy sauce
- 3 tbsp honey *(2 tbsp if using sriracha)*
- 2 tbsp rice vinegar or black vinegar
- 4 cloves garlic, grated
- 1 tbsp fresh ginger, grated
- 1 tsp sesame oil
- 2 tbsp sriracha

**Sides** — rice; baby bok choy, halved; 1 English cucumber *(see Corrections)*

### Method

1. **Peel the membrane** from the bone side — knife tip under one end, grip with a paper towel, pull.
   The single highest-leverage step; without it the rub never reaches the meat.
2. Dry rub both sides, meat side more generously. Rest at room temperature while the oven heats.
3. **275°F, meat side up, tightly covered in foil — 2.5 hours.**
4. **Bend test:** lift one end; the rack should bend and crack the surface without falling apart.
5. Hold at **170°F, still covered**, until 20 minutes before serving. (See Timing.)
6. Cut into 2–3 bone sections *before* glazing — easier to handle, more cut surface for the glaze.
7. **400°F**, glaze meat side and cut faces, 8 min; glaze again, 6 min. Never glaze before this stage:
   sugar held at heat goes bitter.
8. Rest 10–15 min. Scatter sliced green onion and sesame seeds.

### Timing — backwards from a 6:00 dinner

| Clock | Step | Note |
|---|---|---|
| 1:45 | Rub on, into the oven at 275°F | |
| 1:50 | **Pickles** — salt cucumber 20 min, drain, brine, fridge | Needs 3–4 hr; do it while the oven works |
| 4:15 | Bend test | |
| 4:30 | Drop to **170°F**, hold | Decouples "done" from "dinner" |
| 5:15 | 400°F, first glaze | |
| 5:20 | Start rice | |
| 5:25 | Second glaze | |
| 5:35 | Ribs out, rest | |
| 5:40 | Bok choy — 4 min, cut-side down in a hot skillet | Skillet, not wok: flat contact = sear |
| 5:50 | Cut and serve | |

**The hold at step 5 is the trick.** It converts "done early" from a problem into slack, which is what
actually happened: the ribs finished 15 minutes ahead and the plan absorbed it without a rush.

### Corrections — what to change next time

*The field no recipe site has, and the most valuable thing on this card.*

1. **Too salty and too sweet.** Salt arrived in both the rub and ⅓ cup of soy; sugar in the rub, the
   honey and the sriracha — then the glaze reduced and concentrated both. **Fix:** one carrier per
   axis. Either a salty rub with the glaze cut by ¼ cup water/stock, or a light rub with full-strength
   soy. Halve the sweetener; raise the acid to 3 tbsp.
2. **Flavour stayed on the surface.** Dry rub + dry cook + late glaze is American barbecue structure;
   it has no interior pathway. **Fix:** marinate overnight in the soy / ginger / garlic / shaoxing
   base, then roast, then glaze. *This correction has to start the night before — it is a scheduling
   change, not an ingredient change.*
3. **Pickles went soft.** English cucumber is the waterist, thinnest-skinned common variety.
   **Fix:** Kirby or Persian; salt-and-ice 20 min before brining; 1 tbsp sugar or none; taste at 3 hr.

### Provenance
Planned in conversation 2026-09-30; ingredients sourced from the household grocery history. Feedback
from both kids and Jon at the table. Full post-mortem in
`docs/briefs/2026-09-27-meal-planning-horizon-and-mcp.md` §8.

---

## What this example says a card must hold

Everything above that a recipe website would **not** give you:

1. **Corrections attached to the recipe.** The most valuable content here was produced *after* eating,
   and it is what makes attempt two better than attempt one. Needs to be first-class, versioned, and
   attributable ("the kids said…"), not a free-text note.
2. **A timeline, computed backwards from eat-time** — not an ordered list of steps. Including
   cross-dish steps (the pickles happen during the rib cook) and holds.
3. **Steps that start before today.** The overnight marinade is unrepresentable in a step list. A card
   that cannot say "this begins 18 hours earlier" cannot carry its own best correction.
4. **Equipment as a constraint, not a note.** "Skillet, not wok" and "one oven" are what make the
   schedule feasible; they are the scheduler's input.
5. **Outcome and verdict.** 3/5 with reasons is what stops this from being cooked the same way twice.
6. **Substitution and its cost.** The English cucumber was a substitution made silently; the card
   should record what was actually used and what it cost.
7. **Ratios that survive scaling** — "2:1 sugar to salt, ~1% salt by weight" is more durable than
   "2 tbsp", and the salt-brand caveat is a real correctness issue, not trivia.

Fields 2 and 3 are the ones that make this a **planner artifact rather than a document**, which is the
decision the spec session has to take: is a recipe card a *record* the app stores, or a *plan* the app
computes?
