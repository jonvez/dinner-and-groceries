/**
 * Week-boundary math — the riskiest logic in slice 1b (TEAM.md / ADR 0003).
 *
 * A "week" is identified by its `start_date` (a plain `YYYY-MM-DD` civil date).
 * The start day is configurable per household (`households.week_start_day`,
 * Monday = 1 by default) and the *current* week is resolved in the household's
 * local timezone (`households.timezone`) — not the server's, not UTC.
 *
 * Framework-free and pure so it is exhaustively unit-tested in isolation and
 * reused by the board server component / actions.
 *
 * Design note on correctness: we first extract the household-local WALL-CLOCK
 * date for the instant (via `Intl`), then do all week arithmetic on that civil
 * date with UTC-based `Date` math. Once the civil date is known, the week start
 * is pure calendar arithmetic — no instant↔date conversion happens again, so
 * DST transitions cannot shift the result.
 */

/** Days in a week — the one magic number, named. */
const DAYS_PER_WEEK = 7;

/**
 * The household-local civil date (`YYYY-MM-DD`) for an instant, in `timeZone`.
 * Uses `en-CA` which formats as ISO `YYYY-MM-DD`.
 */
function civilDateInTimeZone(instant: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(instant);

  const get = (type: string) =>
    parts.find((p) => p.type === type)?.value ?? "";

  return `${get("year")}-${get("month")}-${get("day")}`;
}

/** Parse a strict `YYYY-MM-DD` civil date into a UTC `Date` at midnight. */
function parseCivilDateUTC(isoDate: string): Date {
  const [y, m, d] = isoDate.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

/** Format a UTC `Date` back to a `YYYY-MM-DD` civil date. */
function formatCivilDateUTC(date: Date): string {
  const y = String(date.getUTCFullYear()).padStart(4, "0");
  const m = String(date.getUTCMonth() + 1).padStart(2, "0");
  const d = String(date.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/**
 * The week start (`YYYY-MM-DD`) for a given civil date, given the configured
 * week-start day (0=Sun..6=Sat). Pure calendar arithmetic.
 */
export function weekStartForDate(isoDate: string, weekStartDay: number): string {
  const date = parseCivilDateUTC(isoDate);
  const dow = date.getUTCDay(); // 0=Sun..6=Sat — purely a function of the date.
  const back = (dow - weekStartDay + DAYS_PER_WEEK) % DAYS_PER_WEEK;
  date.setUTCDate(date.getUTCDate() - back);
  return formatCivilDateUTC(date);
}

/**
 * The start date of the week that CONTAINS `instant`, resolved in the
 * household-local `timeZone` with the configured `weekStartDay`. This is the
 * lazy "current week" landing target.
 */
export function currentWeekStart(
  instant: Date,
  timeZone: string,
  weekStartDay: number,
): string {
  return weekStartForDate(civilDateInTimeZone(instant, timeZone), weekStartDay);
}

/** A week start shifted by a whole number of weeks (for prev/next navigation). */
export function addWeeks(isoStartDate: string, deltaWeeks: number): string {
  const date = parseCivilDateUTC(isoStartDate);
  date.setUTCDate(date.getUTCDate() + deltaWeeks * DAYS_PER_WEEK);
  return formatCivilDateUTC(date);
}

/** The seven civil dates of the week beginning at `isoStartDate`. */
export function weekDates(isoStartDate: string): string[] {
  const start = parseCivilDateUTC(isoStartDate);
  return Array.from({ length: DAYS_PER_WEEK }, (_, i) => {
    const d = new Date(start);
    d.setUTCDate(d.getUTCDate() + i);
    return formatCivilDateUTC(d);
  });
}

/**
 * Day-of-week numbers (0=Sun..6=Sat) in board-column order, starting from
 * `weekStartDay`. e.g. Monday start -> [1,2,3,4,5,6,0].
 */
export function orderedDayOfWeek(weekStartDay: number): number[] {
  return Array.from(
    { length: DAYS_PER_WEEK },
    (_, i) => (weekStartDay + i) % DAYS_PER_WEEK,
  );
}

/**
 * Strict `YYYY-MM-DD` validation for an untrusted URL `?week=` param — must be
 * zero-padded AND a real calendar date (round-trips through Date).
 */
export function isValidIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = parseCivilDateUTC(value);
  return formatCivilDateUTC(date) === value;
}

// STUB (red): real guard lands in the green commit.
export function isValidDayOfWeek(_value: number): boolean {
  return false;
}
