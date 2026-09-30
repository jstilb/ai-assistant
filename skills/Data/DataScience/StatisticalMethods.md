# Statistical Methods — Which Test When

Reference for the DataScience skill. Maps a question to the right tool, states
the assumptions, and explains how to read the output. All tests are implemented
in `Tools/Stats.ts` and validated in `DataScience.test.ts`.

## Decision guide

| Your question | Test | Command |
|---------------|------|---------|
| What's in this dataset? Quality issues? | Profiling | `Profile.ts` |
| Do two groups differ on a numeric measure? | Welch two-sample t-test | `HypothesisTest.ts --test ttest` |
| Does one sample differ from a known value? | One-sample t-test | `HypothesisTest.ts --test ttest1 --mu <v>` |
| Do 3+ groups differ on a numeric measure? | One-way ANOVA | `HypothesisTest.ts --test anova` |
| Are two numeric variables linearly related? | Pearson correlation | `HypothesisTest.ts --test correlation` |
| Are two categorical variables associated? | Chi-square independence | `HypothesisTest.ts --test chisquare` |
| Which numeric columns move together? | Correlation matrix | `Correlate.ts` |
| Predict a continuous outcome from predictors? | OLS linear regression | `Regression.ts --type linear` |
| Predict a 0/1 outcome from predictors? | Logistic regression | `Regression.ts --type logistic` |

## Reading the output

- **p-value** — probability of an effect this large if the null hypothesis were
  true. Below α (default 0.05) → "statistically significant". It is **not** the
  probability the null is true, and it says nothing about effect *size*.
- **Effect size** — always reported alongside p. A tiny effect can be
  "significant" with enough rows; a large effect can be non-significant with few.
  - **Cohen's d** (t-tests): ~0.2 small, ~0.5 medium, ~0.8 large.
  - **eta-squared** (ANOVA): share of variance explained by group.
  - **Cramér's V** (chi-square): 0 = no association, 1 = perfect.
  - **r** (correlation): ±0.1 weak, ±0.3 moderate, ±0.5 strong (context-dependent).
- **Degrees of freedom** — Welch t-tests report fractional df (Welch–Satterthwaite);
  that is expected, not a bug.

## Assumptions (and what the tools do about them)

- **Welch t-test** does *not* assume equal variances (safer default than
  Student's pooled t-test). Assumes roughly normal group means — robust for
  n ≳ 30 per group by the CLT. Check skew with `Profile.ts`.
- **ANOVA** assumes independent groups and similar within-group variances. A
  significant result says *some* group differs, not which — follow up pairwise.
- **Pearson correlation** measures *linear* association only. A curved
  relationship can have r ≈ 0. Always look at `Profile.ts` distributions first.
- **Chi-square** needs expected cell counts ≳ 5 to be reliable. With small
  counts, treat the p-value as approximate.
- **OLS** assumes a linear relationship, independent observations, and roughly
  constant-variance residuals. Strongly correlated predictors (see `Correlate.ts`)
  inflate standard errors; a perfectly collinear design raises a singular-matrix
  error.
- **Logistic regression** reports `converged: true/false`. **Complete/quasi-
  complete separation** (a predictor that perfectly splits the outcome) makes
  coefficients diverge with huge standard errors and `converged: false` — the
  data are *too* predictive for the MLE to exist. That is a real diagnostic, not
  a tool failure; simplify the model or gather overlapping data.

## Missing data

All tools drop NULLs. Single-column tools drop NULLs in that column;
correlation/regression use **listwise deletion** (a row is dropped if *any*
involved column is NULL). `Profile.ts` reports missingness per column so you know
how much was dropped before trusting a result.

## Method notes

- Quantiles use linear interpolation (matches DuckDB `quantile_cont` and numpy's
  default), so medians/quartiles agree with those tools.
- Distribution tail probabilities come from the regularized incomplete beta
  (t, F) and incomplete gamma (chi-square) functions — accurate to ~1e-10.
- Logistic regression is fit by IRLS (Newton–Raphson); standard errors are the
  square roots of the inverse Fisher information at the solution (Wald tests).
