import { expect, test } from "@playwright/test";

/**
 * Smoke E2E: the app boots and the auth boundary works WITHOUT a real Google
 * round-trip (so this required check stays green with no Google creds).
 *
 * With no session cookie the middleware treats the visitor as signed-out: a
 * protected route redirects to /login, which offers Google sign-in only. This
 * exercises the real middleware + login page; it never contacts Google.
 *
 * Requires Supabase env vars so the middleware can construct its ssr client
 * (CI injects ephemeral local Supabase values; getUser() against it simply
 * returns "no user" for an anonymous request — see playwright.config.ts).
 */
test("a signed-out visitor is routed to the Google sign-in page", async ({
  page,
}) => {
  await page.goto("/");

  // Middleware bounced us to the login route.
  await expect(page).toHaveURL(/\/login/);

  await expect(
    page.getByRole("heading", { name: "Sign in to Dinner & Groceries" }),
  ).toBeVisible();

  await expect(
    page.getByRole("button", { name: "Sign in with Google" }),
  ).toBeVisible();

  // Only Google OAuth is wired — Apple is post-MVP.
  await expect(page.getByRole("button", { name: /apple/i })).toHaveCount(0);
});

/**
 * Regression guard: the browser Supabase client must get its NEXT_PUBLIC_* env
 * INLINED into the client bundle. A dynamic `process.env` access (aliasing it to
 * a variable) is not statically replaced by Next, so the client throws
 * "Missing required Supabase env var(s)" the moment the sign-in button runs —
 * a bug that unit tests (which inject a fake env source) cannot catch.
 *
 * We capture uncaught page errors and click the button: with the env correctly
 * inlined there is no throw (the click then initiates the OAuth redirect). This
 * is independent of whether Supabase/Google is reachable, so it's CI-stable.
 */
test("clicking Google sign-in does not throw a missing-env error (client env is inlined)", async ({
  page,
}) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (err) => pageErrors.push(err.message));

  await page.goto("/login");
  await page.getByRole("button", { name: "Sign in with Google" }).click();
  await page.waitForTimeout(500);

  expect(pageErrors.join("\n")).not.toContain("Missing required Supabase env");
});

/**
 * Home-screen install assets (#82) are reachable BY A SIGNED-OUT VISITOR.
 *
 * Regression guard for a bug caught during implementation: the manifest is a
 * Next route (not a file in public/), so the proxy matcher gated it and an
 * anonymous request got a 307 to /login. Safari fetches the manifest while
 * "Add to Home Screen" is being used, so a gated manifest silently degrades the
 * install to a page-screenshot icon with the wrong name.
 *
 * This also guards the standalone packaging: public/ is NOT part of Next's
 * standalone output, so if `start:standalone` stops copying it these 404.
 */
test("the manifest and iOS touch icon are served to a signed-out visitor", async ({
  request,
}) => {
  const manifest = await request.get("/manifest.webmanifest", {
    maxRedirects: 0,
  });
  expect(manifest.status()).toBe(200);

  const json = await manifest.json();
  expect(json.display).toBe("standalone");
  expect(json.short_name).toBe("Dinner");
  expect(json.start_url).toBe("/");

  // The icon paths the manifest advertises must actually resolve.
  for (const icon of json.icons) {
    const res = await request.get(icon.src, { maxRedirects: 0 });
    expect(res.status(), `${icon.src} should be served`).toBe(200);
  }

  // iOS uses this one, and it is referenced from the document head, not the
  // manifest — so it needs its own assertion.
  const apple = await request.get("/apple-touch-icon.png", { maxRedirects: 0 });
  expect(apple.status()).toBe(200);
  expect(apple.headers()["content-type"]).toContain("image/png");
});

/**
 * The head carries the tags iOS needs to launch chrome-less. Next's
 * `appleWebApp` metadata emits only the modern `mobile-web-app-capable`; iOS
 * below 16.4 honors solely the legacy `apple-mobile-web-app-capable`, and that
 * tag is what actually removes the URL bar.
 */
test("the document head carries the iOS standalone tags", async ({ page }) => {
  await page.goto("/login");

  await expect(
    page.locator('link[rel="manifest"][href="/manifest.webmanifest"]'),
  ).toHaveCount(1);
  await expect(
    page.locator('link[rel="apple-touch-icon"][href="/apple-touch-icon.png"]'),
  ).toHaveCount(1);
  await expect(
    page.locator('meta[name="apple-mobile-web-app-capable"][content="yes"]'),
  ).toHaveCount(1);
  await expect(
    page.locator('meta[name="apple-mobile-web-app-title"][content="Dinner"]'),
  ).toHaveCount(1);
});

/**
 * Security headers (issue #55, phase 2) are actually served on a real response
 * — the issue's primary acceptance criterion ("inspect any page response
 * headers"). The CSP is now enforcing; HSTS is absent over local http (the E2E
 * server is plain http, exercising the non-prod branch).
 */
test("responses carry the security headers (enforcing CSP, no HSTS on local http)", async ({
  page,
}) => {
  const response = await page.goto("/login");
  const headers = response!.headers();

  expect(headers["x-content-type-options"]).toBe("nosniff");
  expect(headers["referrer-policy"]).toBe("strict-origin-when-cross-origin");
  expect(headers["x-frame-options"]).toBe("DENY");

  // Enforcing now — the CSP rides the enforcing header, and the Report-Only
  // variant must NOT be present.
  expect(headers["content-security-policy"]).toContain("default-src 'self'");
  expect(headers["content-security-policy-report-only"]).toBeUndefined();

  // Local dev is http, so HSTS must not be sent.
  expect(headers["strict-transport-security"]).toBeUndefined();
});
