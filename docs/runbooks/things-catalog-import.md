# Runbook: importing the Things grocery vocabulary

One-time import of the family's grocery vocabulary from Things 3 into
`catalog_items` (issue #121, epic #135). Four steps, each of which refuses to
run on bad input rather than importing something subtly wrong.

## What this is, and what it is not

Reading the archive is what settled the design: the Things "Groceries" project
holds **630 rows resolving to ~574 distinct names**, and the most-repeated name
appears four times. That is not purchase history in any analytic sense — it is a
**vocabulary of what this family buys**.

So the target is `catalog_items` (the staples that feed suggestions and the
one-tap chips), **not** `grocery_items` (this week's list, whose `week_id` is
`NOT NULL` and would have to be faked 574 times).

The 31 `______` separator rows are dropped. They are unlabeled, they never
recorded which section they delimited, and the surviving groupings do not
decode. They encoded an *activity* — hand-sorting at shop time — and that
activity is precisely what the sections feature replaces.

## 1. Extract

```bash
node scripts/extract-things-groceries.mjs --out /tmp/things-groceries.json
```

Reads the Things SQLite. Two safety rules are built in:

- **It never opens the live database.** The file is copied first, so a read can
  never take a lock on the running app's own file.
- **It copies the `-wal` and `-shm` sidecars too.** `main.sqlite` alone is the
  state as of the last checkpoint; anything committed since lives in the WAL.
  Copying only the main file silently loses the most recent items.

Expect roughly: `630 items -> 574 distinct names`, `31 separator rows` dropped.
Names are kept verbatim (whitespace and case normalization only), and the
spelling kept for a repeated name is the earliest one used — matching
`promoteToCatalog`, because that is the spelling the family recognizes.

## 2. Build the review table

```bash
node scripts/build-things-review.mjs \
  --extract /tmp/things-groceries.json \
  --out /tmp/review.tsv
```

Joins the extract to the hand-authored proposals in
`scripts/data/things-sections.psv` and emits a TSV.

This step exists mostly to **fail loudly**. The proposals are keyed by name, so
a typo or a stale entry would otherwise vanish silently and quietly drop a
staple. Every name must be accounted for in both directions, and every section
must be one the database actually has. It refuses to emit anything otherwise.
(It caught four real problems on the first run, including a name whose
apostrophe is a curly `’` rather than a straight `'`.)

Rows are ordered **lowest confidence first**, so the ~19 genuinely ambiguous
names read first and the ~460 obvious ones sit below.

## 3. Review in a Google Sheet

Import the TSV to Sheets and edit **`Final section`** — the authoritative
column, pre-filled with the proposal, so reviewing means changing the few that
are wrong rather than filling in 574 blanks.

Valid values are listed in column I. `Drop` excludes a row from the import
entirely — use it for the handful of things that are not staples (`Menu`,
`Area`, `Rx`, `Garden stakes`).

> There is no enforced dropdown: the Sheets MCP surface has no data-validation
> tool. That is fine — step 4 validates every `Final section` against the real
> section list and refuses to build on an unknown value, which is a **stronger**
> guarantee than a dropdown, since it cannot be bypassed by pasting. To add a
> dropdown anyway: select `E2:E`, then Data → Data validation → range `I2:I13`.

Export the reviewed sheet back to TSV before step 4.

## 4. Generate the seed

```bash
node scripts/build-catalog-seed.mjs \
  --extract /tmp/things-groceries.json \
  --reviewed /tmp/reviewed.tsv \
  --out supabase/seeds/0001_things_catalog.sql
```

**Two inputs, deliberately.** `Final section` comes from the Sheet, because that
column is the human decision. Everything else — the exact name, the purchase
count, the last-bought timestamp — comes from the original extract, **never**
from the Sheet: Sheets silently reformats anything that looks like a date and
coerces anything that looks like a number, so round-tripping those columns
through a spreadsheet would quietly corrupt them.

Commit the generated SQL. It is the artifact of record — the thing reviewed in a
PR and the thing that touches prod.

## 5. Apply

The seed lives **outside** `supabase/migrations/` and outside
`supabase/seed.sql`, so that neither `db reset` nor a deploy can run it by
surprise. Applying it is a deliberate human step, like every schema change here.

Local first:

```bash
psql "postgresql://postgres:postgres@127.0.0.1:54322/postgres" \
  -v ON_ERROR_STOP=1 -f supabase/seeds/0001_things_catalog.sql
```

Then **run it a second time** and confirm nothing changed before going near
prod. Only then apply it to cloud prod the same way the grants migration was
applied.

### What the seed refuses to do

- **Import into the wrong kitchen.** The household is resolved by subquery with
  a `count(*) = 1` assertion, never a hardcoded uuid — a pasted id from the wrong
  environment would otherwise import 500 staples into someone else's household.
- **File items into a section that does not exist.** Every aisle named in the
  seed is checked up front. Without that check a typo'd section resolves to
  `NULL` and files the item in Unsorted, which is indistinguishable from a
  correct import until someone goes shopping.

Both raise inside the transaction, so a refusal leaves the database untouched.

### Idempotency

`added_count` uses `greatest()`, not `+=`, so a second run cannot inflate the
history — an accumulating bump would make the seed non-idempotent, which is
exactly the property you want before pointing it at prod. `last_added_at` takes
the later of the two, and `section_id` prefers the reviewed value but never
blanks one that is already set.

### Verifying

```sql
select gs.name, count(*)
  from public.catalog_items ci
  left join public.grocery_sections gs on gs.id = ci.section_id
 group by gs.name, gs.position order by gs.position;

select count(*) filter (where section_id is null) as unsectioned,
       sum(added_count) as total_purchases
  from public.catalog_items;
```

`unsectioned` should be **0**, and `total_purchases` should equal the item count
the extract reported (630) — the per-name counts summing back to the source
total is a cheap proof that nothing was lost or double-counted.
