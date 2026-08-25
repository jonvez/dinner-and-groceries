import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

import { expect, test, type Page } from "@playwright/test";

import { SEED_FIXTURE } from "../support/paths";

/**
 * Aisles, end to end (issue #138, epic #135).
 *
 * The unit suites prove the bucketing and the statements; what only a real
 * browser against a real database can prove is the WRITE-THROUGH — that filing
 * an item into an aisle survives the trip it was filed on, which is the whole
 * point of the feature. Jon's previous list made him re-sort the same items by
 * hand on every shopping trip; if the assignment doesn't outlive the trip, this
 * feature has changed nothing.
 *
 * Serial, because these tests share one household's aisles and one active list:
 * a parallel "Complete trip" would archive another test's items mid-assertion.
 * (CI already runs `workers: 1`; this makes the requirement local too.)
 */
test.describe.configure({ mode: "serial" });

const PRODUCE = "Produce";
const DAIRY = "Dairy & Eggs";

/** The rendered aisle headings, top to bottom — only non-empty ones render. */
async function aisleOrder(page: Page): Promise<string[]> {
  return page.getByTestId("section-group").evaluateAll((els) =>
    els.map((el) => (el as HTMLElement).dataset.name ?? ""),
  );
}

/** The aisle an item is currently rendered under. */
function groupContaining(page: Page, item: string) {
  return page.getByTestId("section-group").filter({ hasText: item });
}

async function addItem(page: Page, name: string) {
  await page.getByLabel("Item", { exact: true }).fill(name);
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await expect(page.getByRole("checkbox", { name })).toBeVisible();
}

async function fileInto(page: Page, item: string, aisle: string) {
  const picker = page.getByLabel(`Aisle for ${item}`);
  await picker.selectOption({ label: aisle });
  await expect(groupContaining(page, item)).toHaveAttribute("data-name", aisle);
  // The picker is disabled while its DURABLE write is in flight, so waiting for
  // it to come back is waiting for the write to settle — no fixed sleep. The
  // assertion above only proves the optimistic re-render; without this, a
  // reload can outrun the write it is meant to be verifying.
  await expect(picker).toBeEnabled();
}

test("items group by aisle, in the household's order, and survive a reload", async ({
  page,
}) => {
  const kale = `E2E Kale ${randomUUID().slice(0, 8)}`;
  const milk = `E2E Milk ${randomUUID().slice(0, 8)}`;

  await page.goto("/grocery");
  await expect(page.getByRole("heading", { name: "Groceries" })).toBeVisible();

  await addItem(page, kale);
  await addItem(page, milk);

  // Both start unfiled, so they share the catch-all aisle.
  await expect(groupContaining(page, kale)).toHaveAttribute("data-name", "Unsorted");

  await fileInto(page, kale, PRODUCE);
  await fileInto(page, milk, DAIRY);

  // Seeded aisle order, not insertion order: Produce (10) precedes Dairy (30).
  const order = await aisleOrder(page);
  expect(order.indexOf(PRODUCE)).toBeLessThan(order.indexOf(DAIRY));

  // The durable write, not just local state.
  await page.reload();
  await expect(groupContaining(page, kale)).toHaveAttribute("data-name", PRODUCE);
  await expect(groupContaining(page, milk)).toHaveAttribute("data-name", DAIRY);
});

test("an aisle filed on one trip is still that aisle on the next one", async ({
  page,
}) => {
  const item = `E2E Chard ${randomUUID().slice(0, 8)}`;

  await page.goto("/grocery");
  await addItem(page, item);
  await fileInto(page, item, PRODUCE);

  // --- Shop it and finish the trip ---------------------------------------
  await page.getByRole("checkbox", { name: item }).check();
  await page.getByRole("button", { name: "Complete trip" }).click();
  await expect(
    page.getByTestId("grocery-item").filter({ hasText: item }),
  ).toHaveCount(0);

  // Promotion carries the aisle onto the staple (#137).
  const prompt = page.getByTestId("promotion-prompt");
  await expect(prompt).toBeVisible();
  await prompt.getByRole("button", { name: "Add to staples" }).click();

  // --- The next trip ------------------------------------------------------
  const chip = page.getByRole("button", { name: `+ ${item}` });
  await expect(chip).toBeVisible();
  await chip.click();

  // Filed once, still filed. Nobody re-sorts this item by hand again.
  await expect(groupContaining(page, item)).toHaveAttribute("data-name", PRODUCE);
});

