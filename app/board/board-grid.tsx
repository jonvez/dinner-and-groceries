/**
 * The weekly board's day x meal-type SLOT GRID (dinner-focused). The grid itself
 * is presentational + server-rendered; the dishes slotted into each cell carry a
 * small client-side tap-to-unslot control (`SlottedDishChip`).
 *
 * Slotting (issue #10): a member deliberately slots proposed dishes onto a day +
 * meal-type from the pool (`ProposalPool`), and a slot can hold MANY dishes
 * (spaghetti + salad). The grid never auto-places anything — it just renders what
 * was slotted, plus the affordance to remove it. The proposal POOL with its
 * reactions/comments (issue #9) is rendered separately by `ProposalPool`.
 */

import {
  DAY_SHORT_NAMES,
  MEAL_TYPES,
  mealTypeLabel,
  type MealType,
} from "@/lib/week/labels";
import { orderedDayOfWeek, weekDates } from "@/lib/week/boundary";

import { SlottedDishChip } from "./slotted-dish";

/** A dish slotted into a specific (day_of_week, meal_type) cell of the week. */
export type SlottedDishView = {
  slotDishId: string;
  dishId: string;
  title: string;
  dayOfWeek: number;
  mealType: MealType;
};

export type BoardGridProps = {
  weekStart: string;
  weekStartDay: number;
  /** Dishes already slotted this week, rendered into their day+meal cells. */
  slotted?: SlottedDishView[];
};

export function BoardGrid({
  weekStart,
  weekStartDay,
  slotted = [],
}: BoardGridProps) {
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
                  {days.map((dow) => {
                    const dishesHere = slotted.filter(
                      (s) => s.dayOfWeek === dow && s.mealType === mealType,
                    );
                    return (
                      <td
                        key={`${mealType}-${dow}`}
                        className="border-border h-16 border p-1 align-top"
                      >
                        {dishesHere.length === 0 ? (
                          <span className="text-muted-foreground/50 text-xs">
                            —
                          </span>
                        ) : (
                          <div className="flex flex-col gap-1">
                            {dishesHere.map((d) => (
                              <SlottedDishChip
                                key={d.slotDishId}
                                slotDishId={d.slotDishId}
                                title={d.title}
                              />
                            ))}
                          </div>
                        )}
                      </td>
                    );
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>
    </section>
  );
}
