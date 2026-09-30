#!/usr/bin/env bun
/**
 * Profile.ts — exploratory data analysis + data-quality report for any tabular
 * source. This is the first thing you run on a new dataset: it tells you the
 * shape, per-column types, missingness, distributions, and flags likely data
 * problems (constant columns, ID columns, high missingness, outliers).
 *
 * Usage:
 *   bun Profile.ts --source data.csv
 *   bun Profile.ts --source data.parquet --format json
 *   bun Profile.ts --source app.db --table events --limit 100000
 *   bun Profile.ts --sql "SELECT * FROM read_csv_auto('x.csv') WHERE y > 0"
 *
 * Flags:
 *   --source <path>   csv/tsv/parquet/json/sqlite/duckdb file
 *   --table <name>    table name (required for sqlite/duckdb sources)
 *   --sql <query>     define the dataset directly with SQL (overrides --source)
 *   --where <expr>    filter predicate applied to the source
 *   --limit <n>       cap rows scanned
 *   --top <k>         top-K categorical values to show (default 5)
 *   --format md|json  output format (default md)
 */

import { DataFrame } from "./DataFrame.ts";
import { describe } from "./Stats.ts";
import { parseArgs, fmtNum, printModeError, loadOptsFromArgs } from "./Cli.ts";

interface ColumnProfile {
  name: string;
  type: string;
  count: number;
  nulls: number;
  nullPct: number;
  distinct: number;
  // numeric
  mean?: number;
  std?: number;
  min?: number;
  q1?: number;
  median?: number;
  q3?: number;
  max?: number;
  skewness?: number;
  outliers?: number; // count outside 1.5*IQR
  // categorical
  top?: Array<{ value: string; count: number }>;
  flags: string[];
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const format = (args.format as string) ?? "md";
  const topK = args.top ? Number(args.top) : 5;

  const df = await DataFrame.open(loadOptsFromArgs(args));

