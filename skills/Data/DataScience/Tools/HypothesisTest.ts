#!/usr/bin/env bun
/**
 * HypothesisTest.ts — run a statistical significance test on columns of a
 * dataset. Supports the four tests that cover most day-to-day questions:
 *
 *   ttest        two-group difference in means (Welch, unequal variance)
 *   ttest1       one sample vs. a hypothesized mean (--mu)
 *   anova        difference in means across 3+ groups (one-way ANOVA)
 *   correlation  linear association between two numeric columns (Pearson)
 *   chisquare    association between two categorical columns (contingency)
 *
 * Usage:
 *   bun HypothesisTest.ts --test ttest --source d.csv --group arm --value score
 *   bun HypothesisTest.ts --test ttest --source d.csv --group arm --value score --groups a,b
 *   bun HypothesisTest.ts --test ttest1 --source d.csv --value score --mu 100
 *   bun HypothesisTest.ts --test anova --source d.csv --group site --value yield
 *   bun HypothesisTest.ts --test correlation --source d.csv --x age --y income
 *   bun HypothesisTest.ts --test chisquare --source d.csv --row region --col plan
 *
 * Common flags:
 *   --source/--table/--sql/--where/--limit   dataset selection (see Profile.ts)
 *   --alpha <a>       significance level for the verdict (default 0.05)
 *   --format md|json  output format (default md)
 */

import { DataFrame } from "./DataFrame.ts";
import {
  welchTTest,
  oneSampleTTest,
  oneWayAnova,
  pearson,
  chiSquareIndependence,
  type TestResult,
} from "./Stats.ts";
import { parseArgs, fmtNum, fmtP, printModeError, loadOptsFromArgs } from "./Cli.ts";

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const testName = args.test as string | undefined;
  const format = (args.format as string) ?? "md";
  const alpha = args.alpha ? Number(args.alpha) : 0.05;

  if (!testName) {
    throw new Error("Specify --test ttest|ttest1|anova|correlation|chisquare");
  }

  const df = await DataFrame.open(loadOptsFromArgs(args));

  try {
    let result: TestResult;

    switch (testName) {
      case "ttest": {
        const groupCol = requireArg(args, "group");
        const valueCol = requireArg(args, "value");
        await ensureColumns(df, [groupCol, valueCol]);
        const levels = args.groups
          ? String(args.groups).split(",").map((s) => s.trim())
          : await distinctLevels(df, groupCol);
        if (levels.length !== 2) {
          throw new Error(
            `ttest needs exactly 2 groups; found ${levels.length} (${levels.join(", ")}). ` +
              `Pass --groups a,b to pick two.`,
          );
        }
        const a = await valuesForGroup(df, groupCol, valueCol, levels[0]!);
        const b = await valuesForGroup(df, groupCol, valueCol, levels[1]!);
        if (a.length < 2 || b.length < 2) throw new Error("Each group needs ≥2 values");
        result = welchTTest(a, b);
        result.detail = { ...result.detail, groupA: levels[0]!, groupB: levels[1]! };
        break;
      }
      case "ttest1": {
        const valueCol = requireArg(args, "value");
        if (args.mu === undefined) throw new Error("ttest1 needs --mu <value>");
        await ensureColumns(df, [valueCol]);
        const xs = await df.numericColumn(valueCol);
        if (xs.length < 2) throw new Error("Need ≥2 values");
        result = oneSampleTTest(xs, Number(args.mu));
        break;
      }
      case "anova": {
        const groupCol = requireArg(args, "group");
        const valueCol = requireArg(args, "value");
        await ensureColumns(df, [groupCol, valueCol]);
        const levels = await distinctLevels(df, groupCol);
        if (levels.length < 2) throw new Error("ANOVA needs ≥2 groups");
        const groups: number[][] = [];
        for (const lvl of levels) groups.push(await valuesForGroup(df, groupCol, valueCol, lvl));
        result = oneWayAnova(groups.filter((g) => g.length > 0));
        result.detail = { ...result.detail, levels: levels.join(", ") };
        break;
      }
      case "correlation": {
        const xCol = requireArg(args, "x");
        const yCol = requireArg(args, "y");
        await ensureColumns(df, [xCol, yCol]);
        const m = await df.numericMatrix([xCol, yCol]);
        if (m[xCol]!.length < 3) throw new Error("Need ≥3 paired observations");
        result = pearson(m[xCol]!, m[yCol]!);
        break;
      }
      case "chisquare": {
        const rowCol = requireArg(args, "row");
        const colCol = requireArg(args, "col");
        await ensureColumns(df, [rowCol, colCol]);
        const { table, rows, cols } = await contingency(df, rowCol, colCol);
        result = chiSquareIndependence(table);
        result.detail = { ...result.detail, rowLevels: rows.join(", "), colLevels: cols.join(", ") };
        break;
      }
      default:
        throw new Error(`Unknown test: ${testName}`);
    }

    const significant = result.pValue < alpha;

    if (format === "json") {
      console.log(JSON.stringify({ ...result, alpha, significant }, null, 2));
      return;
    }

    console.log(`# ${result.test}\n`);
    console.log(`| Quantity | Value |`);
    console.log(`|----------|-------|`);
    console.log(`| Statistic | ${fmtNum(result.statistic)} |`);
    const dfDisplay = typeof result.df === "number" ? fmtNum(result.df) : result.df;
    console.log(`| Degrees of freedom | ${dfDisplay} |`);
    console.log(`| p-value | ${fmtP(result.pValue)} |`);
    if (result.effect) {
      console.log(`| ${result.effect.name} | ${fmtNum(result.effect.value)} |`);
    }
    console.log("");
    if (result.detail) {
      const parts = Object.entries(result.detail).map(
        ([k, v]) => `${k}=${typeof v === "number" ? fmtNum(v) : v}`,
      );
      console.log(`_${parts.join("  ·  ")}_\n`);
    }
    console.log(
      significant
        ? `**Verdict:** Reject the null hypothesis at α=${alpha} — the effect is statistically significant.`
        : `**Verdict:** Fail to reject the null at α=${alpha} — no statistically significant effect.`,
    );
  } finally {
    df.close();
  }
}

