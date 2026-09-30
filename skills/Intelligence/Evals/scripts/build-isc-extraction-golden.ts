#!/usr/bin/env bun
/**
 * build-isc-extraction-golden.ts
 *
 * Slice 4: ISC-Extraction-Fidelity golden builder.
 *
 * Pure TypeScript — NO LLM calls. Reads all 25 fixture files from
 *   Data/golden-isc-fixtures/*.json
 * and emits one JSONL line per fixture to:
 *   Data/golden/isc-extraction-golden.jsonl
 *
 * Output schema per line:
 *   {
 *     "specId": "<filename-without-.json>",
 *     "rowCount": <number>,
 *     "rowDescriptions": ["<first 8 row descriptions>"],
 *     "source": "golden-isc-fixture"
 *   }
 *
 * rowDescriptions is taken from each row's `description` field (first 8 rows only).
 * Rows without a `description` field fall back to `number` (as string) or `id`.
 *
 * Usage:
 *   bun skills/Intelligence/Evals/scripts/build-isc-extraction-golden.ts
 *   bun skills/Intelligence/Evals/scripts/build-isc-extraction-golden.ts --dry-run
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'fs';
import { join, dirname, basename } from 'path';

// ── Config ────────────────────────────────────────────────────────────────────

const FIXTURES_DIR = join(import.meta.dir, '../Data/golden-isc-fixtures');
const OUTPUT_PATH  = join(import.meta.dir, '../Data/golden/isc-extraction-golden.jsonl');
const MAX_ROW_DESCRIPTIONS = 8;

// ── Types ─────────────────────────────────────────────────────────────────────

interface FixtureRow {
  number?: number;
  id?: string | number;
  description?: string;
  verifyMethod?: string;
  source?: string;
  [key: string]: unknown;
}

interface FixtureFile {
  specPath?: string;
  layoutNote?: string;
  rowCount: number;
  rows: FixtureRow[];
  generatedAt?: string;
}

interface GoldenEntry {
  specId: string;
  rowCount: number;
  rowDescriptions: string[];
  source: 'golden-isc-fixture';
}

// ── Helper: extract best description from a row ────────────────────────────────

function extractRowDescription(row: FixtureRow): string {
  // Prefer `description` field
  if (typeof row.description === 'string' && row.description.trim().length > 0) {
    // Truncate to 120 chars to keep JSONL lines manageable
    const desc = row.description.trim();
    return desc.length > 120 ? desc.slice(0, 117) + '...' : desc;
  }

  // Fall back to `id` or `number`
  if (row.id !== undefined) {
    return String(row.id);
  }
  if (row.number !== undefined) {
    return String(row.number);
  }

  // Last resort: first non-empty string value
  for (const [key, val] of Object.entries(row)) {
    if (typeof val === 'string' && val.trim().length > 0) {
      return `${key}:${val.trim().slice(0, 80)}`;
    }
  }

  return '(unnamed row)';
}

// ── Main ──────────────────────────────────────────────────────────────────────

const isDryRun = process.argv.includes('--dry-run');

// 1. Discover all fixture files
if (!existsSync(FIXTURES_DIR)) {
  console.error(`ERROR: Fixtures directory not found: ${FIXTURES_DIR}`);
  process.exit(1);
}

const fixtureFiles = readdirSync(FIXTURES_DIR)
  .filter(f => f.endsWith('.json'))
  .sort();

console.log(`\n=== ISC Extraction Golden Builder ===`);
console.log(`Fixtures: ${FIXTURES_DIR}`);
console.log(`Found: ${fixtureFiles.length} fixture files`);
console.log(`Output: ${OUTPUT_PATH}`);
console.log(`Mode: ${isDryRun ? 'DRY-RUN (no file writes)' : 'LIVE'}\n`);

if (fixtureFiles.length === 0) {
  console.error('ERROR: No fixture files found. Expected *.json in fixtures dir.');
  process.exit(1);
}

// 2. Process each fixture
const lines: string[] = [];
const errors: string[] = [];
let totalRows = 0;
let richCount = 0; // rowCount > 4

for (const filename of fixtureFiles) {
  const specId = basename(filename, '.json');
  const filePath = join(FIXTURES_DIR, filename);

  let fixture: FixtureFile;
  try {
    const raw = readFileSync(filePath, 'utf-8');
    fixture = JSON.parse(raw) as FixtureFile;
  } catch (e) {
    const msg = `Failed to parse ${filename}: ${e}`;
    errors.push(msg);
    console.warn(`  SKIP ${specId}: ${msg}`);
    continue;
  }

  // Validate required fields
  if (typeof fixture.rowCount !== 'number') {
    const msg = `Missing rowCount in ${filename}`;
    errors.push(msg);
    console.warn(`  SKIP ${specId}: ${msg}`);
    continue;
  }

  if (!Array.isArray(fixture.rows)) {
    const msg = `Missing rows array in ${filename}`;
    errors.push(msg);
    console.warn(`  SKIP ${specId}: ${msg}`);
    continue;
  }

  // Extract up to 8 row descriptions
  const rowDescriptions = fixture.rows
    .slice(0, MAX_ROW_DESCRIPTIONS)
    .map(row => extractRowDescription(row));

  const entry: GoldenEntry = {
    specId,
    rowCount: fixture.rowCount,
    rowDescriptions,
    source: 'golden-isc-fixture',
  };

  lines.push(JSON.stringify(entry));
  totalRows += fixture.rowCount;

  if (fixture.rowCount > 4) {
    richCount++;
  }

  console.log(
    `  ✓ ${specId.padEnd(45)} rowCount=${String(fixture.rowCount).padStart(3)}  rows_len=${fixture.rows.length}  layout="${fixture.layoutNote ?? 'unknown'}"`,
  );
}

// 3. Report summary
console.log(`\n=== Summary ===`);
console.log(`Processed:       ${lines.length} fixtures (${errors.length} skipped)`);
console.log(`Total rows:      ${totalRows}`);
console.log(`With rowCount>4: ${richCount} fixtures`);
console.log(`Row distribution:`);
const buckets = { '0-4': 0, '5-9': 0, '10-14': 0, '15-19': 0, '20+': 0 };
for (const line of lines) {
  const entry = JSON.parse(line) as GoldenEntry;
  const rc = entry.rowCount;
  if (rc <= 4) buckets['0-4']++;
  else if (rc <= 9) buckets['5-9']++;
  else if (rc <= 14) buckets['10-14']++;
  else if (rc <= 19) buckets['15-19']++;
  else buckets['20+']++;
}
for (const [range, count] of Object.entries(buckets)) {
  if (count > 0) console.log(`  ${range.padEnd(6)}: ${count}`);
}

if (errors.length > 0) {
  console.log(`\nErrors:`);
  errors.forEach(e => console.log(`  - ${e}`));
}

if (isDryRun) {
  console.log('\nDRY-RUN: no file written.');
  process.exit(0);
}

// 4. Write output
const outputDir = dirname(OUTPUT_PATH);
if (!existsSync(outputDir)) {
  mkdirSync(outputDir, { recursive: true });
}

writeFileSync(OUTPUT_PATH, lines.join('\n') + '\n', 'utf-8');
console.log(`\nWrote ${lines.length} lines to: ${OUTPUT_PATH}`);

if (lines.length !== 25) {
  console.warn(`WARNING: Expected 25 lines, got ${lines.length}.`);
  process.exit(1);
}

console.log('Done.');
