#!/usr/bin/env bun
/**
 * FreshnessGuard.ts
 *
 * Context Integrity Program, Slice A3 — enforces per-artifact freshness
 * classification (see FreshnessClassifier.ts, Slice A2) instead of one
 * blanket "stale after N days" rule, and widens coverage well beyond the
 * original 6 watched artifacts.
 *
 * WHY: the pre-A3 version of this file checked exactly 6 artifacts
 * (VaultContext.md, the 4 AUTOINFO digests, CONTEXT-ROUTING.md) against a
 * single FRESHNESS_THRESHOLD_DAYS. It watched none of context/ or
 * USER/TELOS/ — so context/DtrContext.md (last touched ~Mar 9) and
 * context/GraphContext.md (last touched ~Feb 27) sat silently stale for
 * months, invisible to any freshness check. Separately, a single global
 * threshold is simultaneously too loose for fast-moving artifacts
 * (LucidTasksContext.md needs to be caught within an hour) and wrong for
 * durable ones (USER/TELOS/MISSIONS.md is not "stale" for being six months
 * old — that's the whole point of a mission statement).
 *
 * WHAT CHANGED: every artifact under context/*.md, USER/TELOS/*.md, and
 * MEMORY/AUTOINFO/digests/*.json is now resolved through
 * FreshnessClassifier.classifyArtifact() (Slice A2) and checked against
 * ITS OWN declared class:
 *   - timeless        never flagged for age (existence still checked).
 *   - dated-snapshot   flagged when age exceeds its own maxAgeMs.
 *   - (every class)    ALSO flagged when the CONTENT is empty — frontmatter
 *                      entries_count: 0, or an unfilled [placeholder] scaffold
 *                      (contentStaleReason(); audit 2026-09-11 FG-02 / FG-03).
 *   - pointer          NEVER flagged for age. If its resolving source
 *                       config (skills/Productivity/InformationManager/
 *                       config/*.json) declares an executable `command`,
 *                       that command is run as a reachability probe — a
 *                       non-zero exit/thrown error is what gets flagged,
 *                       not the cached snapshot's age. No `command`
 *                       declared -> nothing to probe -> never flagged
 *                       (never invents an age check the class forbids).
 *
 * STANDALONE REACHABILITY PROBES (context/ retirement, 2026-07-31): pointer
 * probes only run for artifacts discovery finds, so deleting a pointer-class
 * artifact silently deletes its probe. When context/GraphContext.md was
 * retired, its GraphQuerier reachability check moved to
 * STANDALONE_REACHABILITY_PROBES below — run by the CLI on every sentinel
 * pass, independent of any artifact file. See that constant's doc.
 *
 * VaultContext.md (lives outside the repo, under ~/Desktop/obsidian/) and
 * CONTEXT-ROUTING.md are deliberately NOT run through this classification:
 * Slice A2's artifact-freshness.json registry explicitly scoped itself to
 * context/MasterContext.md + USER/TELOS/*.md + the 4 digests and did not
 * classify these two. Reclassifying them here would be re-litigating an A2
 * scoping decision without review, so they keep the original
 * freshnessThresholdDays check, unchanged. Flagged as a residual gap in the
 * A3 report rather than silently resolved.
 *
 * Never exits 0 on degraded runs (ISC-6, per Kaya principle:
 * "Cron wrappers must never exit 0 on degraded runs").
 *
 * SLICE F2 (digest faithfulness): a second, independent check alongside
 * contentLag — contentLag catches a digest whose CONTENT has frozen;
 * qualifierFaithfulness catches a digest entry whose content CHANGED and, in
 * changing, dropped a load-bearing qualifier (negation/condition/scope-
 * limiter/quantifier) present in its source. Scoped to skill-capabilities.json
 * only: it is the one digest where DigestBuilder.ts's source (SKILL.md
 * frontmatter/body text) is richer and more qualifier-bearing than the other
 * three digests' sources (LucidTasks titles, GOALS.md headings, VaultContext
 * table cells — all copied whole with no natural-language compression
 * surface to check). See QualifierFaithfulness.ts for the mechanism (LLM
 * judgment behind two deterministic cost-bounding filters) and its own
 * module doc for the cost/latency profile. Immune to the worktree-mtime
 * gotcha below — this check compares file CONTENT, never mtime.
 *
 * Usage:
 *   bun FreshnessGuard.ts                                          # Check with defaults (live tree)
 *   bun FreshnessGuard.ts --dry-run                                # Check but skip the alert
 *   bun FreshnessGuard.ts --threshold-days 1                       # Override legacy-artifact threshold
 *   bun FreshnessGuard.ts --repo-root <path>                       # Point context/USER-TELOS/config discovery at a different tree (e.g. the live tree from a worktree session)
 *   bun FreshnessGuard.ts --vault-context <path> --digests-dir <dir> --context-routing <path> --threshold-days <N> --dry-run
 *
 * Environment variables:
 *   FRESHNESS_THRESHOLD_DAYS=<N>   Override legacy-artifact threshold (default 7)
 *
 * CRITICAL GOTCHA for anyone verifying this from a git worktree: a worktree
 * checkout resets every file's mtime to the checkout instant, so every
 * artifact inside a worktree looks freshly-touched regardless of its real
 * history. Point --repo-root at the LIVE tree (e.g. ~/.claude)
 * to get a meaningful mtime-based verdict; running against the worktree's
 * own copies will always report "fresh" and prove nothing.
 */

