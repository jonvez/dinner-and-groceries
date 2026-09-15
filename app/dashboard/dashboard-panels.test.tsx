import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { summarizeDashboard, type DashboardEvent } from "@/lib/analytics/dashboard";

import { DashboardPanels } from "./dashboard-panels";

/**
 * The owner-only dashboard's panels (issue #17, ADR 0014). Presentational and
 * pure — it renders whatever `summarizeDashboard` produced — so what is pinned
 * here is the READING of the numbers:
 *
 *   - an empty window says "no activity yet" out loud, rather than showing a
 *     zeroed panel that Jon would reasonably read as a broken screen;
 *   - a member who has done nothing is still listed, with zeroes;
 *   - trips come from completed trips only;
 *   - and the hard boundary: no health/tag figure anywhere on this screen
 *     (#211, blocked on M2), and no per-child health data ever.
 */

const NOW = new Date("2026-09-15T12:00:00.000Z");
const ago = (days: number) =>
  new Date(NOW.getTime() - days * 86_400_000).toISOString();

const MEMBERS = [
  { id: "m-jon", displayName: "Jon" },
  { id: "m-jojo", displayName: "Jojo" },
  { id: "m-kai", displayName: "Kai" },
];

const ev = (
  eventType: DashboardEvent["eventType"],
  memberId: string | null,
  createdAt: string,
): DashboardEvent => ({ eventType, memberId, createdAt });

const BUSY: DashboardEvent[] = [
  ev("session_start", "m-jon", ago(0)),
  ev("session_start", "m-jojo", ago(1)),
  ev("sign_in", "m-jojo", ago(4)),
  ev("proposal_created", "m-jojo", ago(2)),
  ev("reaction_added", "m-jojo", ago(2)),
  ev("comment_added", "m-jon", ago(1)),
  ev("slot_filled", "m-jon", ago(1)),
  ev("trip_completed", "m-jon", ago(3)),
  ev("grocery_list_built", "m-jon", ago(3)),
];

function renderSummary(events: DashboardEvent[], members = MEMBERS) {
  return render(
    <DashboardPanels summary={summarizeDashboard(events, members, { now: NOW })} />,
  );
}

/** The row of a member's table, whichever table it is in. */
function rowFor(name: string) {
  return screen.getAllByRole("row").filter((r) => r.textContent?.includes(name));
}

describe("DashboardPanels — with activity", () => {
  it("says the window is the last 30 days", () => {
    renderSummary(BUSY);
    expect(screen.getByTestId("window-label")).toHaveTextContent(/last 30 days/i);
  });

  it("shows active days per member and the daily/weekly active counts", () => {
    renderSummary(BUSY);
    const adoption = screen.getByRole("region", { name: /adoption/i });
    expect(adoption).toBeInTheDocument();
    expect(screen.getByTestId("active-today")).toHaveTextContent("1");
    expect(screen.getByTestId("active-this-week")).toHaveTextContent("2");
    expect(screen.getByTestId("active-days-m-jojo")).toHaveTextContent("2");
    expect(screen.getByTestId("active-days-m-kai")).toHaveTextContent("0");
  });

  it("shows per-member participation counts by display name", () => {
    renderSummary(BUSY);
    expect(screen.getByRole("region", { name: /participation/i })).toBeInTheDocument();
    expect(rowFor("Jojo").length).toBeGreaterThan(0);
    expect(screen.getByTestId("participation-proposals-m-jojo")).toHaveTextContent("1");
    expect(screen.getByTestId("participation-reactions-m-jojo")).toHaveTextContent("1");
    expect(screen.getByTestId("participation-comments-m-jojo")).toHaveTextContent("0");
    expect(screen.getByTestId("participation-slots-m-jon")).toHaveTextContent("1");
    expect(screen.getByTestId("participation-total-m-jojo")).toHaveTextContent("2");
    expect(screen.getByTestId("participation-total-m-jon")).toHaveTextContent("2");
  });

  it("lists a member who has done nothing, with zeroes rather than omitting them", () => {
    renderSummary(BUSY);
    expect(screen.getByTestId("participation-total-m-kai")).toHaveTextContent("0");
    expect(rowFor("Kai").length).toBeGreaterThan(0);
  });

  it("shows completed trips and lists built", () => {
    renderSummary(BUSY);
    expect(screen.getByRole("region", { name: /trips/i })).toBeInTheDocument();
    expect(screen.getByTestId("trips-completed")).toHaveTextContent("1");
    expect(screen.getByTestId("lists-built")).toHaveTextContent("1");
  });

  it("notes usage that could not be attributed to a member", () => {
    renderSummary([...BUSY, ev("sign_in", null, ago(1))]);
    expect(screen.getByTestId("unattributed-usage")).toHaveTextContent("1");
  });
});

describe("DashboardPanels — empty states", () => {
  it("says 'no activity yet' for adoption instead of showing zeroes", () => {
    renderSummary([ev("trip_completed", "m-jon", ago(1))]);
    const adoption = screen.getByRole("region", { name: /adoption/i });
    expect(adoption).toHaveTextContent(/no activity yet/i);
    expect(screen.queryByTestId("active-today")).not.toBeInTheDocument();
  });

  it("says nobody has planned together yet instead of an all-zero table", () => {
    renderSummary([ev("session_start", "m-jon", ago(1))]);
    const participation = screen.getByRole("region", { name: /participation/i });
    expect(participation).toHaveTextContent(/no activity yet/i);
    expect(screen.queryByTestId("participation-total-m-kai")).not.toBeInTheDocument();
  });

  it("says there have been no shopping trips instead of a zero", () => {
    renderSummary([ev("session_start", "m-jon", ago(1))]);
    const trips = screen.getByRole("region", { name: /trips/i });
    expect(trips).toHaveTextContent(/no activity yet/i);
    expect(screen.queryByTestId("trips-completed")).not.toBeInTheDocument();
  });

  it("renders three explicit empty panels on a completely empty events table", () => {
    renderSummary([], []);
    for (const name of [/adoption/i, /participation/i, /trips/i]) {
      expect(screen.getByRole("region", { name })).toHaveTextContent(/no activity yet/i);
    }
    expect(screen.queryAllByRole("row")).toHaveLength(0);
  });
});

describe("DashboardPanels — the hard boundary", () => {
  it("renders no health or tag figure at all (#211 is blocked on M2)", () => {
    const { container } = renderSummary(BUSY);
    const text = container.textContent ?? "";
    expect(text).not.toMatch(/health/i);
    expect(text).not.toMatch(/\btags?\b/i);
    expect(text).not.toMatch(/veg|protein|dessert/i);
  });
});
