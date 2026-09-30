/**
 * no-empty-catch.ts — Architecture lint rule.
 *
 * Rule: Ban NEW empty/comment-only `catch` blocks introduced in staged
 * changes under hooks/ or lib/.
 *
 * Background: the 2026-07 `let-the-model-speak` S12 slice swept ~50
 * pre-existing empty/comment-only catch blocks in hooks/ (`catch {}` /
 * `catch (e) {}` with no real statement in the body) and gave each one a
 * one-line breadcrumb (`console.error(...)` or `recordFailure(...)`) — fail
 * -open behavior is unchanged, but a swallowed failure now leaves a trace.
 * A small number of sites were left deliberately silent (either because
 * breadcrumbing them would fire on every normal run — an optional local
 * service being absent, a lock-file race that is the expected outcome of
 * concurrent use — or because the catch guards the logging call itself,
 * where breadcrumbing would just be a log-about-a-log). Those sites carry
 * an explicit `// intentionally silent: <reason>` marker comment instead.
 *
 * This rule is the regression guard for that sweep: no future staged commit
 * may introduce a *new* empty/comment-only catch block in hooks/ or lib/
 * without either (a) a real breadcrumb statement in the body, or (b) the
 * `intentionally silent` marker comment as an explicit escape hatch.
 *
 * Only one mode exists — `checkNoEmptyCatchStaged` — unlike sibling rules
 * that also register a full-tree scan with lib/lint/run-all.ts. A full-tree
 * scan of hooks/ + lib/ would immediately surface pre-existing violations
 * outside hooks/ (lib/ was not swept this slice — only hooks/ was audited),
 * breaking unrelated commits on first use. Wiring a full-tree grandfather
 * scan is left to a future sweep of lib/ proper; this rule only prevents
 * *new* regressions via the staged-diff path, exactly like
 * no-raw-append.ts's incremental-migration posture.
 *
 * Detection approach: for each hunk in the staged diff (`git diff --cached
 * -U0`), only the ADDED ('+') lines are considered, in order, per hunk. A
 * `catch { ... }` construct is flagged only if BOTH its opening `catch {`
 * and its matching closing `}` appear among the added lines of that same
 * hunk — i.e. the whole clause is new. This means:
 *   - A brand new `catch {}` (or `catch { /* comment only *\/ }`) block is
 *     flagged.
 *   - An existing catch block that is merely moved, or whose surrounding
 *     code shifted without touching the catch's own lines, is NOT flagged
 *     (its lines remain untouched context, invisible to a `-U0` diff).
 *   - Editing only a comment string INSIDE an existing (grandfathered)
 *     catch, without touching its opening/closing brace lines, is NOT
 *     flagged either — the added line(s) alone don't parse as a complete
 *     catch clause. This keeps the rule scoped to genuinely NEW blocks, per
 *     the sweep's design brief ("must not flag existing code merely being
 *     moved/context-shifted").
 *
 * Used by pre-commit (bin/lint-empty-catch-staged.sh).
 */

import { execSync } from 'child_process';

export interface LintResult {
  errors: string[];
  warnings: string[];
}

const TEST_PATTERN = /\.(test|spec)\.(ts|tsx)$|__tests__\//;
const SCOPE_PATTERN = /^(hooks|lib)\//;
const SILENT_MARKER = /intentionally silent/i;

// Matches `catch {`, `catch (e) {`, `catch (e: unknown) {` — same shape used
// by the S12 sweep's census script.
const CATCH_OPEN = /catch\s*(\([^)]*\))?\s*\{/g;

function isExempt(relativePath: string): boolean {
  // Only TypeScript sources can contain a real catch block — prose/docs files
  // with catch-shaped example text must never be flagged (verifier-found
  // false positive: a .md staged alongside a real .ts change was scanned).
  if (!relativePath.endsWith('.ts')) return true;
  if (!SCOPE_PATTERN.test(relativePath)) return true;
  if (TEST_PATTERN.test(relativePath)) return true;
  if (relativePath.includes('node_modules/') || relativePath.includes('worktrees/')) return true;
  if (relativePath.includes('lib/lint/')) return true; // this rule's own source
  return false;
}

function isEmptyOrCommentOnlyBody(body: string): boolean {
  const stripped = body.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '').trim();
  return stripped.length === 0;
}

/**
 * Scan a block of consecutively-ADDED lines (already stripped of their `+`
 * prefix, joined with '\n') for fully-contained empty/comment-only catch
 * clauses lacking the intentionally-silent marker. Returns 0-based line
 * offsets (within `addedText`) of each violating catch's opening line.
 */
