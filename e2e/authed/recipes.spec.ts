import { randomUUID } from "node:crypto";

import { expect, test } from "@playwright/test";

/**
 * Authenticated recipe-ingest flow (issue #12c): the by-hand add path.
 *
 * The URL-fetch path is deliberately NOT exercised here against a real
 * internet URL — see the plan's Task 9 rationale (ingest-core.test.ts and
 * recipe-ingest-form.test.tsx already cover it offline and deterministically).
 * This test proves the full authenticated stack round-trips for real: an
 * RLS-scoped insert as the signed-in user, the PRG redirect, and the rendered
 * read-only detail page (Task 8).
 */
test("adding a recipe by hand (no URL) saves it and lands on its detail page", async ({
  page,
}) => {
  const title = `E2E Hand-Added Dish ${randomUUID().slice(0, 8)}`;

  await page.goto("/recipes/new");

  await page.getByLabel("Title").fill(title);
  await page.getByLabel(/ingredients/i).fill("2 cups flour\n1 tsp salt");
  await page.getByRole("button", { name: "Save to library" }).click();

  // PRG (kickoff resolution 2): the save redirects to the new recipe's
  // canonical URL, and the read-only detail page shows what we just saved.
  await expect(page).toHaveURL(/\/recipes\/[0-9a-f-]{36}$/);
  await expect(page.getByRole("heading", { name: title })).toBeVisible();
  await expect(page.getByText("2 cups flour")).toBeVisible();
  await expect(page.getByText("1 tsp salt")).toBeVisible();
});

/**
 * The recipe library list (issue #12d): a saved dish shows up on /recipes
 * and its link opens the correct detail page. Assumes 12c's Kickoff
 * Resolution 2 (successful save does a Post/Redirect/Get to /recipes/{id})
 * — see this plan's Global Constraints for the flagged assumption to verify
 * against the actually-merged 12c before running this.
 */
test("a saved recipe appears in the library list and its link opens the correct detail page", async ({
  page,
}) => {
  const title = `E2E Library Dish ${randomUUID().slice(0, 8)}`;

  await page.goto("/recipes/new");
  await page.getByLabel("Title").fill(title);
  await page.getByRole("button", { name: "Save to library" }).click();

  // Save redirects (PRG) straight to the new dish's detail page.
  await expect(page).toHaveURL(/\/recipes\/[^/]+$/);
  await expect(page.getByRole("heading", { name: title })).toBeVisible();

  await page.goto("/recipes");
  const libraryLink = page.getByRole("link", { name: title });
  await expect(libraryLink).toBeVisible();

  await libraryLink.click();
  await expect(page.getByRole("heading", { name: title })).toBeVisible();
});
