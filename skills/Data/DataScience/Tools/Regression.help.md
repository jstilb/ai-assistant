# Regression.ts

Fit a regression model and report the full inferential summary: coefficients,
standard errors, test statistics, p-values, and goodness-of-fit.

## Usage

```bash
bun Regression.ts --type <linear|logistic> --source <path> --target <col> --features <a,b,c>
```

## Model families

| `--type` | Outcome | Method | Extra output |
|----------|---------|--------|--------------|
| `linear` | Continuous number | Ordinary least squares | R², adjusted R², F-test, residual std error |
| `logistic` | Binary 0/1 | Iteratively reweighted least squares | odds ratios, log-likelihood, accuracy, convergence |

## Flags

| Flag | Description |
|------|-------------|
| `--type linear\|logistic` | Model family (default `linear`) |
| `--target <col>` | Outcome column |
| `--features a,b,c` | Comma-separated predictor columns |
| `--source/--table/--sql/--where/--limit` | Dataset selection (see `Profile.help.md`) |
| `--format md\|json` | Output format (default `md`) |

## Examples

```bash
bun Regression.ts --type linear   --source homes.csv --target price --features sqft,beds,age
bun Regression.ts --type logistic --source users.csv --target churn --features tenure,spend
bun Regression.ts --type linear   --source d.csv --target y --features x --format json
```

## Reading the output

- **Linear coefficients** — change in the target per unit of the predictor.
- **Logistic coefficients** — change in **log-odds**; the `Odds Ratio` column is
  `exp(coef)` (odds multiplier per unit).
- **Stars** — `*** p<0.001  ** p<0.01  * p<0.05  . p<0.1`.
- **Fit** — linear: R²/adjusted R² and the overall F p-value; logistic:
  log-likelihood and in-sample accuracy.

## Notes

- Rows with any NULL in the target or a feature are dropped (listwise).
- **Singular design matrix** error → features are perfectly collinear; drop one.
- **`converged: false`** with huge standard errors (logistic) → complete or
  quasi-complete separation; the MLE doesn't exist, so simplify the model.
- In-sample R²/accuracy overstate real performance — this is a fit, not a
  held-out evaluation.
