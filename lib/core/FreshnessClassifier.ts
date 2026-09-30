#!/usr/bin/env bun
/**
 * FreshnessClassifier.ts — Context Integrity Program, Slice A2.
 *
 * WHY THIS EXISTS: a blanket "stale after N days" rule is wrong for this
 * tree. Verified spread in USER/TELOS/: STATUS.md updates every few hours,
 * GOALS.md/STRATEGIES.md roll over roughly quarterly, CHALLENGES.md is a
 * mid-quarter review (~2 months), and MISSIONS.md/BELIEFS.md/MODELS.md are
 * durable statements of intent that have not needed to change since
 * Jan-Feb — and SHOULDN'T be flagged as "stale" for that. A single N-day
 * threshold (the exact shape of skills/Automation/AutoInfoManager/Tools/
 * FreshnessGuard.ts today) manufactures false alarms on the durable files
 * and is too loose for the fast-moving ones. So every artifact must declare
 * which of three regimes it lives in:
 *
 *   - timeless        — no staleness check applies at all (a mission
 *                        statement is not wrong because it's six months old)
 *   - dated-snapshot   — checked against its OWN max age (a cached calendar
 *                        pull IS wrong once it's a day old)
 *   - pointer          — checked for reachability of what it points at, not
 *                        its own age (e.g. GraphContext.md caches a node
 *                        count that only a manual `ingest --all` refreshes —
 *                        an age check on it would page forever; what matters
 *                        is whether the graph tool itself still works)
 *
 * SCHEMA / BACKWARD-COMPAT DECISION: the 9 skills/Productivity/
 * InformationManager/config/*.json files already carry a `freshnessRule`
 * free-text string (e.g. "Update weekly; stale after 7 days", "1h"). That
 * field is read by exactly zero code — the only reference anywhere in the
 * tree was the optional type declaration on SourceConfig in
 * GatheringOrchestrator.ts. Two ways to make it enforceable: (a) parse the
 * existing prose, or (b) add a new structured field and keep the prose as
 * documentation. This file takes (b):
 *   - freshnessRule (string) is UNCHANGED and still present on every config
 *     — GatheringOrchestrator.ts never reads it, so nothing breaks, and it
 *     stays as a human-readable note next to the machine-checkable one.
 *   - freshness (FreshnessDeclaration) is NEW and is the only field this
 *     module or any future enforcer (Slice A3) reads.
 * Parsing the prose was rejected: the four existing strings use four
 * different shapes ("Update X; stale after Y", "1h", pure prose with no
 * duration at all, "User-maintained; update when goals change; tracking
 * metrics weekly") and any regex robust enough to cover all of them would
 * inevitably guess on the next new phrasing instead of failing loud — the
 * one thing this module must never do to an unrecognised value.
 *
 * ARTIFACT COVERAGE: the 9 InformationManager configs only cover their own
 * `output` file (e.g. calendar.json -> context/CalendarContext.md). Every
 * other classified artifact in this program (context/MasterContext.md, the
 * 23 USER/TELOS/*.md files, the 4 MEMORY/AUTOINFO/digests/*.json files) has
 * no existing per-artifact config to extend, so its declaration lives in a
 * new sibling file, skills/Productivity/InformationManager/config/
 * artifact-freshness.json — a flat map of artifact path -> FreshnessDeclaration.
 * One registry, not one file per artifact: 28 entries in a single JSON is
 * easier to audit for gaps than 28 scattered files, and it is the natural
 * extension of "the 9 config files" the plan already pointed at.
 *
 * Architecture: same pure/I-O split as bin/lint-jobs-manifest.ts.
 *   - parseFreshnessDeclaration()      — pure, validates one unknown JSON
 *     value into a FreshnessDeclaration or throws.
 *   - parseArtifactFreshnessRegistry() — pure, validates the whole
 *     artifact-freshness.json shape.
 *   - classifyArtifact()               — pure, resolves one artifact path
 *     against already-loaded config/registry data. Fully unit-testable with
 *     in-memory fixtures, no filesystem access.
 *   - main()                           — thin I/O wrapper: loads the real
 *     config dir + real artifact directories, classifies every artifact it
 *     finds, prints a table, exits non-zero if anything is unclassified or
 *     malformed.
 *
 * Usage:
 *   bun lib/core/FreshnessClassifier.ts
 */

