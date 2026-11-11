import { describe, expect, it, vi } from "vitest";

import {
  assignStepIds,
  ingredientsFromText,
  parseIngredientSections,
  saveRecipe,
  type RecipeInput,
} from "./save-recipe";

describe("parseIngredientSections", () => {
  it("opens a group at each '## ' line; lines before any header are ungrouped", () => {
    expect(
      parseIngredientSections(
        ["1 lb rigatoni", "", "## Filling", "12 oz ricotta", "  2 eggs  ", "##  Topping ", "1 cup red sauce"].join(
          "\n",
        ),
      ),
    ).toEqual([
      { line: "1 lb rigatoni", section: null },
      { line: "12 oz ricotta", section: "Filling" },
      { line: "2 eggs", section: "Filling" },
      { line: "1 cup red sauce", section: "Topping" },
    ]);
  });

  it("returns nothing for blank text", () => {
    expect(parseIngredientSections("  \n\n")).toEqual([]);
  });
});

describe("ingredientsFromText", () => {
  it("parses each line, in order, carrying its section", () => {
    expect(ingredientsFromText("2 lb pork shoulder\n## Rub\n1 tbsp ground cumin")).toEqual([
      { name: "pork shoulder", quantity: 2, unit: "lb", raw_text: "2 lb pork shoulder", section: null },
      { name: "ground cumin", quantity: 1, unit: "tbsp", raw_text: "1 tbsp ground cumin", section: "Rub" },
    ]);
  });

  it("falls back to the raw line as the name when parsing yields no name (e.g. a bare quantity)", () => {
    expect(ingredientsFromText("2")).toEqual([
      { name: "2", quantity: 2, unit: null, raw_text: "2", section: null },
    ]);
  });
});

describe("assignStepIds", () => {
  const existing = [
    { id: "a", body: "Oven to 400°F." },
    { id: "b", body: "Soak the pasta." },
    { id: "c", body: "Stir." },
    { id: "d", body: "Stir." },
  ];
  const phases = (...bodies: string[][]) =>
    bodies.map((steps, i) => ({
      title: `P${i}`,
      intro: [],
      steps: steps.map((body, n) => ({ n: n + 1, body, notes: [] })),
    }));
  const ids = (result: ReturnType<typeof assignStepIds>) =>
    result.flatMap((p) => p.steps.map((s) => s.id));

  it("keeps the id of a step whose trimmed body is unchanged", () => {
    expect(ids(assignStepIds(phases(["  Oven to 400°F. "]), existing))).toEqual(["a"]);
  });

  it("keeps ids when steps are reordered, even across phases", () => {
    expect(ids(assignStepIds(phases(["Soak the pasta."], ["Oven to 400°F."]), existing))).toEqual([
      "b",
      "a",
    ]);
  });

  it("gives an edited step a new id (null)", () => {
    expect(ids(assignStepIds(phases(["Oven to 425°F."]), existing))).toEqual([null]);
  });

  it("maps duplicate bodies one-to-one, in order", () => {
    expect(ids(assignStepIds(phases(["Stir.", "Stir.", "Stir."]), existing))).toEqual([
      "c",
      "d",
      null,
    ]);
  });

  it("gives every step a null id when there are no existing steps", () => {
    expect(ids(assignStepIds(phases(["Stir."]), []))).toEqual([null]);
  });

  it("carries title, intro and notes through to the payload shape", () => {
    expect(
      assignStepIds(
        [{ title: "Bake", intro: ["Rack in the middle."], steps: [{ n: 1, body: "Bake.", notes: ["45 min."] }] }],
        [],
      ),
    ).toEqual([
      { title: "Bake", intro: ["Rack in the middle."], steps: [{ id: null, body: "Bake.", notes: ["45 min."] }] },
    ]);
  });
});

function makeClient(opts: {
  existingSteps?: { id: string; body: string }[];
  stepsError?: unknown;
  rpcResult?: { data: unknown; error: unknown };
}) {
  const fromTables: string[] = [];
  const stepQueries: { dishId: unknown }[] = [];
  const rpc = vi.fn(async () => opts.rpcResult ?? { data: "d1", error: null });
  const from = vi.fn((table: string) => {
    fromTables.push(table);
    return {
      select: () => ({
        eq: (_col: string, dishId: unknown) => {
          stepQueries.push({ dishId });
          return {
            order: async () => ({
              data: opts.stepsError ? null : (opts.existingSteps ?? []),
              error: opts.stepsError ?? null,
            }),
          };
        },
      }),
    };
  });
  return {
    client: { from, rpc } as unknown as Parameters<typeof saveRecipe>[0],
    rpc,
    fromTables,
    stepQueries,
  };
}

const BASE: RecipeInput = {
  title: "  No-boil rigatoni  ",
  sourceUrl: "https://example.com/ziti",
  imageUrl: "https://example.com/ziti.jpg",
  prepMinutes: 20,
  cookMinutes: 60,
  totalMinutes: 110,
  servings: " 6 to 8 ",
  ingredientsText: "1 lb rigatoni\n## Topping\n1 cup red sauce",
  methodText: "## Soak\n1. Cover [[1 lb rigatoni]] with hot water.\n- 30 min.\n## Bake\n2. Bake.",
};

