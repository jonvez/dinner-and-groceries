/**
 * A recipe's method as the detail page reads it from `dish_phases` /
 * `dish_steps` (issue #272). Shared by the loader (server) and cook mode
 * (client), so it is types only.
 */

export type MethodStep = {
  /** The stable `dish_steps.id`; cook progress is keyed by it. */
  id: string;
  /** Display number across the whole dish (position + 1). */
  n: number;
  body: string;
  notes: string[];
};

export type MethodPhase = {
  /** '' for the untitled leading phase. */
  title: string;
  intro: string[];
  steps: MethodStep[];
};
