/**
 * lifeos-label-table-drift.ts — Architecture lint rule (audit finding F5).
 *
 * Rule: every member of `Capture/Router.ts`'s `Label` union must have a
 * matching row in `SKILL.md`'s "## Classification rules" table, and vice
 * versa. The heading's declared label count must match the union's size.
 *
 * Background: SKILL.md's classification-rules table drifted from Router.ts's
 * real `Label` union twice with no mechanism to catch it — the union grew
 * from 11 to 13 members (`FINANCE_TXN`, `NOT_A_CAPTURE` added) while the doc
 * kept saying "11 labels" and never grew a row for either. Nothing tied the
 * doc to the code, so the drift was silent until a manual audit (F5) caught
 * it. This rule is the regression guard: it mechanically parses both sources
 * of truth and diffs them.
 *
 * Required-pattern rule, no grandfathering (unlike no-raw-append.ts's
 * incremental-migration posture) — every Label member must have a row,
 * always, starting now (the doc was brought into sync in the same change
 * that introduced this rule). Full-tree only; there is no meaningful
 * staged-diff mode because this isn't a "did you add a new bad line" check —
 * it's "do the union and the table currently agree", which only makes sense
 * evaluated against the full current content of both files.
 *
 * Used by lib/lint/run-all.ts (`bun lint:architecture`). See
 * bin/lint-lifeos-label-drift.sh for a standalone/manual invocation — it is
 * NOT yet wired into the shared pre-commit hook (that file lives outside any
 * worktree, in the shared `.git/hooks` dir, and worktree sessions must not
 * edit it directly; see the guarded `if [ -x ... ]` precedent for
 * bin/lint-empty-catch-staged.sh / bin/lint-hook-guard-staged.sh for how a
 * future integrator can add a Stage N block once this rule lands on main).
 */

import { readFileSync } from 'fs';
import { join } from 'path';

export interface LintResult {
  errors: string[];
  warnings: string[];
}

const DEFAULT_ROUTER_REL = 'skills/Productivity/LifeOS/Capture/Router.ts';
const DEFAULT_SKILL_REL = 'skills/Productivity/LifeOS/SKILL.md';

const LABEL_UNION_RE = /export type Label\s*=([\s\S]*?);/;
const LABEL_MEMBER_RE = /"([A-Z][A-Z0-9_]*)"/g;
const CLASSIFICATION_HEADING_RE = /^## Classification rules\b.*$/m;
const NEXT_HEADING_RE = /\n##\s/;
const TABLE_ROW_LABEL_RE = /^\|\s*`([A-Z][A-Z0-9_]*)`\s*\|/gm;
const HEADING_COUNT_RE = /## Classification rules \((\d+)\s+labels?\b/;

/**
 * Parse the exact member list of Router.ts's `export type Label = | "X" |
 * "Y" ...;` union, in declaration order. Returns [] if the union's shape
 * can't be found (caller treats that as a hard parse failure, not "zero
 * labels").
 */
export function parseLabelUnion(routerSource: string): string[] {
  const match = LABEL_UNION_RE.exec(routerSource);
  if (!match) return [];
  const block = match[1];
  const labels: string[] = [];
  let m: RegExpExecArray | null;
  LABEL_MEMBER_RE.lastIndex = 0;
  while ((m = LABEL_MEMBER_RE.exec(block))) labels.push(m[1]);
  return labels;
}

/**
 * Parse the label column of every row in SKILL.md's "## Classification
 * rules" table (bounded by the next "## " heading, or end of file). A row is
 * recognized by its first cell being a backtick-quoted ALL_CAPS identifier —
 * the same convention every existing row already uses.
 */
export function parseClassificationTableLabels(skillSource: string): string[] {
  const headingMatch = CLASSIFICATION_HEADING_RE.exec(skillSource);
  if (!headingMatch) return [];
  const rest = skillSource.slice(headingMatch.index + headingMatch[0].length);
  const nextHeadingMatch = NEXT_HEADING_RE.exec(rest);
  const section = nextHeadingMatch ? rest.slice(0, nextHeadingMatch.index) : rest;
  const labels: string[] = [];
  let m: RegExpExecArray | null;
  TABLE_ROW_LABEL_RE.lastIndex = 0;
  while ((m = TABLE_ROW_LABEL_RE.exec(section))) labels.push(m[1]);
  return labels;
}

