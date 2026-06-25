/**
 * The weekly board's day x meal-type SLOT GRID (dinner-focused). Presentational +
 * framework-pure (no client state) so it renders on the server and is unit-tested
 * with RTL.
 *
 * Scope guard: the grid cells are EMPTY placeholders. Assigning dishes into a slot
 * (tap-to-slot) is issue #10. The week's proposal POOL — with its reactions and
 * comments (issue #9) — is rendered separately by `ProposalPool`.
 */

import {
  DAY_SHORT_NAMES,
  MEAL_TYPES,
  mealTypeLabel,
} from "@/lib/week/labels";
import { orderedDayOfWeek, weekDates } from "@/lib/week/boundary";

export type BoardGridProps = {
  weekStart: string;
  weekStartDay: number;
};

export function BoardGrid({ weekStart, weekStartDay }: BoardGridProps) {
  const days = orderedDayOfWeek(weekStartDay);
  const dates = weekDates(weekStart);
  // Map each ordered day-of-week to its civil date for the column header.
  const dayDate = (dow: number) => dates[days.indexOf(dow)];

  return (
    <section aria-label="Weekly slot grid" className="overflow-x-auto">
        <table className="w-full min-w-[640px] border-collapse text-sm">
          <thead>
            <tr>
              <td className="w-24 p-2 text-left font-medium">
                <span className="sr-only">Meal</span>
              </td>
              {days.map((dow) => {
                const [, , dd] = dayDate(dow).split("-");
                return (
                  <th
                    key={dow}
                    scope="col"
                    className="p-2 text-center font-medium"
                  >
                    <span className="block">{DAY_SHORT_NAMES[dow]}</span>
                    <span className="text-muted-foreground block text-xs">
                      {Number(dd)}
                    </span>
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {MEAL_TYPES.map((mealType) => {
              const isDinner = mealType === "dinner";
              return (
                <tr
                  key={mealType}
                  className={isDinner ? "bg-muted/40" : undefined}
                >
                  <th
                    scope="row"
                    className={`p-2 text-left align-top font-medium ${
                      isDinner ? "" : "text-muted-foreground"
                    }`}
                  >
                    {mealTypeLabel(mealType)}
                  </th>
                  {days.map((dow) => (
                    <td
                      key={`${mealType}-${dow}`}
                      className="border-border h-16 border p-1 text-center align-middle"
                    >
                      <span className="text-muted-foreground/50 text-xs">
                        —
                      </span>
                    </td>
                  ))}
                </tr>
              );
            })}
          </tbody>
        </table>
    </section>
  );
}
