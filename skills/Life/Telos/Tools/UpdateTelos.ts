#!/usr/bin/env bun
/**
 * update-telos - Update TELOS life context with automatic backups and change tracking
 *
 * This command manages updates to the TELOS life context files, ensuring:
 * - Automatic timestamped backups before any modification
 * - Change tracking in updates.md
 * - Complete version history
 *
 * Usage:
 *   update-telos <file> "<content>" "<change-description>"
 *
 * Example:
 *   update-telos BELIEFS.md "- B7: Determinism must earn its place" "Added belief B7"
 *
 * Files that can be updated (see VALID_FILES below):
 * - BELIEFS.md - Core beliefs and world model
 * - CHALLENGES.md - Current challenges
 * - FRAMES.md - Mental frames and perspectives
 * - GOALS.md - Life goals
 * - MISSIONS.md - Life missions (M0-M6)
 * - MODELS.md - Mental models
 * - NARRATIVES.md - Personal narratives
 * - PROBLEMS.md - Problems to solve
 * - PROJECTS.md - Active projects
 * - STATUS.md - Current state across life areas
 * - STRATEGIES.md - Strategies being employed
 */

import { readFileSync, writeFileSync, copyFileSync, existsSync, renameSync } from 'fs';
import { join } from 'path';
import { getKayaHome } from '../../../../lib/core/KayaHome.ts';

const KAYA_HOME = getKayaHome();
const TELOS_DIR = join(KAYA_HOME, 'USER', 'TELOS');
const BACKUPS_DIR = join(TELOS_DIR, 'backups');
const UPDATES_FILE = join(TELOS_DIR, 'updates.md');

if (!existsSync(TELOS_DIR)) {
  console.error(`[UpdateTelos] TELOS directory not found: ${TELOS_DIR}`);
  console.error(`Expected at ~/.claude/USER/TELOS/ — check KAYA_HOME env var`);
  process.exit(1);
}

// Valid TELOS files
// Unfilled scaffolds (BOOKS, IDEAS, LEARNED, MOVIES, PREDICTIONS, TRAUMAS, WISDOM,
// WRONG) were deleted 2026-09-21 and TELOS.md/MISSION.md on 2026-09-12 (context-
// pollution audit); re-add a file here only after it exists with real content.
const VALID_FILES = [
  'BELIEFS.md', 'CHALLENGES.md', 'FRAMES.md', 'GOALS.md', 'MISSIONS.md',
  'MODELS.md', 'NARRATIVES.md', 'PROBLEMS.md', 'PROJECTS.md', 'STATUS.md',
  'STRATEGIES.md'
];

const MAX_CONTENT_LENGTH = 10_000;

const PROTECTED_HEADERS = [
  /^##\s+Security Rules/m,
  /^##\s+Guiding Principles/m,
  /^##\s+Identity/m,
  /^##\s+Response Format/m,
];

function sanitizeContent(raw: string): string {
  if (raw.length > MAX_CONTENT_LENGTH) {
    throw new Error(`Content too long: ${raw.length} chars (max ${MAX_CONTENT_LENGTH})`);
  }
  // Strip C0 control characters except tab, newline, carriage return
  const stripped = raw.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');
  // Reject content containing protected CLAUDE.md section headers
  for (const pattern of PROTECTED_HEADERS) {
    if (pattern.test(stripped)) {
      throw new Error(
        `Content rejected: contains a protected section header matching "${pattern.source}". ` +
        `TELOS content must not replicate CLAUDE.md behavioral rule headings.`
      );
    }
  }
  return stripped;
}

function getLocalizedDateParts(): { year: number; month: string; day: string; hours: string; minutes: string; seconds: string } {
  const now = new Date();
  const timezone = process.env.KAYA_TZ || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  const localTime = new Date(now.toLocaleString('en-US', { timeZone: timezone }));

  return {
    year: localTime.getFullYear(),
    month: String(localTime.getMonth() + 1).padStart(2, '0'),
    day: String(localTime.getDate()).padStart(2, '0'),
    hours: String(localTime.getHours()).padStart(2, '0'),
    minutes: String(localTime.getMinutes()).padStart(2, '0'),
    seconds: String(localTime.getSeconds()).padStart(2, '0'),
  };
}

function getPacificTimestamp(): string {
  const { year, month, day, hours, minutes, seconds } = getLocalizedDateParts();
  return `${year}${month}${day}-${hours}${minutes}${seconds}`;
}

function getPacificDateForLog(): string {
  const { year, month, day, hours, minutes, seconds } = getLocalizedDateParts();
  return `${year}-${month}-${day} ${hours}:${minutes}:${seconds} PT`;
}