import { existsSync, readdirSync, readFileSync } from "fs";
import { join } from "path";
import { memPathUnder } from "./MemoryPaths.ts";

// ============================================================================
// Types — the three-way freshness classification
// ============================================================================

export type FreshnessClass = "timeless" | "dated-snapshot" | "pointer";

export interface TimelessFreshness {
  class: "timeless";
  /** Why staleness doesn't apply — durable-by-design, not a snapshot. */
  reason: string;
}

export interface DatedSnapshotFreshness {
  class: "dated-snapshot";
  /** Max age in milliseconds before this artifact is considered stale. */
  maxAgeMs: number;
  /** What update cadence this max age is derived from. */
  reason: string;
}

export interface PointerFreshness {
  class: "pointer";
  /** The live source this artifact points at — checked for reachability, not age. */
  pointsTo: string;
  /** Why this artifact is a pointer rather than a snapshot. */
  reason: string;
}

export type FreshnessDeclaration = TimelessFreshness | DatedSnapshotFreshness | PointerFreshness;

/** Thrown for any malformed or missing freshness declaration. Never caught
 *  and defaulted — an unclassified or malformed artifact must fail loud. */
// ============================================================================
// Pure: content analysis — emptiness is judged from the bytes, not the mtime
// ============================================================================

/**
 * Bracketed prose placeholders left by the USER/TELOS scaffolds — `[Your primary
 * life mission]`, `[DATE]`, `[Idea Name]`. Excludes markdown links `[text](…)`
 * / `[text][…]`, reference definitions `[x]:`, wikilinks `[[…]]`, and short
 * tokens like `[D]` or `[x]`. Calibrated 2026-09-11 against every file under
 * USER/TELOS/ and context/: the 10 unfilled scaffolds score 58–77% placeholder
 * lines, every filled file scores 0.
 */