describe("saveRecipe", () => {
  it("creates: sends one save_recipe call with the whole recipe as jsonb", async () => {
    const { client, rpc, fromTables } = makeClient({});

    expect(await saveRecipe(client, BASE)).toEqual({ ok: true, dishId: "d1" });

    // A create has no existing steps to match, so nothing is read first.
    expect(fromTables).toEqual([]);
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith("save_recipe", {
      p_recipe: {
        id: null,
        title: "No-boil rigatoni",
        source_url: "https://example.com/ziti",
        image_url: "https://example.com/ziti.jpg",
        prep_minutes: 20,
        cook_minutes: 60,
        total_minutes: 110,
        servings: "6 to 8",
        ingredients: [
          { name: "rigatoni", quantity: 1, unit: "lb", raw_text: "1 lb rigatoni", section: null },
          { name: "red sauce", quantity: 1, unit: "cup", raw_text: "1 cup red sauce", section: "Topping" },
        ],
        phases: [
          {
            title: "Soak",
            intro: [],
            steps: [{ id: null, body: "Cover [[1 lb rigatoni]] with hot water.", notes: ["30 min."] }],
          },
          { title: "Bake", intro: [], steps: [{ id: null, body: "Bake.", notes: [] }] },
        ],
      },
    });
  });

  it("updates: matches the dish's current steps so unchanged steps keep their ids", async () => {
    const { client, rpc, fromTables, stepQueries } = makeClient({
      rpcResult: { data: "dish-9", error: null },
      existingSteps: [
        { id: "step-bake", body: "Bake." },
        { id: "step-soak", body: "Cover [[1 lb rigatoni]] with water." },
      ],
    });

    const result = await saveRecipe(client, { ...BASE, id: "dish-9" });

    expect(result).toEqual({ ok: true, dishId: "dish-9" });
    expect(fromTables).toEqual(["dish_steps"]);
    expect(stepQueries).toEqual([{ dishId: "dish-9" }]);
    const payload = (rpc.mock.calls[0] as unknown as [string, { p_recipe: Record<string, unknown> }])[1]
      .p_recipe;
    expect(payload.id).toBe("dish-9");
    expect(
      (payload.phases as { steps: { id: string | null }[] }[]).flatMap((p) => p.steps.map((s) => s.id)),
    ).toEqual([null, "step-bake"]);
  });

  it("fails closed (no write) when the current steps can't be read for an update", async () => {
    const { client, rpc } = makeClient({ stepsError: { message: "boom" } });
    const result = await saveRecipe(client, { ...BASE, id: "dish-9" });
    expect(result.ok).toBe(false);
    expect(rpc).not.toHaveBeenCalled();
  });

  it("rejects a blank title before any DB call", async () => {
    const { client, rpc, fromTables } = makeClient({});
    const result = await saveRecipe(client, { ...BASE, title: "   " });
    expect(result).toEqual({ ok: false, error: "Give the recipe a title." });
    expect(rpc).not.toHaveBeenCalled();
    expect(fromTables).toEqual([]);
  });

  it("drops (not blocks on) unsafe URLs", async () => {
    const { client, rpc } = makeClient({});
    const result = await saveRecipe(client, {
      ...BASE,
      sourceUrl: "javascript:alert(1)",
      imageUrl: "javascript:alert(document.cookie)",
    });
    expect(result.ok).toBe(true);
    expect(rpc.mock.calls[0]).toMatchObject([
      "save_recipe",
      { p_recipe: { source_url: null, image_url: null } },
    ]);
  });

  it("nulls blank servings and invalid minutes, and rounds decimals", async () => {
    const { client, rpc } = makeClient({});
    await saveRecipe(client, {
      ...BASE,
      servings: "  ",
      prepMinutes: -5,
      cookMinutes: Number.NaN,
      totalMinutes: 12.7,
    });
    expect(rpc.mock.calls[0]).toMatchObject([
      "save_recipe",
      { p_recipe: { servings: null, prep_minutes: null, cook_minutes: null, total_minutes: 13 } },
    ]);
  });

  it("omits tags unless given, so an update leaves them alone", async () => {
    const omitted = makeClient({});
    await saveRecipe(omitted.client, BASE);
    expect(
      (omitted.rpc.mock.calls[0] as unknown as [string, { p_recipe: object }])[1].p_recipe,
    ).not.toHaveProperty("tags");

    const given = makeClient({});
    await saveRecipe(given.client, { ...BASE, tags: [" pasta ", "", "dinner"] });
    expect(given.rpc.mock.calls[0]).toMatchObject([
      "save_recipe",
      { p_recipe: { tags: ["pasta", "dinner"] } },
    ]);
  });

  it("sends empty ingredients and phases for a title-only recipe", async () => {
    const { client, rpc } = makeClient({});
    await saveRecipe(client, { title: "Just a title", ingredientsText: "", methodText: "  " });
    expect(rpc.mock.calls[0]).toMatchObject([
      "save_recipe",
      {
        p_recipe: {
          title: "Just a title",
          source_url: null,
          image_url: null,
          servings: null,
          ingredients: [],
          phases: [],
        },
      },
    ]);
  });

  it("reports a missing recipe (P0002) distinctly, and anything else generically", async () => {
    const missing = makeClient({ rpcResult: { data: null, error: { code: "P0002", message: "x" } } });
    expect(await saveRecipe(missing.client, { ...BASE, id: "gone" })).toEqual({
      ok: false,
      error: "That recipe no longer exists.",
    });

    const other = makeClient({ rpcResult: { data: null, error: { code: "XX000", message: "x" } } });
    expect(await saveRecipe(other.client, BASE)).toEqual({
      ok: false,
      error: "We couldn't save that recipe. Please try again.",
    });
  });
});