  try {
    const rowCount = await df.rowCount();
    const cols = await df.columns();
    const profiles: ColumnProfile[] = [];

    for (const col of cols) {
      const q = DataFrame.ident(col.name);
      const counts = (
        await df.all(
          `SELECT COUNT(${q}) AS non_null, COUNT(DISTINCT ${q}) AS distinct_ct FROM df`,
        )
      )[0] as { non_null: unknown; distinct_ct: unknown };
      const nonNull = Number(counts.non_null);
      const distinct = Number(counts.distinct_ct);
      const nulls = rowCount - nonNull;
      const nullPct = rowCount > 0 ? (nulls / rowCount) * 100 : 0;

      const prof: ColumnProfile = {
        name: col.name,
        type: col.type,
        count: nonNull,
        nulls,
        nullPct,
        distinct,
        flags: [],
      };

      if (col.numeric && nonNull > 0) {
        const vals = await df.numericColumn(col.name);
        if (vals.length > 0) {
          const d = describe(vals);
          prof.mean = d.mean;
          prof.std = d.std;
          prof.min = d.min;
          prof.q1 = d.q1;
          prof.median = d.median;
          prof.q3 = d.q3;
          prof.max = d.max;
          prof.skewness = d.skewness;
          const iqr = d.q3 - d.q1;
          const lo = d.q1 - 1.5 * iqr;
          const hi = d.q3 + 1.5 * iqr;
          prof.outliers = vals.filter((v) => v < lo || v > hi).length;
        }
      } else if (nonNull > 0) {
        const top = (await df.all(
          `SELECT CAST(${q} AS VARCHAR) AS value, COUNT(*) AS n
             FROM df WHERE ${q} IS NOT NULL
            GROUP BY 1 ORDER BY n DESC LIMIT ${topK}`,
        )) as Array<{ value: string; n: unknown }>;
        prof.top = top.map((t) => ({ value: t.value, count: Number(t.n) }));
      }

      // ── Data-quality flags ──
      if (rowCount > 0) {
        if (nullPct >= 50) prof.flags.push(`high-missingness (${nullPct.toFixed(0)}% null)`);
        else if (nullPct > 0 && nullPct < 50) prof.flags.push(`${nullPct.toFixed(0)}% null`);
        if (distinct === 1) prof.flags.push("constant");
        // "Likely ID" only makes sense for discrete keys (integers, strings) on
        // a large-enough sample — continuous floats being all-distinct is
        // expected, not noteworthy, and all-distinct on a tiny sample is noise.
        else if (distinct === rowCount && (isDiscreteKey(col.type) && rowCount >= 20))
          prof.flags.push("unique (likely ID)");
        else if (!col.numeric && distinct / rowCount > 0.9 && rowCount > 20)
          prof.flags.push("high-cardinality");
        if (prof.outliers && prof.outliers > 0)
          prof.flags.push(`${prof.outliers} outlier${prof.outliers === 1 ? "" : "s"}`);
        if (prof.skewness !== undefined && Math.abs(prof.skewness) > 1)
          prof.flags.push(`skewed (${prof.skewness.toFixed(1)})`);
      }
      profiles.push(prof);
    }

    if (format === "json") {
      console.log(JSON.stringify({ rows: rowCount, columns: cols.length, profiles }, null, 2));
      return;
    }

    // ── Markdown report ──
    const src = args.source ?? "(sql)";
    console.log(`# Data Profile\n`);
    console.log(`**Source:** \`${src}\`  `);
    console.log(`**Shape:** ${rowCount.toLocaleString()} rows × ${cols.length} columns\n`);

    console.log(`## Columns\n`);
    console.log(`| Column | Type | Non-null | Null % | Distinct | Flags |`);
    console.log(`|--------|------|---------:|-------:|---------:|-------|`);
    for (const p of profiles) {
      console.log(
        `| ${p.name} | ${shortType(p.type)} | ${p.count.toLocaleString()} | ${p.nullPct.toFixed(1)}% | ${p.distinct.toLocaleString()} | ${p.flags.join(", ") || "—"} |`,
      );
    }

    const numeric = profiles.filter((p) => p.mean !== undefined);
    if (numeric.length > 0) {
      console.log(`\n## Numeric Summary\n`);
      console.log(`| Column | Mean | Std | Min | Q1 | Median | Q3 | Max | Skew |`);
      console.log(`|--------|-----:|----:|----:|---:|-------:|---:|----:|-----:|`);
      for (const p of numeric) {
        console.log(
          `| ${p.name} | ${fmtNum(p.mean!)} | ${fmtNum(p.std!)} | ${fmtNum(p.min!)} | ${fmtNum(p.q1!)} | ${fmtNum(p.median!)} | ${fmtNum(p.q3!)} | ${fmtNum(p.max!)} | ${fmtNum(p.skewness!)} |`,
        );
      }
    }

    const categorical = profiles.filter((p) => p.top && p.top.length > 0);
    if (categorical.length > 0) {
      console.log(`\n## Top Categorical Values\n`);
      for (const p of categorical) {
        const parts = p.top!.map((t) => `${t.value} (${t.count})`).join(", ");
        console.log(`- **${p.name}**: ${parts}`);
      }
    }

    const flagged = profiles.filter((p) => p.flags.length > 0);
    if (flagged.length > 0) {
      console.log(`\n## ⚠️ Data-Quality Notes\n`);
      for (const p of flagged) console.log(`- **${p.name}**: ${p.flags.join("; ")}`);
    } else {
      console.log(`\n_No data-quality issues detected._`);
    }
  } finally {
    df.close();
  }
}

function shortType(t: string): string {
  return t.replace(/\(.*\)/, "").toLowerCase();
}

/** A discrete key type is an integer or string (not a continuous float). */
function isDiscreteKey(type: string): boolean {
  if (/\b(DECIMAL|NUMERIC|REAL|FLOAT|DOUBLE)\b/i.test(type)) return false;
  return /\b(TINYINT|SMALLINT|INTEGER|BIGINT|HUGEINT|UTINYINT|USMALLINT|UINTEGER|UBIGINT|VARCHAR|CHAR|TEXT|UUID)\b/i.test(type);
}

main().catch((err) => {
  printModeError(err);
  process.exit(1);
});
