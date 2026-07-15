import { describe, expect, it } from "vitest";

import { requestOrigin } from "./request-origin";

const h = (entries: Record<string, string>) => new Headers(entries);

describe("requestOrigin", () => {
  it("prefers x-forwarded-host + x-forwarded-proto (the proxied public origin)", () => {
    expect(
      requestOrigin(
        h({
          "x-forwarded-host": "app.example.com",
          "x-forwarded-proto": "https",
          host: "0.0.0.0:8080",
        }),
        "https://0.0.0.0:8080",
      ),
    ).toBe("https://app.example.com");
  });

  it("defaults the scheme to https when only x-forwarded-host is present", () => {
    expect(requestOrigin(h({ "x-forwarded-host": "app.example.com" }))).toBe(
      "https://app.example.com",
    );
  });

  it("falls back to the plain host header when there is no x-forwarded-host", () => {
    expect(
      requestOrigin(h({ host: "app.example.com", "x-forwarded-proto": "http" })),
    ).toBe("http://app.example.com");
  });

  it("returns the fallback origin only when no host header of any kind exists", () => {
    expect(requestOrigin(h({}), "https://0.0.0.0:8080")).toBe(
      "https://0.0.0.0:8080",
    );
  });

  it("returns an empty string when there is no host and no fallback", () => {
    expect(requestOrigin(h({}))).toBe("");
  });

  it("regression: does NOT leak the internal bind host when the proxy header is set", () => {
    // The Cloud Run 500-adjacent bug: request.nextUrl.origin was 0.0.0.0:8080.
    // With the forwarded header present we must use the public host.
    expect(
      requestOrigin(
        h({ "x-forwarded-host": "dinner-and-groceries-nr55phmu6q-uc.a.run.app" }),
        "https://0.0.0.0:8080",
      ),
    ).toBe("https://dinner-and-groceries-nr55phmu6q-uc.a.run.app");
  });
});
