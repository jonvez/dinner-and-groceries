/**
 * Rasterizes public/icon.svg into the PNG sizes iOS and the web app manifest
 * need. Run by hand (`npm run icons:generate`) after editing the SVG — the
 * PNGs are committed, so this never runs at build or deploy time.
 *
 * Playwright's Chromium is the rasterizer because it is already a
 * devDependency; this deliberately avoids adding an image-processing package
 * (every new dependency here needs a third-party-security-review first).
 *
 * The PNGs MUST come out opaque (RGB, no alpha): iOS composites a transparent
 * apple-touch-icon onto black, which would put a black square behind the
 * artwork on the home screen. The SVG is full-bleed and `omitBackground` is
 * false, so the screenshot carries no alpha channel.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { chromium } from "playwright";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const publicDir = join(repoRoot, "public");
const svg = readFileSync(join(publicDir, "icon.svg"), "utf8");

/** [filename, edge length in px] */
const TARGETS = [
  // iOS home-screen touch icon. 180 is the largest size iOS asks for (3x of 60pt).
  ["apple-touch-icon.png", 180],
  // Web app manifest icons.
  ["icon-192.png", 192],
  ["icon-512.png", 512],
];

const browser = await chromium.launch();
try {
  for (const [name, size] of TARGETS) {
    const page = await browser.newPage({
      viewport: { width: size, height: size },
      deviceScaleFactor: 1,
    });
    await page.setContent(
      `<style>html,body{margin:0;padding:0;overflow:hidden}` +
        `svg{display:block;width:${size}px;height:${size}px}</style>${svg}`,
    );
    await page.screenshot({
      path: join(publicDir, name),
      omitBackground: false,
    });
    await page.close();
    console.log(`${name} — ${size}x${size}`);
  }
} finally {
  await browser.close();
}
