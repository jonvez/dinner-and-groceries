/**
 * The weekly board: a day x meal-type slot grid (dinner-focused) plus the
 * week's shared proposal pool (issue #8). Presentational + framework-pure (no
 * client state) so it renders on the server and is unit-tested with RTL.
 *
 * Scope guard: the grid cells are EMPTY placeholders. Assigning dishes into a
 * slot (tap-to-slot) is issue #10; here a proposal lives in the week's POOL,
 * not in a slot. Reactions/comments are issue #9.
 */

import {
  DAY_SHORT_NAMES,
  MEAL_TYPES,
  mealTypeLabel,
} from "@/lib/week/labels";
import { orderedDayOfWeek, weekDates } from "@/lib/week/boundary";

export type ProposalView = {
  id: string;
  title: string;
  note: string | null;
  sourceUrl: string | null;
  proposerName: string | null;
};

export type BoardGridProps = {
  weekStart: string;
  weekStartDay: number;
  proposals: ProposalView[];
};

export function BoardGrid({ weekStart, weekStartDay, proposals }: BoardGridProps) {
  const days = orderedDayOfWeek(weekStartDay);
  const dates = weekDates(weekStart);
  // Map each ordered day-of-week to its civil date for the column header.
  const dayDate = (dow: number) => dates[days.indexOf(dow)];

  return (
    <div className="space-y-8">
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

      <section aria-label="This week's ideas" className="space-y-3">
        <h2 className="text-lg font-medium">This week&apos;s ideas</h2>
        {proposals.length === 0 ? (
          <p className="text-muted-foreground text-sm">
            No ideas yet — be the first to propose a dish for this week.
          </p>
        ) : (
          <ul className="space-y-2">
            {proposals.map((p) => (
              <li
                key={p.id}
                className="border-border rounded-lg border p-3 text-left"
              >
                <div className="flex items-baseline justify-between gap-2">
                  <span className="font-medium">{p.title}</span>
                  {p.proposerName ? (
                    <span className="text-muted-foreground text-xs">
                      proposed by {p.proposerName}
                    </span>
                  ) : null}
                </div>
                {p.note ? (
                  <p className="text-muted-foreground mt-1 text-sm">{p.note}</p>
                ) : null}
                {p.sourceUrl ? (
                  <a
                    href={p.sourceUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-primary mt-1 inline-block text-xs underline underline-offset-4"
                  >
                    View recipe
                  </a>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
