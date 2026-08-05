import { describe, expect, it, vi } from "vitest";

import type { SafeFetchFailure, SafeFetchResult } from "@/lib/http/safe-fetch";

import {
  EMPTY_RECIPE_PREVIEW,
  fetchRecipePreview,
  ingredientRowsFromText,
  saveIngestedDish,
  type FetchHtml,
} from "./ingest-core";

/**
 * `fetchRecipePreview` orchestrates the fetch → extract → scrub pipeline over
 * an INJECTED fetcher (no live network) so both the SSRF-guarded fetcher's
 * rejections and JSON-LD extraction/scrubbing are exercised deterministically.
 * See ingest-core.ts's module doc for the security contract this pins.
 */

const RECIPE_JSON = {
  "@context": "https://schema.org",
  "@type": "Recipe",
  name: "Carnitas Tacos",
  image: "https://example.com/tacos.jpg",
  recipeIngredient: ["2 lb pork shoulder", "1 tbsp ground cumin"],
  prepTime: "PT20M",
  cookTime: "PT1H30M",
  totalTime: "PT1H50M",
};
const RECIPE_HTML = `<html><head><script type="application/ld+json">${JSON.stringify(RECIPE_JSON)}</script></head><body></body></html>`;

const XSS_IMAGE_HTML = `<html><head><script type="application/ld+json">${JSON.stringify(
  {
    "@type": "Recipe",
    name: "Sneaky",
    image: "javascript:alert(1)",
    recipeIngredient: ["1 egg"],
  },
)}</script></head></html>`;

const NO_RECIPE_HTML = `<html><body><p>Just a blog post, no recipe here.</p></body></html>`;

function fetchOk(html: string): FetchHtml {
  return vi.fn(
    async (url: string): Promise<SafeFetchResult> => ({ ok: true, html, finalUrl: url }),
  );
}

function fetchFail(reason: SafeFetchFailure): FetchHtml {
  return vi.fn(async (): Promise<SafeFetchResult> => ({ ok: false, reason }));
}

describe("fetchRecipePreview", () => {
  it("returns an editable preview extracted from a fetched recipe page", async () => {
    const fetchHtml = fetchOk(RECIPE_HTML);
    const result = await fetchRecipePreview(fetchHtml, "https://example.com/tacos");

    expect(result).toEqual({
      ok: true,
      sourceUrl: "https://example.com/tacos",
      preview: {
        title: "Carnitas Tacos",
        imageUrl: "https://example.com/tacos.jpg",
        ingredientLines: ["2 lb pork shoulder", "1 tbsp ground cumin"],
        prepMinutes: 20,
        cookMinutes: 90,
        totalMinutes: 110,
      },
    });
    expect(fetchHtml).toHaveBeenCalledWith("https://example.com/tacos");
  });

  it("rejects a non-http(s) URL WITHOUT ever calling the fetcher", async () => {
    const fetchHtml = vi.fn();
    const result = await fetchRecipePreview(
      fetchHtml as unknown as FetchHtml,
      "javascript:alert(1)",
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.notice).toMatch(/valid http/i);
    expect(result.preview).toEqual(EMPTY_RECIPE_PREVIEW);
    expect(fetchHtml).not.toHaveBeenCalled();
  });

  it("falls back to the empty editable preview when the fetch is blocked (SSRF / private range)", async () => {
    const fetchHtml = fetchFail("blocked-address");
    const result = await fetchRecipePreview(fetchHtml, "http://169.254.169.254/");

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.notice).toMatch(/couldn't fetch/i);
    expect(result.preview).toEqual(EMPTY_RECIPE_PREVIEW);
  });

  it("falls back to the empty editable preview when the page has no Recipe JSON-LD", async () => {
    const fetchHtml = fetchOk(NO_RECIPE_HTML);
    const result = await fetchRecipePreview(fetchHtml, "https://example.com/blog-post");

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.notice).toMatch(/couldn't find a recipe/i);
    expect(result.preview).toEqual(EMPTY_RECIPE_PREVIEW);
  });

  it("drops a javascript: image URL found in the page's JSON-LD (never reaches the client)", async () => {
    const fetchHtml = fetchOk(XSS_IMAGE_HTML);
    const result = await fetchRecipePreview(fetchHtml, "https://example.com/sneaky");

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.preview.imageUrl).toBeNull();
  });
});

