/**
 * Presentational constants/formatters for the week board. Kept framework-free
 * and pure (no React) so they're trivially unit-tested and shared by the grid.
 */

import type { Database } from "@/lib/database.types";

export type MealType = Database["public"]["Enums"]["meal_type"];

/** Short day names indexed by day-of-week number (0=Sun..6=Sat). */
export const DAY_SHORT_NAMES = [
  "Sun",
  "Mon",
  "Tue",
  "Wed",
  "Thu",
  "Fri",
  "Sat",
] as const;

/**
 * Meal occasions in board-row order. Dinner-focused MVP, but the model + grid
 * support the full set so we're not boxed in (SPEC "Weekly menu board").
 * Mirrors the `meal_type` enum order.
 */
export const MEAL_TYPES: readonly MealType[] = [
  "breakfast",
  "lunch",
  "dinner",
  "snack",
];

/** Human label for a meal type (capitalized). */
export function mealTypeLabel(mealType: MealType): string {
  return mealType.charAt(0).toUpperCase() + mealType.slice(1);
}

/**
 * A human week range like "Jun 22 – Jun 28, 2026". Formatted in UTC so a civil
 * `YYYY-MM-DD` never shifts a day under the server's local timezone.
 */
export function formatWeekRange(isoStartDate: string): string {
  const [y, m, d] = isoStartDate.split("-").map(Number);
  const start = new Date(Date.UTC(y, m - 1, d));
  const end = new Date(start);
  end.setUTCDate(end.getUTCDate() + 6);

  const monthDay = new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
  const full = new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });

  return `${monthDay.format(start)} – ${full.format(end)}`;
}