import { join } from "path";
import { existsSync, readFileSync, readdirSync, statSync } from "fs";
import { execSync } from "child_process";
import { getKayaHome } from "../../../../lib/core/KayaHome.ts";
import { memPath } from "../../../../lib/core/MemoryPaths.ts";
import { DETECTION_EXIT_CODE } from "../../../../lib/cron/FailureClassifier.ts";
import {
  checkEntriesFaithfulness,
  type EntryFaithfulnessCheck,
  type FaithfulnessPair,
  type InferenceFn as QualifierInferenceFn,
} from "./QualifierFaithfulness.ts";
import {
  analyzeArtifactContent,
  classifyArtifact,
  findRepoRoot,
  loadRegistry,
  loadSourceConfigs,
  listMarkdownArtifacts,
  FreshnessClassificationError,
  type FreshnessClass,
  type FreshnessDeclaration,
  type PointerFreshness,
  type SourceConfigLike,
} from "../../../../lib/core/FreshnessClassifier.ts";

// ============================================================================
// Types
// ============================================================================

export interface FreshnessResult {
  stale: boolean;
  staleFiles: string[];
  checkedFiles: string[];
  thresholdDays: number;
  /**
   * Content-lag check result (additive, backward compatible): non-null when
   * both recent-completions.json and the approved-work archive were parseable.
   * Flags the case where the digest's mtime looks fresh (recently rebuilt)
   * but its content has silently frozen relative to its source archive.
   */
  contentLag?: { digestMaxDate: string; archiveMaxDate: string; lagDays: number } | null;
  /**
   * Slice F2 digest-faithfulness check (additive, backward compatible):
   * present whenever skill-capabilities.json exists and has entries; null
   * when it doesn't (nothing to check). `unfaithful` lists only the entries
   * the LLM judged unfaithful — see QualifierFaithfulness.ts. A non-empty
   * `unfaithful` also contributes an entry to staleFiles/stale, same as
   * contentLag does.
   */
  qualifierFaithfulness?: {
    checked: number;
    skipped: number;
    errored: number;
    unfaithful: EntryFaithfulnessCheck[];
  } | null;
  /**
   * Per-artifact classification detail for every artifact checked through
   * Slice A2's FreshnessClassifier (the 4 digests + everything discovered
   * under context/*.md and USER/TELOS/*.md) — NOT the two legacy artifacts
   * (VaultContext.md, CONTEXT-ROUTING.md), which stay on the plain
   * threshold check and are reported only via staleFiles/checkedFiles.
   */
  classified: ClassifiedArtifactCheck[];
  /**
   * Standalone (non-artifact) reachability probes that ran this check —
   * empty unless the caller passed opts.standaloneProbes (the CLI passes
   * STANDALONE_REACHABILITY_PROBES). A failed probe contributes to
   * staleFiles/stale exactly like a stale artifact.
   */
  standaloneProbes: StandaloneProbeResult[];
}

export interface ClassifiedArtifactCheck {
  /** Repo-relative artifact key used for classification lookup, e.g.
   *  "context/DtrContext.md" or "MEMORY/AUTOINFO/digests/recent-completions.json". */
  artifact: string;
  /** Absolute path actually stat'd/probed — may live outside repoRoot (e.g. digestsDir override). */
  absolutePath: string;
  /** "unclassified" only when classifyArtifact() itself throws (should be unreachable
   *  in production — see FreshnessClassifier's 37/37 coverage — kept as a fail-loud net). */
  freshnessClass: FreshnessClass | "unclassified";
  stale: boolean;
  /** Human-readable explanation: age vs maxAge, timeless skip-reason, pointer
   *  reachability probe result/skip-reason, or the classification error message. */
  reason: string;
}

// ============================================================================
// Core check
// ============================================================================

const KAYA_HOME = getKayaHome();
const DEFAULT_VAULT_CONTEXT = join(
  process.env.HOME || "",
  "Desktop",
  "obsidian",
  "VaultContext.md"
);
// memPath() (not a hand-rolled join(KAYA_HOME, "MEMORY", ...)) per the
// no-inline-memory-path rule — resolves against getKayaHome() exactly like
// KAYA_HOME above, but through the canonical accessor so a future KAYA_HOME
// override is never silently bypassed. Matches the convention Slice A2's
// FreshnessClassifier.ts main() already uses (memPathUnder) for the same
// digests directory.
const DEFAULT_DIGESTS_DIR = memPath("AUTOINFO", "digests");
const DEFAULT_CONTEXT_ROUTING_PATH = join(KAYA_HOME, "CONTEXT-ROUTING.md");
const DEFAULT_ARCHIVE_PATH = memPath("QUEUES", "archive", "approved-work-archive.jsonl");
const DIGEST_NAMES = [
  "skill-capabilities",
  "active-projects-goals",
  "recent-completions",
  "vault-folder-map",
];

const CONTENT_LAG_THRESHOLD_DAYS = 3;

/** Timeout for a reachability probe (a pointer artifact's source-config
 *  `command`, or a standalone probe without a declared `timeoutMs`). */
const DEFAULT_REACHABILITY_TIMEOUT_MS = 15_000;

/**
 * A reachability probe that is NOT tied to any artifact file. Same semantics
 * as a pointer artifact's probe (command exits 0 → reachable), but it runs
 * unconditionally — it does not depend on some context/*.md file existing to
 * be discovered.
 */
export interface StandaloneReachabilityProbe {
  /** Stable name — appears in staleFiles entries and the CLI report. */
  name: string;
  /** Shell command; nonzero exit / timeout / spawn failure = unreachable. */
  command: string;
  /** Probe timeout; DEFAULT_REACHABILITY_TIMEOUT_MS when omitted. */
  timeoutMs?: number;
  /** Why this probe exists and what it guards. */
  reason: string;
}

export interface StandaloneProbeResult {
  name: string;
  command: string;
  ok: boolean;
  reason: string;
}

