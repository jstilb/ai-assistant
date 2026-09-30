# FitModel

Fit a regression model to explain or predict an outcome from one or more
predictors, and report the full inferential summary.

## Steps

1. **Pick the family by the outcome type:**

   | Outcome | `--type` | Notes |
   |---------|----------|-------|
   | Continuous number (price, minutes, score) | `linear` | Ordinary least squares |
   | Binary 0/1 (churn, converted, pass) | `logistic` | Fit by IRLS; needs 0/1 target |

2. **Profile and correlate first** (recommended). Run `Profile.ts` to confirm the
   target and features are numeric with acceptable missingness, and `Correlate.ts`
   to spot near-collinear predictors (|r| ≳ 0.9) that will inflate standard
   errors.

3. **Fit the model.**
   ```bash
   DS=~/.claude/skills/Data/DataScience/Tools
   bun $DS/Regression.ts --type <linear|logistic> \
     --source <path> --target <col> --features <a,b,c>
   ```
   Shared source flags (`--table`, `--sql`, `--where`, `--limit`, `--format json`)
   behave as in `Profile.ts`. Rows with any NULL in the target or a feature are
   dropped (listwise).

4. **Interpret the output:**
   - **Coefficients** — for linear, the change in the target per unit of the
     predictor; for logistic, the change in log-odds (report the **odds ratio**
     column too, `exp(coef)`).
   - **p-value / stars** — whether each predictor is distinguishable from zero.
   - **Fit** — linear: R² / adjusted R² (variance explained) and the overall F
     test; logistic: log-likelihood, in-sample accuracy, and convergence.

5. **Diagnostics to surface loudly:**
   - Linear: a **singular design matrix** error means perfectly collinear
     features — drop one.
   - Logistic: **`converged: false`** with enormous standard errors signals
     complete/quasi-complete separation (a predictor perfectly splits the
     outcome). The MLE doesn't exist; simplify the model rather than trusting the
     coefficients.
   - In-sample accuracy/R² overstate real-world performance — note that this is a
     fit, not a held-out evaluation.

## Notes

- Keep the feature count well below the row count; the tool errors if there are
  too few complete rows for the requested predictors.
- For non-linear relationships, transform features first (e.g. `--sql` with
  `LOG(x)`), since both models are linear in their parameters.
