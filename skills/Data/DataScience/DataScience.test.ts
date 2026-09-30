/**
 * DataScience.test.ts — validates the pure-TS statistics core against known
 * reference values (hand-computable cases + values cross-checked with
 * scipy/R), and exercises the DuckDB DataFrame loader end-to-end.
 *
 * Run: bun test skills/Data/DataScience/DataScience.test.ts
 */

import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  gammaln,
  betai,
  gammap,
  normalCdf,
  tDistTwoTailedP,
  fDistP,
  chiSquareP,
  describe as describeStats,
  quantile,
  welchTTest,
  oneSampleTTest,
  oneWayAnova,
  pearson,
  chiSquareIndependence,
  linearRegression,
  logisticRegression,
  invert,
} from "./Tools/Stats.ts";
import { DataFrame } from "./Tools/DataFrame.ts";

const approx = (a: number, b: number, tol = 1e-3) => Math.abs(a - b) <= tol;

// ── Special functions ────────────────────────────────────────────────────────

test("gammaln matches known factorials", () => {
  // gamma(n) = (n-1)!  => gammaln(5) = ln(24)
  expect(approx(gammaln(5), Math.log(24), 1e-6)).toBe(true);
  expect(approx(gammaln(1), 0, 1e-6)).toBe(true);
});

test("betai boundary + midpoint symmetry", () => {
  expect(betai(2, 3, 0)).toBe(0);
  expect(betai(2, 3, 1)).toBe(1);
  // I_0.5(a,a) == 0.5 by symmetry
  expect(approx(betai(3, 3, 0.5), 0.5, 1e-6)).toBe(true);
});

test("normalCdf reference points", () => {
  expect(approx(normalCdf(0), 0.5, 1e-6)).toBe(true);
  expect(approx(normalCdf(1.959964), 0.975, 1e-4)).toBe(true);
  expect(approx(normalCdf(-1.959964), 0.025, 1e-4)).toBe(true);
});

test("gammap is a proper CDF", () => {
  expect(gammap(2, 0)).toBe(0);
  expect(approx(gammap(2, 1000), 1, 1e-6)).toBe(true);
});

// ── Distribution tail probabilities ──────────────────────────────────────────

test("t-distribution two-tailed p at classic critical values", () => {
  // t(4) critical value 2.776 -> two-tailed p ~ 0.05
  expect(approx(tDistTwoTailedP(2.776445, 4), 0.05, 1e-4)).toBe(true);
  // t=0 -> p=1
  expect(approx(tDistTwoTailedP(0, 10), 1, 1e-9)).toBe(true);
});

test("F-distribution upper tail at classic critical value", () => {
  // F(1,4) critical value 7.7086 -> p ~ 0.05
  expect(approx(fDistP(7.7086, 1, 4), 0.05, 1e-4)).toBe(true);
});

test("chi-square upper tail at classic critical values", () => {
  // chi2(1) crit 3.8415 -> p ~ 0.05; chi2(2) crit 5.9915 -> p ~ 0.05
  expect(approx(chiSquareP(3.8415, 1), 0.05, 1e-4)).toBe(true);
  expect(approx(chiSquareP(5.9915, 2), 0.05, 1e-4)).toBe(true);
});

// ── Descriptive ──────────────────────────────────────────────────────────────

test("describe on a simple vector", () => {
  const d = describeStats([1, 2, 3, 4, 5]);
  expect(d.mean).toBe(3);
  expect(approx(d.std, Math.sqrt(2.5), 1e-9)).toBe(true); // sample sd
  expect(d.median).toBe(3);
  expect(d.min).toBe(1);
  expect(d.max).toBe(5);
});

test("quantile linear interpolation", () => {
  const s = [1, 2, 3, 4];
  expect(approx(quantile(s, 0.5), 2.5, 1e-9)).toBe(true);
  expect(approx(quantile(s, 0.25), 1.75, 1e-9)).toBe(true);
});

// ── Hypothesis tests ─────────────────────────────────────────────────────────

test("Welch t-test: identical groups -> t=0, p=1", () => {
  const r = welchTTest([1, 2, 3, 4, 5], [1, 2, 3, 4, 5]);
  expect(approx(r.statistic, 0, 1e-9)).toBe(true);
  expect(approx(r.pValue, 1, 1e-9)).toBe(true);
});

test("Welch t-test: clearly different groups -> small p", () => {
  const a = [1, 2, 3, 4, 5];
  const b = [10, 11, 12, 13, 14];
  const r = welchTTest(a, b);
  expect(r.pValue).toBeLessThan(0.001);
  expect(r.statistic).toBeLessThan(0); // a < b
});

test("one-sample t-test recovers direction", () => {
  const r = oneSampleTTest([4, 5, 6, 5, 4, 6], 3);
  expect(r.statistic).toBeGreaterThan(0);
  expect(r.pValue).toBeLessThan(0.01);
});

test("one-way ANOVA: identical group means -> F~0, p~1", () => {
  const r = oneWayAnova([
    [1, 2, 3],
    [1, 2, 3],
    [1, 2, 3],
  ]);
  expect(approx(r.statistic, 0, 1e-9)).toBe(true);
  expect(approx(r.pValue, 1, 1e-6)).toBe(true);
});

