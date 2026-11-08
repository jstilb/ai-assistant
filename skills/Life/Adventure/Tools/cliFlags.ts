/**
 * cliFlags.ts — `--key value` / `--flag` parser shared by the Adventure CLIs
 * (DatePlanner, ItineraryPlanner, PackingListGenerator, SpontaneousAdventure,
 * TripTracker), which used to carry five identical copies.
 *
 * `--key value` → { key: "value" }; a `--flag` followed by another `--…` or
 * nothing → { flag: true }. Positional args are ignored.
 */
export function parseFlags(args: string[]): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = args[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        out[key] = next;
        i++;
      } else {
        out[key] = true;
      }
    }
  }
  return out;
}
