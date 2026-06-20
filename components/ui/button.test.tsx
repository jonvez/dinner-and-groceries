import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { Button } from "@/components/ui/button";

describe("Button", () => {
  it("renders its children", () => {
    render(<Button>Get started</Button>);
    expect(
      screen.getByRole("button", { name: "Get started" }),
    ).toBeInTheDocument();
  });

  it("applies variant + size classes via cn", () => {
    render(
      <Button variant="outline" size="sm">
        Outlined
      </Button>,
    );
    const button = screen.getByRole("button", { name: "Outlined" });
    expect(button.className).toContain("border");
    expect(button.className).toContain("h-8");
  });

  it("forwards native button props", () => {
    render(<Button disabled>Disabled</Button>);
    expect(screen.getByRole("button", { name: "Disabled" })).toBeDisabled();
  });
});