test("one-way ANOVA: separated groups -> small p", () => {
  const r = oneWayAnova([
    [1, 2, 3],
    [11, 12, 13],
    [21, 22, 23],
  ]);
  expect(r.pValue).toBeLessThan(0.001);
});

test("pearson: perfect positive correlation", () => {
  const r = pearson([1, 2, 3, 4, 5], [2, 4, 6, 8, 10]);
  expect(approx(r.r, 1, 1e-9)).toBe(true);
  expect(r.pValue).toBe(0);
});

test("pearson: no correlation -> r~0, high p", () => {
  const r = pearson([1, 2, 3, 4], [1, 2, 1, 2]);
  expect(Math.abs(r.r)).toBeLessThan(0.5);
});

test("chi-square independence: independent table -> high p", () => {
  // Perfectly proportional table => chi2 = 0
  const r = chiSquareIndependence([
    [10, 20],
    [20, 40],
  ]);
  expect(approx(r.statistic, 0, 1e-9)).toBe(true);
  expect(approx(r.pValue, 1, 1e-6)).toBe(true);
});

test("chi-square independence: classic 2x2 reference", () => {
  // Uncorrected Pearson chi-square for [[10,20],[30,40]]: chi2 = 0.79365,
  // df=1, p ~ 0.3732 (cross-checked with scipy.stats.chi2_contingency,
  // correction=False).
  const r = chiSquareIndependence([
    [10, 20],
    [30, 40],
  ]);
  expect(approx(r.statistic, 0.79365, 1e-3)).toBe(true);
  expect(approx(r.pValue, 0.3732, 1e-3)).toBe(true);
  expect(r.df).toBe(1);
});

// ── Linear algebra ───────────────────────────────────────────────────────────

test("matrix invert: identity and singular", () => {
  const inv = invert([
    [2, 0],
    [0, 4],
  ]);
  expect(inv).not.toBeNull();
  expect(approx(inv![0]![0]!, 0.5, 1e-12)).toBe(true);
  expect(approx(inv![1]![1]!, 0.25, 1e-12)).toBe(true);
  expect(invert([
    [1, 2],
    [2, 4],
  ])).toBeNull(); // singular
});

// ── Regression ───────────────────────────────────────────────────────────────

test("linear regression recovers exact line y = 2x + 1", () => {
  const X = [[1], [2], [3], [4], [5]];
  const y = [3, 5, 7, 9, 11];
  const m = linearRegression(X, y, ["x"]);
  expect(approx(m.coefficients[0]!.estimate, 1, 1e-6)).toBe(true); // intercept
  expect(approx(m.coefficients[1]!.estimate, 2, 1e-6)).toBe(true); // slope
  expect(approx(m.rSquared, 1, 1e-9)).toBe(true);
});

test("linear regression multiple features: y = 3 + 2a - 1b", () => {
  const X = [
    [1, 1],
    [2, 1],
    [3, 2],
    [4, 3],
    [5, 5],
    [2, 4],
  ];
  const y = X.map(([a, b]) => 3 + 2 * a! - 1 * b!);
  const m = linearRegression(X, y, ["a", "b"]);
  expect(approx(m.coefficients[0]!.estimate, 3, 1e-6)).toBe(true);
  expect(approx(m.coefficients[1]!.estimate, 2, 1e-6)).toBe(true);
  expect(approx(m.coefficients[2]!.estimate, -1, 1e-6)).toBe(true);
  expect(approx(m.rSquared, 1, 1e-9)).toBe(true);
});

test("logistic regression separates a clean boundary", () => {
  // x < 0 -> 0, x > 0 -> 1, with a margin
  const X = [[-3], [-2], [-1.5], [-1], [1], [1.5], [2], [3]];
  const y = [0, 0, 0, 0, 1, 1, 1, 1];
  const m = logisticRegression(X, y, ["x"]);
  expect(m.coefficients[1]!.estimate).toBeGreaterThan(0); // positive slope
  expect(m.accuracy).toBe(1);
});

// ── DataFrame (DuckDB) end-to-end ────────────────────────────────────────────

test("DataFrame loads a CSV and profiles columns", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ds-test-"));
  const csv = join(dir, "data.csv");
  writeFileSync(
    csv,
    "id,group,value\n1,a,10\n2,a,12\n3,b,20\n4,b,22\n5,b,\n",
  );
  const df = await DataFrame.open({ source: csv });
  try {
    expect(await df.rowCount()).toBe(5);
    const cols = await df.columns();
    expect(cols.map((c) => c.name)).toEqual(["id", "group", "value"]);
    const numeric = await df.numericColumns();
    expect(numeric).toContain("value");
    expect(numeric).toContain("id");
    // value has one NULL -> only 4 numeric entries
    const vals = await df.numericColumn("value");
    expect(vals.length).toBe(4);
    expect(vals).toEqual([10, 12, 20, 22]);
    const groups = await df.categoryColumn("group");
    expect(groups.length).toBe(5);
  } finally {
    df.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("DataFrame numericMatrix does listwise deletion", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ds-test-"));
  const csv = join(dir, "m.csv");
  writeFileSync(csv, "a,b\n1,2\n2,4\n3,\n4,8\n");
  const df = await DataFrame.open({ source: csv });
  try {
    const m = await df.numericMatrix(["a", "b"]);
    // row with NULL b is dropped
    expect(m.a).toEqual([1, 2, 4]);
    expect(m.b).toEqual([2, 4, 8]);
  } finally {
    df.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
