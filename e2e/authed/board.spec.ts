import { randomUUID } from "node:crypto";

import { expect, test } from "@playwright/test";

/**
 * Authenticated board flows (issue #56). These run with user A's seeded session
 * (`storageState` at the project level), so they exercise the loop today's smoke
 * suite skips: authed SSR + RLS rendering (the surface #62 broke on) and the full
 * propose -> react -> comment round-trip.
 */

test("an authenticated member lands on the board (authed SSR + RLS render)", async ({
  page,
}) => {
  await page.goto("/board");

  // Not bounced to /login — the seeded session is honored end to end.
  await expect(page).toHaveURL(/\/board/);
  await expect(
    page.getByRole("heading", { name: "Weekly menu" }),
  ).toBeVisible();
  // The RLS-scoped proposal pool region renders for the member's household.
  await expect(
    page.getByRole("region", { name: "This week's ideas" }),
  ).toBeVisible();
});

test("propose -> react -> comment all render", async ({ page }) => {
  const title = `Authed Dish ${randomUUID().slice(0, 8)}`;
  const comment = `Looks great ${randomUUID().slice(0, 8)}`;

  await page.goto("/board");

  // Propose a new dish for the current week.
  await page.getByLabel("Dish title").fill(title);
  await page.getByRole("button", { name: "Propose dish" }).click();

  // The proposal renders in the pool (revalidated server snapshot).
  const card = page.locator("li").filter({ hasText: title });
  await expect(card.getByTestId("proposal-title")).toHaveText(title);

  // React with a thumbs-up: the actor's own view refreshes via revalidatePath,
  // so the count appears and the button reads as pressed.
  await card.getByRole("button", { name: "React 👍", exact: true }).click();
  await expect(
    card.getByRole("button", { name: "React 👍 (1)", exact: true }),
  ).toBeVisible();

  // Comment on the same proposal and confirm it renders in the thread.
  await card.getByLabel("Add a comment").fill(comment);
  await card.getByRole("button", { name: "Post", exact: true }).click();
  await expect(card.getByText(comment)).toBeVisible();
});
