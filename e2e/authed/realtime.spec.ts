import { randomUUID } from "node:crypto";

import { expect, test, type Page } from "@playwright/test";

import { STORAGE_STATE_A, STORAGE_STATE_B } from "../support/paths";

/**
 * Live Realtime regression guard (issue #56 — the point of this task).
 *
 * Two browser contexts, two members of ONE household. One member reacts and
 * un-reacts; the OTHER must see the reaction ARRIVE and then DISAPPEAR live,
 * with no reload. This is the automated version of the manual P4 gate and the
 * guard that would have caught #63 (DELETE / un-react dropped over Realtime
 * because the DEFAULT replica identity carried no household_id in the change
 * image). It asserts BOTH:
 *   - reaction INSERT delivery (the "Live" push works at all), and
 *   - reaction DELETE propagation (the specific #63 regression class).
 *
 * Determinism (no fixed sleeps): the channel reports "Live" the instant its JOIN
 * is acked, but Postgres-Changes delivery only begins once replication is
 * actually attached (Realtime emits a "Subscribed to PostgreSQL" system frame a
 * beat later). Acting before that beat could drop the INSERT. So we gate the
 * actor on that readiness frame, then use web-first (auto-retrying) assertions
 * for the arrive/disappear transitions.
 */

const THUMB = "React 👍";
const THUMB_ONE = "React 👍 (1)";

/**
 * Resolve once the page's Realtime socket confirms Postgres-Changes replication
 * is attached — the true readiness signal for receiving row changes. Must be
 * wired BEFORE the page navigates so the frame isn't missed.
 */
function trackPostgresChangesReady(page: Page): { ready: () => boolean } {
  let ready = false;
  page.on("websocket", (ws) => {
    if (!ws.url().includes("/realtime/")) return;
    ws.on("framereceived", (frame) => {
      const payload =
        typeof frame.payload === "string" ? frame.payload : "";
      if (payload.includes("Subscribed to PostgreSQL")) ready = true;
    });
  });
  return { ready: () => ready };
}

test("a reaction INSERT and its DELETE propagate live to the other member", async ({
  browser,
}) => {
  const title = `Realtime Dish ${randomUUID().slice(0, 8)}`;

  // Actor (owner) and Observer (second member), each with its own session.
  const actorCtx = await browser.newContext({ storageState: STORAGE_STATE_A });
  const observerCtx = await browser.newContext({ storageState: STORAGE_STATE_B });

  try {
    const actor = await actorCtx.newPage();
    const observer = await observerCtx.newPage();
    const observerPg = trackPostgresChangesReady(observer);

    // The actor proposes a dish on the current week.
    await actor.goto("/board");
    await actor.getByLabel("Dish title").fill(title);
    await actor.getByRole("button", { name: "Propose dish" }).click();
    const actorCard = actor.locator("li").filter({ hasText: title });
    await expect(actorCard.getByTestId("proposal-title")).toHaveText(title);

    // The observer opens the SAME household's board and must see the proposal
    // (server-rendered, RLS-scoped), go "Live", and have replication attached
    // before we react — so the reaction can only reach them via Realtime.
    await observer.goto("/board");
    const observerCard = observer.locator("li").filter({ hasText: title });
    await expect(observerCard.getByTestId("proposal-title")).toHaveText(title);
    await expect(observer.getByTestId("realtime-status")).toHaveText("Live", {
      timeout: 20_000,
    });
    await expect
      .poll(observerPg.ready, { timeout: 20_000 })
      .toBe(true);

    // INSERT: the actor reacts; the observer sees the count appear live.
    await actorCard.getByRole("button", { name: THUMB, exact: true }).click();
    await expect(
      observerCard.getByRole("button", { name: THUMB_ONE, exact: true }),
    ).toBeVisible({ timeout: 20_000 });

    // DELETE (the #63 guard): the actor un-reacts; the observer sees the count
    // DISAPPEAR live. Under the pre-fix DEFAULT replica identity this event
    // never arrived and this assertion would hang/fail.
    await actorCard.getByRole("button", { name: THUMB_ONE, exact: true }).click();
    await expect(
      observerCard.getByRole("button", { name: THUMB, exact: true }),
    ).toBeVisible({ timeout: 20_000 });
    await expect(
      observerCard.getByRole("button", { name: /React 👍 \(\d+\)/ }),
    ).toHaveCount(0);
  } finally {
    await actorCtx.close();
    await observerCtx.close();
  }
});
