/**
 * Resolve the public origin of an incoming request when the app runs behind a
 * reverse proxy (Cloud Run).
 *
 * Next.js's standalone server derives `request.nextUrl.origin` from the
 * container's internal bind address (`HOSTNAME=0.0.0.0`, `PORT=8080`), so an
 * absolute redirect built from it leaks `https://0.0.0.0:8080` to the browser.
 * The proxy forwards the real public host in `x-forwarded-host` /
 * `x-forwarded-proto` — prefer those, then the plain `host` header, and only
 * fall back to `fallbackOrigin` (e.g. `request.nextUrl.origin`) if neither is
 * present.
 *
 * This is the same rule the invite-URL builder already used inline
 * (`app/join/actions.ts`); centralized here so every absolute redirect resolves
 * the origin identically.
 */
export function requestOrigin(headers: Headers, fallbackOrigin = ""): string {
  const host = headers.get("x-forwarded-host") ?? headers.get("host");
  if (!host) return fallbackOrigin;
  const proto = headers.get("x-forwarded-proto") ?? "https";
  return `${proto}://${host}`;
}