test("the move picker and the aisle reorder are both reachable and operable by keyboard", async ({
  page,
}) => {
  const item = `E2E Yogurt ${randomUUID().slice(0, 8)}`;

  await page.goto("/grocery");
  await addItem(page, item);

  // --- Move an item ------------------------------------------------------
  // The keyboard path for the picker is the PLATFORM's, because the control is
  // a native <select> rather than a bespoke menu. What is ours to prove is that
  // we actually earned that: the control is reachable by Tab and carries an
  // accessible name. Driving the option list itself would be testing the
  // browser — and its arrow-key behaviour differs by OS (macOS Chrome opens an
  // OS-level popup Playwright cannot reach), so an assertion on it would pass
  // or fail on the runner, not on this code.
  await page.getByRole("checkbox", { name: item }).focus();
  const picker = page.getByLabel(`Aisle for ${item}`);
  for (let i = 0; i < 6 && !(await picker.evaluate((el) => el === document.activeElement)); i++) {
    await page.keyboard.press("Tab");
  }
  await expect(picker).toBeFocused();
  expect(await picker.evaluate((el) => el.tagName)).toBe("SELECT");

  await expect(groupContaining(page, item)).toHaveAttribute("data-name", "Unsorted");
  await picker.selectOption({ label: PRODUCE });
  await expect(groupContaining(page, item)).toHaveAttribute("data-name", PRODUCE);

  // --- Reorder aisles: buttons, operated with Enter -----------------------
  const toggle = page.getByRole("button", { name: "Edit aisles" });
  await toggle.focus();
  await page.keyboard.press("Enter");

  const rows = page.getByTestId("aisle-row");
  await expect(rows.first()).toBeVisible();
  const first = (await rows.first().getAttribute("data-name")) ?? "";
  const second = (await rows.nth(1).getAttribute("data-name")) ?? "";

  await page.getByRole("button", { name: `Move ${second} up` }).focus();
  await page.keyboard.press("Enter");

  await expect(rows.first()).toHaveAttribute("data-name", second);
  await expect(rows.nth(1)).toHaveAttribute("data-name", first);

  // Put the household's order back, so this test leaves no trace for the aisle
  // ORDER assertions above (which read the seeded order).
  //
  // Wait for the control to come back before pressing it: the move buttons are
  // disabled while a reorder is in flight, deliberately — the optimistic
  // re-render lands well before the write settles, and without the lock a
  // second press could be clobbered by the first write's revalidated snapshot.
  const moveDown = page.getByRole("button", { name: `Move ${second} down` });
  await expect(moveDown).toBeEnabled();
  await moveDown.focus();
  await page.keyboard.press("Enter");
  await expect(rows.first()).toHaveAttribute("data-name", first);
});

/**
 * The rolling list (2026-08-24). A whole week of the family's additions vanished
 * when the week rolled over on a Monday morning: the rows were never deleted,
 * just filtered out of the read, which to the people shopping is
 * indistinguishable from losing them.
 *
 * This is the only test that can catch a regression of it. Every other grocery
 * test adds its item "now", so the item always belongs to the current week and
 * a week-scoped read looks perfectly healthy. The fixture item is seeded three
 * weeks back on purpose (`e2e/support/seed.ts`).
 */
test("an item from an earlier week is still on the list", async ({ page }) => {
  const { carriedOverItem } = JSON.parse(
    readFileSync(SEED_FIXTURE, "utf8"),
  ) as { carriedOverItem: string };

  await page.goto("/grocery");
  await expect(page.getByRole("heading", { name: "Groceries" })).toBeVisible();

  await expect(page.getByRole("checkbox", { name: carriedOverItem })).toBeVisible();

  // And it behaves like any other row — it can be filed into an aisle, which
  // proves it is a first-class item and not merely rendered.
  await fileInto(page, carriedOverItem, PRODUCE);
  await page.reload();
  await expect(groupContaining(page, carriedOverItem)).toHaveAttribute(
    "data-name",
    PRODUCE,
  );
});
