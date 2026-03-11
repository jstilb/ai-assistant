// Recommendation Parser — parses Recommendations_Received.csv
import { readCsv } from "../utils/csv-reader.ts";
import { parseDate, toISODate } from "../utils/date-parser.ts";
import type { RecommendationRow, Result } from "../types.ts";

export interface ParsedRecommendation {
  firstName: string;
  lastName: string;
  company: string;
  jobTitle: string;
  text: string;
  date: string; // ISO8601
}

export function parseRecommendations(
  csvPath: string
): Result<ParsedRecommendation[]> {
  const readResult = readCsv<RecommendationRow>(csvPath);
  if (!readResult.success) return readResult;

  const recommendations: ParsedRecommendation[] = [];

  for (const row of readResult.data) {
    const dateStr = row["Creation Date"] ?? "";
    const parsed = parseDate(dateStr);
    const dateFormatted = parsed ? toISODate(parsed) : dateStr.slice(0, 10);

    // Only include VISIBLE/accepted recommendations
    const status = row["Status"]?.trim().toUpperCase() ?? "";
    if (status && status !== "VISIBLE" && status !== "") continue;

    const text = row["Text"]?.trim() ?? "";
    if (!text) continue;

    recommendations.push({
      firstName: row["First Name"]?.trim() ?? "",
      lastName: row["Last Name"]?.trim() ?? "",
      company: row["Company"]?.trim() ?? "",
      jobTitle: row["Job Title"]?.trim() ?? "",
      text,
      date: dateFormatted,
    });
  }

  return { success: true, data: recommendations };
}
