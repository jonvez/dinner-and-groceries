import { describe, expect, it, vi } from "vitest";

import type { SafeFetchFailure, SafeFetchResult } from "@/lib/http/safe-fetch";

import {
  EMPTY_RECIPE_PREVIEW,
  fetchRecipePreview,
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

/**
 * `saveIngestedDish` is now a thin adapter over the atomic `saveRecipe`
 * (lib/recipes/save-recipe.ts, #272): form strings in, ONE `save_recipe` RPC
 * out. Household and author are derived in SQL from the session, so the
 * adapter never sends them. There is no partial-success state any more: the
 * dish, its ingredients and its method land together or not at all.
 */
function makeSaveClient(opts: { rpcResult?: { data: unknown; error: unknown } } = {}) {
  const rpc = vi.fn(async () => opts.rpcResult ?? { data: "d1", error: null });
  const from = vi.fn();
  return {
    client: { from, rpc } as unknown as Parameters<typeof saveIngestedDish>[0],
    rpc,
    from,
  };
}

const FORM = {
  title: "  Carnitas Tacos  ",
  sourceUrl: "https://example.com/tacos",
  imageUrl: "https://example.com/tacos.jpg",
  prepMinutes: "20",
  cookMinutes: "90",
  totalMinutes: "110",
  servings: "4",
  ingredientsText: "2 lb pork shoulder\n## Rub\n1 tbsp ground cumin",
  methodText: "## Start\n1. Rub [[the pork]].\n2. Braise.",
};

function sentRecipe(rpc: ReturnType<typeof makeSaveClient>["rpc"]) {
  return (rpc.mock.calls[0] as unknown as [string, { p_recipe: Record<string, unknown> }])[1]
    .p_recipe;
}

describe("saveIngestedDish", () => {
  it("creates the whole recipe (dish, grouped ingredients, method) in ONE save_recipe call", async () => {
    const { client, rpc, from } = makeSaveClient();

    const result = await saveIngestedDish(client, FORM);

    expect(result).toEqual({ ok: true, dishId: "d1", sourceUrl: "https://example.com/tacos" });
    expect(from).not.toHaveBeenCalled();
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith("save_recipe", {
      p_recipe: {
        id: null,
        title: "Carnitas Tacos",
        source_url: "https://example.com/tacos",
        image_url: "https://example.com/tacos.jpg",
        prep_minutes: 20,
        cook_minutes: 90,
        total_minutes: 110,
        servings: "4",
        ingredients: [
          { name: "pork shoulder", quantity: 2, unit: "lb", raw_text: "2 lb pork shoulder", section: null },
          { name: "ground cumin", quantity: 1, unit: "tbsp", raw_text: "1 tbsp ground cumin", section: "Rub" },
        ],
        phases: [
          {
            title: "Start",
            intro: [],
            steps: [
              { id: null, body: "Rub [[the pork]].", notes: [] },
              { id: null, body: "Braise.", notes: [] },
            ],
          },
        ],
      },
    });
  });

  it("never sends a household or author: SQL derives both from the session", async () => {
    const { client, rpc } = makeSaveClient();
    await saveIngestedDish(client, FORM);
    const recipe = sentRecipe(rpc);
    expect(recipe).not.toHaveProperty("household_id");
    expect(recipe).not.toHaveProperty("created_by");
  });

  it("rejects a blank title before any DB call", async () => {
    const { client, rpc } = makeSaveClient();
    const result = await saveIngestedDish(client, { ...FORM, title: "   " });
    expect(result.ok).toBe(false);
    expect(rpc).not.toHaveBeenCalled();
  });

  it("stores null source/image URLs, servings and times for a by-hand add with none", async () => {
    const { client, rpc } = makeSaveClient();
    await saveIngestedDish(client, {
      ...FORM,
      sourceUrl: "",
      imageUrl: "",
      prepMinutes: "",
      cookMinutes: "",
      totalMinutes: "",
      servings: "",
    });
    expect(sentRecipe(rpc)).toMatchObject({
      source_url: null,
      image_url: null,
      prep_minutes: null,
      cook_minutes: null,
      total_minutes: null,
      servings: null,
    });
  });

  it("drops (not blocks on) a javascript: image URL — the dish still saves", async () => {
    const { client, rpc } = makeSaveClient();
    const result = await saveIngestedDish(client, {
      ...FORM,
      imageUrl: "javascript:alert(document.cookie)",
    });
    expect(result.ok).toBe(true);
    expect(sentRecipe(rpc)).toMatchObject({ image_url: null });
  });

  it("drops a mistyped/tampered source URL and reports the scrubbed (null) URL", async () => {
    const { client, rpc } = makeSaveClient();
    const result = await saveIngestedDish(client, { ...FORM, sourceUrl: "javascript:alert(1)" });
    expect(result.ok).toBe(true);
    expect(sentRecipe(rpc)).toMatchObject({ source_url: null });
    // The scrubbed source URL a caller gates `recipe_ingested` on is null here —
    // a tampered javascript: URL is NOT a real URL-sourced ingest.
    if (result.ok) expect(result.sourceUrl).toBeNull();
  });

  it("ignores unparseable/negative minutes fields rather than crashing, and rounds decimals", async () => {
    const { client, rpc } = makeSaveClient();
    await saveIngestedDish(client, {
      ...FORM,
      prepMinutes: "not-a-number",
      cookMinutes: "-5",
      totalMinutes: "12.7",
    });
    expect(sentRecipe(rpc)).toMatchObject({
      prep_minutes: null,
      cook_minutes: null,
      total_minutes: 13,
    });
  });

  it("saves a title-only recipe with no ingredients and no method", async () => {
    const { client, rpc } = makeSaveClient();
    const result = await saveIngestedDish(client, {
      ...FORM,
      sourceUrl: "",
      ingredientsText: "   ",
      methodText: "",
    });
    expect(result).toEqual({ ok: true, dishId: "d1", sourceUrl: null });
    expect(sentRecipe(rpc)).toMatchObject({ ingredients: [], phases: [] });
  });

  it("fails closed when the save itself errors (nothing was written: it is atomic)", async () => {
    const { client } = makeSaveClient({ rpcResult: { data: null, error: { code: "XX000", message: "boom" } } });
    const result = await saveIngestedDish(client, FORM);
    expect(result).toEqual({ ok: false, error: "We couldn't save that recipe. Please try again." });
  });
});