/**
 * The production standalone probes. The CLI entrypoint passes these to
 * checkFreshness() explicitly; checkFreshness() itself defaults to [] so
 * that programmatic/test callers stay hermetic (no live subprocess runs
 * unless a caller opts in). The context-freshness-sentinel LaunchAgent runs
 * the CLI daily, so these execute daily in production.
 *
 * graph-tool: relocated from config/graph.json's pointer-class declaration
 * when context/GraphContext.md was retired (2026-07-31,
 * plans/context-dir-retirement/). The probe's rationale outlived its
 * artifact: what matters is whether the Graph tool is still queryable, not
 * any cached snapshot's age. Before the retirement this command ran via
 * checkPointerReachability() whenever GraphContext.md was discovered under
 * context/; with that file gone, discovery would silently skip it — this
 * list is what keeps the check alive.
 */
export const STANDALONE_REACHABILITY_PROBES: StandaloneReachabilityProbe[] = [
  {
    name: "graph-tool",
    command: `bun ${join(KAYA_HOME, "skills", "Intelligence", "Graph", "Tools", "GraphQuerier.ts")} stats --json`,
    reason:
      "Knowledge Graph queryability (GraphQuerier stats) — the reachability check formerly attached to context/GraphContext.md's pointer classification.",
  },
];

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Max leading "YYYY-MM-DD" date across recent-completions.json entries whose
 * surface suffix is NOT "(git)" (entry format: "YYYY-MM-DD <title> (<surface>)"),
 * plus how many such AW-surface entries exist. Returns null if the file is
 * missing or unparseable — never throws.
 *
 * WHY exclude "(git)" entries: F5 (2026-07) unioned recent-completions.json
 * with git merge-to-main landings, which land roughly daily. This content-lag
 * check exists to catch the S1 regression class — the AW-ARCHIVE parser
 * silently freezing while the archive itself keeps moving (observed: a
 * 4.5-month freeze at 2026-02-19). If the digest-side max date scanned git
 * entries too, it would read as "today" almost always regardless of whether
 * the archive-sourced entries had frozen, so a repeat of the S1 regression
 * would go undetected — git would mask it. Restricting the scan to
 * non-"(git)" entries restores the original S1 semantics untouched by git.
 *
 * RESIDUAL GAP (explicitly documented, not silently swallowed): the top-40
 * digest slice can legitimately be crowded out to all-git if git landings are
 * simply fresher than every archive completion — in that case awEntryCount
 * is 0 and there is nothing archive-sourced left in the digest to compare
 * against, so no content-lag verdict is possible (we cannot distinguish
 * "crowded out because genuinely older" from "broken parsing" from date data
 * alone). checkFreshness emits a distinct stderr diagnostic for that case
 * instead of silently passing — see the call site below.
 */
function awEntriesFromRecentCompletionsDigest(
  digestPath: string
): { maxDate: string | null; awEntryCount: number } | null {
  if (!existsSync(digestPath)) return null;
  try {
    const parsed = JSON.parse(readFileSync(digestPath, "utf8")) as { entries?: unknown };
    const entries = Array.isArray(parsed.entries) ? parsed.entries : [];
    let maxDate: string | null = null;
    let awEntryCount = 0;
    for (const entry of entries) {
      if (typeof entry !== "string") continue;
      if (entry.trimEnd().endsWith("(git)")) continue; // git-sourced landing — excluded, see doc above
      awEntryCount++;
      const m = entry.match(/^(\d{4}-\d{2}-\d{2})/);
      if (m && (!maxDate || m[1] > maxDate)) maxDate = m[1];
    }
    return { maxDate, awEntryCount };
  } catch {
    return null;
  }
}

/**
 * Max `(completedAt || updated)` date across `status:"completed"` records in
 * the approved-work archive jsonl. Returns null if the file is missing,
 * unparseable, or has no dated completed records — never throws.
 */
function maxDateFromArchive(archivePath: string): string | null {
  if (!existsSync(archivePath)) return null;
  try {
    const lines = readFileSync(archivePath, "utf8")
      .split("\n")
      .filter(l => l.trim());
    let maxDate: string | null = null;
    for (const line of lines) {
      try {
        const item = JSON.parse(line) as { status?: string; completedAt?: string; updated?: string };
        if (item.status !== "completed") continue;
        const raw = item.completedAt || item.updated;
        if (!raw) continue;
        const date = raw.slice(0, 10);
        if (!maxDate || date > maxDate) maxDate = date;
      } catch {
        // skip malformed lines
      }
    }
    return maxDate;
  } catch {
    return null;
  }
}

// ============================================================================
// Slice A3: per-artifact classification enforcement
// ============================================================================

/** Finds the source config (if any) whose `output` matches this artifact key
 *  — used to look up a pointer's reachability-probe `command`, since that
 *  field lives on the source config, not on the FreshnessDeclaration itself. */
function findMatchingSourceConfig(
  artifactKey: string,
  sourceConfigs: ReadonlyMap<string, SourceConfigLike>
): SourceConfigLike | null {
  for (const config of sourceConfigs.values()) {
    if (config.output === artifactKey) return config;
  }
  return null;
}

/**
 * Reachability probe for a `pointer`-class artifact. Per A2's design, a
 * pointer is NEVER checked for its own age — what matters is whether the
 * thing it points at is still reachable. The only reachability signal this
 * tool can check without inventing per-artifact special cases is the
 * resolving source config's own declared `command` (e.g. graph.json's
 * "bun ~/.claude/skills/Graph/Tools/GraphQuerier.ts stats --json"): if that
 * command still runs, the pointer is reachable; if it doesn't (wrong path,
 * missing binary, thrown error), the artifact's declared refresh mechanism
 * is broken — which is exactly why it can go stale silently forever, so it
 * is flagged.
 *
 * When no source config (or no `command` field) is available — e.g.
 * USER/TELOS/PROJECTS.md, whose pointsTo is "Asana" but which has no local
 * executable command — there is no reachability probe this tool can run
 * without adding a live network call (out of proportion for a freshness
 * guard). Such pointers are never flagged; the skip is reported, not silent.
 */
