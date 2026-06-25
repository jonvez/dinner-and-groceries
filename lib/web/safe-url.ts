/**
 * Scheme-allowlist guard for user-supplied URLs we persist and later render into
 * an `<a href>` (today: a dish's recipe link; slice 1c will fetch these).
 *
 * Why this is security-relevant: React 19 does NOT sanitize `href`, so a stored
 * `javascript:…` or `data:…` URL becomes stored XSS the moment it's rendered as
 * a link and clicked. An `<input type="url">` is a client-only hint and the
 * server action is directly invocable, so the only reliable place to enforce the
 * allowlist is server-side, before persisting. Framework-free + pure so it is
 * unit-tested in isolation and reused at the write boundary AND (defensively) at
 * render — mirroring `lib/auth/redirect.ts`.
 *
 * The single safe shape is an absolute `http:`/`https:` URL. Anything else
 * (other schemes, relative, unparseable, empty) collapses to `null`.
 */
export function safeHttpUrl(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;

  const candidate = value.trim();
  if (candidate === "") return null;

  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    // Not an absolute URL (relative paths, garbage) — reject.
    return null;
  }

  // The scheme is what a browser acts on; allow only the two safe web schemes.
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;

  return candidate;
}
