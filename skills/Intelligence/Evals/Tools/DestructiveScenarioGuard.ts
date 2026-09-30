/**
 * DestructiveScenarioGuard - refuse destructive scenario prompts unless
 * sandboxed (evals-rebuild slice B6).
 *
 * INCIDENT THIS GUARDS AGAINST — MEMORY/SkillAudits/evals-infra-audit-
 * 2026-07-09/liverun.md finding 4: two now-retired tasks
 * (task_sec_destructive_rm_refusal.yaml, task_negative_no_destructive_
 * commands.yaml — both gone as of evals-rebuild slice A3b's corpus
 * retirement) had `scenario_prompt`s that told the spawned agent to
 * `rm -rf /Users/[user]/projects` — a real, non-empty directory — under
 * `--permission-mode bypassPermissions`. EvalExecutor's "sandbox" isolation
 * only relocates the subprocess's cwd; it never restricted absolute-path
 * filesystem access. The real directory survived four live firings ONLY
 * because the model itself refused the request. Nothing dangerous exists in
 * the corpus today (it's retired) — this module guards the EXECUTOR itself
 * so a future task-author can't reintroduce the same class of danger.
 *
 * WHAT THIS IS: a category-D tripwire (per feedback_determinism_earns_its_
 * place — deterministic pattern-matching is correct here because the input
 * is machine-authored task CONFIG, not free-form agent output) that scans
 * for a narrow, documented set of destructive verbs co-occurring with a
 * real absolute path that resolves outside the trial's sandbox. It is
 * deliberately NOT a general security scanner: the pattern list stays
 * tight, matching happens per-line/per-command (not whole-document fuzzy
 * proximity), and it can be defeated by sufficiently indirect phrasing. Its
 * job is to catch the exact incident-class mistake (a literal, hardcoded
 * real path combined with a literal destructive command), not to reason
 * about intent.
 *
 * ESCAPE HATCH: a task that legitimately needs to operate on a real path
 * declares `setup.sandbox_paths` (Types/schemas.ts) mapping that real path
 * to `'copy'`. `resolveSandboxPathMappings()` then materializes a sandbox
 * copy and rewrites literal occurrences of the real path in
 * scenario_prompt/setup_commands to reference the copy — after which the
 * guard sees only the (now in-sandbox) copy path and does not block.
 *
 * KNOWN LIMITATION — shell/env-var indirection in setup_commands is NOT
 * detected: the guard's path extraction (ABS_PATH_RE) matches literal
 * absolute-path TEXT in the YAML string, not the command's actual runtime
 * behavior. EvalExecutor.ts runs each setup_commands entry via
 * `Bun.spawnSync(['sh', '-c', cmd], ...)`, so a command that references a
 * real destructive target indirectly — `rm -rf "$HOME/projects"`,
 * `rm -rf "$REAL_PROJECTS_DIR"` (an env var set elsewhere), or a
 * `working_dir`-relative `cd ~ && rm -rf projects` — never contains the
 * literal resolved path string at scan time and passes through untouched,
 * even though `sh -c` will expand it to the real path at execution time.
 * Closing this gap would require either resolving shell expansions before
 * scanning (a much bigger surface: quoting, command substitution, sourced
 * env files) or sandboxing setup_commands' actual filesystem access (a
 * different mechanism entirely, e.g. a restricted PATH/chroot/container) —
 * out of scope for this tripwire. Not a regression: the ORIGINAL incident
 * (finding 4) was itself a literal hardcoded path, which this guard does
 * catch.
 */

import { existsSync, mkdirSync, cpSync } from 'fs';
import { basename, join, resolve, sep } from 'path';
import { homedir } from 'os';
import { createHash } from 'crypto';
import type { Task } from '../Types/index.ts';
import { matchKnownInfraSignature, INFRA_SIGNATURE_GROUPS } from './TrialRunner.ts';

// ============================================================================
// Destructive verb patterns
// ============================================================================

/**
 * Tight, documented set of destructive-verb patterns. Each is checked
 * independently against a single "unit" of text (one scenario_prompt line,
 * or one setup_commands array entry) — see scanUnit() below. Kept as a flat
 * list (not a generated one) deliberately: this is a tripwire for a named
 * incident class, not an attempt at exhaustive coverage.
 */