function checkPointerReachability(
  decl: PointerFreshness,
  matchedConfig: SourceConfigLike | null
): { ok: boolean; reason: string } {
  const command = matchedConfig?.command;
  if (typeof command !== "string" || command.trim() === "") {
    return {
      ok: true,
      reason: `pointer (${decl.pointsTo}) — no executable "command" declared in its source config; reachability not probed, never flagged for age.`,
    };
  }

  const timeoutMs =
    typeof matchedConfig?.timeout === "number" ? matchedConfig.timeout : DEFAULT_REACHABILITY_TIMEOUT_MS;

  try {
    execSync(command, { encoding: "utf-8", timeout: timeoutMs, stdio: ["ignore", "pipe", "pipe"] });
    return { ok: true, reason: `pointer (${decl.pointsTo}) — reachability probe succeeded: \`${command}\`` };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      reason: `pointer (${decl.pointsTo}) — reachability probe FAILED (\`${command}\`): ${message.split("\n")[0]}`,
    };
  }
}

/**
 * Run one standalone reachability probe. Same execution contract as
 * checkPointerReachability() (execSync, capped timeout, nonzero exit /
 * spawn failure / timeout = unreachable), but unconditional — no artifact
 * file needs to exist for it to run.
 */
function runStandaloneProbe(probe: StandaloneReachabilityProbe): StandaloneProbeResult {
  const timeoutMs = probe.timeoutMs ?? DEFAULT_REACHABILITY_TIMEOUT_MS;
  try {
    execSync(probe.command, { encoding: "utf-8", timeout: timeoutMs, stdio: ["ignore", "pipe", "pipe"] });
    return {
      name: probe.name,
      command: probe.command,
      ok: true,
      reason: `standalone probe succeeded: \`${probe.command}\` — ${probe.reason}`,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      name: probe.name,
      command: probe.command,
      ok: false,
      reason: `standalone probe FAILED (\`${probe.command}\`): ${message.split("\n")[0]} — ${probe.reason}`,
    };
  }
}

/**
 * Content verdict for a markdown artifact that exists (audit 2026-09-11,
 * FG-02 / FG-03). Returns the stale reason, or null when the content is fine
 * or unreadable (an unreadable file is not this check's call — the age /
 * pointer checks still run). Non-markdown artifacts (the JSON digests) skip.
 */
function contentStaleReason(absolutePath: string): string | null {
  if (!absolutePath.endsWith(".md")) return null;
  let text: string;
  try {
    text = readFileSync(absolutePath, "utf-8");
  } catch {
    return null;
  }
  const a = analyzeArtifactContent(text);
  if (a.emptySnapshot) {
    return "empty snapshot — frontmatter entries_count: 0 (the writer ran but gathered nothing; mtime is not freshness)";
  }
  if (a.emptyTemplate) {
    return `empty template — ${a.placeholderLines} of ${a.bodyLines} body lines are unfilled [placeholders] (fill it in, or delete it and its CONTEXT-ROUTING row)`;
  }
  return null;
}

/**
 * Evaluate one already-classified artifact against its declaration. Missing
 * files are always flagged regardless of class (existence is orthogonal to
 * "how do we judge age"). Otherwise dispatches on the three A2 classes.
 */
function evaluateArtifact(
  artifactKey: string,
  absolutePath: string,
  decl: FreshnessDeclaration,
  now: number,
  matchedConfig: SourceConfigLike | null
): ClassifiedArtifactCheck {
  if (!existsSync(absolutePath)) {
    return { artifact: artifactKey, absolutePath, freshnessClass: decl.class, stale: true, reason: "missing file" };
  }

  // Content beats mtime: an existing, recently-written file is still pollution
  // if the writer produced nothing or nobody ever filled the scaffold in.
  const contentReason = contentStaleReason(absolutePath);
  if (contentReason) {
    return { artifact: artifactKey, absolutePath, freshnessClass: decl.class, stale: true, reason: contentReason };
  }

  if (decl.class === "timeless") {
    return {
      artifact: artifactKey,
      absolutePath,
      freshnessClass: "timeless",
      stale: false,
      reason: `timeless — ${decl.reason}`,
    };
  }

  if (decl.class === "dated-snapshot") {
    const ageMs = now - statSync(absolutePath).mtimeMs;
    const stale = ageMs > decl.maxAgeMs;
    const ageDays = (ageMs / MS_PER_DAY).toFixed(1);
    const maxDays = (decl.maxAgeMs / MS_PER_DAY).toFixed(1);
    return {
      artifact: artifactKey,
      absolutePath,
      freshnessClass: "dated-snapshot",
      stale,
      reason: stale
        ? `dated-snapshot — ${ageDays}d old exceeds maxAge ${maxDays}d`
        : `dated-snapshot — ${ageDays}d old, within maxAge ${maxDays}d`,
    };
  }

  // decl.class === "pointer"
  const probe = checkPointerReachability(decl, matchedConfig);
  return { artifact: artifactKey, absolutePath, freshnessClass: "pointer", stale: !probe.ok, reason: probe.reason };
}

/** Classify + evaluate one artifact. Classification failure (should be
 *  unreachable given FreshnessClassifier's current 37/37 coverage) is
 *  itself reported as stale — an unclassified artifact is a bug to surface
 *  loudly, never a file to silently skip freshness enforcement for. */
