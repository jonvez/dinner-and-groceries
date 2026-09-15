import { render, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The `session_start` beacon (issue #210). One event per BROWSER SESSION, not
 * per page view: the guard is `sessionStorage`, so navigating Board → Recipes →
 * Groceries (each a fresh mount of the app shell) emits nothing further, while a
 * new tab/session starts counting again. `screen_view` is deliberately not in
 * the taxonomy we emit (ADR 0014), so this must not become a per-navigation
 * event.
 */

const mocks = vi.hoisted(() => ({
  record: vi.fn<() => Promise<{ ok: boolean }>>(),
}));

vi.mock("@/app/session-actions", () => ({
  recordSessionStartAction: () => mocks.record(),
}));

const { SessionBeacon } = await import("./session-beacon");

beforeEach(() => {
  window.sessionStorage.clear();
  mocks.record.mockReset().mockResolvedValue({ ok: true });
});

describe("SessionBeacon", () => {
  it("records session_start once when the app shell mounts", async () => {
    const { container } = render(<SessionBeacon />);

    await waitFor(() => expect(mocks.record).toHaveBeenCalledTimes(1));
    // It renders nothing — it is a beacon, not UI.
    expect(container).toBeEmptyDOMElement();
  });

  it("does NOT record again on a later navigation in the same session", async () => {
    render(<SessionBeacon />);
    await waitFor(() => expect(mocks.record).toHaveBeenCalledTimes(1));

    // A navigation re-mounts the shell (Board → Recipes → Groceries).
    render(<SessionBeacon />);
    render(<SessionBeacon />);
    await waitFor(() => expect(mocks.record).toHaveBeenCalledTimes(1));
  });

  it("records again in a NEW browser session (sessionStorage cleared)", async () => {
    render(<SessionBeacon />);
    await waitFor(() => expect(mocks.record).toHaveBeenCalledTimes(1));

    window.sessionStorage.clear();
    render(<SessionBeacon />);
    await waitFor(() => expect(mocks.record).toHaveBeenCalledTimes(2));
  });

  it("leaves the guard unset when the emission did not land, so it can retry", async () => {
    mocks.record.mockResolvedValue({ ok: false });

    render(<SessionBeacon />);
    await waitFor(() => expect(mocks.record).toHaveBeenCalledTimes(1));

    render(<SessionBeacon />);
    await waitFor(() => expect(mocks.record).toHaveBeenCalledTimes(2));
  });

  it("swallows a rejected action — analytics never reaches the user", async () => {
    mocks.record.mockRejectedValue(new Error("network down"));

    expect(() => render(<SessionBeacon />)).not.toThrow();
    await waitFor(() => expect(mocks.record).toHaveBeenCalledTimes(1));
  });

  it("does not record when sessionStorage is unusable (private mode)", async () => {
    // Some browsers throw on the very ACCESS of sessionStorage. Without a
    // usable guard we skip emitting rather than emit on every navigation.
    const original = Object.getOwnPropertyDescriptor(
      window,
      "sessionStorage",
    ) as PropertyDescriptor;
    Object.defineProperty(window, "sessionStorage", {
      configurable: true,
      get() {
        throw new Error("SecurityError");
      },
    });

    try {
      expect(() => render(<SessionBeacon />)).not.toThrow();
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(mocks.record).not.toHaveBeenCalled();
    } finally {
      Object.defineProperty(window, "sessionStorage", original);
    }
  });
});
