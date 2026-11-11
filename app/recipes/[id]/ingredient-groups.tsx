import type { IngredientGroup } from "./detail-core";

/**
 * The full ingredient list (the shopping / gather view), grouped by section
 * ("Filling", "Topping"; issue #272). Ungrouped lines render with no heading.
 * Untrusted text renders as plain React children (escaped by construction).
 */
export function IngredientGroups({ groups }: { groups: IngredientGroup[] }) {
  if (groups.length === 0) {
    return <p className="text-muted-foreground text-sm">No ingredients yet.</p>;
  }
  return (
    <div className="space-y-3">
      {groups.map((group, gi) => (
        <div key={gi} className="space-y-1">
          {group.section ? (
            <h3 className="text-sm font-semibold">{group.section}</h3>
          ) : null}
          <ul className="list-disc space-y-1 pl-5 text-sm">
            {group.lines.map((line, li) => (
              <li key={li}>{line}</li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}
