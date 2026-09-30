/**
 * Cli.ts — tiny shared argument parser + formatting helpers for the
 * DataScience tools. Keeps each tool's argument handling consistent without
 * pulling in a dependency.
 */

/** Parse `--key value` and `--flag` style args into a record. */
export function parseArgs(argv: string[]): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) {
        out[key] = true;
      } else {
        out[key] = next;
        i++;
      }
    }
  }
  return out;
}

/**
 * Build the shared DataFrame load options from parsed CLI args. Centralizes the
 * `--source/--table/--sql/--where/--limit/--db-type` flags every tool accepts.
 */
export function loadOptsFromArgs(args: Record<string, string | boolean>): {
  source?: string;
  table?: string;
  sql?: string;
  where?: string;
  limit?: number;
  dbType?: "sqlite" | "duckdb";
} {
  const dbTypeRaw = args["db-type"];
  const dbType =
    dbTypeRaw === "sqlite" || dbTypeRaw === "duckdb" ? dbTypeRaw : undefined;
  return {
    source: args.source as string | undefined,
    table: args.table as string | undefined,
    sql: args.sql as string | undefined,
    where: args.where as string | undefined,
    limit: args.limit ? Number(args.limit) : undefined,
    dbType,
  };
}

/** Format a number for a report: integers plain, floats to 4 significant-ish digits. */
export function fmtNum(v: number): string {
  if (!Number.isFinite(v)) return String(v);
  if (Number.isInteger(v)) return v.toLocaleString();
  const abs = Math.abs(v);
  if (abs !== 0 && (abs < 1e-4 || abs >= 1e6)) return v.toExponential(3);
  return v.toFixed(abs < 1 ? 4 : abs < 100 ? 3 : 2);
}

/** Format a p-value with the conventional `< 0.001` floor. */
export function fmtP(p: number): string {
  if (!Number.isFinite(p)) return String(p);
  if (p < 0.001) return "< 0.001";
  return p.toFixed(4);
}

/** Significance stars for a p-value (APA-style). */
export function sigStars(p: number): string {
  if (p < 0.001) return "***";
  if (p < 0.01) return "**";
  if (p < 0.05) return "*";
  if (p < 0.1) return ".";
  return "";
}

/** Print a clean one-line error to stderr. */
export function printModeError(err: unknown): void {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(`Error: ${msg}`);
}