/**
 * Compare a Router.ts source string against a SKILL.md source string.
 * Pure function — no filesystem access — so tests can feed synthetic
 * fixtures directly without touching the real repo files.
 */
export function diffLabelsAgainstTable(routerSource: string, skillSource: string): LintResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  const unionLabels = parseLabelUnion(routerSource);
  if (unionLabels.length === 0) {
    errors.push(
      'lifeos-label-table-drift: could not parse `export type Label = ...;` union from Router.ts ' +
        '(0 members found). Has the union\'s shape changed? Update the parser in ' +
        'lib/lint/lifeos-label-table-drift.ts if so.',
    );
    return { errors, warnings };
  }

  const tableLabels = parseClassificationTableLabels(skillSource);
  if (tableLabels.length === 0) {
    errors.push(
      'lifeos-label-table-drift: found no label rows under SKILL.md\'s "## Classification rules" ' +
        'table (0 rows found). Has the heading text or table shape changed? Update the parser in ' +
        'lib/lint/lifeos-label-table-drift.ts if so.',
    );
    return { errors, warnings };
  }

  const tableSet = new Set(tableLabels);
  const unionSet = new Set(unionLabels);

  const missing = unionLabels.filter((l) => !tableSet.has(l));
  const extra = [...new Set(tableLabels.filter((l) => !unionSet.has(l)))];

  if (missing.length > 0) {
    errors.push(
      `lifeos-label-table-drift: Router.ts's Label union has member(s) with no row in SKILL.md's ` +
        `classification-rules table: ${missing.join(', ')}. Add a row (Label | Destination | ` +
        `Confirmation) for each to skills/Productivity/LifeOS/SKILL.md.`,
    );
  }
  if (extra.length > 0) {
    errors.push(
      `lifeos-label-table-drift: SKILL.md's classification-rules table has row(s) for label(s) not ` +
        `present in Router.ts's Label union: ${extra.join(', ')}. Remove the stale row(s), or the ` +
        `label was renamed/typo'd — check both sides.`,
    );
  }

  const headingCountMatch = HEADING_COUNT_RE.exec(skillSource);
  if (headingCountMatch) {
    const declared = parseInt(headingCountMatch[1], 10);
    if (declared !== unionLabels.length) {
      errors.push(
        `lifeos-label-table-drift: SKILL.md's "## Classification rules" heading declares ` +
          `${declared} label(s) but Router.ts's Label union currently has ${unionLabels.length}. ` +
          `Update the heading count.`,
      );
    }
  } else {
    warnings.push(
      'lifeos-label-table-drift: could not find a "(<N> labels ...)" count in the ' +
        '"## Classification rules" heading to cross-check against the union size.',
    );
  }

  return { errors, warnings };
}

export interface LifeOSLabelDriftPaths {
  routerPath?: string;
  skillPath?: string;
}

/**
 * Full-tree entry point — reads the real (or overridden, for tests) files
 * off disk and diffs them. Used by lib/lint/run-all.ts.
 */
export async function checkLifeOSLabelTableDrift(
  rootDir: string = process.cwd(),
  paths: LifeOSLabelDriftPaths = {},
): Promise<LintResult> {
  const routerPath = paths.routerPath ?? join(rootDir, DEFAULT_ROUTER_REL);
  const skillPath = paths.skillPath ?? join(rootDir, DEFAULT_SKILL_REL);

  let routerSource: string;
  try {
    routerSource = readFileSync(routerPath, 'utf-8');
  } catch (err) {
    return {
      errors: [`lifeos-label-table-drift: could not read ${routerPath}: ${(err as Error).message}`],
      warnings: [],
    };
  }

  let skillSource: string;
  try {
    skillSource = readFileSync(skillPath, 'utf-8');
  } catch (err) {
    return {
      errors: [`lifeos-label-table-drift: could not read ${skillPath}: ${(err as Error).message}`],
      warnings: [],
    };
  }

  return diffLabelsAgainstTable(routerSource, skillSource);
}

/** CLI: `bun lib/lint/lifeos-label-table-drift.ts` — human-readable report. */
if (import.meta.main) {
  const result = await checkLifeOSLabelTableDrift();
  for (const w of result.warnings) console.warn(`WARN: ${w}`);
  for (const e of result.errors) console.error(`ERROR: ${e}`);
  if (result.errors.length === 0) console.log('lifeos-label-table-drift: OK — Label union and SKILL.md table are in sync.');
  process.exit(result.errors.length > 0 ? 1 : 0);
}
