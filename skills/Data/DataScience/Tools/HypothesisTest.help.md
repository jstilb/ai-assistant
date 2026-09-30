# HypothesisTest.ts

Run a statistical significance test on columns of a dataset. Reports the
statistic, degrees of freedom, p-value, an effect size, and a reject /
fail-to-reject verdict.

## Usage

```bash
bun HypothesisTest.ts --test <name> --source <path> [test flags]
```

## Tests

| `--test` | What it answers | Required flags | Effect size |
|----------|-----------------|----------------|-------------|
| `ttest` | Do two groups differ in mean? (Welch, unequal variance) | `--group <cat> --value <num>` | Cohen's d |
| `ttest1` | Does a sample differ from a known mean? | `--value <num> --mu <v>` | Cohen's d |
| `anova` | Do 3+ groups differ in mean? | `--group <cat> --value <num>` | eta-squared |
| `correlation` | Are two numbers linearly related? | `--x <num> --y <num>` | r |
| `chisquare` | Are two categories associated? | `--row <cat> --col <cat>` | Cramér's V |

## Common flags

| Flag | Description |
|------|-------------|
| `--source/--table/--sql/--where/--limit` | Dataset selection (see `Profile.help.md`) |
| `--groups a,b` | For `ttest`: pick two levels when the group column has >2 |
| `--alpha <a>` | Significance level for the verdict (default 0.05) |
| `--format md\|json` | Output format (default `md`) |

## Examples

```bash
bun HypothesisTest.ts --test ttest  --source d.csv --group arm --value score
bun HypothesisTest.ts --test ttest  --source d.csv --group arm --value score --groups control,treatment
bun HypothesisTest.ts --test ttest1 --source d.csv --value score --mu 100
bun HypothesisTest.ts --test anova  --source d.csv --group site --value yield
bun HypothesisTest.ts --test correlation --source d.csv --x age --y income
bun HypothesisTest.ts --test chisquare   --source d.csv --row region --col plan
```

## Notes

- Welch t-tests report fractional degrees of freedom (Welch–Satterthwaite) —
  expected, not an error.
- Report the effect size alongside the p-value; with large n, trivial effects
  become "significant".
- See `StatisticalMethods.md` for assumptions and how to read each test.
