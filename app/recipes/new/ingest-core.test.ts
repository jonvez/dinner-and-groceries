import { describe, expect, it, vi } from "vitest";

import type { SafeFetchFailure, SafeFetchResult } from "@/lib/http/safe-fetch";

import {
  EMPTY_RECIPE_PREVIEW,
  fetchRecipePreview,
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
