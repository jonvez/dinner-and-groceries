/**
 * Pure parser for a recipe's free-text method (stored in `dishes.description`).
 * The method is written as ONE chronological timeline across all of a recipe's
 * components, with each step carrying the ingredients it uses, so the cook never
 * scrolls back up to the ingredient list.
 *
 * Syntax (a tiny markdown subset; plain text in, plain data out):
 *   "## Phase"     opens a phase (a stretch of the cook, e.g. "While the pork simmers")
 *   "N. text"      a step; steps are renumbered across the whole method, so the
 *                  author's own numbers don't matter
 *   "- text"       a note on the step above, or on the phase if it has no step yet
 *   "[[text]]"     an ingredient-with-quantity token, rendered as a chip
 *   "**text**"     emphasis
 * Any other non-blank line is phase intro text.
 */

export type Step = { n: number; text: string; notes: string[] };
export type Phase = { title: string; intro: string[]; steps: Step[] };
export type Span =
  | { kind: "text"; text: string }
  | { kind: "ingredient"; text: string }
  | { kind: "strong"; text: string };

export function parseMethod(method: string): Phase[] {
  const phases: Phase[] = [];
  let n = 0;
  const phase = () => {
    if (phases.length === 0) phases.push({ title: "", intro: [], steps: [] });
    return phases[phases.length - 1];
  };
  for (const raw of method.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    const step = line.match(/^\d+\.\s+(.*)$/);
    const note = line.match(/^[-*]\s+(.*)$/);
    if (line.startsWith("## ")) {
      phases.push({ title: line.slice(3).trim(), intro: [], steps: [] });
    } else if (step) {
      n += 1;
      phase().steps.push({ n, text: step[1], notes: [] });
    } else if (note) {
      const p = phase();
      const last = p.steps[p.steps.length - 1];
      if (last) last.notes.push(note[1]);
      else p.intro.push(note[1]);
    } else {
      phase().intro.push(line);
    }
  }
  return phases;
}

export function parseSpans(text: string): Span[] {
  return text
    .split(/(\[\[[^\]]+\]\]|\*\*[^*]+\*\*)/g)
    .filter((part) => part !== "")
    .map((part): Span => {
      if (part.startsWith("[[") && part.endsWith("]]")) {
        return { kind: "ingredient", text: part.slice(2, -2) };
      }
      if (part.startsWith("**") && part.endsWith("**")) {
        return { kind: "strong", text: part.slice(2, -2) };
      }
      return { kind: "text", text: part };
    });
}

export function countSteps(phases: Phase[]): number {
  return phases.reduce((sum, p) => sum + p.steps.length, 0);
}

/** The first step not yet done, or null when every step is done. */
export function currentStep(total: number, done: ReadonlySet<number>): number | null {
  for (let n = 1; n <= total; n += 1) if (!done.has(n)) return n;
  return null;
}

/** Read persisted progress defensively: anything malformed is a fresh start. */
export function parseProgress(raw: string | null): Set<number> {
  try {
    const value: unknown = JSON.parse(raw ?? "[]");
    return new Set(
      Array.isArray(value) ? value.filter((n): n is number => Number.isInteger(n)) : [],
    );
  } catch {
    return new Set();
  }
}
