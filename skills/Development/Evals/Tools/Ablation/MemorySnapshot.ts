/**
 * MemorySnapshot.ts — fail-closed copy of auto-memory with eval-describing notes dropped.
 *
 * COPIED from the Eval Lab (Lab/Isolation.ts, section 2 "Memory exclusion") on 2026-10-23.
 * The Eval Lab now lives at /Users/[user]/projects/eval-lab. This copy exists only because
 * Ablation/ProfileBuilder.ts still calls snapshotMemory; it goes away when Ablation is
 * retired (slice 12). Do not extend it. The body below is byte-for-byte from the lab.
 */

import { createHash } from 'crypto';
import {
  copyFileSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync,
} from 'fs';
import { basename, join } from 'path';

// ---------------------------------------------------------------------------
// 2. Memory exclusion
// ---------------------------------------------------------------------------

export interface MemoryMarker {
  id: string;
  /** Only counts when the text ALSO matches this (co-occurrence rule). */
  alsoRequires?: RegExp;
  /** A bare project-name mention: drops a whole note but never trims an index line on its own. */
  indexExempt?: boolean;
  /** Case-insensitive. Word separators ('-', '_', ' ') are interchangeable. */
  pattern: RegExp;
}

/**
 * Notes (or index lines) that describe the evals, their tasks or where the
 * bank lives. Matching is case-insensitive over file NAME + content.
 * Deliberately NOT a bare "bakeoff" / "eval": those match unrelated notes.
 * Known collateral: `Evals/UseCases` also hits notes about other skills' live
 * evals (e.g. project_eventscout_gotchas.md) — conservative by design; the
 * manifest lists every drop so a human can audit.
 */
export const MEMORY_EXCLUSION_MARKERS: readonly MemoryMarker[] = [
  { id: 'eval-lab', pattern: /eval[-_ ]lab/i },
  { id: 'scratch-eval-lab', pattern: /\.scratch\/eval-lab/i },
  { id: 'ablation', pattern: /ablation/i }, // also covers setup-ablation, AblationRunner
  { id: 'ablation-runner', pattern: /AblationRunner/i },
  { id: 'harness-bakeoff', pattern: /harness[-_ ]bakeoff/i, indexExempt: true },
  { id: 'evals-usecases', pattern: /Evals\/UseCases/i, alsoRequires: /ablation|eval[-_ ]lab/i },
  { id: 'evals-suites', pattern: /Evals\/Suites/i, alsoRequires: /ablation|eval[-_ ]lab/i },
  { id: 'task-bank-path', pattern: /eval-lab\/bank/i },
  { id: 'run-dir-path', pattern: /runtime\/eval-lab/i },
];

/** Stable hash of the marker list (spec rule 9: recorded in every manifest). */
export const MEMORY_EXCLUSION_MARKERS_HASH: string = createHash('sha256')
  .update(MEMORY_EXCLUSION_MARKERS.map(m => `${m.id}\t${m.pattern.source}\t${m.pattern.flags}\t${m.alsoRequires?.source ?? ''}\t${m.indexExempt ?? false}`).join('\n'))
  .digest('hex');

function markerHits(text: string): MemoryMarker[] {
  return MEMORY_EXCLUSION_MARKERS.filter(m => m.pattern.test(text) && (!m.alsoRequires || m.alsoRequires.test(text)));
}

export function matchesMemoryMarker(text: string): string[] {
  return markerHits(text).map(m => m.id);
}

/** MEMORY.md and index_*.md are indexes: trim matching lines, keep the rest. */
export function isMemoryIndexFile(fileName: string): boolean {
  return fileName === 'MEMORY.md' || /^index_.*\.md$/.test(fileName);
}

export interface MemoryExclusionReport {
  marker_list_sha256: string;
  marker_ids: string[];
  /** Whole notes removed (path relative to the memory dir) + the markers that hit. */
  excluded_files: { file: string; markers: string[] }[];
  /** Index files whose matching lines were removed. */
  trimmed_files: { file: string; lines_removed: number }[];
  /** Entries NOT copied because they are not plain `.md` notes (dot-dirs such as .git, backups, other types). */
  skipped_entries: string[];
}

