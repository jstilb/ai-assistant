/**
 * Shared by bin/kaya-evals-nightly.ts (writes the marker) and
 * bin/cron-health-monitor.ts (checks it each morning). One definition of "which
 * LA date" and "where the marker lives", so the writer and the checker cannot
 * drift. No side effects at import.
 */
import { join } from 'path';
import { getKayaHome } from '../core/KayaHome.ts';

/** LA-local calendar date (en-CA, YYYY-MM-DD) — the same convention as the manifest's `{date}`. */
export function laDate(now: Date = new Date()): string {
  return now.toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
}

/** LA hour of day, 0-23. */
export function laHour(now: Date = new Date()): number {
  return Number(now.toLocaleString('en-US', { timeZone: 'America/Los_Angeles', hour: 'numeric', hour12: false })) % 24;
}

/**
 * The dated success marker (MEMORY/EVALS/nightly/<date>.md). Written only when a
 * run reached STEP 5. The writer stamps the LA date of the run's END time, so a
 * run that crosses LA midnight marks the NEXT date.
 */
export function nightlyMarkerPath(date: string, kayaHome: string = getKayaHome()): string {
  return join(kayaHome, 'MEMORY', 'EVALS', 'nightly', `${date}.md`);
}