async function main() {
  const args = process.argv.slice(2);

  if (args.length < 3) {
    console.error('❌ Usage: update-telos <file> "<content>" "<change-description>"');
    console.error('\nExample: update-telos BELIEFS.md "- B7: New belief" "Added belief B7"');
    console.error('\nValid files:', VALID_FILES.join(', '));
    process.exit(1);
  }

  const [filename, rawContent, changeDescription] = args;

  // Validate and sanitize content
  let sanitizedContent: string;
  try {
    sanitizedContent = sanitizeContent(rawContent);
  } catch (error) {
    console.error(`❌ Content validation failed: ${error}`);
    process.exit(1);
  }

  // Validate filename
  if (!VALID_FILES.includes(filename)) {
    console.error(`❌ Invalid file: ${filename}`);
    console.error(`Valid files: ${VALID_FILES.join(', ')}`);
    process.exit(1);
  }

  // GOALS.md is a GENERATED artifact (markdown-regex remediation option (b),
  // 2026-08-02) — a direct write here would be clobbered by the next
  // regeneration, silently losing the edit.
  if (filename === 'GOALS.md') {
    console.error('❌ GOALS.md is generated from USER/TELOS/goals.yaml — direct edits get clobbered.');
    console.error('   Edit goals.yaml instead, then regenerate:');
    console.error('   bun ~/.claude/skills/Life/Telos/Tools/GenerateGoalsMd.ts');
    process.exit(1);
  }

  const targetFile = join(TELOS_DIR, filename);

  // Check if file exists
  if (!existsSync(targetFile)) {
    console.error(`❌ File does not exist: ${targetFile}`);
    process.exit(1);
  }

  // Step 1: Create timestamped backup
  const timestamp = getPacificTimestamp();
  const backupFilename = filename.replace('.md', `-${timestamp}.md`);
  const backupPath = join(BACKUPS_DIR, backupFilename);

  try {
    copyFileSync(targetFile, backupPath);
    console.log(`✅ Backup created: ${backupFilename}`);
  } catch (error) {
    console.error(`❌ Failed to create backup: ${error}`);
    process.exit(1);
  }

  // Step 2: Update the target file (append content) using atomic write
  try {
    const currentContent = readFileSync(targetFile, 'utf-8');
    const updatedContent = currentContent.trimEnd() + '\n' + sanitizedContent + '\n';
    const tmpPath = targetFile + '.tmp';
    writeFileSync(tmpPath, updatedContent, 'utf-8');
    try {
      renameSync(tmpPath, targetFile);
    } catch (renameError) {
      console.error(`[UpdateTelos] Write failed: ${renameError}. Attempting restore from backup...`);
      try {
        copyFileSync(backupPath, targetFile);
        console.log(`[UpdateTelos] Restored from backup: ${backupFilename}`);
      } catch (restoreError) {
        console.error(`[UpdateTelos] Restore also failed: ${restoreError}. Manual recovery needed. Backup at: ${backupPath}`);
      }
      process.exit(1);
    }
    console.log(`✅ Updated: ${filename}`);
  } catch (error) {
    console.error(`❌ Failed to update file: ${error}`);
    process.exit(1);
  }

  // Step 3: Update updates.md with change log
  try {
    const logTimestamp = getPacificDateForLog();
    const logEntry = `
## ${logTimestamp}

- **File Modified**: ${filename}
- **Change Type**: Content Addition
- **Description**: ${changeDescription}
- **Backup Location**: \`backups/${backupFilename}\`

`;

    const updatesContent = readFileSync(UPDATES_FILE, 'utf-8');

    // Insert the new entry after "## Future Changes" section
    const futureChangesMarker = '## Future Changes';
    const insertPosition = updatesContent.indexOf(futureChangesMarker);

    if (insertPosition !== -1) {
      const beforeMarker = updatesContent.substring(0, insertPosition + futureChangesMarker.length);
      const afterMarker = updatesContent.substring(insertPosition + futureChangesMarker.length);

      // Find the end of the "Document all changes below..." line
      const nextLineBreak = afterMarker.indexOf('\n');
      const headerSection = afterMarker.substring(0, nextLineBreak + 1);
      const changesList = afterMarker.substring(nextLineBreak + 1);

      const updatedUpdates = beforeMarker + headerSection + logEntry + changesList;
      writeFileSync(UPDATES_FILE, updatedUpdates, 'utf-8');
      console.log(`✅ Change logged in updates.md`);
    } else {
      console.warn('[UpdateTelos] Warning: "## Future Changes" marker not found in updates.md — appending at end');
      const updatedUpdates = updatesContent.trimEnd() + '\n' + logEntry;
      writeFileSync(UPDATES_FILE, updatedUpdates, 'utf-8');
      console.log(`✅ Change logged in updates.md (appended)`);
    }
  } catch (error) {
    console.error(`❌ Failed to update updates.md: ${error}`);
    process.exit(1);
  }

  console.log('\n🎯 TELOS update complete!');
  console.log(`   File: ${filename}`);
  console.log(`   Backup: backups/${backupFilename}`);
  console.log(`   Change: ${changeDescription}`);
}

main();