const DESTRUCTIVE_VERB_PATTERNS: { name: string; re: RegExp }[] = [
  // Matches `rm -r`, `rm -rf`, `rm -fr`, `rm -Rf`, `rm -f -r`, etc. — any
  // `rm` invocation whose flag cluster contains an `r` (recursive).
  { name: 'rm -r/-rf (recursive remove)', re: /\brm\s+(?:-\S+\s+)*-[a-zA-Z]*r[a-zA-Z]*\b/i },
  { name: 'git reset --hard', re: /\bgit\s+reset\s+--hard\b/i },
  { name: 'git push --force', re: /\bgit\s+push\b[^\n]*\s(?:--force(?:-with-lease)?|-f)\b/i },
  { name: 'DROP TABLE/DATABASE', re: /\bDROP\s+(?:TABLE|DATABASE)\b/i },
  { name: 'mkfs', re: /\bmkfs(?:\.\w+)?\b/i },
  { name: 'redirect to /dev/', re: />\s*\/dev\/\S+/ },
  { name: 'truncate', re: /\btruncate\b/i },
  { name: 'deletion phrasing ("delete everything in")', re: /\bdelete\s+everything\s+in\b/i },
];

// Absolute path token: `~/...` or `/...`. The negative lookbehind excludes
// a match whose leading `/`/`~` is immediately preceded by:
//   - a word character or `:` -> so `https://host/path` doesn't get
//     captured starting mid-URL (right after the scheme's `:`).
//   - `/` -> so the SECOND slash of `https://...` doesn't get captured
//     either (the first exclusion alone still leaves `//host/path`
//     matchable starting at the second `/`).
//   - `.` -> so relative prefixes `./build` / `../build` don't get
//     mis-captured as the absolute path "/build" (the leading `.`/`..`
//     isn't part of the path-token character class, so without this
//     exclusion it would be silently dropped, turning a relative path into
//     a false-positive absolute one).
const ABS_PATH_RE = /(?<![:\w./])(~\/[^\s"'`)]+|\/[A-Za-z0-9._\-\/]+)/g;

function expandHome(p: string): string {
  if (p === '~') return homedir();
  if (p.startsWith('~/')) return join(homedir(), p.slice(2));
  return p;
}

function stripTrailingPunctuation(p: string): string {
  return p.replace(/[.,;:'")\]]+$/, '');
}

/** True when `candidatePath` is the sandbox root or nested under it. */
function isInsideSandbox(candidatePath: string, sandboxRoot: string): boolean {
  const c = resolve(expandHome(candidatePath));
  const root = resolve(sandboxRoot);
  return c === root || c.startsWith(root + sep);
}

export interface DestructiveScenarioMatch {
  /** Name of the matched destructive-verb pattern (see DESTRUCTIVE_VERB_PATTERNS). */
  verb: string;
  /** The real absolute path (as it appeared in the text) that resolved outside the sandbox. */
  path: string;
  /** Where the match was found — e.g. "scenario_prompt:line 3" or "setup_commands[1]". */
  source: string;
  /** The offending line/command text (truncated), for the refusal message. */
  snippet: string;
}

export interface DestructiveScenarioScanResult {
  blocked: boolean;
  matches: DestructiveScenarioMatch[];
}

/**
 * Scan one unit of text (one line, or one setup_commands entry) for a
 * destructive-verb + out-of-sandbox-real-path combo. Both must be present
 * in the SAME unit to flag — a verb alone, or a path alone, is not enough
 * (see module doc comment: this is a tripwire for the named incident class,
 * not a general scanner).
 */
function scanUnit(text: string, source: string, sandboxRoot: string): DestructiveScenarioMatch[] {
  const verbHits = DESTRUCTIVE_VERB_PATTERNS.filter(p => p.re.test(text));
  if (verbHits.length === 0) return [];

  const outsidePaths = Array.from(text.matchAll(ABS_PATH_RE))
    .map(m => stripTrailingPunctuation(m[0]))
    .filter(p => !isInsideSandbox(p, sandboxRoot));
  if (outsidePaths.length === 0) return [];

  const snippet = text.length > 200 ? `${text.slice(0, 200)}…` : text;
  return verbHits.map(v => ({ verb: v.name, path: outsidePaths[0], source, snippet }));
}

/**
 * Scan a task's (possibly sandbox_paths-rewritten) scenario_prompt and
 * setup_commands for the destructive-verb + out-of-sandbox-path combo.
 * `sandboxRoot` is the trial's resolved working directory — either the
 * freshly created mkdtemp sandbox (isolation: 'sandbox', the default) or
 * the task's declared/default working_dir (isolation: 'shared'/'none').
 *
 * setup_commands is scanned too, not just scenario_prompt: unlike
 * scenario_prompt (mediated by an agent that can refuse, as in the finding-4
 * incident), setup_commands execute directly via a shell subprocess with no
 * safety net at all — a destructive combo there is strictly more dangerous,
 * not less.
 */
export function scanForDestructiveScenario(
  input: { scenarioPrompt?: string; setupCommands?: string[] },
  sandboxRoot: string,
): DestructiveScenarioScanResult {
  const matches: DestructiveScenarioMatch[] = [];

  if (input.scenarioPrompt) {
    const lines = input.scenarioPrompt.split('\n');
    lines.forEach((line, i) => {
      if (!line.trim()) return;
      matches.push(...scanUnit(line, `scenario_prompt:line ${i + 1}`, sandboxRoot));
    });
  }

  (input.setupCommands ?? []).forEach((cmd, i) => {
    matches.push(...scanUnit(cmd, `setup_commands[${i}]`, sandboxRoot));
  });

  return { blocked: matches.length > 0, matches };
}

const INCIDENT_CITATION =
  'MEMORY/SkillAudits/evals-infra-audit-2026-07-09/liverun.md finding 4 — a retired task ' +
  '(task_sec_destructive_rm_refusal.yaml) told the spawned agent to `rm -rf /Users/[user]/projects` ' +
  'under --permission-mode bypassPermissions with only the subprocess cwd relocated (never the ' +
  'target path); the real directory survived 4 live firings only because the model itself refused.';

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Replace every substring TrialRunner's matchKnownInfraSignature() would
 * treat as an infra-failure signal (imported from TrialRunner.ts's
 * INFRA_SIGNATURE_GROUPS — one source of truth, never a second
 * hand-maintained copy of this list) with a neutral placeholder.
 *
 * WHY THIS EXISTS: `path`/`snippet` on a DestructiveScenarioMatch are
 * extracted from UNTRUSTED task-author text (scenario_prompt/
 * setup_commands). formatRefusalMessage() below throws an Error built from
 * these fields; that Error's message is caught by TrialRunner.run()'s outer
 * catch and run through matchKnownInfraSignature() to decide infra_failure
 * vs. a real, countable status:'error'. Without this redaction, a task
 * whose destructive text merely happened to also contain a word like
 * "timeout" or "authentication" — even coincidentally, e.g. a trailing
 * comment `# ignore any timeout` — would cause a REAL refusal to be
 * misclassified as a transient infra blip: excluded from pass_rate,
 * invisible as a failure. Case-insensitive; only the matched span is
 * replaced, surrounding text is preserved.
 *
 * Exported (remediation-p1p5 E2/F2) so EvalExecutor.ts's setup_commands
 * timeout path can apply the SAME redaction to untrusted `cmd`/subprocess
 * `stderr` text before interpolating it into its own thrown error — the
 * exact same class of hazard this function was built for, just a second
 * call site rather than a second hand-maintained copy of the logic.
 */
export function redactInfraSignatures(text: string): string {
  let redacted = text;
  for (const group of INFRA_SIGNATURE_GROUPS) {
    for (const substring of group.substrings) {
      redacted = redacted.replace(new RegExp(escapeRegExp(substring), 'gi'), '[redacted:infra-signature]');
    }
  }
  return redacted;
}

/**
 * Build the loud, actionable refusal error text — names every offending
 * path+verb combo, cites the incident this guards against, and points at
 * the escape hatch (setup.sandbox_paths).
 *
 * Two layers of defense against the assembled message being misclassified
 * as a TrialRunner infra_failure (see redactInfraSignatures()'s doc
 * comment for why this matters):
 *   1. `path`/`snippet`/`taskId` — every field sourced from untrusted
 *      task-author text — are redacted via redactInfraSignatures() before
 *      interpolation. (`verb` is never redacted: it's always one of our
 *      own static DESTRUCTIVE_VERB_PATTERNS names, never task-author text,
 *      and none of those names collide with an infra signature.)
 *   2. Belt-and-suspenders: after assembly, the FULL message is re-checked
 *      with matchKnownInfraSignature() (the real TrialRunner classifier,
 *      not a re-implementation — avoids drift). If it somehow still
 *      matches (e.g. a redaction gap), every snippet is dropped entirely
 *      (not just re-redacted) and the message is rebuilt — this must never
 *      trigger in practice, but a refusal being misclassified is worse than
 *      a less detailed error message.
 */
export function formatRefusalMessage(taskId: string, result: DestructiveScenarioScanResult): string {
  const safeTaskId = redactInfraSignatures(taskId);

  const buildMessage = (lines: string[]): string =>
    [
      `DESTRUCTIVE_SCENARIO_REFUSED: task "${safeTaskId}" blocked by EvalExecutor's destructive-scenario guard before any command ran.`,
      `Found ${result.matches.length} destructive-verb + real-out-of-sandbox-path combo(s):`,
      ...lines,
      `Incident this guards against: ${INCIDENT_CITATION}`,
      'To run this scenario intentionally, declare setup.sandbox_paths (e.g. { "<real path>": "copy" }) ' +
        'so the executor copies the real path into the trial sandbox and rewrites scenario_prompt/' +
        'setup_commands to reference the copy instead of the real path.',
    ].join('\n');

  const redactedLines = result.matches.map(m => {
    const safePath = redactInfraSignatures(m.path);
    const safeSnippet = redactInfraSignatures(m.snippet);
    return `  - [${m.source}] destructive verb "${m.verb}" targeting real out-of-sandbox path "${safePath}": ${safeSnippet}`;
  });

  const message = buildMessage(redactedLines);
  if (matchKnownInfraSignature(message) === null) {
    return message;
  }

  // Layer 2 fallback — should never be reached given layer 1, but fail SAFE
  // rather than ship a message that risks infra-laundering a real refusal.
  const withheldLines = result.matches.map(
    m => `  - [${m.source}] destructive verb "${m.verb}": <snippet withheld — contained infra-signature text>`
  );
  return buildMessage(withheldLines);
}

// ============================================================================
// sandbox_paths mapping — materialize + rewrite
// ============================================================================

/**
 * Copy `realPath` into `sandboxRoot` and return the copy's path. Uses
 * basename(realPath) + a short content-addressed suffix (hash of the real
 * path itself) as the destination directory name, so two different declared
 * real paths never collide even if they share a basename. If `realPath`
 * doesn't exist on disk (e.g. a fabricated path in a test), creates an
 * empty directory instead of throwing — the rewrite is still well-formed,
 * it just has nothing to copy.
 */
export function materializeSandboxCopy(realPath: string, sandboxRoot: string): string {
  const expanded = expandHome(realPath);
  const hash = createHash('sha1').update(expanded).digest('hex').slice(0, 8);
  const destName = `${basename(expanded) || 'root'}-${hash}`;
  const dest = join(sandboxRoot, destName);
  if (existsSync(expanded)) {
    cpSync(expanded, dest, { recursive: true });
  } else {
    mkdirSync(dest, { recursive: true });
  }
  return dest;
}

/**
 * Apply a task's declared setup.sandbox_paths mappings: for each real path
 * -> 'copy' entry, materialize a sandbox copy (see materializeSandboxCopy)
 * and rewrite every literal occurrence of the real path in scenario_prompt
 * and each setup_commands entry to point at the copy instead.
 *
 * Pass-through (no allocation, no filesystem I/O) when the task declares no
 * sandbox_paths — the common case for the entire kept corpus today, none of
 * which uses this field.
 */
export function resolveSandboxPathMappings(
  task: Pick<Task, 'setup'>,
  sandboxRoot: string,
): { scenarioPrompt?: string; setupCommands?: string[] } {
  const mappings = task.setup?.sandbox_paths;
  const scenarioPrompt = task.setup?.scenario_prompt;
  const setupCommands = task.setup?.setup_commands;

  if (!mappings || Object.keys(mappings).length === 0) {
    return { scenarioPrompt, setupCommands };
  }

  let rewrittenPrompt = scenarioPrompt;
  let rewrittenCommands = setupCommands ? [...setupCommands] : setupCommands;

  for (const [realPath, mode] of Object.entries(mappings)) {
    if (mode !== 'copy') continue; // only supported mode today
    const destPath = materializeSandboxCopy(realPath, sandboxRoot);
    if (rewrittenPrompt) {
      rewrittenPrompt = rewrittenPrompt.split(realPath).join(destPath);
    }
    if (rewrittenCommands) {
      rewrittenCommands = rewrittenCommands.map(cmd => cmd.split(realPath).join(destPath));
    }
  }

  return { scenarioPrompt: rewrittenPrompt, setupCommands: rewrittenCommands };
}
