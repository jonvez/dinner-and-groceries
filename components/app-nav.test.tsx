import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const pathname = vi.fn(() => "/board");
vi.mock("next/navigation", () => ({ usePathname: () => pathname() }));

// The nav mounts the `session_start` beacon (issue #210), which imports a
// "use server" module; mock the action so the shell renders in jsdom.
const recordSessionStart = vi.fn(async () => ({ ok: true }));
vi.mock("@/app/session-actions", () => ({
  recordSessionStartAction: () => recordSessionStart(),
}));

import { AppNav, isActive } from "./app-nav";

beforeEach(() => {
  window.sessionStorage.clear();
  recordSessionStart.mockClear();
});

describe("isActive", () => {
  it("marks Home active only on the exact root", () => {
    expect(isActive("/", "/")).toBe(true);
    expect(isActive("/board", "/")).toBe(false);
  });

  it("marks a section active across its subtree", () => {
    expect(isActive("/board", "/board")).toBe(true);
    expect(isActive("/recipes/new", "/recipes")).toBe(true);
    expect(isActive("/board", "/recipes")).toBe(false);
  });
});

describe("AppNav", () => {
  it("links to Home, Board, Recipes and Groceries", () => {
    pathname.mockReturnValue("/board");
    render(<AppNav />);
    expect(screen.getByRole("link", { name: "Home" })).toHaveAttribute("href", "/");
    expect(screen.getByRole("link", { name: "Board" })).toHaveAttribute("href", "/board");
    expect(screen.getByRole("link", { name: "Recipes" })).toHaveAttribute("href", "/recipes");
    expect(screen.getByRole("link", { name: "Groceries" })).toHaveAttribute(
      "href",
      "/grocery",
    );
  });

  it("mounts the session_start beacon — the shell every signed-in screen renders", async () => {
    pathname.mockReturnValue("/board");
    render(<AppNav />);

    await waitFor(() => expect(recordSessionStart).toHaveBeenCalledTimes(1));

    // The nav itself is unchanged — the beacon renders no markup.
    expect(screen.getByRole("navigation", { name: "Main" })).toBeInTheDocument();
  });

  it("marks the current section with aria-current=page", () => {
    pathname.mockReturnValue("/recipes");
    render(<AppNav />);
    expect(screen.getByRole("link", { name: "Recipes" })).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("link", { name: "Board" })).not.toHaveAttribute("aria-current");
  });
});
