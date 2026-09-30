/**
 * DataFrame.ts — DuckDB-backed loader for the DataScience skill.
 *
 * Wraps any tabular source (CSV/TSV, Parquet, JSON/NDJSON, SQLite, DuckDB) in a
 * single in-memory DuckDB view named `df`, then exposes the read patterns the
 * DataScience tools actually use: column metadata, typed column extraction,
 * numeric-only columns, and raw aggregate queries.
 *
 * DuckDB does the file parsing and heavy aggregation; the pure-TS Stats.ts core
 * does the inference. This keeps the whole skill inside Kaya's bun/DuckDB stack
 * with no Python / pandas dependency.
 */

import { DuckDBInstance, type DuckDBConnection } from "@duckdb/node-api";
import { existsSync, openSync, readSync, closeSync } from "node:fs";
import { extname } from "node:path";

export interface LoadOpts {
  /** Path to a data file (csv/tsv/parquet/json/sqlite/duckdb). */
  source?: string;
  /** Table name inside a SQLite/DuckDB source, or to override auto-detection. */
  table?: string;
  /** Force the database engine for a `.db`-style source ("sqlite" | "duckdb"). */
  dbType?: "sqlite" | "duckdb";
  /** Custom SQL that defines `df` directly (overrides source-based loading). */
  sql?: string;
  /** Optional WHERE predicate applied to the loaded view. */
  where?: string;
  /** Optional row cap applied to the loaded view. */
  limit?: number;
}

export interface ColumnMeta {
  name: string;
  type: string;
  numeric: boolean;
}

const NUMERIC_TYPE = /\b(TINYINT|SMALLINT|INTEGER|BIGINT|HUGEINT|UTINYINT|USMALLINT|UINTEGER|UBIGINT|DECIMAL|NUMERIC|REAL|FLOAT|DOUBLE)\b/i;

/** Reject paths that would break single-quote SQL string literals. */
function assertSafePath(p: string): void {
  if (p.includes("'")) {
    throw new Error(`Unsupported path (contains a single quote): ${p}`);
  }
}

/**
 * Sniff a database file's engine from its header magic bytes. SQLite files
 * begin with "SQLite format 3\0"; native DuckDB files carry "DUCK" at offset 8.
 * Returns null when the header is inconclusive (e.g. an empty file).
 */
