import { describe, expect, it } from "vitest";

import { isoDurationToMinutes } from "./recipe-jsonld";

describe("isoDurationToMinutes", () => {
  it("converts hours + minutes", () => {
    expect(isoDurationToMinutes("PT1H30M")).toBe(90);
    expect(isoDurationToMinutes("PT20M")).toBe(20);
    expect(isoDurationToMinutes("PT2H")).toBe(120);
  });
  it("rounds seconds into minutes", () => {
    expect(isoDurationToMinutes("PT1H0M30S")).toBe(61); // 60 + round(30/60)=1
  });
  it("returns null for empty, non-string, or unparseable input", () => {
    expect(isoDurationToMinutes("PT")).toBeNull();
    expect(isoDurationToMinutes("garbage")).toBeNull();
    expect(isoDurationToMinutes(null)).toBeNull();
    expect(isoDurationToMinutes(90)).toBeNull();
  });
});
