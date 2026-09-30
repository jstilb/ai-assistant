---
name: DataScience
description: Exploratory data analysis, statistics, and modeling on tabular data (CSV, Parquet, JSON, SQLite, DuckDB). USE WHEN analyze a dataset, explore data, data profiling, summary statistics, distribution, missing values, outliers, correlation, correlate columns, hypothesis test, t-test, ANOVA, chi-square, statistical significance, p-value, regression, linear regression, logistic regression, predict, or model a relationship in data.
implements: Science
science_cycle_time: meso
---

# DataScience

Statistics and modeling over tabular data — DuckDB reads the file, pure-TypeScript inference does the math. No Python / pandas dependency; everything runs on the Kaya bun + DuckDB stack.

Reads **CSV, TSV, Parquet, JSON/NDJSON, SQLite, and DuckDB** sources. Every tool takes the same source flags (`--source`, `--table`, `--sql`, `--where`, `--limit`) and supports `--format json`.

## Voice Notification

Use `notifySync()` from `lib/core/NotificationService.ts`

## Workflow Routing

| Workflow | Trigger | File |
|----------|---------|------|
| **ExploreDataset** | "explore / profile this data", "what's in this dataset", "summary stats", "missing values", "outliers", "correlations" | `Workflows/ExploreDataset.md` |
| **TestHypothesis** | "is the difference significant", "t-test", "ANOVA", "chi-square", "are these correlated", "p-value" | `Workflows/TestHypothesis.md` |
| **FitModel** | "predict / model X from Y", "linear regression", "logistic regression", "which factors drive" | `Workflows/FitModel.md` |

## Tools

| Tool | Purpose |
|------|---------|
| `Tools/Profile.ts` | EDA + data-quality report: shape, types, missingness, distributions, outliers, ID/constant/skew flags |
| `Tools/Correlate.ts` | Pairwise Pearson correlation matrix + ranked strong relationships (optionally vs. a `--target`) |
| `Tools/HypothesisTest.ts` | Significance tests: Welch t-test, one-sample t-test, one-way ANOVA, Pearson correlation, chi-square independence |
| `Tools/Regression.ts` | OLS linear regression and binary logistic regression with full coefficient inference |
| `Tools/Stats.ts` | Pure-TS statistics core (distributions, tests, regression) — unit-tested, imported by the tools |
| `Tools/DataFrame.ts` | DuckDB-backed loader shared by all tools |

## Quick Reference

```bash
DS=~/.claude/skills/Data/DataScience/Tools

# Profile any dataset first
bun $DS/Profile.ts --source data.csv
bun $DS/Profile.ts --source app.db --table events --limit 100000

# Correlations (rank against a target)
bun $DS/Correlate.ts --source data.csv --target price

# Hypothesis tests
bun $DS/HypothesisTest.ts --test ttest --source d.csv --group arm --value score
bun $DS/HypothesisTest.ts --test anova --source d.csv --group site --value yield
bun $DS/HypothesisTest.ts --test chisquare --source d.csv --row region --col plan

# Regression
bun $DS/Regression.ts --type linear   --source d.csv --target price --features sqft,beds,age
bun $DS/Regression.ts --type logistic --source d.csv --target churn --features tenure,spend
```

Add `--format json` to any tool for machine-readable output. Each tool has a `.help.md` alongside it.

**When to use what:** `StatisticalMethods.md` (in this directory) maps questions → tests, lists assumptions, and explains how to read the output.

## Examples

**Example 1: Explore an unfamiliar dataset**
```
User: "What's in ~/Downloads/survey.csv? Any data quality issues?"
→ Invokes ExploreDataset workflow
→ bun Profile.ts --source ~/Downloads/survey.csv
→ Returns shape, per-column types/missingness/distributions, and flags
  (constant columns, likely IDs, high missingness, outliers, skew)
```

**Example 2: Test whether a difference is real**
```
User: "Do pro-plan users spend more than basic users? Is it significant?"
→ Invokes TestHypothesis workflow
→ bun HypothesisTest.ts --test ttest --source users.csv --group plan --value spend
→ Returns t, df, p-value, Cohen's d, and a reject/fail-to-reject verdict
```

**Example 3: Model a relationship**
```
User: "Which factors predict churn — tenure or spend?"
→ Invokes FitModel workflow
→ bun Regression.ts --type logistic --source users.csv --target churn --features tenure,spend
→ Returns coefficients, odds ratios, Wald z p-values, accuracy, convergence
```

## Output Requirements

- **Format:** Markdown tables by default; `--format json` for programmatic use
- **Must Include:** the test/model name, the statistic, degrees of freedom, the p-value, an effect size, and a plain-language verdict
- **Must Avoid:** claiming significance without reporting the p-value and effect size; hiding non-convergence or assumption violations — surface them loudly

## Integration

### Uses
- `@duckdb/node-api` — file parsing and aggregation (already a Kaya dependency)
- `Tools/Stats.ts` — inference math (no external stats library)

### Feeds Into
- Any analysis of Jm's own datasets — e.g. `AppUsageTracker/events.db` (media/screen-time), LifeOS SQLite exports, habit/ratings logs, CSV/Parquet exports
- `dataviz` skill — profile/correlate first, then visualize the findings
