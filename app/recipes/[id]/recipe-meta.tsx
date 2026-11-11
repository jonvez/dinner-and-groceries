/**
 * The recipe's at-a-glance facts: prep / cook / total time and servings
 * (issue #272). Renders nothing when none are known.
 */
export function RecipeMeta({
  prepMinutes,
  cookMinutes,
  totalMinutes,
  servings,
}: {
  prepMinutes: number | null;
  cookMinutes: number | null;
  totalMinutes: number | null;
  servings: string | null;
}) {
  const facts = [
    prepMinutes !== null ? { label: "Prep", value: `${prepMinutes} min` } : null,
    cookMinutes !== null ? { label: "Cook", value: `${cookMinutes} min` } : null,
    totalMinutes !== null ? { label: "Total", value: `${totalMinutes} min` } : null,
    servings ? { label: "Serves", value: servings } : null,
  ].filter((f): f is { label: string; value: string } => f !== null);

  if (facts.length === 0) return null;

  return (
    <dl className="flex gap-6 text-sm">
      {facts.map((f) => (
        <div key={f.label}>
          <dt className="text-muted-foreground">{f.label}</dt>
          <dd className="font-medium">{f.value}</dd>
        </div>
      ))}
    </dl>
  );
}