function findViolatingCatchOffsets(addedText: string): number[] {
  const offsets: number[] = [];
  let match: RegExpExecArray | null;
  CATCH_OPEN.lastIndex = 0;
  while ((match = CATCH_OPEN.exec(addedText))) {
    const braceStart = match.index + match[0].length - 1;
    let depth = 1;
    let i = braceStart + 1;
    while (i < addedText.length && depth > 0) {
      if (addedText[i] === '{') depth++;
      else if (addedText[i] === '}') depth--;
      i++;
    }
    if (depth !== 0) {
      // Closing brace not found within the added-lines text — the block is
      // only partially new (its close is unchanged context), so it isn't a
      // fully-new clause. Skip.
      continue;
    }
    const body = addedText.slice(braceStart + 1, i - 1);
    if (isEmptyOrCommentOnlyBody(body) && !SILENT_MARKER.test(body)) {
      const lineOffset = addedText.slice(0, match.index).split('\n').length - 1;
      offsets.push(lineOffset);
    }
  }
  return offsets;
}

function violationMessage(relativePath: string, lineNum: number): string {
  return (
    `${relativePath}:${lineNum}: new empty/comment-only catch block introduced. ` +
    `Add a one-line breadcrumb (console.error(...) or recordFailure(...)) so the ` +
    `swallowed failure isn't invisible, or mark it \`// intentionally silent: <reason>\` ` +
    `if breadcrumbing would fire on every normal run.`
  );
}

/**
 * Diff-based scan: only flags empty/comment-only catch blocks whose entire
 * clause (opening `catch {` through matching `}`) consists of lines ADDED
 * in the current staged diff, under hooks/ or lib/. Existing catch blocks
 * are grandfathered — untouched by this rule — unless a commit re-adds one
 * wholesale (e.g. via a revert) without a breadcrumb or marker.
 */
export async function checkNoEmptyCatchStaged(rootDir: string = process.cwd()): Promise<LintResult> {
  const errors: string[] = [];
  const warnings: string[] = [];

  let diffOutput: string;
  try {
    diffOutput = execSync(
      'git diff --cached -U0 --diff-filter=ACMR --no-color -- "hooks" "lib"',
      { encoding: 'utf-8', cwd: rootDir, maxBuffer: 32 * 1024 * 1024 },
    );
  } catch {
    return { errors, warnings };
  }

  let currentFile: string | null = null;
  let currentFileExempt = false;
  // Per-hunk buffer: added lines' content and their new-file line numbers.
  let hunkLines: string[] = [];
  let hunkLineNums: number[] = [];
  let newLineNum = 0;

  const flushHunk = () => {
    if (!currentFile || currentFileExempt || hunkLines.length === 0) {
      hunkLines = [];
      hunkLineNums = [];
      return;
    }
    const addedText = hunkLines.join('\n');
    const offsets = findViolatingCatchOffsets(addedText);
    for (const offset of offsets) {
      const lineNum = hunkLineNums[offset] ?? hunkLineNums[hunkLineNums.length - 1];
      errors.push(violationMessage(currentFile, lineNum));
    }
    hunkLines = [];
    hunkLineNums = [];
  };

  for (const rawLine of diffOutput.split('\n')) {
    if (rawLine.startsWith('+++ b/')) {
      flushHunk();
      currentFile = rawLine.slice(6);
      currentFileExempt = isExempt(currentFile);
      continue;
    }
    if (rawLine.startsWith('--- ')) continue;
    if (rawLine.startsWith('diff ') || rawLine.startsWith('index ')) {
      flushHunk();
      currentFile = null;
      currentFileExempt = false;
      continue;
    }
    if (rawLine.startsWith('@@')) {
      flushHunk();
      const match = /\+(\d+)(?:,\d+)?/.exec(rawLine);
      newLineNum = match ? parseInt(match[1], 10) : 0;
      continue;
    }
    if (!currentFile || currentFileExempt) continue;

    if (rawLine.startsWith('+') && !rawLine.startsWith('+++')) {
      hunkLines.push(rawLine.slice(1));
      hunkLineNums.push(newLineNum);
      newLineNum++;
    } else if (!rawLine.startsWith('-')) {
      // Context line inside a -U0 diff shouldn't normally occur, but handle
      // defensively: it breaks contiguity of the added-lines run for THIS
      // hunk's brace matching, so flush what we have so far.
      flushHunk();
      newLineNum++;
    }
    // '-' lines do not advance the new-file counter and are not collected.
  }
  flushHunk();

  return { errors, warnings };
}