describe("ingredientRowsFromText", () => {
  it("parses each non-blank line, in order, with household/dish scoping", () => {
    const rows = ingredientRowsFromText(
      "2 lb pork shoulder\n\n1 tbsp ground cumin",
      "hh-1",
      "d1",
    );
    expect(rows).toEqual([
      {
        household_id: "hh-1",
        dish_id: "d1",
        name: "pork shoulder",
        quantity: 2,
        unit: "lb",
        raw_text: "2 lb pork shoulder",
        position: 0,
      },
      {
        household_id: "hh-1",
        dish_id: "d1",
        name: "ground cumin",
        quantity: 1,
        unit: "tbsp",
        raw_text: "1 tbsp ground cumin",
        position: 1,
      },
    ]);
  });

  it("falls back to the raw line as the name when parsing yields no name (e.g. a bare quantity)", () => {
    const rows = ingredientRowsFromText("2", "hh-1", "d1");
    expect(rows).toEqual([
      {
        household_id: "hh-1",
        dish_id: "d1",
        name: "2",
        quantity: 2,
        unit: null,
        raw_text: "2",
        position: 0,
      },
    ]);
  });

  it("returns no rows for blank input", () => {
    expect(ingredientRowsFromText("   \n\n  ", "hh-1", "d1")).toEqual([]);
  });
});

type Result = { data: unknown; error: unknown };

function makeSaveClient(opts: { dish?: Result; ingredientsError?: unknown }) {
  const dishesInsert: unknown[] = [];
  const ingredientsInsert: unknown[] = [];
  const fromTables: string[] = [];

  const from = vi.fn((table: string) => {
    fromTables.push(table);
    if (table === "dishes") {
      return {
        insert: vi.fn((vals: unknown) => {
          dishesInsert.push(vals);
          return {
            select: () => ({
              single: async () => opts.dish ?? { data: { id: "d1" }, error: null },
            }),
          };
        }),
      };
    }
    return {
      insert: vi.fn((vals: unknown) => {
        ingredientsInsert.push(vals);
        return Promise.resolve({ error: opts.ingredientsError ?? null });
      }),
    };
  });

  return {
    client: { from } as unknown as Parameters<typeof saveIngestedDish>[0],
    calls: { dishesInsert, ingredientsInsert, fromTables },
  };
}