function classifyAndEvaluate(
  artifactKey: string,
  absolutePath: string,
  sourceConfigs: ReadonlyMap<string, SourceConfigLike>,
  registry: ReadonlyMap<string, FreshnessDeclaration>,
  now: number
): ClassifiedArtifactCheck {
  let decl: FreshnessDeclaration;
  try {
    decl = classifyArtifact(artifactKey, sourceConfigs, registry);
  } catch (error) {
    const message = error instanceof FreshnessClassificationError ? error.message : String(error);
    return { artifact: artifactKey, absolutePath, freshnessClass: "unclassified", stale: true, reason: message };
  }
  const matchedConfig = findMatchingSourceConfig(artifactKey, sourceConfigs);
  return evaluateArtifact(artifactKey, absolutePath, decl, now, matchedConfig);
}

// ============================================================================
// Slice F2: digest-faithfulness source resolution (skill-capabilities.json only)
// ============================================================================

/**
 * Walk skills/ two levels deep (Category/SkillName), same structure as
 * DigestBuilder.ts's buildSkillCapabilitiesDigest(), collecting each
 * SKILL.md's RAW pre-formatting source text — the frontmatter `description:`
 * line plus body `USE WHEN:` line, exactly as DigestBuilder.ts's
 * parseSkillMd() reads them, BEFORE its join(". ")/quote-strip formatting —
 * keyed by the resolved skill name parseSkillMd() would produce.
 *
 * DELIBERATE DUPLICATION, not an import: parseSkillMd() is not exported from
 * DigestBuilder.ts, and DigestBuilder.ts is outside this slice's ownership
 * (skills/Productivity/InformationManager, a different skill from this
 * file's skills/Automation/AutoInfoManager — importing it would need its own
 * cross-skill-allowed justification, unlike FreshnessClassifier which now
 * lives in lib/core). Mirroring the three regexes locally avoids editing
 * a file another slice may be concurrently building against. If
 * DigestBuilder.ts's extraction regexes ever change, this copy must be kept
 * in sync or this check starts comparing a digest entry against a source
 * excerpt DigestBuilder no longer actually used to build it — flagged here,
 * not silently assumed permanent.
 */
