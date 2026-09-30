/**
 * allow-tally.ts — Track daily security allow event counts
 *
 * Creates: ~/.claude/MEMORY/SECURITY/YYYY/MM/DD-allow-tally.json
 * Format: { "Bash": 42, "Edit": 12, ... }
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { getKayaHome } from '../../lib/core/KayaHome.ts';

function getMemoryRoot(): string {
  return process.env.KAYA_MEMORY_ROOT ?? join(getKayaHome(), 'MEMORY');
}

function getTallyPath(date: Date): string {
  const year = date.getFullYear().toString();
  const month = (date.getMonth() + 1).toString().padStart(2, '0');
  const day = date.getDate().toString().padStart(2, '0');

  return join(
    getMemoryRoot(),
    'SECURITY',
    year,
    month,
    `${day}-allow-tally.json`
  );
}

/**
 * Increment daily allow tally for a given tool
 * Never throws - write failures are swallowed silently
 */
export function incrementAllowTally(toolName: string): void {
  try {
    const now = new Date();
    const tallyPath = getTallyPath(now);
    const dir = tallyPath.substring(0, tallyPath.lastIndexOf('/'));

    // Ensure directory exists
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    // Read existing tally or start fresh
    let tally: Record<string, number> = {};
    if (existsSync(tallyPath)) {
      try {
        tally = JSON.parse(readFileSync(tallyPath, 'utf-8'));
      } catch (err) {
        // Parse error — start fresh
        console.error(`[allow-tally] failed to parse existing tally file, starting fresh: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    // Increment
    tally[toolName] = (tally[toolName] ?? 0) + 1;

    // Write back
    writeFileSync(tallyPath, JSON.stringify(tally, null, 2));
  } catch (err) {
    // Swallow write errors — tally is best-effort
    console.error(`[allow-tally] tally read/write failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}
