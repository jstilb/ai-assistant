# Correlate.ts

Pairwise Pearson correlation across the numeric columns of a dataset, plus a
ranked list of the strongest relationships. Correlations use DuckDB's `corr()`
aggregate over pairwise-complete observations.

## Usage

```bash
bun Correlate.ts --source <path> [flags]
```

## Flags

| Flag | Description |
|------|-------------|
| `--source <path>` | Data file (csv/tsv/parquet/json/sqlite/duckdb) |
| `--table <name>` | Table name (SQLite/DuckDB sources) |
| `--sql <query>` | Define the dataset directly |
| `--where <expr>` | Filter predicate |
| `--limit <n>` | Row cap |
| `--columns a,b,c` | Restrict to these numeric columns |
| `--target <col>` | Rank all columns by \|correlation\| with this one |
| `--threshold <r>` | \|r\| cutoff for the "strong relationships" list (default 0.7) |
| `--format md\|json` | Output format (default `md`) |

## Output

- **Correlation with `<target>`** (when `--target` is given) — every other
  column ranked by absolute correlation, with a strength label.
- **Correlation matrix** — full pairwise Pearson r.
- **Strong relationships** — pairs with |r| ≥ threshold, with direction.

## Examples

```bash
bun Correlate.ts --source data.csv
bun Correlate.ts --source data.csv --target price --threshold 0.5
bun Correlate.ts --source data.parquet --columns sqft,beds,age,price --format json
```

## Notes

- Pearson measures **linear** association only; check distributions with
  `Profile.ts` first.
- Pairs with |r| ≳ 0.9 are near-collinear — drop one before regression to avoid
  inflated standard errors.
- Needs at least two numeric columns.
