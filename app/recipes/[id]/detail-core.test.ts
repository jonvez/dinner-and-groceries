import { describe, expect, it, vi } from "vitest";

import { loadRecipeDetail } from "./detail-core";

/**
 * `loadRecipeDetail` reads a dish + its ingredient lines through an INJECTED
 * client (no live DB). In production the cookie-session client's RLS scopes the
 * read to the caller's household, so a bad id OR another household's id both
 * surface as "no dish row" — the loader returns null and the page 404s. The
 * not-found branch is covered here; the found path end-to-end is Task 9's E2E.
 */

type DishRow = {
  id: string;
  title: string;
  image_url: string | null;
  source_url: string | null;
  prep_minutes: number | null;
  cook_minutes: number | null;
  total_minutes: number | null;
};

function detailClient(opts: {
  dish: DishRow | null;
  ingredients?: { raw_text: string }[];
}) {
  const from = vi.fn((table: string) => {
    if (table === "dishes") {
      return {
        select: () => ({
          eq: () => ({
            maybeSingle: async () => ({ data: opts.dish, error: null }),
          }),
        }),
      };
    }
    return {
      select: () => ({
        eq: () => ({
          order: async () => ({ data: opts.ingredients ?? [], error: null }),
        }),
      }),
    };
  });
  return { from } as unknown as Parameters<typeof loadRecipeDetail>[0];
}

describe("loadRecipeDetail", () => {
  it("returns null when RLS yields no dish row (bad id OR another household's recipe)", async () => {
    const client = detailClient({ dish: null });
    expect(
      await loadRecipeDetail(client, "00000000-0000-0000-0000-000000000000"),
    ).toBeNull();
  });

  it("maps the dish and its ingredient lines (in position order) for a found recipe", async () => {
    const client = detailClient({
      dish: {
        id: "d1",
        title: "Carnitas Tacos",
        image_url: "https://example.com/tacos.jpg",
        source_url: "https://example.com/tacos",
        prep_minutes: 20,
        cook_minutes: 90,
        total_minutes: 110,
      },
      ingredients: [
        { raw_text: "2 lb pork shoulder" },
        { raw_text: "1 tbsp ground cumin" },
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
      ingredientLines: ["2 lb pork shoulder", "1 tbsp ground cumin"],
    });
  });

  it("returns an empty ingredient-line list for a title-only recipe", async () => {
    const client = detailClient({
      dish: {
        id: "d2",
        title: "Just a title",
        image_url: null,
        source_url: null,
        prep_minutes: null,
        cook_minutes: null,
        total_minutes: null,
      },
      ingredients: [],
    });

    const detail = await loadRecipeDetail(client, "d2");
    expect(detail).not.toBeNull();
    expect(detail?.ingredientLines).toEqual([]);
    expect(detail?.imageUrl).toBeNull();
  });

  it("re-scrubs an unsafe stored image/source URL (defense-in-depth) rather than trusting the stored row", async () => {
    const client = detailClient({
      dish: {
        id: "d3",
        title: "Compromised Row",
        image_url: "javascript:alert(1)",
        source_url: "javascript:alert(1)",
        prep_minutes: null,
        cook_minutes: null,
        total_minutes: null,
      },
      ingredients: [],
    });

    const detail = await loadRecipeDetail(client, "d3");
    expect(detail).not.toBeNull();
    expect(detail?.imageUrl).toBeNull();
    expect(detail?.sourceUrl).toBeNull();
  });
});
