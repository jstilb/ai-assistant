# TestHypothesis

Answer a "is this difference/association real?" question with the correct
significance test, then report the statistic, p-value, effect size, and a
plain-language verdict.

## Steps

1. **Classify the question** → pick the test (full guide in `StatisticalMethods.md`):

   | Question shape | `--test` | Required columns |
   |----------------|----------|------------------|
   | Two groups differ on a number? | `ttest` | `--group <cat> --value <num>` |
   | Sample differs from a known value? | `ttest1` | `--value <num> --mu <v>` |
   | 3+ groups differ on a number? | `anova` | `--group <cat> --value <num>` |
   | Two numbers linearly related? | `correlation` | `--x <num> --y <num>` |
   | Two categories associated? | `chisquare` | `--row <cat> --col <cat>` |

2. **Run the test.**
   ```bash
   DS=~/.claude/skills/Data/DataScience/Tools
   bun $DS/HypothesisTest.ts --test <test> --source <path> [test-specific flags]
   ```
   - For `ttest`, if the grouping column has more than two levels, pass
     `--groups levelA,levelB` to choose the pair.
   - Shared source flags (`--table`, `--sql`, `--where`, `--limit`) work exactly
     as in `Profile.ts`.
   - Override the significance level with `--alpha 0.01` if the user wants it.

3. **Report** the statistic, degrees of freedom, p-value, effect size (Cohen's d
   / eta-squared / Cramér's V / r), and the reject / fail-to-reject verdict.
   Translate to plain language: significance = "unlikely to be chance at this
   sample size", and pair it with the effect size (how big) — never report one
   without the other.

4. **Caveats to surface** when relevant:
   - A significant ANOVA says *some* group differs, not which — offer pairwise
     `ttest` follow-ups.
   - Correlation is linear-only; a near-zero r can still hide a curved relationship.
   - Chi-square is approximate when expected cell counts are small (< ~5).
   - Large n makes trivial effects "significant" — lead with the effect size then.

## Notes

- If unsure which columns are numeric vs categorical, run `Profile.ts` first.
- NULLs are dropped automatically (listwise for correlation).