function listMarkdown(dir: string, rel = ''): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(join(dir, rel)).sort()) {
    const relPath = rel ? join(rel, entry) : entry;
    const st = lstatSync(join(dir, relPath));
    if (st.isDirectory()) out.push(...listMarkdown(dir, relPath));
    else if (entry.endsWith('.md')) out.push(relPath);
  }
  return out;
}

const BACKUP_NAME = /\.bak|~$|\.orig$|\.swp$/i;

/**
 * Fail-closed copy of a live memory dir: ONLY regular `.md` notes (files, or
 * symlinks to files, dereferenced) in non-dot directories are copied.
 * Everything else — `.git` (whose history still holds dropped notes), any
 * dot-dir/dot-file, `*.bak*` backups, other file types — is skipped and listed.
 * Then the marker filter runs on the copy. Never touches `srcDir`.
 */
export function snapshotMemory(srcDir: string, destDir: string): MemoryExclusionReport {
  const skipped: string[] = [];
  const walk = (rel: string): void => {
    for (const entry of readdirSync(join(srcDir, rel)).sort()) {
      const relPath = rel ? join(rel, entry) : entry;
      const full = join(srcDir, relPath);
      if (entry.startsWith('.') || BACKUP_NAME.test(entry)) { skipped.push(relPath); continue; }
      let st;
      try { st = statSync(full); } catch { skipped.push(relPath); continue; } // dangling symlink
      if (st.isDirectory()) walk(relPath);
      else if (st.isFile() && entry.endsWith('.md')) {
        mkdirSync(join(destDir, rel), { recursive: true });
        copyFileSync(full, join(destDir, relPath));
      } else skipped.push(relPath);
    }
  };
  mkdirSync(destDir, { recursive: true });
  walk('');
  const report = filterMemorySnapshot(destDir);
  report.skipped_entries = skipped;
  return report;
}

/**
 * Apply the exclusion rules IN PLACE to a COPY of auto-memory (never pass the
 * live dir: this deletes files). Pass 1 drops whole non-index notes whose name
 * or content matches. Pass 2 trims index files: lines that match a marker, and
 * lines that link to a note dropped in pass 1 (so no dangling pointers).
 */
export function filterMemorySnapshot(memoryCopyDir: string): MemoryExclusionReport {
  const report: MemoryExclusionReport = {
    marker_list_sha256: MEMORY_EXCLUSION_MARKERS_HASH,
    marker_ids: MEMORY_EXCLUSION_MARKERS.map(m => m.id),
    excluded_files: [],
    trimmed_files: [],
    skipped_entries: [],
  };
  const files = listMarkdown(memoryCopyDir);
  const droppedNames: string[] = [];

  for (const rel of files) {
    if (isMemoryIndexFile(basename(rel))) continue;
    const full = join(memoryCopyDir, rel);
    const hits = matchesMemoryMarker(`${rel}\n${readFileSync(full, 'utf-8')}`);
    if (hits.length) {
      rmSync(full); // a single file in the snapshot copy
      report.excluded_files.push({ file: rel, markers: hits });
      droppedNames.push(basename(rel, '.md'));
    }
  }

  for (const rel of files) {
    if (!isMemoryIndexFile(basename(rel))) continue;
    const full = join(memoryCopyDir, rel);
    const lines = readFileSync(full, 'utf-8').split('\n');
    const kept = lines.filter(line =>
      !markerHits(line).some(m => !m.indexExempt) && !droppedNames.some(n => line.includes(n)));
    const removed = lines.length - kept.length;
    if (removed > 0) {
      writeFileSync(full, kept.join('\n'), 'utf-8');
      report.trimmed_files.push({ file: rel, lines_removed: removed });
    }
  }
  return report;
}

