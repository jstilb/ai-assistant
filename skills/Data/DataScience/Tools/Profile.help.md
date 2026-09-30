# Profile.ts

Exploratory data analysis + data-quality report for any tabular source. Run this
first on any new dataset.

## Usage

```bash
bun Profile.ts --source <path> [flags]
```

## Flags

| Flag | Description |
|------|-------------|
| `--source <path>` | Data file: `.csv`, `.tsv`, `.parquet`, `.json`/`.ndjson`/`.jsonl`, `.db`/`.sqlite`, `.duckdb`/`.ddb` |
| `--table <name>` | Table name (required for SQLite/DuckDB sources) |
| `--sql <query>` | Define the dataset directly with SQL (overrides `--source`) |
| `--where <expr>` | SQL predicate to filter rows before profiling |
| `--limit <n>` | Cap the number of rows scanned |
| `--top <k>` | Top-K categorical values to display (default 5) |
| `--format md\|json` | Output format (default `md`) |

## Output

- **Shape** — rows × columns.
- **Columns table** — per column: type, non-null count, null %, distinct count,
  and quality flags.
- **Numeric summary** — mean, std, min, Q1, median, Q3, max, skewness.
- **Top categorical values** — most frequent values per text column.
- **Data-quality notes** — `constant`, `unique (likely ID)`, `high-missingness`,
  `high-cardinality`, `skewed`, and outlier counts (1.5×IQR rule).

## Examples

```bash
bun Profile.ts --source ~/Downloads/survey.csv
bun Profile.ts --source data.parquet --format json
bun Profile.ts --source app.db --table events --limit 100000
bun Profile.ts --sql "SELECT * FROM read_csv_auto('x.csv') WHERE amount > 0"
```

## Notes

- Numeric columns are detected from the DuckDB column type. Continuous floats are
  never flagged as "likely ID" even when all values are distinct.
- To discover table names in a SQLite/DuckDB file, list them with the `sqlite3`
  or `duckdb` CLI (e.g. `sqlite3 file.db .tables`), then pass the name via
  `--table`.
