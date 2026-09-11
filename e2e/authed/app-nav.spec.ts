import { expect, test, type Locator, type Page } from "@playwright/test";

/**
 * The global nav on a phone (issue #196).
 *
 * The nav used to lay out the brand and all four links in one non-wrapping
 * row. At 375px that row ran to x=402, so EVERY signed-in page scrolled
 * sideways, whatever its own content did.
 *
 * Now, below `sm` (640px), the brand has its own line and the four links sit
 * together on the line below. From `sm` up it's the single row it always was.
 * jsdom does no layout, so this is the only place that geometry can be proven;
 * the unit suite (`app-nav.test.tsx`) pins the links, their hrefs and
 * `aria-current`.
 */

const PAGES = [
  { path: "/", link: "Home", heading: "Dinner & Groceries" },
  { path: "/board", link: "Board", heading: "Weekly menu" },
  { path: "/recipes", link: "Recipes", heading: "Recipes" },
  { path: "/grocery", link: "Groceries", heading: "Groceries" },
] as const;

const LINKS = ["Home", "Board", "Recipes", "Groceries"] as const;

/** The narrowest phone still in common use, and the everyday one. */
const PHONE_WIDTHS = [320, 375] as const;
const PHONE_HEIGHT = 800;
/** Tailwind's `sm` breakpoint — the single row starts here — and the desktop project's width. */
const WIDE_WIDTHS = [640, 1280] as const;

/** Smallest comfortable tap target, padding included. */
const MIN_TAP_HEIGHT = 40;

type Box = { x: number; y: number; width: number; height: number };
const bottom = (b: Box) => b.y + b.height;
/** Two boxes share a row when their vertical extents overlap. */
const sameRow = (a: Box, b: Box) => a.y < bottom(b) && b.y < bottom(a);

async function box(locator: Locator) {
  const b = await locator.boundingBox();
  expect(b, "element should be laid out").not.toBeNull();
  return b!;
}

function nav(page: Page) {
  const root = page.getByRole("navigation", { name: "Main" });
  return {
    brand: root.getByText("Dinner & Groceries", { exact: true }),
    links: LINKS.map((name) => root.getByRole("link", { name, exact: true })),
  };
}

async function open(page: Page, width: number, { path, heading }: (typeof PAGES)[number]) {
  await page.setViewportSize({ width, height: PHONE_HEIGHT });
  await page.goto(path);
  await expect(page.getByRole("heading", { level: 1, name: heading })).toBeVisible();
}

/** The PAGE doesn't scroll sideways: nothing, nav included, is wider than the screen. */
async function expectNoSidewaysScroll(page: Page) {
  const { scrollWidth, clientWidth } = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
  expect(scrollWidth, "the page must not scroll sideways").toBeLessThanOrEqual(clientWidth);
}

for (const width of PHONE_WIDTHS) {
  test.describe(`at ${width}px`, () => {
    for (const page of PAGES) {
      test(`${page.path} doesn't scroll sideways, and every nav link is on screen`, async ({
        page: p,
      }) => {
        await open(p, width, page);
        await expectNoSidewaysScroll(p);
        for (const link of nav(p).links) {
          await expect(link).toBeInViewport({ ratio: 1 });
        }
      });
    }
  });
}

test.describe("at 375px", () => {
  for (const page of PAGES) {
    test(`on ${page.path}, the brand has its own line and the four links share the line below`, async ({
      page: p,
    }) => {
      await open(p, 375, page);
      const { brand, links } = nav(p);

      const brandBox = await box(brand);
      const linkBoxes = await Promise.all(links.map(box));

      for (const [i, link] of links.entries()) {
        await expect(link).toBeVisible();
        expect(
          linkBoxes[i].height,
          `${LINKS[i]} is a big enough tap target`,
        ).toBeGreaterThanOrEqual(MIN_TAP_HEIGHT);
        // One line of links, below the brand.
        expect(sameRow(linkBoxes[0], linkBoxes[i]), `${LINKS[i]} is on the links' line`).toBe(
          true,
        );
        expect(linkBoxes[i].y, `${LINKS[i]} is below the brand`).toBeGreaterThanOrEqual(
          bottom(brandBox),
        );
      }

      // The current section is still marked, and only it.
      for (const [i, link] of links.entries()) {
        if (LINKS[i] === page.link) await expect(link).toHaveAttribute("aria-current", "page");
        else await expect(link).not.toHaveAttribute("aria-current");
      }
    });
  }
});

for (const width of WIDE_WIDTHS) {
  test(`at ${width}px, the brand and the four links share one row`, async ({ page }) => {
    await open(page, width, PAGES[3]);
    const { brand, links } = nav(page);

    const brandBox = await box(brand);
    const linkBoxes = await Promise.all(links.map(box));
    for (const [i, linkBox] of linkBoxes.entries()) {
      expect(sameRow(brandBox, linkBox), `${LINKS[i]} is on the brand's row`).toBe(true);
      // Left to right: brand, Home, Board, Recipes, Groceries.
      const before = i === 0 ? brandBox : linkBoxes[i - 1];
      expect(linkBox.x, `${LINKS[i]} follows ${i === 0 ? "the brand" : LINKS[i - 1]}`).toBeGreaterThan(
        before.x + before.width - 1,
      );
    }
    await expectNoSidewaysScroll(page);
  });
}
