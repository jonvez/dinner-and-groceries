import { Button } from "@/components/ui/button";

export default function Home() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-6 p-8 text-center">
      <div className="space-y-2">
        <h1 className="text-3xl font-semibold tracking-tight">
          Dinner &amp; Groceries
        </h1>
        <p className="text-muted-foreground max-w-md">
          Plan the family menu together, then let the grocery list flow from it.
        </p>
      </div>
      <Button>Get started</Button>
    </main>
  );
}
