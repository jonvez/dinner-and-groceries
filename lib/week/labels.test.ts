import { describe, expect, it } from "vitest";

import {
  DAY_SHORT_NAMES,
  formatWeekRange,
  MEAL_TYPES,
} from "./labels";

describe("DAY_SHORT_NAMES", () => {
  it("maps day-of-week numbers (0=Sun..6=Sat) to short labels", () => {
    expect(DAY_SHORT_NAMES[0]).toBe("Sun");
    expect(DAY_SHORT_NAMES[1]).toBe("Mon");
    expect(DAY_SHORT_NAMES[6]).toBe("Sat");
    expect(DAY_SHORT_NAMES).toHaveLength(7);
  });
});

describe("MEAL_TYPES", () => {
  it("lists the meal occasions with dinner present (dinner-focused, model supports the rest)", () => {
    expect(MEAL_TYPES).toContain("dinner");
    expect(MEAL_TYPES).toEqual(["breakfast", "lunch", "dinner", "snack"]);
  });
});

describe("formatWeekRange", () => {
  it("formats a Mon-Sun week as a human range (timezone-stable)", () => {
    const label = formatWeekRange("2026-06-22");
    expect(label).toContain("Jun 22");
    expect(label).toContain("Jun 28");
    expect(label).toContain("2026");
  });
});
