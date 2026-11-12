import { describe, expect, it, vi } from "vitest";

import { groupIngredients, loadRecipeDetail } from "./detail-core";

/**
 * `loadRecipeDetail` reads a dish + its ingredients, phases and steps through
 * an INJECTED client (no live DB). In production the cookie-session client's
 * RLS scopes the read to the caller's household, so a bad id OR another
 * household's id both surface as "no dish row": the loader returns null and
 * the page 404s.
 */

type DishRow = {
  id: string;
  title: string;
  image_url: string | null;
  source_url: string | null;
  prep_minutes: number | null;
  cook_minutes: number | null;
  total_minutes: number | null;
  servings?: string | null;
};

type Rows = {
  ingredients?: { raw_text: string; section: string | null }[];
  dish_phases?: { id: string; title: string; intro: string[] }[];
  dish_steps?: { id: string; phase_id: string; position: number; body: string; notes: string[] }[];
};

function detailClient(opts: { dish: DishRow | null } & Rows) {
  const selects: Record<string, string> = {};
  const from = vi.fn((table: string) => {
    if (table === "dishes") {
      return {
        select: (cols: string) => {
          selects[table] = cols;
          return {
            eq: () => ({
              maybeSingle: async () => ({ data: opts.dish, error: null }),
            }),
          };
        },
      };
    }
    return {
      select: (cols: string) => {
        selects[table] = cols;
        return {
          eq: () => ({
            order: async () => ({ data: opts[table as keyof Rows] ?? [], error: null }),
          }),
        };
      },
    };
  });
  return {
    client: { from } as unknown as Parameters<typeof loadRecipeDetail>[0],
    selects,
  };
}

const BARE_DISH: DishRow = {
  id: "d2",
  title: "Just a title",
  image_url: null,
  source_url: null,
  prep_minutes: null,
  cook_minutes: null,
  total_minutes: null,
  servings: null,
};

describe("loadRecipeDetail", () => {
  it("returns null when RLS yields no dish row (bad id OR another household's recipe)", async () => {
    const { client } = detailClient({ dish: null });
    expect(
      await loadRecipeDetail(client, "00000000-0000-0000-0000-000000000000"),
    ).toBeNull();
  });

  it("maps the dish, its grouped ingredients, and its method for a found recipe", async () => {
    const { client } = detailClient({
      dish: {
        id: "d1",
        title: "Carnitas Tacos",
        image_url: "https://example.com/tacos.jpg",
        source_url: "https://example.com/tacos",
        prep_minutes: 20,
        cook_minutes: 90,
        total_minutes: 110,
        servings: "6 to 8",
      },
      ingredients: [
        { raw_text: "2 lb pork shoulder", section: null },
        { raw_text: "1 tbsp ground cumin", section: "Rub" },
      ],
      dish_phases: [
        { id: "p0", title: "Start", intro: [] },
        { id: "p1", title: "Leftovers", intro: ["Store the rice separately."] },
      ],
      dish_steps: [
        { id: "s0", phase_id: "p0", position: 0, body: "Rub the pork.", notes: ["Overnight is best."] },
        { id: "s1", phase_id: "p0", position: 1, body: "Braise.", notes: [] },
      ],
    });

    expect(await loadRecipeDetail(client, "d1")).toEqual({
      id: "d1",
      title: "Carnitas Tacos",
      imageUrl: "https://example.com/tacos.jpg",
      sourceUrl: "https://example.com/tacos",
      prepMinutes: 20,
      cookMinutes: 90,
      totalMinutes: 110,
      servings: "6 to 8",
      ingredientGroups: [
        { section: null, lines: ["2 lb pork shoulder"] },
        { section: "Rub", lines: ["1 tbsp ground cumin"] },
      ],
      method: {
        phases: [
          {
            title: "Start",
            intro: [],
            steps: [
              { id: "s0", n: 1, body: "Rub the pork.", notes: ["Overnight is best."] },
              { id: "s1", n: 2, body: "Braise.", notes: [] },
            ],
          },
          { title: "Leftovers", intro: ["Store the rice separately."], steps: [] },
        ],
      },
    });
  });

  it("numbers steps across the whole dish from their position, under their own phase", async () => {
    const { client } = detailClient({
      dish: BARE_DISH,
      dish_phases: [
        { id: "p0", title: "A", intro: [] },
        { id: "p1", title: "B", intro: [] },
      ],
      dish_steps: [
        { id: "s0", phase_id: "p0", position: 0, body: "One.", notes: [] },
        { id: "s1", phase_id: "p1", position: 1, body: "Two.", notes: [] },
        { id: "s2", phase_id: "p1", position: 2, body: "Three.", notes: [] },
      ],
    });

    const detail = await loadRecipeDetail(client, "d2");
    expect(detail?.method?.phases.map((p) => p.steps.map((s) => `${s.n}:${s.id}`))).toEqual([
      ["1:s0"],
      ["2:s1", "3:s2"],
    ]);
  });

  it("has no method and no ingredient groups for a title-only recipe", async () => {
    const { client } = detailClient({ dish: BARE_DISH });

    const detail = await loadRecipeDetail(client, "d2");
    expect(detail?.method).toBeNull();
    expect(detail?.ingredientGroups).toEqual([]);
    expect(detail?.servings).toBeNull();
  });

  it("never reads the legacy description column (rows are the truth)", async () => {
    const { client, selects } = detailClient({ dish: BARE_DISH });
    await loadRecipeDetail(client, "d2");
    expect(selects.dishes).not.toMatch(/description/);
  });

  it("re-scrubs an unsafe stored image/source URL (defense-in-depth) rather than trusting the stored row", async () => {
    const { client } = detailClient({
      dish: {
        ...BARE_DISH,
        id: "d3",
        image_url: "javascript:alert(1)",
        source_url: "javascript:alert(1)",
      },
    });

    const detail = await loadRecipeDetail(client, "d3");
    expect(detail).not.toBeNull();
    expect(detail?.imageUrl).toBeNull();
    expect(detail?.sourceUrl).toBeNull();
  });
});

describe("groupIngredients", () => {
  it("groups consecutive lines that share a section, in order", () => {
    expect(
      groupIngredients([
        { raw_text: "1 lb rigatoni", section: null },
        { raw_text: "12 oz ricotta", section: "Filling" },
        { raw_text: "2 eggs", section: "Filling" },
        { raw_text: "1 cup red sauce", section: "Topping" },
      ]),
    ).toEqual([
      { section: null, lines: ["1 lb rigatoni"] },
      { section: "Filling", lines: ["12 oz ricotta", "2 eggs"] },
      { section: "Topping", lines: ["1 cup red sauce"] },
    ]);
  });

  it("is empty for no ingredients", () => {
    expect(groupIngredients([])).toEqual([]);
  });
});
