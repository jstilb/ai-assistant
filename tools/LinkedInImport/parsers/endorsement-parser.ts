// Endorsement Parser — parses Endorsement_Received_Info.csv and Endorsement_Given_Info.csv
import { readCsv } from "../utils/csv-reader.ts";
import { normalizeLinkedInUrl } from "../utils/url-normalizer.ts";
import { parseDate, toISODate } from "../utils/date-parser.ts";
import type {
  EndorsementReceivedRow,
  EndorsementGivenRow,
  EndorsementRecord,
  Result,
} from "../types.ts";

export interface ParsedEndorsementData {
  // Map<normalizedUrl, received endorsements>
  received: Map<string, EndorsementRecord[]>;
  // Map<normalizedUrl, given endorsements>
  given: Map<string, EndorsementRecord[]>;
}

export function parseEndorsements(
  receivedPath: string,
  givenPath: string
): Result<ParsedEndorsementData> {
  // Parse received endorsements
  const receivedResult = readCsv<EndorsementReceivedRow>(receivedPath);
  if (!receivedResult.success) return receivedResult;

  const givenResult = readCsv<EndorsementGivenRow>(givenPath);
  if (!givenResult.success) return givenResult;

  const received = new Map<string, EndorsementRecord[]>();
  const given = new Map<string, EndorsementRecord[]>();

  for (const row of receivedResult.data) {
    const rawUrl = row["Endorser Public Url"]?.trim() ?? "";
    if (!rawUrl) continue;
    const normalizedUrl = normalizeLinkedInUrl(rawUrl);
    if (!normalizedUrl) continue;

    const dateStr = row["Endorsement Date"] ?? "";
    const parsed = parseDate(dateStr);
    const dateFormatted = parsed ? toISODate(parsed) : dateStr.slice(0, 10);

    const record: EndorsementRecord = {
      skillName: row["Skill Name"]?.trim() ?? "",
      date: dateFormatted,
    };

    const existing = received.get(normalizedUrl) ?? [];
    existing.push(record);
    received.set(normalizedUrl, existing);
  }

  for (const row of givenResult.data) {
    const rawUrl = row["Endorsee Public Url"]?.trim() ?? "";
    if (!rawUrl) continue;
    const normalizedUrl = normalizeLinkedInUrl(rawUrl);
    if (!normalizedUrl) continue;

    const dateStr = row["Endorsement Date"] ?? "";
    const parsed = parseDate(dateStr);
    const dateFormatted = parsed ? toISODate(parsed) : dateStr.slice(0, 10);

    const record: EndorsementRecord = {
      skillName: row["Skill Name"]?.trim() ?? "",
      date: dateFormatted,
    };

    const existing = given.get(normalizedUrl) ?? [];
    existing.push(record);
    given.set(normalizedUrl, existing);
  }

  return { success: true, data: { received, given } };
}
