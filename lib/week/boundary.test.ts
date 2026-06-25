import { describe, expect, it } from "vitest";

import {
  addWeeks,
  currentWeekStart,
  isValidDayOfWeek,
  isValidIsoDate,
  orderedDayOfWeek,
  weekDates,
  weekStartForDate,
} from "./boundary";

/**
 * Week-boundary math is the riskiest logic in this slice (TEAM.md / ADR 0003):
 * the start_date for the week that contains a given instant must be computed in
 * the HOUSEHOLD-LOCAL timezone with a configurable week-start day (Monday = 1).
 * These tests pin the timezone edges, the Monday rollover, DST, the year
 * boundary, and the Sunday-start variant before any implementation exists.
 *
 * Anchor fact used throughout: 2026-06-22 is a Monday (the #7 pgTAP fixtures
 * seed consecutive weeks at 2026-06-22 / 2026-06-29).
 */

describe("weekStartForDate (pure civil-date arithmetic)", () => {
  it("returns the Monday of a mid-week date (Monday start)", () => {
    // 2026-06-24 is a Wednesday -> its Monday is 2026-06-22.
    expect(weekStartForDate("2026-06-24", 1)).toBe("2026-06-22");
  });

  it("returns the same date when it is already the week start", () => {
    expect(weekStartForDate("2026-06-22", 1)).toBe("2026-06-22");
  });

  it("rolls a Sunday back to the previous Monday (Monday start)", () => {
    // 2026-06-21 is a Sunday -> previous Monday is 2026-06-15.
    expect(weekStartForDate("2026-06-21", 1)).toBe("2026-06-15");
  });

  it("handles the year boundary (Friday 2027-01-01 -> Monday 2026-12-28)", () => {
    expect(weekStartForDate("2027-01-01", 1)).toBe("2026-12-28");
  });

  it("supports a Sunday week-start (week_start_day = 0)", () => {
    // 2026-06-24 is a Wednesday -> previous Sunday is 2026-06-21.
    expect(weekStartForDate("2026-06-24", 0)).toBe("2026-06-21");
  });
});

describe("currentWeekStart (instant -> local week start)", () => {
  const LA = "America/Los_Angeles";
  const TOKYO = "Asia/Tokyo";

  it("uses the household-local calendar date, not UTC's", () => {
    // 2026-06-22T03:00Z is Monday 03:00 in UTC, but Sunday 20:00 in LA.
    // LA -> Sunday 2026-06-21 -> week of Monday 2026-06-15.
    const instant = new Date("2026-06-22T03:00:00Z");
    expect(currentWeekStart(instant, LA, 1)).toBe("2026-06-15");
  });

  it("resolves the same instant differently across timezones", () => {
    // Same instant: Tokyo is already Monday -> week of 2026-06-22;
    // LA is still Sunday -> week of 2026-06-15.
    const instant = new Date("2026-06-21T20:00:00Z");
    expect(currentWeekStart(instant, TOKYO, 1)).toBe("2026-06-22");
    expect(currentWeekStart(instant, LA, 1)).toBe("2026-06-15");
  });

  it("rolls over exactly at local Monday midnight", () => {
    // LA midnight Monday 2026-06-22 == 2026-06-22T07:00Z.
    expect(currentWeekStart(new Date("2026-06-22T07:00:00Z"), LA, 1)).toBe(
      "2026-06-22",
    );
    // One second earlier is still Sunday in LA -> previous week.
    expect(currentWeekStart(new Date("2026-06-22T06:59:59Z"), LA, 1)).toBe(
      "2026-06-15",
    );
  });

  it("is correct within a DST-transition week (LA spring-forward 2026-03-08)", () => {
    // 2026-03-08 02:00 is the spring-forward; the week's Monday is 2026-03-02.
    const instant = new Date("2026-03-08T18:00:00Z"); // Sunday in LA
    expect(currentWeekStart(instant, LA, 1)).toBe("2026-03-02");
  });

  it("is correct within a DST-transition week (LA fall-back 2026-11-01)", () => {
    // 2026-11-01 02:00 is the fall-back; 2026-11-01 is a Sunday, so the week's
    // Monday is 2026-10-26. 20:00Z is 12:00 PST (after the change) -> Sunday.
    const instant = new Date("2026-11-01T20:00:00Z");
    expect(currentWeekStart(instant, LA, 1)).toBe("2026-10-26");
  });

  it("resolves the current week for a Sunday-start household", () => {
    // 2026-06-24T12:00Z is Wednesday 05:00 in LA; Sunday-start week is 2026-06-21.
    const instant = new Date("2026-06-24T12:00:00Z");
    expect(currentWeekStart(instant, LA, 0)).toBe("2026-06-21");
  });
});

describe("addWeeks", () => {
  it("advances by whole weeks", () => {
    expect(addWeeks("2026-06-22", 1)).toBe("2026-06-29");
  });

  it("goes backwards with a negative delta", () => {
    expect(addWeeks("2026-06-22", -1)).toBe("2026-06-15");
  });

  it("crosses month boundaries", () => {
    expect(addWeeks("2026-06-29", 1)).toBe("2026-07-06");
  });

  it("is a no-op for delta 0", () => {
    expect(addWeeks("2026-06-22", 0)).toBe("2026-06-22");
  });
});

describe("weekDates", () => {
  it("returns the 7 ISO dates of the week", () => {
    expect(weekDates("2026-06-22")).toEqual([
      "2026-06-22",
      "2026-06-23",
      "2026-06-24",
      "2026-06-25",
      "2026-06-26",
      "2026-06-27",
      "2026-06-28",
    ]);
  });
});

describe("orderedDayOfWeek", () => {
  it("orders day-of-week numbers from a Monday start", () => {
    expect(orderedDayOfWeek(1)).toEqual([1, 2, 3, 4, 5, 6, 0]);
  });

  it("orders day-of-week numbers from a Sunday start", () => {
    expect(orderedDayOfWeek(0)).toEqual([0, 1, 2, 3, 4, 5, 6]);
  });
});

describe("isValidIsoDate (untrusted URL param guard)", () => {
  it("accepts a real zero-padded date", () => {
    expect(isValidIsoDate("2026-06-22")).toBe(true);
  });

  it("rejects malformed strings", () => {
    expect(isValidIsoDate("garbage")).toBe(false);
    expect(isValidIsoDate("2026-6-2")).toBe(false);
    expect(isValidIsoDate("2026/06/22")).toBe(false);
    expect(isValidIsoDate("")).toBe(false);
  });

  it("rejects impossible calendar dates", () => {
    expect(isValidIsoDate("2026-13-01")).toBe(false);
    expect(isValidIsoDate("2026-02-30")).toBe(false);
  });
});

describe("isValidDayOfWeek (untrusted slot-target guard)", () => {
  it("accepts each integer 0..6", () => {
    for (let d = 0; d <= 6; d++) expect(isValidDayOfWeek(d)).toBe(true);
  });

  it("rejects out-of-range numbers", () => {
    expect(isValidDayOfWeek(-1)).toBe(false);
    expect(isValidDayOfWeek(7)).toBe(false);
  });

  it("rejects non-integers and non-finite values", () => {
    expect(isValidDayOfWeek(2.5)).toBe(false);
    expect(isValidDayOfWeek(NaN)).toBe(false);
    expect(isValidDayOfWeek(Infinity)).toBe(false);
  });
});