describe("saveIngestedDish", () => {
  it("inserts the dish then its ingredients, in order", async () => {
    const { client, calls } = makeSaveClient({});

    const result = await saveIngestedDish(client, {
      householdId: "hh-1",
      createdBy: "m1",
      title: "  Carnitas Tacos  ",
      sourceUrl: "https://example.com/tacos",
      imageUrl: "https://example.com/tacos.jpg",
      prepMinutes: "20",
      cookMinutes: "90",
      totalMinutes: "110",
      ingredientsText: "2 lb pork shoulder\n1 tbsp ground cumin",
    });

    expect(result).toEqual({
      ok: true,
      dishId: "d1",
      ingredientsSaved: true,
      sourceUrl: "https://example.com/tacos",
    });
    expect(calls.dishesInsert).toEqual([
      {
        household_id: "hh-1",
        title: "Carnitas Tacos",
        source_url: "https://example.com/tacos",
        image_url: "https://example.com/tacos.jpg",
        prep_minutes: 20,
        cook_minutes: 90,
        total_minutes: 110,
        created_by: "m1",
      },
    ]);
    expect(calls.ingredientsInsert).toEqual([
      [
        {
          household_id: "hh-1",
          dish_id: "d1",
          name: "pork shoulder",
          quantity: 2,
          unit: "lb",
          raw_text: "2 lb pork shoulder",
          position: 0,
        },
        {
          household_id: "hh-1",
          dish_id: "d1",
          name: "ground cumin",
          quantity: 1,
          unit: "tbsp",
          raw_text: "1 tbsp ground cumin",
          position: 1,
        },
      ],
    ]);
  });

  it("rejects a blank title before any DB call", async () => {
    const { client, calls } = makeSaveClient({});
    const result = await saveIngestedDish(client, {
      householdId: "hh-1",
      createdBy: "m1",
      title: "   ",
      sourceUrl: "",
      imageUrl: "",
      prepMinutes: "",
      cookMinutes: "",
      totalMinutes: "",
      ingredientsText: "",
    });
    expect(result.ok).toBe(false);
    expect(calls.fromTables).toEqual([]);
  });

  it("stores null source/image URLs and null times for a by-hand add with no URL", async () => {
    const { client, calls } = makeSaveClient({});
    await saveIngestedDish(client, {
      householdId: "hh-1",
      createdBy: "m1",
      title: "Skillet Chicken",
      sourceUrl: "",
      imageUrl: "",
      prepMinutes: "",
      cookMinutes: "",
      totalMinutes: "",
      ingredientsText: "1 lb chicken thighs",
    });
    expect(calls.dishesInsert[0]).toMatchObject({
      source_url: null,
      image_url: null,
      prep_minutes: null,
      cook_minutes: null,
      total_minutes: null,
    });
  });

  it("drops (not blocks on) a javascript: image URL — the dish still saves", async () => {
    const { client, calls } = makeSaveClient({});
    const result = await saveIngestedDish(client, {
      householdId: "hh-1",
      createdBy: "m1",
      title: "Sneaky",
      sourceUrl: "",
      imageUrl: "javascript:alert(document.cookie)",
      prepMinutes: "",
      cookMinutes: "",
      totalMinutes: "",
      ingredientsText: "1 egg",
    });
    expect(result.ok).toBe(true);
    expect(calls.dishesInsert[0]).toMatchObject({ image_url: null });
  });

  it("drops a mistyped/tampered source URL rather than failing the save", async () => {
    const { client, calls } = makeSaveClient({});
    const result = await saveIngestedDish(client, {
      householdId: "hh-1",
      createdBy: "m1",
      title: "Tampered",
      sourceUrl: "javascript:alert(1)",
      imageUrl: "",
      prepMinutes: "",
      cookMinutes: "",
      totalMinutes: "",
      ingredientsText: "",
    });
    expect(result.ok).toBe(true);
    expect(calls.dishesInsert[0]).toMatchObject({ source_url: null });
    // The scrubbed source URL a caller gates `recipe_ingested` on is null here —
    // a tampered javascript: URL is NOT a real URL-sourced ingest.
    if (result.ok) expect(result.sourceUrl).toBeNull();
  });

  it("ignores unparseable/negative minutes fields rather than crashing, and rounds decimals", async () => {
    const { client, calls } = makeSaveClient({});
    await saveIngestedDish(client, {
      householdId: "hh-1",
      createdBy: "m1",
      title: "Weird Times",
      sourceUrl: "",
      imageUrl: "",
      prepMinutes: "not-a-number",
      cookMinutes: "-5",
      totalMinutes: "12.7",
      ingredientsText: "",
    });
    expect(calls.dishesInsert[0]).toMatchObject({
      prep_minutes: null,
      cook_minutes: null,
      total_minutes: 13,
    });
  });

  it("does not touch the ingredients table for a title-only add (no ingredient lines)", async () => {
    const { client, calls } = makeSaveClient({});
    const result = await saveIngestedDish(client, {
      householdId: "hh-1",
      createdBy: "m1",
      title: "Just a title",
      sourceUrl: "",
      imageUrl: "",
      prepMinutes: "",
      cookMinutes: "",
      totalMinutes: "",
      ingredientsText: "   ",
    });
    expect(result).toEqual({
      ok: true,
      dishId: "d1",
      ingredientsSaved: true,
      sourceUrl: null,
    });
    expect(calls.fromTables).toEqual(["dishes"]);
  });

  it("returns a benign ingredientsSaved:false when the dish saves but the ingredients insert fails", async () => {
    const { client } = makeSaveClient({ ingredientsError: { message: "boom" } });
    const result = await saveIngestedDish(client, {
      householdId: "hh-1",
      createdBy: "m1",
      title: "Half Saved",
      sourceUrl: "",
      imageUrl: "",
      prepMinutes: "",
      cookMinutes: "",
      totalMinutes: "",
      ingredientsText: "1 egg",
    });
    expect(result).toEqual({
      ok: true,
      dishId: "d1",
      ingredientsSaved: false,
      sourceUrl: null,
    });
  });

  it("fails closed when the dish insert itself errors", async () => {
    const { client, calls } = makeSaveClient({
      dish: { data: null, error: { message: "boom" } },
    });
    const result = await saveIngestedDish(client, {
      householdId: "hh-1",
      createdBy: "m1",
      title: "Ill-Fated",
      sourceUrl: "",
      imageUrl: "",
      prepMinutes: "",
      cookMinutes: "",
      totalMinutes: "",
      ingredientsText: "1 egg",
    });
    expect(result.ok).toBe(false);
    expect(calls.ingredientsInsert).toEqual([]);
  });
});
