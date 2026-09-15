import { randomInt, randomUUID } from "node:crypto";

import { expect, test, type BrowserContext, type Page } from "@playwright/test";

import { addWeeks } from "@/lib/week/boundary";

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
 *
 * THE GAP THIS FILE MISSED (issue #64), now covered below: the first test
 * proposes the dish BEFORE the observer opens the board, so the proposal always
 * arrived by server render and the missing `proposals` Realtime path was never
 * exercised. `public.proposals` was not even in the `supabase_realtime`
 * publication. The "already open" tests below observe a board that is open and
 * Live FIRST, then have the actor propose — a new dish, a recycled one, and the
 * very first proposal of a week — and assert the card arrives with its joined
 * title and proposer, in nudge order, while another week's activity does not
 * disturb it.
 *
 * AND THE GAP IN THAT GUARD (issue #219): "another week does not disturb it"
 * was asserted as "the foreign dish is not on screen", which is unfalsifiable —
 * the server re-render is week-scoped, so a cross-week leak refreshes the page
 * and changes nothing visible. The cross-week test now counts the observed
 * page's `router.refresh()` round trips (`countServerRefreshes`) and asserts
 * ZERO over a bounded settle window. Assert the mechanism the AC names, not a
 * symptom it happens not to produce.
 */

const THUMB = "React 👍";
const THUMB_ONE = "React 👍 (1)";

/**
 * Far-future weeks, so a test's pool starts EMPTY and can't be disturbed by the
 * rest of the authed suite (which works on the current week). The board
 * normalizes `?week=` to the household's canonical boundary, so actor and
 * observer passing the same date land on the same week row.
 *
 * Each week is picked per ATTEMPT, from a `k`-specific residue class, so (a) two
 * purposes can never collide and (b) a Playwright RETRY gets a virgin week —
 * with fixed dates a failed attempt would leave proposals behind and the retry
 * would fail on the zero-proposal precondition instead of the real behavior.
 */
const WEEK_BASE = "2027-03-01";
const WEEK_SLOTS = 4;
function freshWeek(k: number): string {
  return addWeeks(WEEK_BASE, randomInt(0, 250) * WEEK_SLOTS + k);
}

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

/**
 * Open a board week and wait until it can actually RECEIVE row changes: the
 * channel reports "Live" (subscribed AND socket-authenticated, issue #44) and
 * Realtime has confirmed Postgres-Changes replication is attached. Anything the
 * actor does after this can only reach the page over the socket.
 */
async function openLiveBoard(page: Page, week: string): Promise<void> {
  const pg = trackPostgresChangesReady(page); // wire BEFORE navigating
  await page.goto(`/board?week=${week}`);
  await expect(page.getByTestId("realtime-status")).toHaveText("Live", {
    timeout: 20_000,
  });
  await expect.poll(pg.ready, { timeout: 20_000 }).toBe(true);
}

/**
 * How long the cross-week guard below waits before concluding that nothing
 * reached the observed board. A negative assertion needs a window; this one is
 * bounded AND self-validating — the positive control at the end of that test
 * requires a refresh that DOES happen to be observed inside the same budget, so
 * a window too small to catch a spurious refresh fails loudly instead of
 * passing vacuously.
 */
const SETTLE_MS = 3_000;

/**
 * Count SERVER RE-RENDERS of `pathname` in a browser context — i.e. how many
 * times this context's `router.refresh()` actually round-tripped (issue #219).
 *
 * #64's cross-week acceptance criterion is "another week's proposal does not
 * RE-RENDER this week's open board". That is a claim about the round trip, not
 * about what ends up on screen: the server re-render is itself week-scoped, so
 * a spurious refresh re-renders the very same proposals and leaves no visible
 * trace at all. Asserting the foreign dish is absent therefore asserts nothing
 * — it passes with the week filter widened back to `household_id` (#219). The
 * refresh is the only observable, so we count it.
 *
 * On the wire a `router.refresh()` is an RSC fetch to the page's own URL whose
 * router state tree carries the `refetch` marker. Next's own link PREFETCHES
 * hit the same paths, so they are excluded by their `Next-Router-Prefetch`
 * header. If that wire shape ever changes, the positive control (a same-week
 * proposal whose refresh MUST be counted) goes red — the guard cannot quietly
 * go dead again.
 */
function countServerRefreshes(
  context: BrowserContext,
  pathname: string,
): () => number {
  let count = 0;
  context.on("request", (request) => {
    const headers = request.headers();
    if (headers["rsc"] !== "1") return;
    if (headers["next-router-prefetch"]) return;
    const tree = decodeURIComponent(headers["next-router-state-tree"] ?? "");
    if (!tree.includes("refetch")) return;
    if (new URL(request.url()).pathname !== pathname) return;
    count += 1;
  });
  return () => count;
}

async function proposeNewDish(page: Page, title: string): Promise<void> {
  await page.getByLabel("Dish title").fill(title);
  await page.getByRole("button", { name: "Propose dish" }).click();
  await expect(page.locator("li").filter({ hasText: title }).first()).toBeVisible();
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

test("a new dish and a recycled dish reach a board that is ALREADY open (issue #64)", async ({
  browser,
}) => {
  const suffix = randomUUID().slice(0, 8);
  const newTitle = `Live New Dish ${suffix}`;
  const recycledTitle = `Live Recycled Dish ${suffix}`;
  const laterTitle = `Live Later Dish ${suffix}`;
  const openWeek = freshWeek(0);
  const recycleSourceWeek = freshWeek(1);

  const actorCtx = await browser.newContext({ storageState: STORAGE_STATE_A });
  const observerCtx = await browser.newContext({ storageState: STORAGE_STATE_B });

  try {
    const actor = await actorCtx.newPage();
    const observer = await observerCtx.newPage();

    // A library dish to recycle later, created on a DIFFERENT week so the
    // observed week still starts at zero proposals.
    await actor.goto(`/board?week=${recycleSourceWeek}`);
    await proposeNewDish(actor, recycledTitle);

    // The observer opens the week FIRST — and it has ZERO proposals, which used
    // to mean no channel was created at all (proposal-pool.tsx:185), so the
    // week's first idea could never arrive live.
    await openLiveBoard(observer, openWeek);
    await expect(observer.getByText(/be the first to propose/i)).toBeVisible();

    // 1) A brand-new dish: it must arrive with the JOINED dish title and
    //    proposer name — never a placeholder like "Untitled dish" (the payload
    //    carries neither, which is why a proposals change triggers a server
    //    re-render instead of being rendered directly; ADR 0013 §2).
    await actor.goto(`/board?week=${openWeek}`);
    await proposeNewDish(actor, newTitle);

    const newCard = observer.locator("li").filter({ hasText: newTitle });
    await expect(newCard.getByTestId("proposal-title")).toHaveText(newTitle, {
      timeout: 20_000,
    });
    await expect(newCard.getByText(/proposed by Alex \(E2E\)/)).toBeVisible();
    await expect(observer.getByText(/untitled dish/i)).toHaveCount(0);

    // 2) A RECYCLED library dish (recycleDishAction) arrives live too.
    await actor.getByLabel(/propose again from your library/i).selectOption({
      label: recycledTitle,
    });
    await actor.getByRole("button", { name: "Propose again" }).click();
    const recycledCard = observer.locator("li").filter({ hasText: recycledTitle });
    await expect(recycledCard.getByTestId("proposal-title")).toHaveText(
      recycledTitle,
      { timeout: 20_000 },
    );

    // 3) Ordering under the nudge sort, WITH a reacted proposal present: the
    //    actor reacts on the first dish, then proposes a third. The new arrival
    //    has zero positive reactions, so it must sort BELOW the reacted one and
    //    at the TOP of the zero-reaction group (most-recent-first tiebreak).
    const actorNewCard = actor.locator("li").filter({ hasText: newTitle });
    await actorNewCard.getByRole("button", { name: THUMB, exact: true }).click();
    await expect(
      newCard.getByRole("button", { name: THUMB_ONE, exact: true }),
    ).toBeVisible({ timeout: 20_000 });

    await proposeNewDish(actor, laterTitle);
    await expect(observer.getByTestId("proposal-title")).toHaveText(
      [newTitle, laterTitle, recycledTitle],
      { timeout: 20_000 },
    );

    // 4) The social layer still propagates on the same one channel: a comment
    //    arrives, and the un-react DELETE still lands (the #63 class).
    await actorNewCard.getByPlaceholder("Add a comment…").fill(`ooh yes ${suffix}`);
    await actorNewCard.getByRole("button", { name: "Post" }).click();
    await expect(newCard.getByText(`ooh yes ${suffix}`)).toBeVisible({
      timeout: 20_000,
    });

    await actorNewCard
      .getByRole("button", { name: THUMB_ONE, exact: true })
      .click();
    await expect(
      newCard.getByRole("button", { name: /React 👍 \(\d+\)/ }),
    ).toHaveCount(0, { timeout: 20_000 });
  } finally {
    await actorCtx.close();
    await observerCtx.close();
  }
});

test("a proposal on ANOTHER week does not re-render this week's open board (issue #64)", async ({
  browser,
}) => {
  const suffix = randomUUID().slice(0, 8);
  const elsewhereTitle = `Live Elsewhere Dish ${suffix}`;
  const sameWeekTitle = `Live Same Week Dish ${suffix}`;
  const observedWeek = freshWeek(2);
  const elsewhereWeek = freshWeek(3);

  const actorCtx = await browser.newContext({ storageState: STORAGE_STATE_A });
  const observerCtx = await browser.newContext({ storageState: STORAGE_STATE_B });

  try {
    const actor = await actorCtx.newPage();
    const observer = await observerCtx.newPage();

    await openLiveBoard(observer, observedWeek);

    // Count the observed board's server re-renders from here on. This — not the
    // absence of the foreign dish from the DOM — is the acceptance criterion:
    // the re-render is week-scoped, so a leak that refreshed this page would be
    // invisible on screen (#219).
    const observedRefreshes = countServerRefreshes(observerCtx, "/board");

    // The `proposals` binding is filtered by `week_id`, so week 2's activity
    // must not reach the week-1 page at all.
    await actor.goto(`/board?week=${elsewhereWeek}`);
    await proposeNewDish(actor, elsewhereTitle);

    // Bounded settle window: `proposeNewDish` already waited out the actor's own
    // write + revalidate, so whatever Realtime is going to deliver has been
    // emitted; SETTLE_MS covers delivery plus the coalescer's round trip. (A
    // socket drop inside this window would also refresh — a reconnect asks the
    // server for the authoritative snapshot — but that is not a 5-second event
    // against a local stack.)
    await observer.waitForTimeout(SETTLE_MS);
    expect(
      observedRefreshes(),
      "another week's proposal must not re-render this board",
    ).toBe(0);
    await expect(
      observer.locator("li").filter({ hasText: elsewhereTitle }),
    ).toHaveCount(0);
    await expect(observer.getByTestId("proposal-title")).toHaveCount(0);

    // ...and the channel really was live all along: a proposal on the OBSERVED
    // week DOES refresh this page and arrive, so the zero above is a real
    // negative rather than deadness — in the channel or in the counter.
    await actor.goto(`/board?week=${observedWeek}`);
    const proposedAt = Date.now();
    await proposeNewDish(actor, sameWeekTitle);
    await expect
      .poll(observedRefreshes, { timeout: 20_000 })
      .toBeGreaterThan(0);
    expect(
      Date.now() - proposedAt,
      "SETTLE_MS must be long enough to catch a refresh that DOES happen",
    ).toBeLessThan(SETTLE_MS);
    await expect(observer.getByTestId("proposal-title")).toHaveText(
      [sameWeekTitle],
      { timeout: 20_000 },
    );
  } finally {
    await actorCtx.close();
    await observerCtx.close();
  }
});