const TEMPLATE_PLACEHOLDER = /(?<!\[)\[[A-Z][^\]\n]{2,}\](?![(\[\]:])/;

/** An artifact is an empty template when at least this many body lines are
 *  placeholders AND they are at least this share of the body. Both bounds
 *  matter: the count stops a lone `[DATE]` from flagging a real file; the
 *  share stops a long real file with a leftover scaffold section from flagging. */
export const EMPTY_TEMPLATE_MIN_PLACEHOLDER_LINES = 3;
export const EMPTY_TEMPLATE_MIN_PLACEHOLDER_SHARE = 0.5;

export interface ArtifactContentAnalysis {
  /** Frontmatter declared `entries_count: 0` — the writer ran and gathered nothing. */
  emptySnapshot: boolean;
  /** Non-blank, non-heading, non-table-rule body lines (frontmatter and HTML comments excluded). */
  bodyLines: number;
  /** Body lines containing a template placeholder. */
  placeholderLines: number;
  /** placeholderLines ≥ EMPTY_TEMPLATE_MIN_PLACEHOLDER_LINES and ≥ EMPTY_TEMPLATE_MIN_PLACEHOLDER_SHARE of bodyLines. */
  emptyTemplate: boolean;
}

/**
 * Judge a markdown artifact's CONTENT. Pure — takes the text, returns facts;
 * the guard decides what to do with them. Two pollution classes the mtime
 * check cannot see (context-pollution audit 2026-09-11, FG-02 / FG-03):
 *   - empty snapshot: a generated file whose frontmatter says `entries_count: 0`
 *     (context/CalendarContext.md sat "fresh" for ~143 days this way);
 *   - empty template: a scaffold nobody filled in (`[Your ...]` placeholders),
 *     routed to sessions as if it were content.
 * Both self-clear the moment real content lands — no registry change needed.
 */
export function analyzeArtifactContent(text: string): ArtifactContentAnalysis {
  let body = text;
  let frontmatter = "";
  if (body.startsWith("---\n")) {
    const end = body.indexOf("\n---", 4);
    if (end > 0) {
      frontmatter = body.slice(4, end);
      body = body.slice(end + 4);
    }
  }
  const emptySnapshot = /^entries_count:\s*0\s*$/m.test(frontmatter);
  body = body.replace(/<!--[\s\S]*?-->/g, "");
  const lines = body
    .split("\n")
    .filter((l) => l.trim() !== "" && !l.trimStart().startsWith("#") && !/^\s*\|?\s*-{2,}/.test(l));
  const placeholderLines = lines.filter((l) => TEMPLATE_PLACEHOLDER.test(l)).length;
  const emptyTemplate =
    placeholderLines >= EMPTY_TEMPLATE_MIN_PLACEHOLDER_LINES &&
    placeholderLines >= EMPTY_TEMPLATE_MIN_PLACEHOLDER_SHARE * lines.length;
  return { emptySnapshot, bodyLines: lines.length, placeholderLines, emptyTemplate };
}

export class FreshnessClassificationError extends Error {}

// ============================================================================
// Pure: parseFreshnessDeclaration — validate + narrow an unknown JSON value
// ============================================================================

/**
 * Validate one unknown JSON value as a FreshnessDeclaration. `artifactLabel`
 * is purely for error messages (which artifact / which config produced this
 * value) — this function does no I/O and no filesystem lookups.
 *
 * Throws FreshnessClassificationError on anything that isn't a well-formed
 * declaration: missing/non-object value, missing "reason", unrecognised
 * "class", or a class-specific field missing/wrong-typed
 * (dated-snapshot needs a positive finite maxAgeMs; pointer needs a
 * non-empty pointsTo). No default is ever returned — silence here would be
 * exactly the "unclassified artifact silently treated as permissive" bug
 * this module exists to prevent.
 */
export function parseFreshnessDeclaration(value: unknown, artifactLabel: string): FreshnessDeclaration {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new FreshnessClassificationError(
      `${artifactLabel}: missing or non-object "freshness" declaration (got ${JSON.stringify(value)}). ` +
        `Every artifact must declare freshness.class as "timeless" | "dated-snapshot" | "pointer".`,
    );
  }
  const record = value as Record<string, unknown>;

  const reason = record.reason;
  if (typeof reason !== "string" || reason.trim() === "") {
    throw new FreshnessClassificationError(
      `${artifactLabel}: freshness declaration is missing a non-empty "reason" string.`,
    );
  }

  switch (record.class) {
    case "timeless":
      return { class: "timeless", reason };

    case "dated-snapshot": {
      const maxAgeMs = record.maxAgeMs;
      if (typeof maxAgeMs !== "number" || !Number.isFinite(maxAgeMs) || maxAgeMs <= 0) {
        throw new FreshnessClassificationError(
          `${artifactLabel}: dated-snapshot declaration requires a positive finite "maxAgeMs" number ` +
            `(got ${JSON.stringify(maxAgeMs)}).`,
        );
      }
      return { class: "dated-snapshot", maxAgeMs, reason };
    }

    case "pointer": {
      const pointsTo = record.pointsTo;
      if (typeof pointsTo !== "string" || pointsTo.trim() === "") {
        throw new FreshnessClassificationError(
          `${artifactLabel}: pointer declaration requires a non-empty "pointsTo" string.`,
        );
      }
      return { class: "pointer", pointsTo, reason };
    }

    default:
      throw new FreshnessClassificationError(
        `${artifactLabel}: unrecognised freshness.class ${JSON.stringify(record.class)} — ` +
          `must be "timeless", "dated-snapshot", or "pointer".`,
      );
  }
}

// ============================================================================
// Pure: parseArtifactFreshnessRegistry — validate artifact-freshness.json
// ============================================================================

/**
 * Validate the whole artifact-freshness.json shape: a flat object mapping
 * artifact path (repo-relative, e.g. "USER/TELOS/STATUS.md") to a raw
 * freshness declaration. Every entry is run through
 * parseFreshnessDeclaration, so a single malformed entry fails the whole
 * load loudly rather than silently dropping that one artifact.
 *
 * Deliberately no `_comment`/`$schema`-style escape hatch: every top-level
 * key is treated as an artifact path and validated. JSON has no native
 * comment syntax, and carving out a magic-prefix convention to skip would
 * itself be a silent special case (and would let a genuine typo'd artifact
 * path — e.g. "_USER/TELOS/STATUS.md" — slip through unvalidated instead of
 * failing loud). Put rationale in this file's doc comments instead.
 */
