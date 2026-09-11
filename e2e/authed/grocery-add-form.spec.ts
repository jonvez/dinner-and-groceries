import { randomUUID } from "node:crypto";

import { expect, test, type Locator, type Page } from "@playwright/test";

/**
 * "Add something else" on a phone (issue #185).
 *
 * The form used to put Item, Quantity, Unit and Add on ONE row. Item was the
 * only flexible control, so on a phone it got whatever width the three
 * fixed-width ones left over — and the staple suggestions, which are exactly
 * as wide as the Item field, were squeezed along with it.
 *
 * Now Item has its own line, with Add beside it, and Quantity + Unit sit on the
 * line below. jsdom does no layout, so this is the only place that geometry can
 * be proven: every other Playwright project is Desktop Chrome, and nothing else
 * sets a phone viewport. The unit suite (`grocery-list.test.tsx`) pins the DOM
 * structure and the form's behaviour; this pins what a thumb actually sees.
 *
 * With Quantity and Unit directly under Item, an open suggestion list covers
 * them, so the list must close on a tap outside it without picking (#197).
 */

const PHONE = { width: 375, height: 800 };
/** The Desktop Chrome project's own viewport — "still looks right on desktop". */
const DESKTOP = { width: 1280, height: 720 };

/** Sub-pixel slack for layout comparisons (fractional widths round differently). */
const PX = 1;

function addForm(page: Page) {
  const item = page.getByLabel("Item", { exact: true });
  const form = page.locator("form").filter({ has: item });
  return {
    form,
    item,
    add: form.getByRole("button", { name: "Add", exact: true }),
    quantity: form.getByLabel("Quantity", { exact: true }),
    unit: form.getByLabel("Unit", { exact: true }),
  };
}

async function box(locator: Locator) {
  const b = await locator.boundingBox();
  expect(b, "element should be laid out").not.toBeNull();
  return b!;
}

type Box = { x: number; y: number; width: number; height: number };
const right = (b: Box) => b.x + b.width;
const bottom = (b: Box) => b.y + b.height;
/** Two boxes share a row when their vertical extents overlap. */
const sameRow = (a: Box, b: Box) => a.y < bottom(b) && b.y < bottom(a);

/**
 * Nothing on the grocery screen pushes it sideways. `scrollWidth` counts every
 * overflowing descendant, in flow or absolutely positioned (the open suggestion
 * list), so this catches the form and its dropdown alike.
 *
 * Scoped to `<main>` rather than the whole document: at 375px the GLOBAL nav is
 * already wider than the screen on every page (#196), which is not this form's
 * doing. Tighten this to `document.documentElement` once #196 lands.
 */
async function expectNoSidewaysScroll(page: Page) {
  const { scrollWidth, clientWidth, viewport } = await page
    .locator("main")
    .evaluate((main) => ({
      scrollWidth: main.scrollWidth,
      clientWidth: main.clientWidth,
      viewport: document.documentElement.clientWidth,
    }));
  expect(clientWidth).toBeLessThanOrEqual(viewport);
  expect(scrollWidth, "the screen must not scroll sideways").toBeLessThanOrEqual(
    clientWidth,
  );
}

/** Row 1: Item across the form, Add at its right. Row 2: Quantity, Unit. */
async function expectTwoRowLayout(page: Page) {
  const f = addForm(page);
  const [form, item, add, quantity, unit] = await Promise.all(
    [f.form, f.item, f.add, f.quantity, f.unit].map(box),
  );

  // --- Row 1: Item spans the form, less the Add button beside it ---------
  expect(sameRow(item, add), "Item and Add share a row").toBe(true);
  expect(Math.abs(item.x - form.x)).toBeLessThanOrEqual(PX);
  expect(Math.abs(right(add) - right(form))).toBeLessThanOrEqual(PX);
  expect(add.x).toBeGreaterThanOrEqual(right(item) - PX);
  // Nothing between them but the gap.
  expect(add.x - right(item)).toBeLessThanOrEqual(12);

  // --- Row 2: Quantity and Unit, together, below Item ---------------------
  expect(sameRow(quantity, unit), "Quantity and Unit share a row").toBe(true);
  expect(quantity.y).toBeGreaterThanOrEqual(bottom(item));
  expect(quantity.y).toBeGreaterThanOrEqual(bottom(add));
  expect(unit.x).toBeGreaterThanOrEqual(right(quantity));
  expect(Math.abs(quantity.x - form.x)).toBeLessThanOrEqual(PX);
  expect(right(unit)).toBeLessThanOrEqual(right(form) + PX);

  return { form, item, add };
}

/** Give the household a staple to find: add it, buy it, promote it. */
async function promoteStaple(page: Page, staple: string) {
  const f = addForm(page);
  await f.item.fill(staple);
  await f.add.click();
  await page.getByRole("checkbox", { name: staple }).check();
  await page.getByRole("button", { name: "Complete trip" }).click();
  const prompt = page.getByTestId("promotion-prompt");
  await expect(prompt).toBeVisible();
  await prompt.getByRole("button", { name: "Add to staples" }).click();
  await expect(prompt).toBeHidden();
}

test("on a phone, Item has its own line with Add beside it, and Quantity/Unit sit below", async ({
  page,
}) => {
  await page.setViewportSize(PHONE);
  await page.goto("/grocery");
  await expect(page.getByRole("heading", { name: "Groceries" })).toBeVisible();

  const { form, item } = await expectTwoRowLayout(page);
  // The whole point: Item is no longer squeezed by three fixed-width controls.
  // (At 375px the old one-row layout left it well under half the form.)
  expect(item.width).toBeGreaterThan(form.width * 0.7);
  await expectNoSidewaysScroll(page);

  // --- Keyboard order is the visual order: Item → Add → Quantity → Unit ---
  const f = addForm(page);
  await f.item.focus();
  await page.keyboard.press("Tab");
  await expect(f.add).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(f.quantity).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(f.unit).toBeFocused();
});

