/**
 * The owner-only dashboard's three panels (issue #17, slice 1e; ADR 0014):
 * adoption, per-member participation, trips. Presentational and pure — it
 * renders a `DashboardSummary` and reads nothing itself — so the whole screen
 * is testable in jsdom while `page.tsx` keeps only the owner gate and the read.
 *
 * Deliberate choices:
 *   - **Numbers and small tables, not charts.** Thirty days of a family's
 *     activity is a handful of figures; a chart of it would be decoration that
 *     also has to render honestly when empty. Rich trends are post-MVP (SPEC).
 *   - **Empty is said out loud.** A panel with nothing behind it renders "No
 *     activity yet" plus the reason, never a zero-filled table — a zeroed panel
 *     is indistinguishable from a broken one, and this screen's only job is to
 *     tell Jon the truth about how the family is using the app.
 *   - **And broken is said out loud too.** `summary.readFailed` means the read
 *     failed, so the figures are UNKNOWN rather than zero: every panel shows
 *     "Couldn't load" instead, and no figure or member row is rendered at all.
 *     Showing the empty state here would be the screen's worst possible
 *     failure — telling a parent nobody has used the app when the truth is
 *     that we could not find out.
 *   - **Every member appears, alphabetically, including zeroes.** Not sorted by
 *     volume: the north star forbids a scorecard, and this screen is the parent's
 *     private read, never shown to the kids.
 *   - **No health or tag figure.** #211 owns that panel and is blocked on the M2
 *     pick-list; there is no per-child health data anywhere in this app.
 */

import type { DashboardSummary } from "@/lib/analytics/dashboard";

/** The shared "nothing happened" state — explicit, with the why. */
function EmptyState({ children }: { children: React.ReactNode }) {
  return (
    <p className="text-muted-foreground text-sm">
      No activity yet — {children}
    </p>
  );
}

/**
 * The shared "we could not find out" state. Deliberately worded so it can never
 * be mistaken for the empty state above: this says nothing about whether the
 * family used the app.
 */
function LoadErrorState() {
  return (
    <p role="status" className="text-sm font-medium">
      Couldn&rsquo;t load these numbers just now. This is a problem reading the data, not a sign
      that nothing happened — try reloading.
    </p>
  );
}

function Panel({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle: string;
  children: React.ReactNode;
}) {
  const id = `panel-${title.toLowerCase().replace(/\s+/g, "-")}`;
  return (
    <section aria-labelledby={id} className="border-border space-y-3 rounded-lg border p-4">
      <div className="space-y-0.5">
        <h2 id={id} className="text-lg font-medium">
          {title}
        </h2>
        <p className="text-muted-foreground text-xs">{subtitle}</p>
      </div>
      {children}
    </section>
  );
}

/** One headline number with its label. */
function Figure({
  label,
  value,
  testId,
}: {
  label: string;
  value: number;
  testId: string;
}) {
  return (
    <div>
      <dt className="text-muted-foreground text-xs">{label}</dt>
      <dd data-testid={testId} className="text-2xl font-semibold tabular-nums">
        {value}
      </dd>
    </div>
  );
}

const CELL = "px-2 py-1.5 text-right tabular-nums";
const HEAD = "px-2 py-1.5 text-right font-medium";

