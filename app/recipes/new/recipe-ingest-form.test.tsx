import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

// The form imports the "use server" actions module, which pulls in next/headers
// etc. Mock it so the client component renders in jsdom (we assert the UI
// wiring here; the action contract itself is covered by ingest-core.test.ts).
const actionMocks = vi.hoisted(() => ({
  fetchRecipePreviewAction: vi.fn(async (_prev: unknown, _formData: FormData) => null as unknown),
  saveIngestedDishAction: vi.fn(async (_prev: unknown, _formData: FormData) => null as unknown),
}));

vi.mock("./actions", () => actionMocks);

import { RecipeIngestForm } from "./recipe-ingest-form";

beforeEach(() => {
  actionMocks.fetchRecipePreviewAction.mockReset().mockResolvedValue(null);
  actionMocks.saveIngestedDishAction.mockReset().mockResolvedValue(null);
});

describe("RecipeIngestForm", () => {
  it("renders the URL fetch field and an empty, usable editor by default", () => {
    render(<RecipeIngestForm />);

    expect(screen.getByLabelText("Recipe URL")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Fetch recipe" })).toBeInTheDocument();
    expect(screen.getByLabelText("Title")).toBeRequired();
    expect(screen.getByLabelText(/ingredients/i)).toHaveValue("");
    expect(screen.getByRole("button", { name: "Save to library" })).toBeEnabled();
  });

  it("saves by hand without ever fetching a URL", async () => {
    // On success the real action redirects (PRG); the mock just resolves. We
    // assert the FormData contract the action is invoked with — the redirect
    // itself is covered by the Task 9 E2E round-trip, not in jsdom.
    render(<RecipeIngestForm />);

    fireEvent.change(screen.getByLabelText("Title"), {
      target: { value: "Skillet Chicken" },
    });
    fireEvent.change(screen.getByLabelText(/ingredients/i), {
      target: { value: "1 lb chicken thighs\n2 tbsp olive oil" },
    });

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Save to library" }));
    });

    expect(actionMocks.saveIngestedDishAction).toHaveBeenCalledTimes(1);
    const submitted = actionMocks.saveIngestedDishAction.mock.calls[0][1] as FormData;
    expect(submitted.get("title")).toBe("Skillet Chicken");
    expect(submitted.get("sourceUrl")).toBe("");
    expect(submitted.get("ingredients")).toBe("1 lb chicken thighs\n2 tbsp olive oil");
    expect(actionMocks.fetchRecipePreviewAction).not.toHaveBeenCalled();
  });

  it("populates the editable fields from a successful fetch", async () => {
    actionMocks.fetchRecipePreviewAction.mockResolvedValueOnce({
      ok: true,
      sourceUrl: "https://example.com/tacos",
      preview: {
        title: "Carnitas Tacos",
        imageUrl: "https://example.com/tacos.jpg",
        ingredientLines: ["2 lb pork shoulder", "1 tbsp ground cumin"],
        prepMinutes: 20,
        cookMinutes: 90,
        totalMinutes: 110,
      },
    });
    render(<RecipeIngestForm />);

    fireEvent.change(screen.getByLabelText("Recipe URL"), {
      target: { value: "https://example.com/tacos" },
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Fetch recipe" }));
    });

    expect(screen.getByLabelText("Title")).toHaveValue("Carnitas Tacos");
    expect(screen.getByLabelText(/ingredients/i)).toHaveValue(
      "2 lb pork shoulder\n1 tbsp ground cumin",
    );
    expect(screen.getByLabelText(/prep/i)).toHaveValue(20);

    const hidden = document.querySelector('input[name="sourceUrl"]');
    expect(hidden).toHaveValue("https://example.com/tacos");
  });

  it("shows a friendly notice and leaves a usable empty editor when extraction fails", async () => {
    actionMocks.fetchRecipePreviewAction.mockResolvedValueOnce({
      ok: false,
      notice: "We couldn't find a recipe on that page. Add it by hand below.",
      preview: {
        title: "",
        imageUrl: null,
        ingredientLines: [],
        prepMinutes: null,
        cookMinutes: null,
        totalMinutes: null,
      },
    });
    render(<RecipeIngestForm />);

    fireEvent.change(screen.getByLabelText("Recipe URL"), {
      target: { value: "https://example.com/blog-post" },
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Fetch recipe" }));
    });

    expect(screen.getByText(/couldn't find a recipe.*add it by hand/i)).toBeInTheDocument();
    expect(screen.getByLabelText("Title")).toHaveValue("");
    expect(screen.getByRole("button", { name: "Save to library" })).toBeEnabled();
  });
});