test("on desktop, the form keeps the same two rows", async ({ page }) => {
  await page.setViewportSize(DESKTOP);
  await page.goto("/grocery");
  await expect(page.getByRole("heading", { name: "Groceries" })).toBeVisible();

  await expectTwoRowLayout(page);
  await expectNoSidewaysScroll(page);
});

test("on a phone, Enter in Item, Quantity or Unit still adds the item and clears the form", async ({
  page,
}) => {
  await page.setViewportSize(PHONE);
  await page.goto("/grocery");
  await expect(page.getByRole("heading", { name: "Groceries" })).toBeVisible();
  const f = addForm(page);

  for (const [field, target] of [
    ["Item", f.item],
    ["Quantity", f.quantity],
    ["Unit", f.unit],
  ] as const) {
    // Unique, and unlike any staple, so no suggestion is open or highlighted.
    const name = `E2E Enter ${field} ${randomUUID().slice(0, 8)}`;
    await f.item.fill(name);
    if (field === "Quantity") await f.quantity.fill("2");
    if (field === "Unit") await f.unit.fill("jar");
    await target.press("Enter");

    await expect(page.getByRole("checkbox", { name })).toBeVisible();
    await expect(f.item).toHaveValue("");
    await expect(f.quantity).toHaveValue("");
    await expect(f.unit).toHaveValue("");
  }
});

test("on a phone, the staple suggestions are as wide as the Item field, with nothing cut off", async ({
  page,
}) => {
  // A long staple name, so a cramped list would have something to truncate.
  const tag = randomUUID().slice(0, 8);
  const staple = `E2E Extra Virgin Olive Oil ${tag}`;

  await page.setViewportSize(PHONE);
  await page.goto("/grocery");
  await expect(page.getByRole("heading", { name: "Groceries" })).toBeVisible();
  const f = addForm(page);
  await promoteStaple(page, staple);

  // --- Type, and the list opens under the Item field ----------------------
  await f.item.fill(tag);
  const listbox = page.getByRole("listbox", { name: "Item suggestions" });
  const option = listbox.getByRole("option", { name: staple });
  await expect(option).toBeVisible();

  const [form, item, add, list] = await Promise.all(
    [f.form, f.item, f.add, listbox].map(box),
  );
  expect(Math.abs(list.width - item.width)).toBeLessThanOrEqual(PX);
  expect(Math.abs(list.x - item.x)).toBeLessThanOrEqual(PX);
  // …which is the form's width, less only the Add button.
  expect(list.width).toBeGreaterThanOrEqual(form.width - add.width - 12);

  // Every option's text fits: nothing clipped or pushed out sideways.
  const clipped = await listbox
    .getByRole("option")
    .evaluateAll((els) =>
      els
        .filter((el) => el.scrollWidth > el.clientWidth)
        .map((el) => el.textContent),
    );
  expect(clipped).toEqual([]);
  await expectNoSidewaysScroll(page);
});

test.describe("on a touch phone", () => {
  // Real taps: touch events and a `pointerType: "touch"` pointerdown, as on a
  // phone. File-local, so the shared Playwright config is untouched.
  test.use({ hasTouch: true });

  test("tapping blank space closes the staple suggestions without picking, so Quantity can be filled (#197)", async ({
    page,
  }) => {
    const tag = randomUUID().slice(0, 8);
    const staple = `E2E Tapaway Mustard ${tag}`;
    // Free text that happens to match the staple: the match is a substring.
    const typed = `Mustard ${tag}`;

    await page.setViewportSize(PHONE);
    await page.goto("/grocery");
    await expect(page.getByRole("heading", { name: "Groceries" })).toBeVisible();
    const f = addForm(page);
    await promoteStaple(page, staple);

    // --- Type free text, and the list opens (over Quantity and Unit) -------
    await f.item.fill(typed);
    const listbox = page.getByRole("listbox", { name: "Item suggestions" });
    await expect(listbox.getByRole("option", { name: staple })).toBeVisible();

    // --- Tap blank space outside the list ----------------------------------
    // The empty tail of the form's "Add something else" heading row. Checked,
    // so the test can't pass by tapping a control that dismisses by itself.
    const form = await box(f.form);
    const spot = { x: right(form) - 4, y: form.y + 4 };
    const hit = await page.evaluate(({ x, y }) => {
      const el = document.elementFromPoint(x, y);
      return {
        found: el !== null,
        control: !!el?.closest(
          "input, button, select, textarea, a, label, [role=listbox]",
        ),
      };
    }, spot);
    expect(hit, "the tap must land on blank space").toEqual({
      found: true,
      control: false,
    });
    await page.touchscreen.tap(spot.x, spot.y);

    await expect(listbox).toBeHidden();
    await expect(f.item).toHaveAttribute("aria-expanded", "false");
    await expect(f.item).toHaveValue(typed);

    // --- Quantity is uncovered now ------------------------------------------
    // `tap()` refuses a target that something else covers, so this also
    // proves no suggestion is sitting over Quantity.
    await f.quantity.tap();
    await expect(f.quantity).toBeFocused();
    await f.quantity.fill("7");
    await f.add.tap();

    // The row has what was TYPED and the quantity, not the staple.
    const row = page
      .getByTestId("grocery-item")
      .filter({ has: page.getByRole("checkbox", { name: typed, exact: true }) });
    await expect(row).toHaveCount(1);
    await expect(row.getByText("7", { exact: true })).toBeVisible();
    await expect(page.getByRole("checkbox", { name: staple, exact: true })).toHaveCount(0);
  });
});
