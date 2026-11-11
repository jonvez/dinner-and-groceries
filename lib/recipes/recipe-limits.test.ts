import { describe, expect, it } from "vitest";

import { jsonbTextBytes } from "./recipe-limits";

describe("jsonbTextBytes", () => {
  it("measures a value exactly as Postgres prints jsonb (`::text`)", () => {
    // Postgres: '{"a":[1,2.5,null,true],"b":"x€\n","c":{},"d":[],"e":{"f":"\u0001"}}'::jsonb::text
    //        -> {"a": [1, 2.5, null, true], "b": "x€\n", "c": {}, "d": [], "e": {"f": "\u0001"}}
    // and octet_length of that is 82.
    const value = { a: [1, 2.5, null, true], b: "x€\n", c: {}, d: [], e: { f: "\u0001" } };
    expect(jsonbTextBytes(value)).toBe(82);
  });

  it("skips undefined object members, as JSON.stringify does on the wire", () => {
    expect(jsonbTextBytes({ a: 1, b: undefined })).toBe(jsonbTextBytes({ a: 1 }));
  });
});