function collectSkillSources(skillsDir: string): Map<string, string> {
  const sources = new Map<string, string>();
  if (!existsSync(skillsDir)) return sources;

  let categories: string[];
  try {
    categories = readdirSync(skillsDir, { withFileTypes: true })
      .filter(e => e.isDirectory())
      .map(e => e.name);
  } catch {
    return sources;
  }

  const addFromSkillMd = (skillMdPath: string): void => {
    let content: string;
    try {
      content = readFileSync(skillMdPath, "utf8");
    } catch {
      return;
    }

    const fmMatch = content.match(/^---\s*\n([\s\S]*?)\n---/);
    let description = "";
    let name = "";
    if (fmMatch) {
      const fm = fmMatch[1];
      const descMatch = fm.match(/^description:\s*(.+)$/m);
      if (descMatch) description = descMatch[1].trim().replace(/^["']|["']$/g, "");
      const nameMatch = fm.match(/^name:\s*(.+)$/m);
      if (nameMatch) name = nameMatch[1].trim().replace(/^["']|["']$/g, "");
    }

    const useWhenMatch = content.match(/USE\s+WHEN[:\s]+(.+?)(?:\n|$)/i);
    const useWhen = useWhenMatch ? useWhenMatch[1].trim().replace(/\.$/, "") : "";
    if (!description && !useWhen) return;

    // Reconstruct the same "content only" shape DigestBuilder.ts's join(". ")
    // produces (minus the "<name>: " prefix it adds separately), so the
    // comparison is content-vs-content, not content-vs-name-prefixed-content.
    const descriptionHasUseWhen = /use\s+when/i.test(description);
    const raw = useWhen && !descriptionHasUseWhen ? `${description}. Use when: ${useWhen}` : description;

    if (name && raw) sources.set(name, raw);
  };

  for (const cat of categories) {
    const catDir = join(skillsDir, cat);
    const directSkillMd = join(catDir, "SKILL.md");
    if (existsSync(directSkillMd)) addFromSkillMd(directSkillMd);

    let subDirs: string[] = [];
    try {
      subDirs = readdirSync(catDir, { withFileTypes: true })
        .filter(e => e.isDirectory())
        .map(e => e.name);
    } catch {
      continue;
    }
    for (const sub of subDirs) {
      const skillMdPath = join(catDir, sub, "SKILL.md");
      if (existsSync(skillMdPath)) addFromSkillMd(skillMdPath);
    }
  }

  return sources;
}

/**
 * Pair each skill-capabilities.json entry ("<name>: <content>") with its
 * resolved SKILL.md source content, stripping the "<name>: " prefix from the
 * digest entry so both sides of the pair are content-only. Entries whose
 * name matches no discovered SKILL.md (renamed/removed skill, or a
 * repoRoot fixture with no skills/ dir) are skipped quietly — that drift is
 * FreshnessGuard's existing dated-snapshot/missing-file coverage's job, not
 * this check's.
 */
function buildSkillFaithfulnessPairs(skillsDir: string, digestEntries: readonly string[]): FaithfulnessPair[] {
  const sources = collectSkillSources(skillsDir);
  const pairs: FaithfulnessPair[] = [];

  for (const entry of digestEntries) {
    const sepIdx = entry.indexOf(": ");
    if (sepIdx === -1) continue;
    const name = entry.slice(0, sepIdx);
    const compressed = entry.slice(sepIdx + 2);
    const source = sources.get(name);
    if (source === undefined) continue;
    pairs.push({ key: name, source, compressed });
  }

  return pairs;
}

/**
 * Check whether every A2-classified artifact (the 4 digests + everything
 * discovered under context/*.md and USER/TELOS/*.md) is fresh per its own
 * declared class, plus the two legacy artifacts (VaultContext.md,
 * CONTEXT-ROUTING.md) against the plain day threshold.
 *
 * @param opts.vaultContextPath - Path to VaultContext.md (legacy threshold check)
 * @param opts.digestsDir - Directory containing digest JSON files
 * @param opts.contextRoutingPath - Path to CONTEXT-ROUTING.md (legacy threshold check; testability override)
 * @param opts.freshnessThresholdDays - Max age in days for the two legacy artifacts
 * @param opts.archivePath - Path to the approved-work archive jsonl (content-lag check; testability override)
 * @param opts.repoRoot - Root to discover context/*.md, USER/TELOS/*.md, and the
 *   InformationManager config dir from. Defaults to this module's own repo
 *   (via FreshnessClassifier.findRepoRoot()). Override to point at a
 *   different checkout — e.g. the live tree from a worktree session, since a
 *   worktree checkout resets every file's mtime and would otherwise make
 *   every artifact look artificially fresh.
 * @param opts.sourceConfigs - Pre-loaded source configs (testability: skip
 *   real config-dir I/O). Defaults to loading from repoRoot's config dir.
 * @param opts.registry - Pre-loaded artifact-freshness registry (testability,
 *   same rationale as sourceConfigs).
 * @param opts.qualifierInferenceFn - Slice F2 testability override: injected
 *   in place of the real lib/core/Inference.ts `inference()` so tests never
 *   spawn a `claude -p` subprocess. Defaults to the real inference.
 * @param opts.qualifierMaxChecks - Slice F2: caps how many LLM faithfulness
 *   calls a single run makes (default QualifierFaithfulness.MAX_CHECKS_PER_RUN).
 * @param opts.standaloneProbes - Non-artifact reachability probes to run.
 *   Defaults to [] so programmatic/test callers stay hermetic; the CLI
 *   entrypoint (the only production caller — the sentinel invokes the CLI)
 *   passes STANDALONE_REACHABILITY_PROBES. A failed probe flips stale=true.
 * @returns FreshnessResult with stale=true if any artifact is stale
 */
export async function checkFreshness(opts: {
  vaultContextPath?: string;
  digestsDir?: string;
  contextRoutingPath?: string;
  freshnessThresholdDays?: number;
  archivePath?: string;
  repoRoot?: string;
  sourceConfigs?: ReadonlyMap<string, SourceConfigLike>;
  registry?: ReadonlyMap<string, FreshnessDeclaration>;
  qualifierInferenceFn?: QualifierInferenceFn;
  qualifierMaxChecks?: number;
  standaloneProbes?: StandaloneReachabilityProbe[];
}): Promise<FreshnessResult> {
  const vaultContextPath = opts.vaultContextPath ?? DEFAULT_VAULT_CONTEXT;
  const digestsDir = opts.digestsDir ?? DEFAULT_DIGESTS_DIR;
  const contextRoutingPath = opts.contextRoutingPath ?? DEFAULT_CONTEXT_ROUTING_PATH;
  const repoRoot = opts.repoRoot ?? findRepoRoot();

  // Threshold for the two legacy (non-A2-classified) artifacts only:
  // opts → env var → default 7 days.
  const thresholdDays =
    opts.freshnessThresholdDays ??
    (process.env.FRESHNESS_THRESHOLD_DAYS != null
      ? parseFloat(process.env.FRESHNESS_THRESHOLD_DAYS)
      : 7);

  const thresholdMs = thresholdDays * MS_PER_DAY;
  const now = Date.now();

  const staleFiles: string[] = [];

  // ---- Legacy artifacts: VaultContext.md + CONTEXT-ROUTING.md ----
  // NOT run through A2 classification — Slice A2's artifact-freshness.json
  // registry deliberately did not declare these two (VaultContext.md lives
  // outside the repo; CONTEXT-ROUTING.md is a generated index over the
  // classified artifacts). See module doc comment for the residual-gap note.
  const legacyPaths = [vaultContextPath, contextRoutingPath];
  for (const filePath of legacyPaths) {
    if (!existsSync(filePath)) {
      staleFiles.push(filePath);
      continue;
    }
    const stat = statSync(filePath);
    const ageMs = now - stat.mtimeMs;
    if (ageMs > thresholdMs) {
      staleFiles.push(filePath);
    }
  }

  // ---- A2-classified artifacts: digests + widened context/USER-TELOS coverage ----
  const configDir = join(repoRoot, "skills", "Productivity", "InformationManager", "config");
  const sourceConfigs = opts.sourceConfigs ?? loadSourceConfigs(configDir);
  const registry = opts.registry ?? loadRegistry(configDir);

  const classified: ClassifiedArtifactCheck[] = [];

  // The 4 AUTOINFO digests — same artifact set the pre-A3 guard watched,
  // now checked against A2's per-digest dated-snapshot rule (48h) instead
  // of the global --threshold-days.
  for (const name of DIGEST_NAMES) {
    const absolutePath = join(digestsDir, `${name}.json`);
    const artifactKey = `MEMORY/AUTOINFO/digests/${name}.json`;
    const result = classifyAndEvaluate(artifactKey, absolutePath, sourceConfigs, registry, now);
    classified.push(result);
    if (result.stale) staleFiles.push(absolutePath);
  }

  // Widened coverage: every *.md directly under context/ and USER/TELOS/ —
  // includes context/DtrContext.md and context/GraphContext.md, both
  // invisible to the pre-A3 guard.
  const discovered = [
    ...listMarkdownArtifacts(join(repoRoot, "context"), repoRoot),
    ...listMarkdownArtifacts(join(repoRoot, "USER", "TELOS"), repoRoot),
  ];
  for (const artifactKey of discovered) {
    const absolutePath = join(repoRoot, artifactKey);
    const result = classifyAndEvaluate(artifactKey, absolutePath, sourceConfigs, registry, now);
    classified.push(result);
    if (result.stale) staleFiles.push(absolutePath);
  }

  // ---- Standalone reachability probes (not tied to any artifact file) ----
  // Runs after discovery precisely because discovery can't see these: a
  // pointer probe attached to a deleted artifact would otherwise vanish
  // silently (how the graph-tool check was lost when GraphContext.md was
  // retired — see STANDALONE_REACHABILITY_PROBES).
  const standaloneProbes: StandaloneProbeResult[] = [];
  for (const probe of opts.standaloneProbes ?? []) {
    const result = runStandaloneProbe(probe);
    standaloneProbes.push(result);
    if (!result.ok) staleFiles.push(`standalone-probe:${result.name} [${result.reason}]`);
  }

  // Content-lag check: recent-completions.json can pass the mtime check above
  // (it was rebuilt "recently") yet still contain silently-frozen content if the
  // digest's sort key diverges from the archive it's built from (observed: a
  // 4.5-month freeze at 2026-02-19 while the archive kept moving). Compare the
  // digest's max entry date against the archive's max completed-record date.
  let contentLag: FreshnessResult["contentLag"] = null;
  try {
    const archivePath = opts.archivePath ?? DEFAULT_ARCHIVE_PATH;
    const recentCompletionsPath = join(digestsDir, "recent-completions.json");
    const awDigestInfo = awEntriesFromRecentCompletionsDigest(recentCompletionsPath);
    const archiveMaxDate = maxDateFromArchive(archivePath);

    if (awDigestInfo && archiveMaxDate) {
      if (awDigestInfo.awEntryCount === 0) {
        // Crowded-out case (see awEntriesFromRecentCompletionsDigest doc):
        // the archive has completions but the top-40 digest slice is all
        // git-sourced, so there is nothing archive-sourced left to compare
        // dates against. Never page on this — we can't tell "crowded out
        // because genuinely older" from "broken parsing" — but never go
        // silent either.
        console.error(
          `[FreshnessGuard] recent-completions.json: archive has completions up to ${archiveMaxDate} but none are represented in the digest (all entries are git-sourced) — content-lag check skipped`
        );
      } else if (awDigestInfo.maxDate) {
        const lagDays =
          (Date.parse(archiveMaxDate) - Date.parse(awDigestInfo.maxDate)) / MS_PER_DAY;
        if (lagDays > CONTENT_LAG_THRESHOLD_DAYS) {
          contentLag = { digestMaxDate: awDigestInfo.maxDate, archiveMaxDate, lagDays };
          staleFiles.push(
            `${recentCompletionsPath} [content-lag: digest=${awDigestInfo.maxDate} archive=${archiveMaxDate}]`
          );
        }
      }
    }
    // If either file is missing/unparseable, no content-lag flag is added here —
    // the existsSync/mtime checks above already cover the missing-digest case.
  } catch {
    // Never throw from the content-lag check.
  }

  // Slice F2 digest-faithfulness check: does skill-capabilities.json's
  // compressed entry text still carry every load-bearing qualifier present
  // in its SKILL.md source. See module doc + QualifierFaithfulness.ts for
  // why this is scoped to skill-capabilities.json only (the one digest whose
  // source is richer than a verbatim field copy) and why it never throws out
  // of checkFreshness (mirrors the content-lag try/catch above).
  let qualifierFaithfulness: FreshnessResult["qualifierFaithfulness"] = null;
  try {
    const skillCapabilitiesPath = join(digestsDir, "skill-capabilities.json");
    if (existsSync(skillCapabilitiesPath)) {
      const raw = JSON.parse(readFileSync(skillCapabilitiesPath, "utf8")) as { entries?: unknown };
      const entries = Array.isArray(raw.entries) ? raw.entries.filter((e): e is string => typeof e === "string") : [];
      const pairs = buildSkillFaithfulnessPairs(join(repoRoot, "skills"), entries);

      if (pairs.length > 0) {
        const checks = await checkEntriesFaithfulness(pairs, {
          inferenceFn: opts.qualifierInferenceFn,
          maxChecks: opts.qualifierMaxChecks,
        });
        const unfaithful = checks.filter(c => c.faithful === false);
        const errored = checks.filter(c => c.error !== undefined);

        qualifierFaithfulness = {
          checked: checks.filter(c => !c.skipped).length,
          skipped: checks.filter(c => c.skipped).length,
          errored: errored.length,
          unfaithful,
        };

        for (const e of errored) {
          console.error(
            `[FreshnessGuard] qualifier-faithfulness: "${e.key}" errored during check (${e.error}) — never silently treated as faithful`
          );
        }
        if (unfaithful.length > 0) {
          staleFiles.push(
            `${skillCapabilitiesPath} [qualifier-faithfulness: ${unfaithful.map(u => u.key).join(", ")}]`
          );
        }
      }
    }
  } catch (err) {
    // Never throw out of checkFreshness for this check — mirrors the
    // content-lag try/catch above — but never go silent either.
    console.error(
      `[FreshnessGuard] qualifier-faithfulness check failed: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  const checkedFiles = [vaultContextPath, contextRoutingPath, ...classified.map(c => c.absolutePath)];

  return {
    stale: staleFiles.length > 0,
    staleFiles,
    checkedFiles,
    thresholdDays,
    contentLag,
    qualifierFaithfulness,
    classified,
    standaloneProbes,
  };
}

// ============================================================================
// Alert sender (routed through AlertGate — the central alert policy layer)
// ============================================================================

async function sendStaleAlert(staleFiles: string[], thresholdDays: number): Promise<void> {
  const now = Date.now();
  const lines = staleFiles.map(f => {
    let staleDays = "missing";
    try {
      if (existsSync(f)) {
        const age = now - statSync(f).mtimeMs;
        staleDays = `${(age / MS_PER_DAY).toFixed(1)}d old`;
      }
    } catch {
      // file may not exist
    }
    const shortName = f.split("/").slice(-2).join("/");
    return `  • ${shortName} (${staleDays})`;
  });

  const message = [
    `⚠️ FreshnessGuard: ${staleFiles.length} stale artifact(s) (legacy threshold: ${thresholdDays}d; classified artifacts use their own A2 rule)`,
    "",
    ...lines,
    "",
    `Run \`bun bin/run-cron-job.ts daily-upkeep --catchup\` to refresh.`,
  ].join("\n");

  const { sendAlert } = await import("../../../../lib/core/AlertGate.ts");
  const result = await sendAlert(message, { key: "freshness-guard", tier: "page" });
  console.log(`[FreshnessGuard] AlertGate result: ${result}`);
  console.error(`[FreshnessGuard] AlertGate result: ${result}`);
}

// ============================================================================
// CLI entrypoint
// ============================================================================

if (import.meta.main) {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");

  // Parse --vault-context
  const vcIdx = args.indexOf("--vault-context");
  const vaultContextPath = vcIdx >= 0 ? args[vcIdx + 1] : undefined;

  // Parse --digests-dir
  const ddIdx = args.indexOf("--digests-dir");
  const digestsDir = ddIdx >= 0 ? args[ddIdx + 1] : undefined;

  // Parse --context-routing
  const crIdx = args.indexOf("--context-routing");
  const contextRoutingPath = crIdx >= 0 ? args[crIdx + 1] : undefined;

  // Parse --threshold-days
  const tdIdx = args.indexOf("--threshold-days");
  const freshnessThresholdDays = tdIdx >= 0 ? parseFloat(args[tdIdx + 1]) : undefined;

  // Parse --repo-root
  const rrIdx = args.indexOf("--repo-root");
  const repoRoot = rrIdx >= 0 ? args[rrIdx + 1] : undefined;

  try {
    const result = await checkFreshness({
      vaultContextPath,
      digestsDir,
      contextRoutingPath,
      freshnessThresholdDays,
      repoRoot,
      standaloneProbes: STANDALONE_REACHABILITY_PROBES,
    });

    // Always print the per-artifact classification detail — what was
    // flagged AND what was skipped, with the reason for each — regardless
    // of the overall verdict.
    console.log(
      `[FreshnessGuard] Per-artifact classification (${result.classified.length} checked via Slice A2):`
    );
    for (const c of result.classified) {
      const verdict = c.stale ? "STALE" : "fresh";
      console.log(`  [${verdict}] ${c.freshnessClass.padEnd(14)} ${c.artifact} — ${c.reason}`);
    }
    console.log("");

    // Standalone (non-artifact) reachability probes — printed pass or fail,
    // so a silently-skipped probe is visible as an absence in this section.
    console.log(
      `[FreshnessGuard] Standalone reachability probes (${result.standaloneProbes.length} ran):`
    );
    for (const p of result.standaloneProbes) {
      console.log(`  [${p.ok ? "ok" : "UNREACHABLE"}] ${p.name} — ${p.reason}`);
    }
    console.log("");

    // Slice F2: digest-faithfulness summary (skill-capabilities.json only —
    // see module doc for scope rationale).
    if (result.qualifierFaithfulness) {
      const qf = result.qualifierFaithfulness;
      console.log(
        `[FreshnessGuard] Qualifier faithfulness (skill-capabilities.json): ${qf.checked} checked via LLM, ${qf.skipped} skipped (unchanged/no-candidate/budget), ${qf.errored} errored, ${qf.unfaithful.length} unfaithful.`
      );
      for (const u of qf.unfaithful) {
        console.log(`  [UNFAITHFUL] ${u.key} — ${u.reason} (dropped: ${(u.droppedQualifiers ?? []).join("; ")})`);
      }
      console.log("");
    }

    if (!result.stale) {
      console.log(
        `[FreshnessGuard] All ${result.checkedFiles.length} artifacts are fresh (legacy threshold: ${result.thresholdDays}d; classified artifacts use their own A2 rule).`
      );
      process.exit(0);
    }

    // Stale artifacts found — write to both stdout and stderr so tests can reliably capture output
    const staleMsg = `[FreshnessGuard] ${result.staleFiles.length} stale artifact(s) detected (legacy threshold: ${result.thresholdDays}d; classified artifacts use their own A2 rule):`;
    console.log(staleMsg);
    console.error(staleMsg);
    for (const f of result.staleFiles) {
      console.log(`  - ${f}`);
      console.error(`  - ${f}`);
    }

    if (!dryRun) {
      await sendStaleAlert(result.staleFiles, result.thresholdDays);
    } else {
      const dryMsg = "[FreshnessGuard] --dry-run: alert suppressed (AlertGate not called).";
      console.log(dryMsg);
      console.error(dryMsg);
    }

    // CRITICAL: Always exit non-zero when stale (ISC-6, Kaya principle).
    // DETECTION_EXIT_CODE, not 1: staleness was detected AND our own
    // AlertGate page above handled the announcement — exit 1 here made
    // FailStreak/cron-health/incident-triage classify each detection as a
    // 'bug' and page the same incident two more times (observed 2026-08-05
    // → 08-07 on USER/TELOS/STRATEGIES.md). A crash still exits 1 below.
    process.exit(DETECTION_EXIT_CODE);
  } catch (err) {
    console.error("[FreshnessGuard] Fatal error:", err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}
