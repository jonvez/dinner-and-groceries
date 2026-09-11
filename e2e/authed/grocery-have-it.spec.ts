import { randomUUID } from "node:crypto";

import { expect, test, type Page } from "@playwright/test";

import { STORAGE_STATE_A, STORAGE_STATE_B } from "../support/paths";

/**
 * "We have it" takes the item off the list — in ONE tap (issue #171). Two
 * browser contexts, two members of ONE household, against a real Supabase
 * Realtime socket:
 *
 *   1. A adds an ad-hoc item with a quantity + unit; B sees it (RLS-scoped SSR).
 *   2. A taps "We have it": the row leaves A's list immediately — no checkbox,
 *      no "Complete trip" — and the "(N to get)" count drops with it.
 *   3. It leaves B's list LIVE, with no reload. The row is NOT deleted or
 *      archived server-side (the roll-up planner still needs it, ADR 0012); the
 *      claim stamp is what removes it from both screens.
 *   4. A taps Undo: the item is back on BOTH lists with its quantity and unit
 *      intact — it never went anywhere, so nothing had to be reconstructed.
 *
 * Determinism (no fixed sleeps): the channel reports "Live" as soon as its JOIN
 * is acked, but Postgres-Changes delivery only starts once replication is
 * attached. We gate on Realtime's "Subscribed to PostgreSQL" system frame, then
 * rely on web-first (auto-retrying) assertions. Mirrors
 * e2e/authed/grocery-checkoff.spec.ts.
 */

const REALTIME_TIMEOUT = 20_000;

function trackPostgresChangesReady(page: Page): { ready: () => boolean } {
  let ready = false;
  page.on("websocket", (ws) => {
    if (!ws.url().includes("/realtime/")) return;
    ws.on("framereceived", (frame) => {
      const payload = typeof frame.payload === "string" ? frame.payload : "";
      if (payload.includes("Subscribed to PostgreSQL")) ready = true;
    });
  });
  return { ready: () => ready };
}

test('"we have it" removes the item on both phones, and Undo puts it back', async ({
  browser,
}) => {
  // A unique item, so parallel runs can never collide.
  const item = `E2E Olive Oil ${randomUUID().slice(0, 8)}`;

  const actorCtx = await browser.newContext({ storageState: STORAGE_STATE_A });
  const observerCtx = await browser.newContext({ storageState: STORAGE_STATE_B });

  try {
    const actor = await actorCtx.newPage();
    const observer = await observerCtx.newPage();
    const observerPg = trackPostgresChangesReady(observer);

    const actorRow = actor.getByTestId("grocery-item").filter({ hasText: item });
    const observerRow = observer
      .getByTestId("grocery-item")
      .filter({ hasText: item });

    // --- A adds an ad-hoc item, with an amount worth preserving -------------
    await actor.goto("/grocery");
    await expect(actor.getByRole("heading", { name: "Groceries" })).toBeVisible();
    await actor.getByLabel("Item", { exact: true }).fill(item);
    await actor.getByLabel("Quantity", { exact: true }).fill("2");
    await actor.getByLabel("Unit", { exact: true }).fill("cup");
    await actor.getByRole("button", { name: "Add", exact: true }).click();

    await expect(actorRow).toHaveCount(1);
    await expect(actorRow).toContainText("2 cup");

    // --- B opens the SAME household's list and goes live --------------------
    await observer.goto("/grocery");
    await expect(observerRow).toHaveCount(1);
    await expect(observer.getByTestId("realtime-status")).toHaveText("Live", {
      timeout: REALTIME_TIMEOUT,
    });
    await expect.poll(observerPg.ready, { timeout: REALTIME_TIMEOUT }).toBe(true);

    // --- A taps "We have it" — one tap, and it's gone -----------------------
    await actorRow.getByRole("button", { name: "We have it" }).click();

    await expect(actorRow).toHaveCount(0);
    // …and live on B, with no reload.
    await expect(observerRow).toHaveCount(0, { timeout: REALTIME_TIMEOUT });

    // --- Undo puts it back, aisle/quantity/unit intact ----------------------
    const notice = actor.getByTestId("grocery-notice");
    await expect(notice).toContainText(item);
    await notice.getByRole("button", { name: "Undo" }).click();

    await expect(actorRow).toHaveCount(1);
    await expect(actorRow).toContainText("2 cup");
    // The other phone gets it back live too — an undone claim is an ordinary
    // row update, upserted by PK.
    await expect(observerRow).toHaveCount(1, { timeout: REALTIME_TIMEOUT });
    await expect(observerRow).toContainText("2 cup");
  } finally {
    await actorCtx.close();
    await observerCtx.close();
  }
});
