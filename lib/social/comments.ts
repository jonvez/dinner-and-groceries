/**
 * Comment body normalization — the server-side guard run before persisting a
 * comment (the DB also CHECKs non-empty). Pure so it's unit-tested in isolation
 * and reused by the thin server action. Rendering safety is separate: the body is
 * shown via React's default text escaping (never dangerouslySetInnerHTML).
 */

/** Upper bound on a stored comment body (a planning chat line, not an essay). */
export const MAX_COMMENT_LENGTH = 1000;

export function normalizeCommentBody(
  body: string,
): { ok: true; body: string } | { ok: false; error: string } {
  const trimmed = body.trim();
  if (trimmed === "") {
    return { ok: false, error: "Write something first." };
  }
  if (trimmed.length > MAX_COMMENT_LENGTH) {
    return {
      ok: false,
      error: `Keep it under ${MAX_COMMENT_LENGTH} characters.`,
    };
  }
  return { ok: true, body: trimmed };
}