export function parseArtifactFreshnessRegistry(json: unknown): Map<string, FreshnessDeclaration> {
  if (typeof json !== "object" || json === null || Array.isArray(json)) {
    throw new FreshnessClassificationError(
      `artifact-freshness.json: expected a top-level object mapping artifact path -> freshness declaration, ` +
        `got ${JSON.stringify(json)}.`,
    );
  }
  const registry = new Map<string, FreshnessDeclaration>();
  for (const [artifactPath, raw] of Object.entries(json as Record<string, unknown>)) {
    registry.set(artifactPath, parseFreshnessDeclaration(raw, artifactPath));
  }
  return registry;
}

// ============================================================================
// Pure: classifyArtifact — resolve one artifact's freshness declaration
// ============================================================================

/** The subset of SourceConfig (GatheringOrchestrator.ts) this module needs. */
export interface SourceConfigLike {
  source: string;
  output: string;
  freshness?: unknown;
  /**
   * Optional executable command declared alongside the config (e.g.
   * graph.json's "command": "bun ~/.claude/skills/Graph/Tools/GraphQuerier.ts
   * stats --json"). Not read by this module — carried through purely so
   * Slice A3's FreshnessGuard.ts can probe a `pointer`-class artifact's
   * declared refresh command for reachability instead of checking its age
   * (which the pointer class explicitly forbids). Typed `unknown` like
   * `freshness` above: this module does no validation of it, the consumer
   * narrows at the use site.
   */
  command?: unknown;
  /** Optional timeout (ms) declared alongside `command` — same pass-through
   *  rationale as `command`. */
  timeout?: unknown;
}

/**
 * Resolve the freshness declaration for one artifact path. Two places are
 * searched, in order:
 *
 *   1. sourceConfigs — the 9 InformationManager config/*.json files,
 *      matched by their `output` field (e.g. "context/CalendarContext.md").
 *   2. registry — artifact-freshness.json, for everything the 9 source
 *      configs don't cover (USER/TELOS/*.md, context/MasterContext.md, the
 *      AUTOINFO digests).
 *
 * Pure — takes already-loaded maps, does no I/O. Throws
 * FreshnessClassificationError if neither place has a declaration: an
 * unclassified artifact is a bug to surface, never a file to silently skip.
 */
export function classifyArtifact(
  artifactPath: string,
  sourceConfigs: ReadonlyMap<string, SourceConfigLike>,
  registry: ReadonlyMap<string, FreshnessDeclaration>,
): FreshnessDeclaration {
  for (const config of sourceConfigs.values()) {
    if (config.output === artifactPath) {
      return parseFreshnessDeclaration(config.freshness, `${artifactPath} (source config: ${config.source})`);
    }
  }

  const fromRegistry = registry.get(artifactPath);
  if (fromRegistry) return fromRegistry;

  throw new FreshnessClassificationError(
    `Unclassified artifact: ${artifactPath} — no freshness declaration found in ` +
      `skills/Productivity/InformationManager/config/*.json (matched by "output") or ` +
      `skills/Productivity/InformationManager/config/artifact-freshness.json. ` +
      `Add one before this artifact can pass freshness enforcement.`,
  );
}

// ============================================================================
// I/O wrapper — thin, real filesystem access
// ============================================================================

/**
 * Repo root, computed relative to THIS module's own location (not
 * getKayaHome()/KAYA_HOME) — so it resolves correctly no matter which
 * checkout this file is running from (live tree, a worktree, or a scratch
 * copy), and callers that need to point at a *different* tree entirely
 * (Slice A3's live-tree-vs-worktree verification split) can still override
 * it explicitly rather than being locked to wherever this module happens to
 * live. Exported for FreshnessGuard.ts (Slice A3) to reuse as its own
 * default rather than duplicating this join() elsewhere.
 */
