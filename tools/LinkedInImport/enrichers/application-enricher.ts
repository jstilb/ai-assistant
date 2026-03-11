// Application Enricher — generates dedup hashes, appends to applications.jsonl
// Updated to output unified ApplicationRecord format with 16-char truncated SHA-256 hashes
// matching computeDedupHash() from JobEngine/Tools/lib/dedup.ts
import { createHash } from "crypto";
import { readFileSync, appendFileSync } from "fs";
import type { ParsedApplication } from "../parsers/application-parser.ts";
import type { Result } from "../types.ts";

// =============================================================================
// DEDUP HASH — matches JobEngine computeDedupHash() exactly
// =============================================================================

/**
 * Normalize a string for dedup key purposes.
 * Lowercases and strips all non-alphanumeric characters.
 * Matches normalizeDedupKey() in JobEngine/Tools/lib/dedup.ts.
 */
function normalizeDedupKey(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/**
 * Compute a 16-character SHA-256 dedup hash from company + title + location.
 * Matches computeDedupHash() in JobEngine/Tools/lib/dedup.ts.
 */
export function generateDedupHash(company: string, title: string, location: string): string {
  const normalized = [
    normalizeDedupKey(company),
    normalizeDedupKey(title),
    normalizeDedupKey(location),
  ].join("|");

  return createHash("sha256").update(normalized).digest("hex").slice(0, 16);
}

// =============================================================================
// UNIFIED APPLICATION RECORD
// =============================================================================

/** Matches ApplicationRecord from JobEngine/Tools/lib/types.ts */
interface UnifiedApplicationRecord {
  id: string;
  timestamp: string;
  company: string;
  title: string;
  url: string;
  workflow: "manual";
  match_score: number;
  resume_variant: string;
  cover_letter: boolean;
  status: "submitted";
  dedup_hash: string;
  source: "linkedin_historical";
  location: string;
  referral_status: "none";
  outcome: null;
  callback_date: null;
  notes: string;
  updated_at: string;
}

// Load existing dedup hashes from applications.jsonl
function loadExistingHashes(jsonlPath: string): Set<string> {
  const hashes = new Set<string>();
  try {
    const content = readFileSync(jsonlPath, "utf-8");
    const lines = content.split("\n").filter((l) => l.trim() !== "");
    for (const line of lines) {
      try {
        const obj = JSON.parse(line) as Record<string, unknown>;
        if (typeof obj["dedup_hash"] === "string") {
          hashes.add(obj["dedup_hash"]);
        }
      } catch {
        // Skip malformed lines
      }
    }
  } catch {
    // File may not exist yet — that's fine
  }
  return hashes;
}

export interface ApplicationEnrichmentResult {
  newEntries: UnifiedApplicationRecord[];
  duplicatesSkipped: number;
  totalParsed: number;
}

export function enrichApplications(
  applications: ParsedApplication[],
  jsonlPath: string,
  dryRun: boolean
): Result<ApplicationEnrichmentResult> {
  const existingHashes = loadExistingHashes(jsonlPath);
  const importedAt = new Date().toISOString();
  const newEntries: UnifiedApplicationRecord[] = [];
  let duplicatesSkipped = 0;

  for (const app of applications) {
    const dedupHash = generateDedupHash(app.companyName, app.jobTitle, app.location);

    if (existingHashes.has(dedupHash)) {
      duplicatesSkipped++;
      continue;
    }

    // Mark as seen to prevent in-batch duplicates
    existingHashes.add(dedupHash);

    const hashPrefix = dedupHash.slice(0, 12);
    const entry: UnifiedApplicationRecord = {
      id: `linkedin-hist-${hashPrefix}`,
      timestamp: app.applicationDate,
      company: app.companyName,
      title: app.jobTitle,
      url: app.jobUrl,
      workflow: "manual",
      match_score: 0,
      resume_variant: "",
      cover_letter: false,
      status: "submitted",
      dedup_hash: dedupHash,
      source: "linkedin_historical",
      location: app.location || "",
      referral_status: "none",
      outcome: null,
      callback_date: null,
      notes: "LinkedIn Easy Apply",
      updated_at: importedAt,
    };

    newEntries.push(entry);
  }

  if (!dryRun && newEntries.length > 0) {
    try {
      const lines = newEntries.map((e) => JSON.stringify(e)).join("\n") + "\n";
      appendFileSync(jsonlPath, lines, "utf-8");
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err : new Error(String(err)),
      };
    }
  }

  return {
    success: true,
    data: {
      newEntries,
      duplicatesSkipped,
      totalParsed: applications.length,
    },
  };
}
