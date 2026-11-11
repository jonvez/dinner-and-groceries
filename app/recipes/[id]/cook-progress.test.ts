import { describe, expect, it } from "vitest";

import { currentStepId, parseProgress, progressKey } from "./cook-progress";

describe("progressKey", () => {
  it("is versioned, so the old number-keyed progress is simply ignored", () => {
    expect(progressKey("d1")).toBe("cook-progress:v2:d1");
  });
});

describe("currentStepId", () => {
  it("is the first step in order not yet done, even if later steps are done", () => {
    expect(currentStepId(["a", "b", "c", "d"], new Set(["a", "c"]))).toBe("b");
  });

  it("is null once every step is done", () => {
    expect(currentStepId(["a", "b"], new Set(["a", "b"]))).toBeNull();
  });

  it("ignores done ids that are no longer steps of the recipe", () => {
    expect(currentStepId(["b"], new Set(["gone"]))).toBe("b");
  });
});

describe("parseProgress", () => {
  it("reads a saved list of step ids", () => {
    expect(parseProgress('["a","b"]')).toEqual(new Set(["a", "b"]));
  });

  it("treats missing or malformed storage as a fresh start", () => {
    expect(parseProgress(null)).toEqual(new Set());
    expect(parseProgress("not json")).toEqual(new Set());
    expect(parseProgress('{"a":1}')).toEqual(new Set());
    expect(parseProgress('["a",2,null,"b"]')).toEqual(new Set(["a", "b"]));
  });
});
