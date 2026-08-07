import { randomUUID } from "node:crypto";

import { expect, test, type Page } from "@playwright/test";

import { STORAGE_STATE_A, STORAGE_STATE_B } from "../support/paths";

/**
 * Two shoppers, one store (issue #15). Two browser contexts, two members of ONE
 * household, against a real Supabase Realtime socket:
 *
 *   1. A adds an ad-hoc item; B sees it (server-rendered, RLS-scoped).
 *   2. A checks it off; B sees it CHECKED live, with no reload — the acceptance
 *      criterion "one checks an item, the other sees it checked live".
 *   3. A completes the trip; the item leaves BOTH active lists (the archived-row
 *      UPDATE must propagate — the #63 replica-identity class of bug — and the
 *      new migration's REPLICA IDENTITY FULL is what makes the household_id
 *      filter + RLS match on that change image).
 *   4. The ad-hoc item is OFFERED for the staples catalog; accepting it makes it
 *      a one-tap staple chip.
 *
 * Determinism (no fixed sleeps): the channel reports "Live" as soon as its JOIN
 * is acked, but Postgres-Changes delivery only starts once replication is
 * attached (Realtime emits a "Subscribed to PostgreSQL" system frame a beat
 * later). We gate the actor on that readiness frame, then rely on web-first
 * (auto-retrying) assertions. Mirrors e2e/authed/realtime.spec.ts.
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

test("a check-off propagates live, and completing the trip archives + offers promotion", async ({
  browser,
}) => {
  // A unique ad-hoc item, so parallel runs can never collide.
  const item = `E2E Paper Towels ${randomUUID().slice(0, 8)}`;

  const actorCtx = await browser.newContext({ storageState: STORAGE_STATE_A });
  const observerCtx = await browser.newContext({ storageState: STORAGE_STATE_B });

  try {
    const actor = await actorCtx.newPage();
    const observer = await observerCtx.newPage();
    const observerPg = trackPostgresChangesReady(observer);

    // --- A adds an ad-hoc item (both feeder FKs null) ----------------------
    await actor.goto("/grocery");
    await expect(actor.getByRole("heading", { name: "Groceries" })).toBeVisible();
    await actor.getByLabel("Item", { exact: true }).fill(item);
    await actor.getByRole("button", { name: "Add", exact: true }).click();

    const actorBox = actor.getByRole("checkbox", { name: item });
    await expect(actorBox).toBeVisible();
    // No quantity typed: the row shows the bare name, never "0" or "1".
    const actorRow = actor.getByTestId("grocery-item").filter({ hasText: item });
    await expect(actorRow).toHaveCount(1);

    // --- B opens the SAME household's list and goes live -------------------
    await observer.goto("/grocery");
    const observerBox = observer.getByRole("checkbox", { name: item });
    await expect(observerBox).toBeVisible();
    await expect(observer.getByTestId("realtime-status")).toHaveText("Live", {
      timeout: REALTIME_TIMEOUT,
    });
    await expect.poll(observerPg.ready, { timeout: REALTIME_TIMEOUT }).toBe(true);
    await expect(observerBox).not.toBeChecked();

    // --- A checks it off; B sees it checked LIVE ---------------------------
    await actorBox.check();
    await expect(observerBox).toBeChecked({ timeout: REALTIME_TIMEOUT });

    // --- A completes the trip ---------------------------------------------
    await actor.getByRole("button", { name: "Complete trip" }).click();

    // The archived row leaves A's active list…
    await expect(
      actor.getByTestId("grocery-item").filter({ hasText: item }),
    ).toHaveCount(0);
    // …and B's, live (the archived UPDATE reaches the other phone).
    await expect(
      observer.getByTestId("grocery-item").filter({ hasText: item }),
    ).toHaveCount(0, { timeout: REALTIME_TIMEOUT });

    // --- The ad-hoc item is OFFERED for the staples catalog ----------------
    const prompt = actor.getByTestId("promotion-prompt");
    await expect(prompt).toBeVisible();
    await expect(prompt.getByText(item)).toBeVisible();

    // Accepting is an explicit step; then it's a one-tap staple.
    await prompt.getByRole("button", { name: "Add to staples" }).click();
    await expect(prompt).toBeHidden();
    await expect(
      actor.getByRole("button", { name: `+ ${item}` }),
    ).toBeVisible({ timeout: REALTIME_TIMEOUT });
  } finally {
    await actorCtx.close();
    await observerCtx.close();
  }
});
