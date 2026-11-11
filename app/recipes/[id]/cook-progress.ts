/**
 * Cook-mode progress (issue #272): which steps the cook has tapped done, kept
 * per dish in localStorage. Keyed by step ID, not step number, so a recipe
 * edited mid-cook (a step inserted, a step moved) never scrambles progress:
 * `save_recipe` keeps the ids of steps whose text didn't change.
 *
 * The key is versioned. Progress saved by the spike under the number-keyed
 * `cook-progress:${dishId}` is ignored, which is a fresh start (accepted).
 */

export function progressKey(dishId: string): string {
  return `cook-progress:v2:${dishId}`;
}

/** The first step in order not yet done, or null when every step is done. */
export function currentStepId(
  stepIds: readonly string[],
  done: ReadonlySet<string>,
): string | null {
  return stepIds.find((id) => !done.has(id)) ?? null;
}

/** Read persisted progress defensively: anything malformed is a fresh start. */
export function parseProgress(raw: string | null): Set<string> {
  try {
    const value: unknown = JSON.parse(raw ?? "[]");
    return new Set(
      Array.isArray(value) ? value.filter((id): id is string => typeof id === "string") : [],
    );
  } catch {
    return new Set();
  }
}
