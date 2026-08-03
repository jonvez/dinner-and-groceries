import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

const pathname = vi.fn(() => "/board");
vi.mock("next/navigation", () => ({ usePathname: () => pathname() }));

import { AppNav, isActive } from "./app-nav";

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
  it("links to Home, Board and Recipes", () => {
    pathname.mockReturnValue("/board");
    render(<AppNav />);
    expect(screen.getByRole("link", { name: "Home" })).toHaveAttribute("href", "/");
    expect(screen.getByRole("link", { name: "Board" })).toHaveAttribute("href", "/board");
    expect(screen.getByRole("link", { name: "Recipes" })).toHaveAttribute("href", "/recipes");
  });

  it("marks the current section with aria-current=page", () => {
    pathname.mockReturnValue("/recipes");
    render(<AppNav />);
    expect(screen.getByRole("link", { name: "Recipes" })).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("link", { name: "Board" })).not.toHaveAttribute("aria-current");
  });
});