function sniffDbType(path: string): "SQLITE" | "DUCKDB" | null {
  let fd: number | null = null;
  try {
    fd = openSync(path, "r");
    const buf = Buffer.alloc(16);
    readSync(fd, buf, 0, 16, 0);
    if (buf.slice(0, 15).toString("latin1") === "SQLite format 3") return "SQLITE";
    if (buf.slice(8, 12).toString("latin1") === "DUCK") return "DUCKDB";
    return null;
  } catch {
    return null;
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

/**
 * Resolve the attach engine for a source. Content sniffing wins (the `.db`
 * extension is ambiguous — SQLite and DuckDB both use it); the extension and an
 * explicit override are fallbacks.
 */
function attachType(
  ext: string,
  path: string,
  override?: "sqlite" | "duckdb",
): "SQLITE" | "DUCKDB" | null {
  const isDbLike =
    ext === ".db" ||
    ext === ".sqlite" ||
    ext === ".sqlite3" ||
    ext === ".duckdb" ||
    ext === ".ddb";
  if (!isDbLike) return null;
  if (override) return override === "sqlite" ? "SQLITE" : "DUCKDB";
  const sniffed = sniffDbType(path);
  if (sniffed) return sniffed;
  // Fall back to the extension when the header is inconclusive.
  if (ext === ".duckdb" || ext === ".ddb") return "DUCKDB";
  return "SQLITE";
}

export class DataFrame {
  private constructor(
    private readonly conn: DuckDBConnection,
    private readonly instance: DuckDBInstance,
    private colCache: ColumnMeta[] | null = null,
  ) {}

  static async open(opts: LoadOpts): Promise<DataFrame> {
    const instance = await DuckDBInstance.create(":memory:");
    const conn = await instance.connect();
    const frame = new DataFrame(conn, instance);
    await frame.buildView(opts);
    return frame;
  }

  private async buildView(opts: LoadOpts): Promise<void> {
    let base: string;

    if (opts.sql) {
      base = `SELECT * FROM (${opts.sql})`;
    } else {
      const src = opts.source;
      if (!src) throw new Error("Provide --source <file> or --sql <query>");
      if (!existsSync(src)) throw new Error(`Source not found: ${src}`);
      assertSafePath(src);
      const ext = extname(src).toLowerCase();
      const attach = attachType(ext, src, opts.dbType);

      if (attach) {
        if (!opts.table) {
          const listCmd =
            attach === "SQLITE" ? `sqlite3 '${src}' .tables` : `duckdb '${src}' .tables`;
          throw new Error(
            `A ${attach.toLowerCase()} source needs --table <name>. ` +
              `List tables with: ${listCmd}`,
          );
        }
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(opts.table)) {
          throw new Error(`Invalid --table name: ${opts.table}`);
        }
        await this.conn.run(`ATTACH '${src}' AS src (TYPE ${attach}, READ_ONLY)`);
        base = `SELECT * FROM src.${opts.table}`;
      } else if (ext === ".parquet") {
        base = `SELECT * FROM read_parquet('${src}')`;
      } else if (ext === ".json" || ext === ".ndjson" || ext === ".jsonl") {
        base = `SELECT * FROM read_json_auto('${src}')`;
      } else if (ext === ".tsv") {
        base = `SELECT * FROM read_csv_auto('${src}', delim='\t')`;
      } else {
        // Default: treat as CSV (covers .csv and extensionless delimited files).
        base = `SELECT * FROM read_csv_auto('${src}')`;
      }
    }

    if (opts.where) base = `SELECT * FROM (${base}) WHERE ${opts.where}`;
    if (opts.limit && opts.limit > 0) base = `${base} LIMIT ${Math.floor(opts.limit)}`;

    await this.conn.run(`CREATE VIEW df AS ${base}`);
  }

  async columns(): Promise<ColumnMeta[]> {
    if (this.colCache) return this.colCache;
    const rows = (await this.all("DESCRIBE df")) as Array<{
      column_name: string;
      column_type: string;
    }>;
    this.colCache = rows.map((r) => ({
      name: r.column_name,
      type: r.column_type,
      numeric: NUMERIC_TYPE.test(r.column_type),
    }));
    return this.colCache;
  }

  async numericColumns(): Promise<string[]> {
    return (await this.columns()).filter((c) => c.numeric).map((c) => c.name);
  }

  async hasColumn(name: string): Promise<boolean> {
    return (await this.columns()).some((c) => c.name === name);
  }

  /** Quote an identifier for safe interpolation into SQL. */
  static ident(name: string): string {
    return `"${name.replace(/"/g, '""')}"`;
  }

  async rowCount(): Promise<number> {
    const r = (await this.all("SELECT COUNT(*) AS n FROM df"))[0] as { n: unknown };
    return Number(r.n);
  }

  /**
   * Fetch a single column's non-null numeric values, as JS numbers.
   * Non-numeric or NULL entries are dropped.
   */
  async numericColumn(name: string): Promise<number[]> {
    const q = DataFrame.ident(name);
    const rows = (await this.all(
      `SELECT CAST(${q} AS DOUBLE) AS v FROM df WHERE ${q} IS NOT NULL`,
    )) as Array<{ v: unknown }>;
    const out: number[] = [];
    for (const r of rows) {
      const n = Number(r.v);
      if (Number.isFinite(n)) out.push(n);
    }
    return out;
  }

  /** Fetch a column's non-null values as strings (for grouping / contingency). */
  async categoryColumn(name: string): Promise<string[]> {
    const q = DataFrame.ident(name);
    const rows = (await this.all(
      `SELECT CAST(${q} AS VARCHAR) AS v FROM df WHERE ${q} IS NOT NULL`,
    )) as Array<{ v: unknown }>;
    return rows.map((r) => String(r.v));
  }

  /**
   * Fetch rows for a set of columns, keeping only rows where ALL requested
   * columns are non-null and numeric-castable. Returns parallel arrays keyed by
   * column name. Used for regression / paired correlation (listwise deletion).
   */
  async numericMatrix(names: string[]): Promise<Record<string, number[]>> {
    const quoted = names.map((n) => DataFrame.ident(n));
    const notNull = quoted.map((q) => `${q} IS NOT NULL`).join(" AND ");
    const selects = names
      .map((n) => `CAST(${DataFrame.ident(n)} AS DOUBLE) AS ${DataFrame.ident(n)}`)
      .join(", ");
    const rows = (await this.all(
      `SELECT ${selects} FROM df WHERE ${notNull}`,
    )) as Array<Record<string, unknown>>;
    const out: Record<string, number[]> = {};
    for (const n of names) out[n] = [];
    for (const row of rows) {
      const vals = names.map((n) => Number(row[n]));
      if (vals.some((v) => !Number.isFinite(v))) continue;
      names.forEach((n, i) => out[n]!.push(vals[i]!));
    }
    return out;
  }

  /** Run an arbitrary read query against the loaded data (or `df`). */
  async all(sql: string, params?: Record<string, unknown>): Promise<Record<string, unknown>[]> {
    const reader = params
      ? await this.conn.runAndReadAll(sql, params)
      : await this.conn.runAndReadAll(sql);
    return reader.getRowObjects() as Record<string, unknown>[];
  }

  close(): void {
    this.conn.disconnectSync();
    this.instance.closeSync();
  }
}

/** Coerce a DuckDB scalar to a finite JS number, or null. */
export function toNum(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const n = typeof v === "bigint" ? Number(v) : Number(v);
  return Number.isFinite(n) ? n : null;
}
