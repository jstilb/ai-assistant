#!/usr/bin/env bun
/**
 * Correlate.ts — pairwise Pearson correlation across the numeric columns of a
 * dataset, plus a ranked list of the strongest relationships. Use it to find
 * which variables move together before modeling, and to spot multicollinearity.
 *
 * Correlations are computed with DuckDB's `corr()` aggregate (pairwise-complete
 * observations). When --target is given, columns are ranked by |correlation|
 * with that target.
 *
 * Usage:
 *   bun Correlate.ts --source data.csv
 *   bun Correlate.ts --source data.csv --target price --threshold 0.5
 *   bun Correlate.ts --source data.parquet --columns a,b,c --format json
 *
 * Flags:
 *   --source <path>     data file (csv/tsv/parquet/json/sqlite/duckdb)
 *   --table <name>      table name (sqlite/duckdb sources)
 *   --sql <query>       define dataset directly
 *   --columns a,b,c     restrict to these numeric columns
 *   --target <col>      rank correlations against this column
 *   --threshold <r>     |r| cutoff for "strong" flags (default 0.7)
 *   --format md|json    output format (default md)
 */

import { DataFrame } from "./DataFrame.ts";
import { parseArgs, printModeError, loadOptsFromArgs } from "./Cli.ts";

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const format = (args.format as string) ?? "md";
  const threshold = args.threshold ? Number(args.threshold) : 0.7;
  const target = args.target as string | undefined;

  const df = await DataFrame.open(loadOptsFromArgs(args));

  try {
    let cols = await df.numericColumns();
    if (args.columns) {
      const requested = String(args.columns).split(",").map((s) => s.trim());
      cols = requested.filter((c) => cols.includes(c));
    }
    if (target && !cols.includes(target)) {
      throw new Error(`--target "${target}" is not a numeric column`);
    }
    if (cols.length < 2) {
      throw new Error("Need at least 2 numeric columns to correlate");
    }

    // Build the correlation matrix in one query.
    const selects: string[] = [];
    for (let i = 0; i < cols.length; i++) {
      for (let j = i; j < cols.length; j++) {
        const a = DataFrame.ident(cols[i]!);
        const b = DataFrame.ident(cols[j]!);
        selects.push(`corr(${a}, ${b}) AS "c_${i}_${j}"`);
      }
    }
    const row = (await df.all(`SELECT ${selects.join(", ")} FROM df`))[0] as Record<string, unknown>;

    const matrix: number[][] = cols.map(() => new Array(cols.length).fill(NaN));
    for (let i = 0; i < cols.length; i++) {
      for (let j = i; j < cols.length; j++) {
        const v = row[`c_${i}_${j}`];
        const r = v === null || v === undefined ? NaN : Number(v);
        matrix[i]![j] = r;
        matrix[j]![i] = r;
      }
    }

    // Strong pairs (excluding the diagonal).
    const pairs: Array<{ a: string; b: string; r: number }> = [];
    for (let i = 0; i < cols.length; i++) {
      for (let j = i + 1; j < cols.length; j++) {
        const r = matrix[i]![j]!;
        if (Number.isFinite(r)) pairs.push({ a: cols[i]!, b: cols[j]!, r });
      }
    }
    pairs.sort((x, y) => Math.abs(y.r) - Math.abs(x.r));
    const strong = pairs.filter((p) => Math.abs(p.r) >= threshold);

    if (format === "json") {
      const out: Record<string, unknown> = {
        columns: cols,
        matrix,
        strongPairs: strong,
      };
      if (target) {
        const idx = cols.indexOf(target);
        out.targetCorrelations = cols
          .map((c, i) => ({ column: c, r: matrix[idx]![i]! }))
          .filter((x) => x.column !== target && Number.isFinite(x.r))
          .sort((x, y) => Math.abs(y.r) - Math.abs(x.r));
      }
      console.log(JSON.stringify(out, null, 2));
      return;
    }

    console.log(`# Correlation Analysis\n`);
    console.log(`**Columns:** ${cols.length} numeric  ·  **Method:** Pearson (pairwise-complete)\n`);

    if (target) {
      const idx = cols.indexOf(target);
      const ranked = cols
        .map((c, i) => ({ column: c, r: matrix[idx]![i]! }))
        .filter((x) => x.column !== target && Number.isFinite(x.r))
        .sort((x, y) => Math.abs(y.r) - Math.abs(x.r));
      console.log(`## Correlation with \`${target}\`\n`);
      console.log(`| Column | r | Strength |`);
      console.log(`|--------|--:|----------|`);
      for (const x of ranked) {
        console.log(`| ${x.column} | ${x.r.toFixed(3)} | ${strengthLabel(x.r)} |`);
      }
      console.log("");
    }

    console.log(`## Correlation Matrix\n`);
    const header = ["", ...cols.map(abbrev)].join(" | ");
    console.log(`| ${header} |`);
    console.log(`|${new Array(cols.length + 1).fill("---").join("|")}|`);
    for (let i = 0; i < cols.length; i++) {
      const cells = matrix[i]!.map((r) => (Number.isFinite(r) ? r.toFixed(2) : "—"));
      console.log(`| ${abbrev(cols[i]!)} | ${cells.join(" | ")} |`);
    }

    console.log(`\n## Strong Relationships (|r| ≥ ${threshold})\n`);
    if (strong.length === 0) {
      console.log(`_None above the threshold._`);
    } else {
      console.log(`| Pair | r | Direction |`);
      console.log(`|------|--:|-----------|`);
      for (const p of strong) {
        console.log(
          `| ${p.a} ↔ ${p.b} | ${p.r.toFixed(3)} | ${p.r > 0 ? "positive" : "negative"} |`,
        );
      }
    }
  } finally {
    df.close();
  }
}

function strengthLabel(r: number): string {
  const a = Math.abs(r);
  if (a >= 0.7) return "strong";
  if (a >= 0.4) return "moderate";
  if (a >= 0.2) return "weak";
  return "negligible";
}

function abbrev(name: string): string {
  return name.length > 12 ? name.slice(0, 11) + "…" : name;
}

main().catch((err) => {
  printModeError(err);
  process.exit(1);
});