export function findRepoRoot(): string {
  // lib/core/ -> lib -> repo root
  return join(import.meta.dir, "..", "..");
}

/** Exported for FreshnessGuard.ts (Slice A3) — loads the same 9
 *  InformationManager source configs this module classifies against, so
 *  A3's enforcement never re-parses config/*.json with different rules. */
export function loadSourceConfigs(configDir: string): Map<string, SourceConfigLike> {
  const map = new Map<string, SourceConfigLike>();
  if (!existsSync(configDir)) return map;
  for (const name of readdirSync(configDir)) {
    if (!name.endsWith(".json") || name === "artifact-freshness.json") continue;
    const raw = JSON.parse(readFileSync(join(configDir, name), "utf-8")) as Record<string, unknown>;
    const source = raw.source;
    const output = raw.output;
    if (typeof source !== "string" || typeof output !== "string") {
      throw new FreshnessClassificationError(`${name}: source config is missing string "source"/"output" fields.`);
    }
    map.set(source, { source, output, freshness: raw.freshness, command: raw.command, timeout: raw.timeout });
  }
  return map;
}

/** Exported for FreshnessGuard.ts (Slice A3) — same rationale as
 *  loadSourceConfigs above. */
export function loadRegistry(configDir: string): Map<string, FreshnessDeclaration> {
  const registryPath = join(configDir, "artifact-freshness.json");
  const json = JSON.parse(readFileSync(registryPath, "utf-8"));
  return parseArtifactFreshnessRegistry(json);
}

/** .md files directly in `dir`, excluding *.compressed.md (Slice A4 owns
 *  deleting those — this module ignores them entirely). Returns paths
 *  relative to repoRoot. Exported for FreshnessGuard.ts (Slice A3), which
 *  needs the exact same context/ and USER/TELOS/ discovery this module's
 *  own main() uses — reusing it instead of re-implementing directory
 *  listing keeps "which .md files count as artifacts" defined in one place. */
export function listMarkdownArtifacts(dir: string, repoRoot: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith(".md") && !name.endsWith(".compressed.md"))
    .map((name) => join(dir, name).slice(repoRoot.length + 1));
}

/** .json files directly in `dir`. Returns paths relative to repoRoot. */
function listJsonArtifacts(dir: string, repoRoot: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith(".json"))
    .map((name) => join(dir, name).slice(repoRoot.length + 1));
}

function main(): void {
  const repoRoot = findRepoRoot();
  const configDir = join(repoRoot, "skills/Productivity/InformationManager/config");

  const sourceConfigs = loadSourceConfigs(configDir);
  const registry = loadRegistry(configDir);

  const artifacts = [
    ...listMarkdownArtifacts(join(repoRoot, "context"), repoRoot),
    ...listMarkdownArtifacts(join(repoRoot, "USER/TELOS"), repoRoot),
    ...listJsonArtifacts(memPathUnder(repoRoot, "AUTOINFO", "digests"), repoRoot),
  ].sort();

  const rows: { artifact: string; freshnessClass: FreshnessClass; detail: string }[] = [];
  const failures: string[] = [];

  for (const artifact of artifacts) {
    try {
      const decl = classifyArtifact(artifact, sourceConfigs, registry);
      const detail =
        decl.class === "dated-snapshot"
          ? `maxAgeMs=${decl.maxAgeMs}`
          : decl.class === "pointer"
            ? `pointsTo=${decl.pointsTo}`
            : "";
      rows.push({ artifact, freshnessClass: decl.class, detail });
    } catch (error) {
      failures.push(error instanceof Error ? error.message : String(error));
    }
  }

  console.log(`FreshnessClassifier: classified ${rows.length}/${artifacts.length} artifact(s):\n`);
  for (const row of rows) {
    const line = `  ${row.freshnessClass.padEnd(15)} ${row.artifact}${row.detail ? `  (${row.detail})` : ""}`;
    console.log(line);
  }

  if (failures.length > 0) {
    console.error(`\nFreshnessClassifier: ${failures.length} artifact(s) failed classification:`);
    for (const f of failures) console.error(`  - ${f}`);
    process.exit(1);
  }

  process.exit(0);
}

if (import.meta.main) {
  main();
}