export function DashboardPanels({ summary }: { summary: DashboardSummary }) {
  const { adoption, participation, trips, readFailed } = summary;

  return (
    <div className="space-y-4">
      {/*
        The window is stated ONCE, up front: it is fixed at 30 days (ADR 0014),
        so every figure below is read against it and there is nothing to pick.
      */}
      <p data-testid="window-label" className="text-muted-foreground text-sm">
        Last 30 days
      </p>

      <Panel title="Adoption" subtitle="Who has opened the app">
        {readFailed ? (
          <LoadErrorState />
        ) : adoption.hasActivity ? (
          <>
            <dl className="flex flex-wrap gap-8">
              {/*
                A ROLLING 24 hours, and the label says so (#228). "Active
                today" was a UTC calendar day, which read 0 all evening during
                the household's own Pacific afternoon — the label has to match
                what the number actually measures, or it lies just as loudly.
              */}
              <Figure
                label="Active in the last 24 hours"
                value={adoption.activeLast24h}
                testId="active-last-24h"
              />
              {/*
                Same rule as the figure above: this is a rolling 7 days, so it
                does not say "this week" either. A label that names a calendar
                period while measuring a trailing window is the #228 bug in
                miniature.
              */}
              <Figure
                label="Active in the last 7 days"
                value={adoption.activeThisWeek}
                testId="active-this-week"
              />
              <Figure label="App opens" value={adoption.usageEvents} testId="usage-events" />
            </dl>
            <table className="w-full text-sm">
              <caption className="text-muted-foreground pb-1 text-left text-xs">
                Days each person opened the app
              </caption>
              <thead>
                <tr className="text-muted-foreground border-border border-b">
                  <th className="px-2 py-1.5 text-left font-medium">Member</th>
                  <th className={HEAD}>Active days</th>
                </tr>
              </thead>
              <tbody>
                {adoption.byMember.map((m) => (
                  <tr key={m.memberId} className="border-border border-b last:border-0">
                    <td className="px-2 py-1.5">{m.displayName}</td>
                    <td className={CELL} data-testid={`active-days-${m.memberId}`}>
                      {m.activeDays}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {adoption.unattributedUsageEvents > 0 ? (
              <p className="text-muted-foreground text-xs">
                <span data-testid="unattributed-usage">{adoption.unattributedUsageEvents}</span>{" "}
                app open(s) could not be attributed to anyone (a sign-in before joining, or a
                member who has since left).
              </p>
            ) : null}
          </>
        ) : (
          <EmptyState>nobody has opened the app in the last 30 days.</EmptyState>
        )}
      </Panel>

      <Panel
        title="Participation"
        subtitle="Proposing, reacting, commenting and slotting"
      >
        {readFailed ? (
          <LoadErrorState />
        ) : participation.hasActivity ? (
          <table className="w-full text-sm">
            <caption className="text-muted-foreground pb-1 text-left text-xs">
              Everyone is listed, in alphabetical order
            </caption>
            <thead>
              <tr className="text-muted-foreground border-border border-b">
                <th className="px-2 py-1.5 text-left font-medium">Member</th>
                <th className={HEAD}>Proposed</th>
                <th className={HEAD}>Reacted</th>
                <th className={HEAD}>Commented</th>
                <th className={HEAD}>Slotted</th>
                <th className={HEAD}>All</th>
              </tr>
            </thead>
            <tbody>
              {participation.byMember.map((m) => (
                <tr key={m.memberId} className="border-border border-b last:border-0">
                  <td className="px-2 py-1.5">{m.displayName}</td>
                  <td className={CELL} data-testid={`participation-proposals-${m.memberId}`}>
                    {m.proposalsCreated}
                  </td>
                  <td className={CELL} data-testid={`participation-reactions-${m.memberId}`}>
                    {m.reactionsAdded}
                  </td>
                  <td className={CELL} data-testid={`participation-comments-${m.memberId}`}>
                    {m.commentsAdded}
                  </td>
                  <td className={CELL} data-testid={`participation-slots-${m.memberId}`}>
                    {m.slotsFilled}
                  </td>
                  <td
                    className={`${CELL} font-medium`}
                    data-testid={`participation-total-${m.memberId}`}
                  >
                    {m.total}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <EmptyState>
            nobody has proposed, reacted, commented or slotted a dish in the last 30 days.
          </EmptyState>
        )}
      </Panel>

      <Panel title="Trips" subtitle="Shopping finished">
        {readFailed ? (
          <LoadErrorState />
        ) : trips.hasActivity ? (
          <dl className="flex flex-wrap gap-8">
            <Figure
              label="Trips completed"
              value={trips.completed}
              testId="trips-completed"
            />
            <Figure label="Lists built from the menu" value={trips.listsBuilt} testId="lists-built" />
          </dl>
        ) : (
          <EmptyState>
            no shopping trip has been completed and no list has been built from the menu in the
            last 30 days. Tapping &ldquo;we have it&rdquo; is not a trip.
          </EmptyState>
        )}
      </Panel>
    </div>
  );
}
