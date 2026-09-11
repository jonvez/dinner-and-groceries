import { randomUUID } from "node:crypto";

import { expect, test } from "@playwright/test";

/**
 * A pasted, bullet-prefixed ingredient list survives all the way to the grocery
 * list with the amount OUT of the item name (issue #170).
 *
 * The parser's unit suite proves the parse; only the browser proves the whole
 * pipe — free-text ingest -> stored ingredient rows -> the week's roll-up ->
 * what a parent actually reads in the store. The bug was invisible in the parser
 * alone: the line still saved, still rendered, and only the NAME was wrong —
 * which is also the roll-up's dedupe key (ADR 0003), so the same ingredient
 * stopped merging across dishes.
 *
 * Serial: the roll-up rebuilds this household's one active list, so a parallel
 * "Complete trip" elsewhere would archive rows mid-assertion.
 */
test.describe.configure({ mode: "serial" });

/** Letters only, so "the name carries no digits" is a meaningful assertion. */
function lettersOnlyToken(): string {
  return randomUUID().replace(/[^a-z]/g, "").slice(0, 8).padEnd(8, "x");
}

test("a bullet-prefixed pasted list reaches the grocery list with no amount in the name", async ({
  page,
}) => {
  const token = lettersOnlyToken();
  const title = `E2E Pasted Dish ${token}`;
  const flour = `Eziest Flour ${token}`;
  const oil = `Eziest Olive Oil ${token}`;
  const garlic = `Eziest Garlic ${token}`;

  // --- Paste the list exactly as a recipe site hands it over ---------------
  await page.goto("/recipes/new");
  await page.getByLabel("Title").fill(title);
  await page
    .getByLabel(/ingredients/i)
    .fill([`- 2 cups ${flour}`, `• 1 tbsp ${oil}`, `▢ 3 cloves ${garlic}`].join("\n"));
  await page.getByRole("button", { name: "Save to library" }).click();
  await expect(page).toHaveURL(/\/recipes\/[0-9a-f-]{36}$/);
  await expect(page.getByRole("heading", { name: title })).toBeVisible();

  // --- Put it on this week's menu -----------------------------------------
  await page.goto("/board");
  await page.getByLabel("Propose again from your library").selectOption({ label: title });
  await page.getByRole("button", { name: "Propose again" }).click();

  const card = page.locator("li").filter({ hasText: title });
  await expect(card.getByTestId("proposal-title")).toHaveText(title);

  // Index 1 skips the disabled "Day…" placeholder; the meal type defaults.
  await card.getByLabel("Day").selectOption({ index: 1 });
  await card.getByRole("button", { name: "Slot it" }).click();
  await expect(page.getByRole("button", { name: `Unslot ${title}` })).toBeVisible();

  // --- Build the list a parent would shop from ----------------------------
  await page.goto("/grocery");
  await expect(page.getByRole("heading", { name: "Groceries" })).toBeVisible();
  await page.getByRole("button", { name: "Rebuild from menu" }).click();
  await expect(page.getByTestId("grocery-notice")).toBeVisible();

  for (const [ingredient, amount] of [
    [flour, "2 cup"],
    [oil, "1 tbsp"],
    [garlic, "3 clove"],
  ] as const) {
    const row = page.getByTestId("grocery-item").filter({ hasText: token });
    const mine = row.filter({ hasText: ingredient });
    await expect(mine).toHaveCount(1);

    // The NAME is the assertion: no bullet, no digits, no unit token. It is
    // also the dedupe key, which is why this is the row that matters.
    await expect(mine).toHaveAttribute("data-name", ingredient);
    const name = (await mine.getAttribute("data-name")) ?? "";
    expect(name).not.toMatch(/\d/);
    expect(name).not.toMatch(/[-•▢]/);
    expect(name).not.toMatch(/\b(cups?|tbsp|tablespoons?|cloves?)\b/i);

    // The amount is still there — parsed out into its own field, not lost.
    await expect(mine).toContainText(amount);
    await expect(page.getByRole("checkbox", { name: ingredient })).toBeVisible();
  }
});