function requireArg(args: Record<string, string | boolean>, key: string): string {
  const v = args[key];
  if (typeof v !== "string") throw new Error(`Missing --${key}`);
  return v;
}

async function ensureColumns(df: DataFrame, names: string[]): Promise<void> {
  for (const n of names) {
    if (!(await df.hasColumn(n))) throw new Error(`Column not found: ${n}`);
  }
}

async function distinctLevels(df: DataFrame, col: string): Promise<string[]> {
  const q = DataFrame.ident(col);
  const rows = (await df.all(
    `SELECT DISTINCT CAST(${q} AS VARCHAR) AS v FROM df WHERE ${q} IS NOT NULL ORDER BY 1`,
  )) as Array<{ v: string }>;
  return rows.map((r) => r.v);
}

async function valuesForGroup(
  df: DataFrame,
  groupCol: string,
  valueCol: string,
  level: string,
): Promise<number[]> {
  const g = DataFrame.ident(groupCol);
  const v = DataFrame.ident(valueCol);
  const rows = (await df.all(
    `SELECT CAST(${v} AS DOUBLE) AS val FROM df
      WHERE CAST(${g} AS VARCHAR) = $level AND ${v} IS NOT NULL`,
    { level },
  )) as Array<{ val: unknown }>;
  return rows.map((r) => Number(r.val)).filter((n) => Number.isFinite(n));
}

async function contingency(
  df: DataFrame,
  rowCol: string,
  colCol: string,
): Promise<{ table: number[][]; rows: string[]; cols: string[] }> {
  const r = DataFrame.ident(rowCol);
  const c = DataFrame.ident(colCol);
  const rows = (await df.all(
    `SELECT CAST(${r} AS VARCHAR) AS rv, CAST(${c} AS VARCHAR) AS cv, COUNT(*) AS n
       FROM df WHERE ${r} IS NOT NULL AND ${c} IS NOT NULL
      GROUP BY 1, 2`,
  )) as Array<{ rv: string; cv: string; n: unknown }>;
  const rowLevels = [...new Set(rows.map((x) => x.rv))].sort();
  const colLevels = [...new Set(rows.map((x) => x.cv))].sort();
  const rIdx = new Map(rowLevels.map((v, i) => [v, i]));
  const cIdx = new Map(colLevels.map((v, i) => [v, i]));
  const table = rowLevels.map(() => new Array(colLevels.length).fill(0));
  for (const x of rows) table[rIdx.get(x.rv)!]![cIdx.get(x.cv)!] = Number(x.n);
  return { table, rows: rowLevels, cols: colLevels };
}

main().catch((err) => {
  printModeError(err);
  process.exit(1);
});
