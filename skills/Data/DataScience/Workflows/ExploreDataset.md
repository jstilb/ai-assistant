# ExploreDataset

Profile an unfamiliar tabular dataset: shape, column types, missingness,
distributions, outliers, and data-quality flags — then optionally surface the
strongest correlations. This is the first thing to run on any new data.

## Steps

1. **Locate the source.** Accept a file path (CSV/TSV/Parquet/JSON/NDJSON) or a
   database file (SQLite/DuckDB). For a database file you also need a table name.

2. **Profile it.**
   ```bash
   DS=~/.claude/skills/Data/DataScience/Tools
   bun $DS/Profile.ts --source <path>
   ```
   Map user intent to flags:

   | User says | Flag |
   |-----------|------|
   | "it's a SQLite/DuckDB file", table given | `--table <name>` |
   | "just the first N rows", large file | `--limit <n>` |
   | "only rows where …" | `--where "<sql predicate>"` |
   | "top 10 categories" | `--top 10` |
   | "give me JSON" / feeding another tool | `--format json` |
   | fully custom slice | `--sql "<SELECT …>"` |

3. **Read the report to the user**, calling out:
   - Shape (rows × columns) and any columns flagged **constant**, **unique
     (likely ID)**, **high-missingness**, **high-cardinality**, **skewed**, or
     carrying **outliers**.
   - For numeric columns: center (mean/median) and spread (std, IQR via Q1/Q3).
   - For categorical columns: the dominant values.

4. **If the user wants relationships**, run the correlation matrix:
   ```bash
   bun $DS/Correlate.ts --source <path> [--target <col>] [--threshold 0.7]
   ```
   Use `--target` when they care about one outcome; report the ranked strong
   relationships and warn about any near-collinear pairs (|r| ≳ 0.9) before
   modeling.

5. **Recommend next steps** based on findings — e.g. a hypothesis test
   (`TestHypothesis`) for a specific group difference, or a model (`FitModel`)
   if they want to predict an outcome. See `StatisticalMethods.md`.

## Notes

- Always profile before testing or modeling — it reveals missingness and
  distribution shape that determine which test is valid.
- Do not silently ignore high missingness; state how many rows a downstream test
  would drop.
