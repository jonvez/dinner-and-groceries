import { randomUUID } from "node:crypto";

import { expect, test } from "@playwright/test";

import { STORAGE_STATE_B } from "../support/paths";

/**
 * The owner-only PO dashboard, end to end (issue #17, ADR 0014).
 *
 * The seeded fixture is exactly the shape this feature is about: user A created
 * the household (so A is the OWNER) and user B joined by invite (a plain
 * MEMBER — the stand-in for a teen). Project-level `storageState` signs these
 * tests in as A; the deny case opens its own context as B.
 *
 * What only a browser can prove here: that a real non-owner session gets a real
 * 404 from the real middleware + route, and that none of the dashboard's copy
 * reaches them. The data boundary underneath it is RLS
 * (`supabase/tests/15_events_rls_test.sql`), and the route's branching is
 * unit-tested in `app/dashboard/page.test.tsx`.
 */

test("the owner opens the dashboard from Home and sees the three panels", async ({ page }) => {
  await page.goto("/");

  // The ONLY entry point: the owner-only region of Home (there is no nav
  // entry — ADR 0014 §4).
  const nav = page.getByRole("navigation", { name: "Main" });
  await expect(nav.getByRole("link", { name: /dashboard/i })).toHaveCount(0);
  await page.getByRole("link", { name: "Dashboard" }).click();

  await expect(page).toHaveURL(/\/dashboard$/);
  await expect(page.getByRole("heading", { level: 1, name: "Dashboard" })).toBeVisible();
  await expect(page.getByTestId("window-label")).toHaveText(/last 30 days/i);

  for (const name of [/adoption/i, /participation/i, /trips/i]) {
    await expect(page.getByRole("region", { name })).toBeVisible();
  }

  // Never a health/tag figure on this screen (#211 is blocked on M2).
  await expect(page.getByText(/health/i)).toHaveCount(0);
});

test("a participation event the owner just generated shows up per member", async ({ page }) => {
  const title = `Dashboard Dish ${randomUUID().slice(0, 8)}`;

  // Propose a dish: `proposal_created` is emitted server-side (#210).
  await page.goto("/board");
  await page.getByLabel("Dish title").fill(title);
  await page.getByRole("button", { name: "Propose dish" }).click();
  await expect(page.locator("li").filter({ hasText: title }).getByTestId("proposal-title"))
    .toHaveText(title);

  await page.goto("/dashboard");
  const participation = page.getByRole("region", { name: /participation/i });

  // The owner's own row carries at least the proposal just made, by display
  // name — the members join is display names only.
  const ownerRow = participation.getByRole("row").filter({ hasText: "Alex (E2E)" });
  await expect(ownerRow).toHaveCount(1);
  const proposed = Number(await ownerRow.getByTestId(/^participation-proposals-/).innerText());
  expect(proposed).toBeGreaterThanOrEqual(1);

  // The other member is listed too, even with nothing of her own: an absent row
  // would be indistinguishable from a bug.
  await expect(participation.getByRole("row").filter({ hasText: "Bailey (E2E)" })).toHaveCount(1);
});

test("a non-owner member gets a 404 — not a 403, and not a single figure", async ({ browser }) => {
  const memberCtx = await browser.newContext({ storageState: STORAGE_STATE_B });
  try {
    const member = await memberCtx.newPage();

    // The member IS signed in and IS in the household: /board renders for her.
    await member.goto("/board");
    await expect(member.getByRole("heading", { name: "Weekly menu" })).toBeVisible();

    const response = await member.goto("/dashboard");
    expect(response?.status(), "a non-owner must get 404, not 403").toBe(404);

    // None of the dashboard's copy reaches her — not the heading, not a panel.
    await expect(member.getByRole("heading", { level: 1, name: "Dashboard" })).toHaveCount(0);
    for (const name of [/adoption/i, /participation/i, /trips/i]) {
      await expect(member.getByRole("region", { name })).toHaveCount(0);
    }
    await expect(member.getByTestId("window-label")).toHaveCount(0);

    // And Home offers her no way in.
    await member.goto("/");
    await expect(member.getByRole("link", { name: /dashboard/i })).toHaveCount(0);
  } finally {
    await memberCtx.close();
  }
});
