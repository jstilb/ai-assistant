#!/usr/bin/env bun
/**
 * Regression.ts — fit a regression model to a dataset and report the full
 * inferential summary (coefficients, standard errors, test statistics,
 * p-values, and goodness-of-fit).
 *
 *   linear    ordinary least squares for a continuous target
 *   logistic  binary logistic regression (target must be 0/1) fit by IRLS
 *
 * Rows with any missing feature/target value are dropped (listwise deletion).
 *
 * Usage:
 *   bun Regression.ts --type linear   --source d.csv --target price --features sqft,beds,age
 *   bun Regression.ts --type logistic --source d.csv --target churn --features tenure,spend
 *   bun Regression.ts --type linear   --source d.csv --target y --features x --format json
 *
 * Flags:
 *   --type linear|logistic     model family (default linear)
 *   --target <col>             outcome column
 *   --features a,b,c           predictor columns (comma-separated)
 *   --source/--table/--sql/--where/--limit   dataset selection (see Profile.ts)
 *   --format md|json           output format (default md)
 */

import { DataFrame } from "./DataFrame.ts";
import { linearRegression, logisticRegression } from "./Stats.ts";
import { parseArgs, fmtNum, fmtP, sigStars, printModeError, loadOptsFromArgs } from "./Cli.ts";

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const type = (args.type as string) ?? "linear";
  const format = (args.format as string) ?? "md";
  const target = args.target as string | undefined;
  if (!target) throw new Error("Missing --target <col>");
  if (!args.features) throw new Error("Missing --features a,b,c");
  const features = String(args.features).split(",").map((s) => s.trim()).filter(Boolean);
  if (features.length === 0) throw new Error("Provide at least one feature");

  const df = await DataFrame.open(loadOptsFromArgs(args));

  try {
    for (const col of [target, ...features]) {
      if (!(await df.hasColumn(col))) throw new Error(`Column not found: ${col}`);
    }

    // Listwise-complete numeric matrix over target + features.
    const cols = [target, ...features];
    const m = await df.numericMatrix(cols);
    const n = m[target]!.length;
    if (n <= features.length + 1) {
      throw new Error(`Not enough complete rows (${n}) for ${features.length} feature(s)`);
    }
    const y = m[target]!;
    const X: number[][] = [];
    for (let i = 0; i < n; i++) X.push(features.map((f) => m[f]![i]!));

    if (type === "linear") {
      const model = linearRegression(X, y, features);
      if (format === "json") {
        console.log(JSON.stringify(model, null, 2));
        return;
      }
      console.log(`# Linear Regression (OLS)\n`);
      console.log(`**Target:** \`${target}\`  ·  **n:** ${model.n}  ·  **df:** ${model.df}\n`);
      console.log(`## Coefficients\n`);
      console.log(`| Term | Estimate | Std. Error | t | p-value | |`);
      console.log(`|------|---------:|-----------:|--:|--------:|---|`);
      for (const c of model.coefficients) {
        console.log(
          `| ${c.name} | ${fmtNum(c.estimate)} | ${fmtNum(c.stdError)} | ${fmtNum(c.statistic)} | ${fmtP(c.pValue)} | ${sigStars(c.pValue)} |`,
        );
      }
      console.log(`\n## Fit\n`);
      console.log(`| Metric | Value |`);
      console.log(`|--------|------:|`);
      console.log(`| R² | ${model.rSquared.toFixed(4)} |`);
      console.log(`| Adjusted R² | ${model.adjRSquared.toFixed(4)} |`);
      console.log(`| Residual std. error | ${fmtNum(model.residualStdError)} |`);
      console.log(`| F-statistic | ${fmtNum(model.fStatistic)} |`);
      console.log(`| F p-value | ${fmtP(model.fPValue)} |`);
      console.log(`\n_Signif.: *** p<0.001  ** p<0.01  * p<0.05  . p<0.1_`);
    } else if (type === "logistic") {
      const distinct = new Set(y);
      for (const v of distinct) {
        if (v !== 0 && v !== 1) {
          throw new Error(`logistic target must be 0/1; found value ${v}`);
        }
      }
      const model = logisticRegression(X, y, features);
      if (format === "json") {
        console.log(JSON.stringify(model, null, 2));
        return;
      }
      console.log(`# Logistic Regression\n`);
      console.log(
        `**Target:** \`${target}\`  ·  **n:** ${model.n}  ·  **converged:** ${model.converged} (${model.iterations} iters)\n`,
      );
      console.log(`## Coefficients (log-odds)\n`);
      console.log(`| Term | Estimate | Std. Error | z | p-value | Odds Ratio | |`);
      console.log(`|------|---------:|-----------:|--:|--------:|-----------:|---|`);
      for (const c of model.coefficients) {
        console.log(
          `| ${c.name} | ${fmtNum(c.estimate)} | ${fmtNum(c.stdError)} | ${fmtNum(c.statistic)} | ${fmtP(c.pValue)} | ${fmtNum(Math.exp(c.estimate))} | ${sigStars(c.pValue)} |`,
        );
      }
      console.log(`\n## Fit\n`);
      console.log(`| Metric | Value |`);
      console.log(`|--------|------:|`);
      console.log(`| Log-likelihood | ${fmtNum(model.logLikelihood)} |`);
      console.log(`| In-sample accuracy | ${(model.accuracy * 100).toFixed(1)}% |`);
      console.log(`\n_Signif.: *** p<0.001  ** p<0.01  * p<0.05  . p<0.1_`);
    } else {
      throw new Error(`Unknown --type: ${type} (use linear or logistic)`);
    }
  } finally {
    df.close();
  }
}

main().catch((err) => {
  printModeError(err);
  process.exit(1);
});
