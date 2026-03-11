// Typed CSV reading wrapper using csv-parse/sync
import { readFileSync } from "fs";
import { parse } from "csv-parse/sync";
import type { Result } from "../types.ts";

export function readCsv<T extends Record<string, string>>(
  filePath: string
): Result<T[]> {
  try {
    const content = readFileSync(filePath, "utf-8");
    const records = parse(content, {
      columns: true,
      skip_empty_lines: true,
      trim: true,
      relax_column_count: true,
      relax_quotes: true,
      bom: true,
    }) as T[];
    return { success: true, data: records };
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err : new Error(String(err)),
    };
  }
}

// Read a JSONL file and return parsed records
export function readJsonl<T>(filePath: string): Result<T[]> {
  try {
    const content = readFileSync(filePath, "utf-8");
    const lines = content.split("\n").filter((l) => l.trim() !== "");
    const records: T[] = [];
    for (const line of lines) {
      try {
        records.push(JSON.parse(line) as T);
      } catch {
        // Skip malformed lines
      }
    }
    return { success: true, data: records };
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err : new Error(String(err)),
    };
  }
}
