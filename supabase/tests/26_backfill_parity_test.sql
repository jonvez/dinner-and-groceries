-- Backfill parity (issue #272): the migration's SQL parser for legacy
-- `dishes.description` methods must produce exactly what the app's TypeScript
-- `parseMethod` (lib/recipes/method-parse.ts) produces for the same text.
--
-- The fixture texts below are copies of lib/recipes/fixtures/methods/*.md (the
-- two real recipes in prod plus a syntax edge-case file), and each `expected`
-- block is `parseMethod(text)` serialized as [{title, intro, steps:[{body,
-- notes}]}]. The Vitest guard lib/recipes/backfill-parity.test.ts reads THIS
-- file and fails if either block drifts from the fixture or from parseMethod,
-- so the two parsers are pinned to each other from both sides.
--
-- One rolled-back transaction; fixtures inlined so the file is self-contained.
begin;
select plan(14);

create schema if not exists tests;

insert into auth.users (id, instance_id, aud, role, email) values
  ('11111111-1111-1111-1111-111111111111', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'h-owner@test.local');
insert into public.households (id, name, owner_id) values
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'Household H', '11111111-1111-1111-1111-111111111111');
insert into public.members (id, household_id, user_id, display_name, role) values
  ('a0000001-0000-0000-0000-000000000001', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '11111111-1111-1111-1111-111111111111', 'H Owner', 'owner');

create table tests.fixtures (key text primary key, method text not null, expected jsonb not null);

-- The persisted method of a dish, in parseMethod's shape.
create or replace function tests.method_of(p_dish uuid) returns jsonb language sql as $fn$
  select coalesce(jsonb_agg(jsonb_build_object(
           'title', p.title,
           'intro', to_jsonb(p.intro),
           'steps', (select coalesce(jsonb_agg(jsonb_build_object('body', s.body, 'notes', to_jsonb(s.notes))
                                               order by s.position), '[]'::jsonb)
                       from public.dish_steps s where s.phase_id = p.id))
         order by p.position), '[]'::jsonb)
    from public.dish_phases p where p.dish_id = p_dish;
$fn$;

-- soup: lib/recipes/fixtures/methods/cilantro-lime-soup.md
insert into tests.fixtures (key, method, expected) values ('soup',
$soup_method$## Start the pork (20 min)
1. Bone the 5½ lb pork butt. Cut [[1½ lb lean meat]] into **¾–1 inch cubes**. Fatty pieces and trimmings go to the carnitas; the bone stays here. Start the carnitas now.
2. Into the soup pot: [[the pork cubes]] [[the bone]] [[1 qt store-bought chicken stock]] [[½ qt homemade chicken stock]] [[1 qt pork broth]] [[2 cups Parmesan broth]] [[½ onion, whole]] [[5 garlic cloves, smashed]] [[2 bay leaves]] [[a handful of cilantro stems]]
- **No salt until step 22.**
3. Bring up slowly over medium. **Skim the foam** for the first 10 min.
4. **Gentle simmer, partly covered. Timer: 1¼ hr.**

## While the pork simmers
5. Dice [[½ onion]] and [[3 carrots]]. Keep together.
6. Juice [[3 limes]]. Cut [[1–2 limes]] into wedges.
7. Put [[1½ cups chickpeas]] and [[1½ cups pinto beans]] in one bowl.
8. Wash and dry [[the rest of the cilantro]]. Chop later.
9. Peel [[½ lb shrimp]] (thaw first if frozen). Keep in the fridge.
10. 30 min before the timer: take [[1½ lb chicken breast]] out of the fridge.
11. At the timer: a pork cube should break under light fork pressure. If not, 15 more min. If the pot is low, add water.

## Clear the pot
12. Remove the bone, onion half, bay leaves and cilantro stems.
13. Add [[2 cups Parmesan broth]]. If the broth already tastes salty, use [[2 cups water]] instead.

## Chicken (15–18 min)
14. Add [[the chicken, whole]] and [[the onion and carrots]]. **Bare simmer.**
15. Start [[the rice]] in a separate pot.
16. Chop [[the cilantro]].
17. Pull the chicken at **155°F**. Rest it.

## Finish (10 min)
18. Add [[the chickpeas and pintos]]. 5–10 min.
19. Cut the chicken into **¾ inch pieces**.
20. Add [[the shrimp]] for the last **2–3 min**, until just pink.
21. **Off the heat:** add [[the chicken]] [[the cilantro]] [[the lime juice]].
22. Salt to taste: [[kosher salt]]. More lime if needed.
23. Serve over [[rice]] with [[lime wedges]].

## Leftovers
- Store the rice separately.
- Add fresh cilantro and lime when reheating.
$soup_method$,
$soup_expected$[
  {
    "title": "Start the pork (20 min)",
    "intro": [],
    "steps": [
      {
        "body": "Bone the 5½ lb pork butt. Cut [[1½ lb lean meat]] into **¾–1 inch cubes**. Fatty pieces and trimmings go to the carnitas; the bone stays here. Start the carnitas now.",
        "notes": []
      },
      {
        "body": "Into the soup pot: [[the pork cubes]] [[the bone]] [[1 qt store-bought chicken stock]] [[½ qt homemade chicken stock]] [[1 qt pork broth]] [[2 cups Parmesan broth]] [[½ onion, whole]] [[5 garlic cloves, smashed]] [[2 bay leaves]] [[a handful of cilantro stems]]",
        "notes": [
          "**No salt until step 22.**"
        ]
      },
      {
        "body": "Bring up slowly over medium. **Skim the foam** for the first 10 min.",
        "notes": []
      },
      {
        "body": "**Gentle simmer, partly covered. Timer: 1¼ hr.**",
        "notes": []
      }
    ]
  },
  {
    "title": "While the pork simmers",
    "intro": [],
    "steps": [
      {
        "body": "Dice [[½ onion]] and [[3 carrots]]. Keep together.",
        "notes": []
      },
      {
        "body": "Juice [[3 limes]]. Cut [[1–2 limes]] into wedges.",
        "notes": []
      },
      {
        "body": "Put [[1½ cups chickpeas]] and [[1½ cups pinto beans]] in one bowl.",
        "notes": []
      },
      {
        "body": "Wash and dry [[the rest of the cilantro]]. Chop later.",
        "notes": []
      },
      {
        "body": "Peel [[½ lb shrimp]] (thaw first if frozen). Keep in the fridge.",
        "notes": []
      },
      {
        "body": "30 min before the timer: take [[1½ lb chicken breast]] out of the fridge.",
        "notes": []
      },
      {
        "body": "At the timer: a pork cube should break under light fork pressure. If not, 15 more min. If the pot is low, add water.",
        "notes": []
      }
    ]
  },
  {
    "title": "Clear the pot",
    "intro": [],
    "steps": [
      {
        "body": "Remove the bone, onion half, bay leaves and cilantro stems.",
        "notes": []
      },
      {
        "body": "Add [[2 cups Parmesan broth]]. If the broth already tastes salty, use [[2 cups water]] instead.",
        "notes": []
      }
    ]
  },
  {
    "title": "Chicken (15–18 min)",
    "intro": [],
    "steps": [
      {
        "body": "Add [[the chicken, whole]] and [[the onion and carrots]]. **Bare simmer.**",
        "notes": []
      },
      {
        "body": "Start [[the rice]] in a separate pot.",
        "notes": []
      },
      {
        "body": "Chop [[the cilantro]].",
        "notes": []
      },
      {
        "body": "Pull the chicken at **155°F**. Rest it.",
        "notes": []
      }
    ]
  },
  {
    "title": "Finish (10 min)",
    "intro": [],
    "steps": [
      {
        "body": "Add [[the chickpeas and pintos]]. 5–10 min.",
        "notes": []
      },
      {
        "body": "Cut the chicken into **¾ inch pieces**.",
        "notes": []
      },
      {
        "body": "Add [[the shrimp]] for the last **2–3 min**, until just pink.",
        "notes": []
      },
      {
        "body": "**Off the heat:** add [[the chicken]] [[the cilantro]] [[the lime juice]].",
        "notes": []
      },
      {
        "body": "Salt to taste: [[kosher salt]]. More lime if needed.",
        "notes": []
      },
      {
        "body": "Serve over [[rice]] with [[lime wedges]].",
        "notes": []
      }
    ]
  },
  {
    "title": "Leftovers",
    "intro": [
      "Store the rice separately.",
      "Add fresh cilantro and lime when reheating."
    ],
    "steps": []
  }
]$soup_expected$::jsonb);

-- rigatoni: lib/recipes/fixtures/methods/no-boil-baked-rigatoni.md
insert into tests.fixtures (key, method, expected) values ('rigatoni',
$rigatoni_method$## Start (30 min soak)
1. Cover [[1 lb rigatoni]] with hot, well-salted tap water by 3–4 inches. Stir once after 5 min so it doesn't stick. **Timer: 30 min.**

## While the pasta soaks
2. Cut [[1 lb mozzarella]] into **¼ inch cubes**.
3. Grate [[3 oz Parmesan]] (about 1½ cups).
4. **When the timer shows 15 min left:** oven to **400°F**, rack in the middle.
5. Mince [[3 tbsp parsley]] and [[3 tbsp basil]]. Keep together.
6. In a large pot, stir together: [[12 oz ricotta]] [[2 eggs]] [[1 cup heavy cream]] [[3 cups red sauce]] [[half the Parmesan]] [[half the herbs]]. Season with [[salt]] and [[pepper]].
7. Spray one side of a sheet of foil with [[cooking spray]].

## Assemble
8. Drain the pasta. Fold it into the pot with [[half the mozzarella]].
- Rigatoni is thick: a piece should bend without snapping. If not, soak 10 more min.
9. Spread in a **9×13 dish**. No greasing needed.
10. Top with [[1 cup red sauce]], then [[the rest of the mozzarella]].
11. Cover tightly with the foil, sprayed side down.

## Bake (1 hr)
12. **Bake covered 45 min.**
13. Uncover. **Bake ~15 min** more, until the cheese browns in spots.
14. Sprinkle [[the rest of the Parmesan]]. **Rest 10 min.**
15. Top with [[the rest of the herbs]]. Serve.
$rigatoni_method$,
$rigatoni_expected$[
  {
    "title": "Start (30 min soak)",
    "intro": [],
    "steps": [
      {
        "body": "Cover [[1 lb rigatoni]] with hot, well-salted tap water by 3–4 inches. Stir once after 5 min so it doesn't stick. **Timer: 30 min.**",
        "notes": []
      }
    ]
  },
  {
    "title": "While the pasta soaks",
    "intro": [],
    "steps": [
      {
        "body": "Cut [[1 lb mozzarella]] into **¼ inch cubes**.",
        "notes": []
      },
      {
        "body": "Grate [[3 oz Parmesan]] (about 1½ cups).",
        "notes": []
      },
      {
        "body": "**When the timer shows 15 min left:** oven to **400°F**, rack in the middle.",
        "notes": []
      },
      {
        "body": "Mince [[3 tbsp parsley]] and [[3 tbsp basil]]. Keep together.",
        "notes": []
      },
      {
        "body": "In a large pot, stir together: [[12 oz ricotta]] [[2 eggs]] [[1 cup heavy cream]] [[3 cups red sauce]] [[half the Parmesan]] [[half the herbs]]. Season with [[salt]] and [[pepper]].",
        "notes": []
      },
      {
        "body": "Spray one side of a sheet of foil with [[cooking spray]].",
        "notes": []
      }
    ]
  },
  {
    "title": "Assemble",
    "intro": [],
    "steps": [
      {
        "body": "Drain the pasta. Fold it into the pot with [[half the mozzarella]].",
        "notes": [
          "Rigatoni is thick: a piece should bend without snapping. If not, soak 10 more min."
        ]
      },
      {
        "body": "Spread in a **9×13 dish**. No greasing needed.",
        "notes": []
      },
      {
        "body": "Top with [[1 cup red sauce]], then [[the rest of the mozzarella]].",
        "notes": []
      },
      {
        "body": "Cover tightly with the foil, sprayed side down.",
        "notes": []
      }
    ]
  },
  {
    "title": "Bake (1 hr)",
    "intro": [],
    "steps": [
      {
        "body": "**Bake covered 45 min.**",
        "notes": []
      },
      {
        "body": "Uncover. **Bake ~15 min** more, until the cheese browns in spots.",
        "notes": []
      },
      {
        "body": "Sprinkle [[the rest of the Parmesan]]. **Rest 10 min.**",
        "notes": []
      },
      {
        "body": "Top with [[the rest of the herbs]]. Serve.",
        "notes": []
      }
    ]
  }
]$rigatoni_expected$::jsonb);

-- edge: lib/recipes/fixtures/methods/edge-cases.md
insert into tests.fixtures (key, method, expected) values ('edge',
$edge_method$1. Boil water.
A plain line after a step is still phase intro.
   2. An indented step.
* A star note on the step above.
- A dash note too.
##Not a heading (no space)
## 
## Real heading
- A phase intro bullet (no step yet).
Plain intro line.
3) Not a step (paren, not dot).
10.	A tab after the dot.
4.Not a step (no space).
- A note on the tab step.
$edge_method$,
$edge_expected$[
  {
    "title": "",
    "intro": [
      "A plain line after a step is still phase intro.",
      "##Not a heading (no space)",
      "##"
    ],
    "steps": [
      {
        "body": "Boil water.",
        "notes": []
      },
      {
        "body": "An indented step.",
        "notes": [
          "A star note on the step above.",
          "A dash note too."
        ]
      }
    ]
  },
  {
    "title": "Real heading",
    "intro": [
      "A phase intro bullet (no step yet).",
      "Plain intro line.",
      "3) Not a step (paren, not dot).",
      "4.Not a step (no space)."
    ],
    "steps": [
      {
        "body": "A tab after the dot.",
        "notes": [
          "A note on the tab step."
        ]
      }
    ]
  }
]$edge_expected$::jsonb);

-- One dish per fixture, its method in the legacy `description` column, plus a
-- dish with a blank description that must be left alone.
insert into public.dishes (id, household_id, title, description, created_by) values
  ('0d000001-0000-0000-0000-000000000001', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'Cilantro lime soup', (select method from tests.fixtures where key = 'soup'),     'a0000001-0000-0000-0000-000000000001'),
  ('0d000002-0000-0000-0000-000000000002', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'No-boil rigatoni',   (select method from tests.fixtures where key = 'rigatoni'), 'a0000001-0000-0000-0000-000000000001'),
  ('0d000003-0000-0000-0000-000000000003', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'Edge cases',         (select method from tests.fixtures where key = 'edge'),     'a0000001-0000-0000-0000-000000000001'),
  ('0d000004-0000-0000-0000-000000000004', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'Blank method',       E'  \n\n ',                                                  'a0000001-0000-0000-0000-000000000001'),
  ('0d000005-0000-0000-0000-000000000005', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'CRLF method',        replace((select method from tests.fixtures where key = 'rigatoni'), E'\n', E'\r\n'), 'a0000001-0000-0000-0000-000000000001');

-- 1-3: the helper exists but no client role can call it
select has_function('public', '_backfill_dish_method', array['uuid'], '_backfill_dish_method(uuid) exists');
select ok(not has_function_privilege('authenticated', 'public._backfill_dish_method(uuid)', 'execute'), 'authenticated cannot execute the backfill helper');
select ok(not has_function_privilege('anon', 'public._backfill_dish_method(uuid)', 'execute'), 'anon cannot execute the backfill helper');

select public._backfill_dish_method(id) from public.dishes where household_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';

-- 4-6: parity with parseMethod (phase titles, intro, step bodies and notes)
select is(tests.method_of('0d000001-0000-0000-0000-000000000001'), (select expected from tests.fixtures where key = 'soup'),     'parity: the soup backfills exactly as parseMethod parses it');
select is(tests.method_of('0d000002-0000-0000-0000-000000000002'), (select expected from tests.fixtures where key = 'rigatoni'), 'parity: the rigatoni backfills exactly as parseMethod parses it');
select is(tests.method_of('0d000003-0000-0000-0000-000000000003'), (select expected from tests.fixtures where key = 'edge'),     'parity: syntax edge cases backfill exactly as parseMethod parses them');

-- 7: CRLF line endings parse the same as LF (trim drops the \r)
select is(tests.method_of('0d000005-0000-0000-0000-000000000005'), (select expected from tests.fixtures where key = 'rigatoni'), 'parity: CRLF text parses like LF text');

-- 8-9: step counts, and positions numbered 0..n-1 across the whole dish
select is((select count(*)::int from public.dish_steps where dish_id = '0d000001-0000-0000-0000-000000000001'), 23, 'soup: 23 steps');
select is(
  (select array_agg(position order by position) from public.dish_steps where dish_id = '0d000002-0000-0000-0000-000000000002'),
  (select array_agg(g) from generate_series(0, 14) g),
  'rigatoni: 15 steps at positions 0..14 across all phases');

-- 10: phase positions 0..n-1
select is(
  (select array_agg(position order by position) from public.dish_phases where dish_id = '0d000001-0000-0000-0000-000000000001'),
  array[0, 1, 2, 3, 4, 5],
  'soup: 6 phases at positions 0..5');

-- 11: rows carry the dish's own household
select is(
  (select count(*)::int from public.dish_steps
    where dish_id in ('0d000001-0000-0000-0000-000000000001', '0d000002-0000-0000-0000-000000000002')
      and household_id <> 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'),
  0,
  'backfilled rows carry the dish''s household_id');

-- 12: a blank description yields no phases
select is((select count(*)::int from public.dish_phases where dish_id = '0d000004-0000-0000-0000-000000000004'), 0, 'a blank description backfills nothing');

-- 13: idempotent — a dish that already has phases is skipped
select public._backfill_dish_method('0d000001-0000-0000-0000-000000000001');
select is((select count(*)::int from public.dish_steps where dish_id = '0d000001-0000-0000-0000-000000000001'), 23, 'a second run on a dish with phases is a no-op');

-- 14: the legacy description is left in place (expand-only)
select is(
  (select description from public.dishes where id = '0d000001-0000-0000-0000-000000000001'),
  (select method from tests.fixtures where key = 'soup'),
  'description is untouched by the backfill');

select * from finish();
rollback;
