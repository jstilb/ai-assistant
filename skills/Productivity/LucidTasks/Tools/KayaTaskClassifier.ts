#!/usr/bin/env bun
/**
 * KayaTaskClassifier.ts - LLM-driven decision: can Kaya autonomously execute this task?
 *
 * Replaces the dead `@kaya` context_tag convention used by TriageLucidTasks.
 * Sends a batch of active tasks to Sonnet and returns per-task 3-way clarity verdicts.
 *
 * Note: The triage-sweep CLI (--enqueue / --backfill / --threshold) has been retired.
 * Capture routing is now done by the agent workflows (Triage-Inbox.md / scratch pad),
 * not a TS router. This file retains the LLM clarity-classification core
 * (classifyTasksForKaya, ClarityVerdictSchema, etc.) and pure helper exports
 * (computeTriageHash, partitionGrilledItems, decideBackfillAction) for the spec pipeline.
 */

import { join } from "path";
import { readdirSync, existsSync, readFileSync } from "fs";
import { z } from "zod";
import { inference } from "../../../../lib/core/Inference.ts";
import { getKayaHome } from "../../../../lib/core/KayaHome.ts";
import { memPath } from "../../../../lib/core/MemoryPaths.ts";
import { recordFailure } from "../../../../lib/core/FailureLog.ts";
// cross-skill-allowed: the classification engine reads queue context by design (shared engine across LucidTasks/QueueRouter/InformationManager)
import { QueueManager, hasValidGrillStamp, type QueueItem } from "../../../Automation/QueueRouter/Tools/QueueManager.ts";
// cross-skill-allowed: the classification engine reads digest context by design (shared engine across LucidTasks/QueueRouter/InformationManager)
import { buildAllDigests, type DigestFile } from "../../InformationManager/DigestBuilder.ts";
// Context Integrity Program Slice D2 — on-stale refresh must use the SAME
// canonical freshness declaration (artifact-freshness.json, Slice A2) that
// FreshnessGuard.ts (Slice A3) already enforces, rather than a second
// hardcoded threshold that could silently drift out of sync with it. This is
// the "ensure our system's refresh process is consistent" guarantee.
import { classifyArtifact, findRepoRoot, loadRegistry, loadSourceConfigs, type FreshnessDeclaration, type SourceConfigLike } from "../../../../lib/core/FreshnessClassifier.ts";

const KAYA_HOME = getKayaHome();

// NOTE: The pre-LLM staleness guard (skip tasks >60d with no human activity) was
// removed 2026-06-10 at Jm's direction: stale tasks must be VISIBLE, not silently
// dropped. The triage stamp (kaya_triage hash) already guarantees each task is
// judged at most once per content change, so the guard's cost rationale is gone.
// Old tasks now get one verdict and end up parked (Kaya project) or stamped.

// ============================================================================
// Skill inventory (for prompt guards)
// ============================================================================

/**
 * Enumerate existing skill names as "Category/Name" strings by walking
 * skills/ two levels deep looking for directories that contain a SKILL.md.
 * Result is sorted and cached per-process.
 *
 * Exported for testing — callers may inject a custom skillsDir to avoid
 * touching the filesystem in unit tests.
 */
export function enumerateSkillNames(skillsDir?: string): string[] {
  const dir = skillsDir ?? join(KAYA_HOME, "skills");
  if (!existsSync(dir)) return [];

  const names: string[] = [];

  let categories: string[];
  try {
    categories = readdirSync(dir, { withFileTypes: true })
      .filter(e => e.isDirectory())
      .map(e => e.name);
  } catch {
    return [];
  }

  for (const cat of categories) {
    const catPath = join(dir, cat);
    // Check if SKILL.md is directly in the category dir (flat skill)
    if (existsSync(join(catPath, "SKILL.md"))) {
      names.push(cat);
    }
    // Also check one level deeper (Category/Name/SKILL.md)
    let children: string[];
    try {
      children = readdirSync(catPath, { withFileTypes: true })
        .filter(e => e.isDirectory())
        .map(e => e.name);
    } catch {
      continue;
    }
    for (const child of children) {
      if (existsSync(join(catPath, child, "SKILL.md"))) {
        names.push(`${cat}/${child}`);
      }
    }
  }

  return names.sort();
}

// ============================================================================
// Types
// ============================================================================

export interface LucidTaskInput {
  id: string;
  title: string;
  description?: string;
  status: string;
  queue_item_id?: string | null;
  project_id?: string | null;
  project_name?: string;
  /** ISO string — used by the staleness guard. May be absent in legacy/injected test data. */
  created_at?: string;
  /** JSON TriageStamp recorded for skipped tasks; valid stamp = skip re-judging. */
  kaya_triage?: string | null;
}

// ============================================================================
// Schema — 3-way clarity verdict
// ============================================================================

/**
 * The kind of artifact a work item targets.
 * Declared once by the classifier; carried on every downstream item.
 * UX/UI generation fires only for `browser` and `native`.
 */
export const SurfaceEnum = z.enum(["browser", "native", "cli", "api", "library"]);
export type Surface = z.infer<typeof SurfaceEnum>;

/**
 * How much effort a work item requires. Judged by the LLM alongside clarity —
 * no thresholds, no keyword rules. Drives IntakeRunner's routing split within
 * disposition='autonomous' LucidTasks: "project" scope goes through the spec
 * pipeline (research + spec before work begins); "lightweight" scope is left
 * for the Lane A autonomous executor to run directly.
 */
export const ScopeEnum = z.enum(["lightweight", "project"]);
export type Scope = z.infer<typeof ScopeEnum>;

export const ClarityVerdictSchema = z
  .object({
    id: z.string(),
    verdict: z.enum(["clear", "needs-grill", "not-executable"]),
    confidence: z.number().min(0).max(1),
    /**
     * What the task targets. Set by the LLM classifier; optional for back-compat
     * with legacy verdicts that predate this field. Absent → unknown → skip
     * auto UX/UI, allow manual trigger.
     */
    surface: SurfaceEnum.optional(),
    /**
     * Effort scope. Set by the LLM classifier; optional for back-compat with
     * legacy verdicts that predate this field. Absent → callers default to the
     * safe "lightweight" reading (never auto-routed into the heavier spec
     * pipeline without a positive, explicit "project" signal).
     */
    scope: ScopeEnum.optional(),
    reasoning: z.string(),
    missing: z.array(z.string()).optional(),
    suggested_questions: z.array(z.string()).optional(),
  })
  .superRefine((val, ctx) => {
    if (val.verdict === "needs-grill") {
      if (!val.missing || val.missing.length === 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["missing"],
          message: "needs-grill verdict requires non-empty missing[]",
        });
      }
      if (!val.suggested_questions || val.suggested_questions.length === 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["suggested_questions"],
          message: "needs-grill verdict requires non-empty suggested_questions[]",
        });
      }
    }
  });

export type ClarityVerdict = z.infer<typeof ClarityVerdictSchema>;

// ============================================================================
// Surface persistence helper (exported for testing + callers)
// ============================================================================

/**
 * Build the context fragment carrying `surface` onto a spec-pipeline item.
 *
 * Pure function — no I/O, fully unit-testable.
 *
 * When `surface` is present, returns `{ surface }`.
 * When `surface` is absent/undefined (legacy verdict), returns `{}` so callers
 * can safely spread it without polluting the context with an explicit `undefined`.
 */
export function buildSurfaceContext(
  surface: Surface | undefined
): Record<string, unknown> {
  if (surface === undefined) return {};
  return { surface };
}

// ============================================================================
// Pure routing functions (exported for testing)
// ============================================================================

/**
 * Decide the backfill routing action for an already-queued awaiting-context item
 * based on its re-judged ClarityVerdict.
 *
 * Pure function — no I/O, fully unit-testable.
 *
 * - clear       → "advance"  (attach context + move toward researching)
 * - needs-grill → "park"     (parkForGrill with the brief)
 * - not-executable → "park"  (parked too — needs-grilling is the single visible
 *                             holding pen; Jm confirms or kills at grill time)
 */
export function decideBackfillAction(
  verdict: ClarityVerdict["verdict"]
): "advance" | "park" {
  switch (verdict) {
    case "clear":          return "advance";
    case "needs-grill":    return "park";
    case "not-executable": return "park";
  }
}

/**
 * Returns true if projectName is "kaya" (case-insensitive, exact match).
 */
export function isKayaProject(projectName: string | undefined): boolean {
  if (!projectName) return false;
  return projectName.trim().toLowerCase() === "kaya";
}

// ============================================================================
// Triage stamp — persisted skip verdicts (stops hourly re-judging)
// ============================================================================

/**
 * Shape of the JSON stored in tasks.kaya_triage for skipped (non-enqueued)
 * tasks. `hash` covers project+title+description so any edit (or project
 * move) invalidates the stamp and the task is re-judged.
 */
export interface TriageStamp {
  verdict: ClarityVerdict["verdict"];
  confidence: number;
  reasoning: string;
  hash: string;
  at: string;
  /** Scope judged alongside verdict (IntakeRunner) — informational only, not re-validated by hasValidTriageStamp. */
  scope?: Scope;
}

// Stamp hash lives in lib/core/EscalationHelper.ts (lifted 2026-07-05, F2) so
// the stamper (EscalationHelper) and this validator share one hash source.
// Re-exported here because IntakeRunner and the classifier tests import it
// from this module.
export { computeTriageHash } from "../../../../lib/core/EscalationHelper.ts";
import { computeTriageHash } from "../../../../lib/core/EscalationHelper.ts";

/**
 * Returns true if the task carries a still-valid triage stamp (verdict
 * recorded for its current content) and should NOT be re-judged.
 * Malformed stamps are treated as absent (task gets re-judged).
 */
export function hasValidTriageStamp(task: LucidTaskInput): boolean {
  if (!task.kaya_triage) return false;
  try {
    const stamp = JSON.parse(task.kaya_triage) as Partial<TriageStamp>;
    if (typeof stamp.hash !== "string") return false;
    return stamp.hash === computeTriageHash(task.project_name, task.title, task.description ?? "");
  } catch {
    return false;
  }
}

/**
 * Build the grill brief for a park-grill routed verdict.
 *
 * needs-grill verdicts carry their own missing[]/suggested_questions[]
 * (schema-enforced). not-executable and low-confidence-clear verdicts — which
 * Kaya-project routing now parks instead of silently skipping — get sensible
 * defaults so the grill flow always has something to work with, plus the
 * verdict + reasoning so Jm can overrule (or kill) the LLM's call.
 *
 * Pure function — no I/O, fully unit-testable.
 */
export function buildGrillBrief(v: ClarityVerdict): {
  missing: string[];
  suggested_questions: string[];
  confidence: number;
  verdict: ClarityVerdict["verdict"];
  reasoning: string;
} {
  let missing = v.missing ?? [];
  let questions = v.suggested_questions ?? [];

  if (missing.length === 0) {
    missing = v.verdict === "not-executable"
      ? [`LLM judged not-executable: ${v.reasoning}`]
      : [`Low-confidence ${v.verdict} verdict (${v.confidence.toFixed(2)}) — scope needs confirmation`];
  }
  if (questions.length === 0) {
    questions = v.verdict === "not-executable"
      ? ["Should Kaya attempt this anyway, or should it be killed/kept as a personal task?"]
      : ["Is the target, scope, and expected output as the classifier understood it?"];
  }

  return {
    missing,
    suggested_questions: questions,
    confidence: v.confidence,
    verdict: v.verdict,
    reasoning: v.reasoning,
  };
}

// ============================================================================
// Context digest loading
// ============================================================================

const DIGESTS_DIR = memPath("AUTOINFO", "digests");
// Used ONLY when the canonical A2/A3 classification (below) can't be loaded —
// this module's own pre-D2 value, kept as a defensive fallback so
// loadContextDigests() can never hard-fail triage over a broken config dir.
const DIGEST_STALE_HOURS_FALLBACK = 48;

interface LoadedDigests {
  skillCapabilities: string[];
  activeProjectsGoals: string[];
  recentCompletions: string[];
  vaultFolderMap: string[];
  warnings: string[];
}

const DIGEST_NAMES = [
  { key: "skillCapabilities" as const, file: "skill-capabilities.json", label: "skill-capabilities" },
  { key: "activeProjectsGoals" as const, file: "active-projects-goals.json", label: "active-projects-goals" },
  { key: "recentCompletions" as const, file: "recent-completions.json", label: "recent-completions" },
  { key: "vaultFolderMap" as const, file: "vault-folder-map.json", label: "vault-folder-map" },
];

export interface LoadContextDigestsOptions {
  /** Directory containing the 4 digest JSON files. Defaults to memPath("AUTOINFO", "digests"). */
  digestsDir?: string;
  /** Repo root used to resolve the InformationManager config dir for the
   *  canonical A2/A3 freshness declaration. Defaults to
   *  FreshnessClassifier.findRepoRoot(). Override for tests. */
  repoRoot?: string;
  /** Pre-loaded source configs — testability: skips real config-dir I/O. */
  sourceConfigs?: ReadonlyMap<string, SourceConfigLike>;
  /** Pre-loaded artifact-freshness registry — testability, same rationale. */
  registry?: ReadonlyMap<string, FreshnessDeclaration>;
  /**
   * Injected digest rebuild function. Defaults to the real buildAllDigests.
   * Testability seam: lets a test simulate a rebuild success or failure
   * without touching the real skills/ tree, git, TELOS, or LucidTasks.
   */
  buildAllDigestsFn?: (force: boolean) => Record<string, string[]>;
  /** Injected "now" (ms epoch) for deterministic staleness tests. */
  now?: number;
}

/**
 * Load all four context digests from disk.
 *
 * On stale OR missing: bypasses the (possibly stale) cached JSON, triggers
 * ONE regeneration pass in place (buildAllDigests — reads the real
 * underlying sources: skills/, TELOS, LucidTasks, git) and uses the
 * freshly-rebuilt entries. This is the Context Integrity Program Slice D2
 * fix: the pre-D2 version of this function only rebuilt on MISSING digests —
 * a digest that existed but had gone stale (>48h) was logged as a warning
 * and then silently served anyway ("continuing with partial context"). Per
 * Jm's ruling, staleness must "degrade to source of truth and refresh then
 * and there," not just get logged and ignored.
 *
 * STALENESS SOURCE OF TRUTH (the *consistency* half of that ruling — "that
 * assumes our process for ensuring context is fresh is consistent"): each
 * digest's own max age comes from the SAME canonical declaration
 * FreshnessGuard.ts (Slice A3) already enforces —
 * skills/Productivity/InformationManager/config/artifact-freshness.json via
 * FreshnessClassifier.classifyArtifact() (Slice A2) — not a second,
 * independently-hardcoded threshold that could silently drift out of sync
 * with it. All 4 digests are declared `dated-snapshot` with
 * maxAgeMs=172800000 (48h) there today. If that classification can't be
 * loaded at all (config dir missing/malformed — should not happen in
 * production), DIGEST_STALE_HOURS_FALLBACK (this module's pre-D2 48h value)
 * is used instead so this function's "never hard-fail triage" contract
 * holds either way — but the fallback itself is never silent: it is logged
 * to stderr AND recorded via FailureLog.recordFailure (tier "log"), per
 * "cron wrappers must not silently exit 0 on degraded runs" generalized to
 * "must not silently degrade quality on degraded runs" either.
 *
 * LOOP GUARD (infinite-refresh protection): regeneration is attempted AT
 * MOST ONCE per call — there is no retry-if-still-stale loop inside this
 * function. A successful rebuild's own writeDigest() (DigestBuilder.ts)
 * always stamps a fresh `generatedAt`, so a successful rebuild is
 * unconditionally fresh; a FAILING rebuild is reported loudly (console
 * warning + recordFailure) and this call returns immediately with the best
 * available data (the stale/parsed snapshot, or an empty array for a digest
 * that was missing) rather than retrying in a loop. The next EXTERNAL call
 * (the next classification batch) will try again on its own — that is the
 * intended "keep healing until fixed" behaviour, not an in-call spin.
 */
export function loadContextDigests(opts: LoadContextDigestsOptions = {}): LoadedDigests {
  const digestsDir = opts.digestsDir ?? DIGESTS_DIR;
  const now = opts.now ?? Date.now();
  const buildAllDigestsFn = opts.buildAllDigestsFn ?? buildAllDigests;

  const result: LoadedDigests = {
    skillCapabilities: [],
    activeProjectsGoals: [],
    recentCompletions: [],
    vaultFolderMap: [],
    warnings: [],
  };

  // Load the canonical A2/A3 freshness declaration once per call. Failure
  // here is non-fatal (falls back to DIGEST_STALE_HOURS_FALLBACK below) but
  // IS surfaced loudly — a broken classification config is itself a bug
  // worth knowing about, not something to paper over.
  let sourceConfigs: ReadonlyMap<string, SourceConfigLike> | null = opts.sourceConfigs ?? null;
  let registry: ReadonlyMap<string, FreshnessDeclaration> | null = opts.registry ?? null;
  if (!sourceConfigs || !registry) {
    try {
      const repoRoot = opts.repoRoot ?? findRepoRoot();
      const configDir = join(repoRoot, "skills", "Productivity", "InformationManager", "config");
      sourceConfigs = sourceConfigs ?? loadSourceConfigs(configDir);
      registry = registry ?? loadRegistry(configDir);
    } catch (err) {
      sourceConfigs = null;
      registry = null;
      const message = err instanceof Error ? err.message : String(err);
      result.warnings.push(
        `Canonical freshness classification unavailable (${message}) — falling back to hardcoded ${DIGEST_STALE_HOURS_FALLBACK}h threshold.`
      );
      recordFailure({
        source: "KayaTaskClassifier.loadContextDigests",
        error: err,
        context: { step: "load-freshness-classification" },
        tier: "log",
      });
    }
  }

  let anyMissing = false;
  let anyStale = false;
  const staleLabels: string[] = [];

  for (const { key, file, label } of DIGEST_NAMES) {
    const fullPath = join(digestsDir, file);
    const artifactKey = `MEMORY/AUTOINFO/digests/${file}`;

    // Resolve this digest's own max age: canonical A2 declaration first,
    // hardcoded fallback second. classifyArtifact() failing for one artifact
    // (should be unreachable given A2's 37/37 coverage — see
    // FreshnessGuard.ts's identical rationale) falls back the same way a
    // wholesale classification-load failure does, without re-logging (the
    // module-level failure record above already covers that case).
    let maxAgeMs = DIGEST_STALE_HOURS_FALLBACK * 60 * 60 * 1000;
    if (sourceConfigs && registry) {
      try {
        const decl = classifyArtifact(artifactKey, sourceConfigs, registry);
        if (decl.class === "dated-snapshot") maxAgeMs = decl.maxAgeMs;
      } catch {
        // Falls back to the hardcoded threshold — see comment above.
      }
    }

    if (!existsSync(fullPath)) {
      anyMissing = true;
      result.warnings.push(`Context digest missing: ${label} — will trigger build`);
      continue;
    }
    try {
      const raw = readFileSync(fullPath, "utf8");
      const parsed = JSON.parse(raw) as DigestFile;
      const ageMs = now - new Date(parsed.generatedAt).getTime();
      if (ageMs > maxAgeMs) {
        anyStale = true;
        staleLabels.push(label);
        result.warnings.push(
          `Context digest stale (${Math.round(ageMs / 3600000)}h, max ${Math.round(maxAgeMs / 3600000)}h): ${label} — refreshing in place`
        );
      }
      // Recorded regardless of staleness — the fallback this call serves if
      // regeneration below fails. "Degrade to source of truth" beats
      // "degrade to nothing", but a live refresh always wins when it works.
      result[key] = parsed.entries || [];
    } catch (err) {
      result.warnings.push(`Context digest parse error for ${label}: ${String(err)}`);
    }
  }

  // Regeneration: attempted AT MOST ONCE (loop guard — see doc comment
  // above), whenever anything was missing OR stale. Uses buildAllDigests's
  // own per-digest 24h TTL (buildAllDigestsFn(false), not force) — always
  // <= the 48h canonical threshold above, so anything this function
  // considers stale is guaranteed to actually get rebuilt, while digests
  // that are merely 24-48h old (not yet stale by the canonical rule) are
  // also opportunistically refreshed at no extra cost.
  if (anyMissing || anyStale) {
    try {
      const rebuilt = buildAllDigestsFn(false);
      for (const { key, file } of DIGEST_NAMES) {
        const stem = file.replace(/\.json$/, "");
        if (rebuilt[stem]) result[key] = rebuilt[stem];
      }
      const reasons = [
        ...(anyMissing ? ["missing digest(s)"] : []),
        ...(staleLabels.length ? [`stale: ${staleLabels.join(", ")}`] : []),
      ].join("; ");
      result.warnings.push(`Context digests refreshed in place (${reasons}).`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      result.warnings.push(
        `Context digest regeneration FAILED (${message}) — serving last-known on-disk snapshot, which may still be stale.`
      );
      recordFailure({
        source: "KayaTaskClassifier.loadContextDigests",
        error: err,
        context: { anyMissing, staleLabels },
        tier: "log",
      });
      // No retry inside this call (loop guard): `result` keeps whatever the
      // read pass above already populated (stale content for digests that
      // existed, empty arrays for digests that were missing). The next
      // EXTERNAL call will attempt regeneration again on its own.
    }
  }

  return result;
}

// ============================================================================
// System prompt — 3-way verdict
// ============================================================================

/**
 * Build the full system prompt, injecting the live skill inventory so the LLM
 * can detect tasks that are already covered by an existing capability.
 *
 * Now also injects four Context Digests before the skill-name list:
 *   - Skill Capabilities (from SKILL.md descriptions)
 *   - Active Projects & Goals (from LucidTasks + TELOS)
 *   - Recent Completions (most recent finished work: AW archive + git merges)
 *   - Vault Folder Map (from VaultContext.md)
 *
 * Exported so tests can verify the injection contract without LLM calls.
 */
export function buildSystemPrompt(skillNames: string[]): string {
  const digests = loadContextDigests();

  // Emit warnings to stderr (non-blocking — never fail triage)
  for (const w of digests.warnings) {
    process.stderr.write(`[KayaTaskClassifier] WARNING: ${w}\n`);
  }

  const skillList = skillNames.length > 0
    ? skillNames.map(s => `- ${s}`).join("\n")
    : "- (none found)";

  // Build digest sections (empty sections are omitted)
  const skillCapabilitiesSection = digests.skillCapabilities.length > 0
    ? `## Skill Capabilities (what Kaya can already do)\n\n${digests.skillCapabilities.map(e => `- ${e}`).join("\n")}`
    : "";

  const activeProjectsSection = digests.activeProjectsGoals.length > 0
    ? `## Active Projects & Goals\n\n${digests.activeProjectsGoals.map(e => `- ${e}`).join("\n")}`
    : "";

  const recentCompletionsSection = digests.recentCompletions.length > 0
    ? `## Recent Completions (most recent finished work)\n\n${digests.recentCompletions.map(e => `- ${e}`).join("\n")}`
    : "";

  const vaultFolderSection = digests.vaultFolderMap.length > 0
    ? `## Vault Folder Map (Obsidian knowledge base structure)\n\n${digests.vaultFolderMap.map(e => `- ${e}`).join("\n")}`
    : "";

  const digestBlock = [
    skillCapabilitiesSection,
    activeProjectsSection,
    recentCompletionsSection,
    vaultFolderSection,
  ].filter(Boolean).join("\n\n");

  const contextPreamble = digestBlock
    ? `## Context: Kaya's Current Capabilities and State\n\nUse this context to make accurate executability judgments. Kaya's active projects, recent completions, and vault structure tell you what has already been built and what Jm is working on.\n\n${digestBlock}\n\n`
    : "";

  return `You are evaluating tasks from Jm's task list to decide which ones Kaya (his AI agent) can execute, and whether they are specified clearly enough to begin immediately.

${contextPreamble}## Executability axis — Kaya CAN vs CANNOT

Kaya CAN do:
- Software engineering: write/debug/refactor code, set up dev environments, run tests, build features, audit codebases
- Research: web search, summarize articles, evaluate tools/products, read papers/dissertations, gather references
- Spec & plan generation, technical writing for systems/code
- Information gathering and document analysis
- Email/Telegram message drafting (sending requires Jm's approval)
- Anki card creation, Obsidian note generation, knowledge graph queries
- Online shopping via Instacart/Commerce skills for specific, well-defined items
- DnD content (magical items, encounters), recipes/cooking research
- Configuring software, automations, scheduled jobs, deployments

Kaya CANNOT do:
- Physical presence tasks: phone calls, in-person visits, errands, dance classes, piano lessons, going somewhere
- Tasks hinging on Jm's real-time human judgment: "decide what to do with X", "pick the MVP value prop", subjective preference calls
- Personal/creative work where Jm's voice matters: writing personal letters (Valentine, family), writing chapters of Jm's memoir/book
- Financial transactions, signing legal/medical documents, making appointments by phone
- Tasks Jm explicitly marked "Manual:" — those are reserved for him
- Anything requiring Jm's physical body (his own exercise, his own cooking practice, his own piano playing)
- Personal-life errands: grocery runs, restaurant reservations, travel bookings, purchasing physical goods
- Purchases, trip plans, and media/essay ideas that have no software-deliverable component
- Physical-world tasks: home maintenance, vehicle care, in-person social plans

IMPORTANT: The above "cannot" list is not exhaustive. Any task that is purely a personal-life errand,
purchase, trip plan, media consumption plan, or physical-world activity is NOT executable by Kaya
and must be classified "not-executable". These tasks belong in LucidTasks/LifeOS as personal
reminders, not in the software development pipeline.

## Already-built capability guard

The following skills already exist in Kaya's codebase. If a task's core ask appears to be already
covered by one of these skills (i.e., the task is asking Kaya to build something that already
exists), emit verdict "needs-grill" with a note in reasoning: "verify-already-built: <SkillName>"
and set missing[] to ["Confirm whether existing <SkillName> skill already handles this"].

Existing skills:
${skillList}

## Clarity axis — clear vs needs-grill

For tasks Kaya CAN execute, further evaluate whether the intent and detail are sufficient to write a spec now:

"clear" = Kaya-executable AND the task has enough detail to begin immediately (target, scope, expected output, constraints are clear from title+description).

"needs-grill" = Kaya-executable BUT underspecified — key information is missing. Use these analytical lenses to identify gaps:
  - kill: At what result would this not be worth doing? (stop condition missing)
  - negative_space: What was NOT said or avoided? (undeclared assumptions)
  - premortem: If this fails in 6 months, what is the most likely cause? (risk gaps)
Frame missing[] items using these lenses. Then generate 3-5 Socratic questions to resolve the gaps.

"not-executable" = Cannot be done by Kaya autonomously (needs Jm's body, judgment, or voice).

## Surface field — what does this task target?

For tasks Kaya CAN execute, also determine the surface:

- "browser"  — a web UI (React app, web page, SPA, browser extension, web dashboard)
- "native"   — a mobile or desktop app UI (iOS, Android, macOS, Electron)
- "cli"      — a command-line tool, shell script, or terminal interface
- "api"      — an HTTP/REST/GraphQL API, webhook, or service endpoint (no user-facing UI)
- "library"  — a reusable module, package, SDK, or internal utility (no direct user interface)

Rules:
- Emit "surface" when the task clearly fits one category.
- If the task is not software-facing (e.g. research, writing, configuration), omit "surface".
- If the task could be multiple surfaces (e.g. both API + browser client), pick the dominant one from the task description.

## Scope field — lightweight vs project

For tasks Kaya CAN execute (clear or needs-grill), also judge the scope of effort required:

- "lightweight" — a small, self-contained action completable in a single sitting with no dedicated research or spec generation (e.g. a one-line config change, drafting a specific email, creating one Anki deck, a quick script, answering a single research question).
- "project" — a multi-step engineering or research effort that benefits from dedicated research and a written spec before work begins (e.g. building a new skill, a multi-file refactor, designing a new system, an investigation spanning multiple sources).

Judge scope from the task's actual content — no keyword lists, no thresholds. When genuinely unsure, prefer "lightweight" (the safe default: it stays with the fast autonomous executor rather than being pulled into the heavier spec pipeline).

Rules:
- Emit "scope" for clear or needs-grill tasks.
- Omit "scope" for not-executable tasks (scope is meaningless — the task isn't happening).

## Output format

For each task output exactly:
{
  "id": string,
  "verdict": "clear" | "needs-grill" | "not-executable",
  "confidence": number (0-1),
  "surface": "browser" | "native" | "cli" | "api" | "library" (omit if not applicable),
  "scope": "lightweight" | "project" (omit if not applicable),
  "reasoning": string (one short sentence),
  "missing": string[] (required and non-empty for needs-grill; omit or [] for others),
  "suggested_questions": string[] (3-5 questions, required and non-empty for needs-grill; omit or [] for others)
}

Bias: be conservative on executability. When ambiguous between not-executable and needs-grill, prefer "needs-grill" — ambiguous tasks park for clarification rather than being silently discarded. For clear vs needs-grill, a short task title with no description is almost always needs-grill.

Output ONLY a JSON array, one object per input task, in the same order. No prose, no markdown fences.`;
}

// ============================================================================
// Pure helpers (exported for testing)
// ============================================================================

/**
 * Split `arr` into sequential chunks of at most `size` elements.
 *
 * Pure function — no I/O. Exported so tests can exercise it directly.
 *
 * chunk([1,2,3,4,5], 2) → [[1,2],[3,4],[5]]
 * chunk([], 25)          → []
 */
export function chunk<T>(arr: T[], size: number): T[][] {
  if (size <= 0) throw new Error("chunk: size must be > 0");
  const result: T[][] = [];
  for (let i = 0; i < arr.length; i += size) {
    result.push(arr.slice(i, i + size));
  }
  return result;
}

// ============================================================================
// Core classification
// ============================================================================

export const CHUNK_SIZE = 10;

/**
 * Type for an injectable chunk-classifier function.
 * Accepts (tasks, today, chunkIndex, totalChunks, systemPrompt) and returns verdicts.
 * Exported so tests can inject fakes without hitting the LLM.
 */
export type ChunkClassifierFn = (
  tasks: LucidTaskInput[],
  today: string,
  chunkIndex: number,
  totalChunks: number,
  systemPrompt: string,
) => Promise<ClarityVerdict[]>;

async function classifyChunk(
  tasks: LucidTaskInput[],
  today: string,
  _chunkIndex: number,
  _totalChunks: number,
  systemPrompt: string,
): Promise<ClarityVerdict[]> {
  const payload = tasks.map(t => ({
    id: t.id,
    title: t.title,
    description: (t.description || "").slice(0, 400),
    status: t.status,
    project_name: t.project_name || null,
  }));

  const userPrompt = `Today: ${today}

Classify the following ${tasks.length} task(s):

${JSON.stringify(payload, null, 2)}`;

  // 120s per chunk — chunks are now 10 tasks, classifying in ~15-30s normally.
  // retries: 1 means 2 attempts max; a stuck chunk costs ≤240s not 540s,
  // and other chunks still complete via the per-chunk fault tolerance below.
  const result = await inference({
    systemPrompt,
    userPrompt,
    level: "standard",
    expectJson: true,
    timeout: 120_000,
    retries: 1,
  });

  if (!result.success || !result.parsed) {
    throw new Error(`KayaTaskClassifier inference failed: ${result.error || "no parsed output"}`);
  }

  if (!Array.isArray(result.parsed)) {
    throw new Error(`KayaTaskClassifier expected array, got ${typeof result.parsed}`);
  }

  const out: ClarityVerdict[] = [];
  for (const item of result.parsed) {
    const parsed = ClarityVerdictSchema.safeParse(item);
    if (parsed.success) {
      out.push(parsed.data);
    } else {
      const id = (item as Record<string, unknown>)?.id ?? "unknown";
      console.warn(`[KayaTaskClassifier] Skipping item id=${id}: ${parsed.error.issues[0]?.message}`);
    }
  }
  return out;
}

/**
 * Classify tasks in chunks with per-chunk fault tolerance.
 *
 * On failure of an individual chunk: logs a warning and continues to the next
 * chunk. Tasks in failed chunks simply get no verdict this run — they remain
 * active+unqueued and will be picked up on the next daily run (self-healing).
 *
 * Only throws fatally when ZERO chunks succeeded AND at least one chunk was
 * attempted, so a total API outage surfaces as a non-zero exit while partial
 * success exits 0 with partial results.
 *
 * @param tasks     - All tasks to classify
 * @param classifyFn - Optional injected classifier for testing. Defaults to the
 *                     real LLM-backed classifyChunk.
 */
export async function classifyTasksForKaya(
  tasks: LucidTaskInput[],
  classifyFn: ChunkClassifierFn = classifyChunk,
  skillsDir?: string,
): Promise<ClarityVerdict[]> {
  if (tasks.length === 0) return [];

  // Build system prompt with live skill inventory injected.
  const skillNames = enumerateSkillNames(skillsDir);
  const systemPrompt = buildSystemPrompt(skillNames);

  const today = new Date().toISOString().slice(0, 10);
  const chunks = chunk(tasks, CHUNK_SIZE);
  console.log(`[KayaTaskClassifier] Classifying ${tasks.length} task(s) in ${chunks.length} chunk(s) of ${CHUNK_SIZE}.`);

  const all: ClarityVerdict[] = [];
  let failedChunks = 0;

  for (let i = 0; i < chunks.length; i++) {
    console.log(`[KayaTaskClassifier] Chunk ${i + 1}/${chunks.length} (${chunks[i].length} tasks)…`);
    try {
      const verdicts = await classifyFn(chunks[i], today, i, chunks.length, systemPrompt);
      all.push(...verdicts);
    } catch (err) {
      failedChunks++;
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(
        `[KayaTaskClassifier] Chunk ${i + 1}/${chunks.length} failed: ${msg} — skipping (will retry next run)`
      );
    }
  }

  // Total outage: every chunk failed → throw so the CLI exits non-zero.
  if (failedChunks === chunks.length && chunks.length > 0) {
    throw new Error(
      `KayaTaskClassifier: all ${chunks.length} chunk(s) failed — zero verdicts produced. Check API availability.`
    );
  }

  if (failedChunks > 0) {
    console.warn(
      `[KayaTaskClassifier] Partial success: ${failedChunks}/${chunks.length} chunk(s) failed, returning ${all.length} verdict(s).`
    );
  }

  return all;
}

// ============================================================================
// Advance helper — move a spec-pipeline item from awaiting-context → researching
// ============================================================================

// ============================================================================
// Shared helper: advance a spec-pipeline item from awaiting-context → researching
// ============================================================================

/**
 * Advance a spec-pipeline item from `awaiting-context` to `researching` using
 * the LLM-judged clarity verdict — bypassing the old regex heuristic.
 *
 * This is the single source of truth for the "clear" transition — used by
 * callers that need to advance an awaiting-context item to researching.
 *
 * @param qm            - A QueueManager instance (caller owns lifetime)
 * @param itemId        - The spec-pipeline item ID
 * @param description   - The task description (or title as fallback)
 * @param reasoning     - The LLM verdict reasoning, included in researchGuidance
 * @param confidence    - Classifier confidence, included in researchGuidance
 * @returns true if the item was advanced; false if it was already past awaiting-context
 *          (safe no-op); throws on unexpected errors so callers can log/catch
 */
export async function advanceClearItem(
  qm: QueueManager,
  itemId: string,
  description: string,
  reasoning: string,
  confidence: number,
): Promise<boolean> {
  // Guard: re-read the item to avoid a TOCTOU race — if it was already
  // auto-advanced by addSpecPipelineItem (rich-description path), skip.
  const current = await qm.get(itemId);
  if (!current) {
    throw new Error(`advanceClearItem: item ${itemId} not found in any queue`);
  }
  if (current.status !== "awaiting-context") {
    // Already advanced (e.g. by regex auto-advance on rich descriptions) — no-op.
    console.log(`    → already at ${current.status}, skipping attachContext`);
    return false;
  }

  const researchGuidance = `Auto-routed clear (conf ${confidence.toFixed(2)}): ${reasoning}`;
  await qm.attachContext(itemId, description, researchGuidance);
  return true;
}

// ============================================================================
// Backfill: re-judge awaiting-context items already in the spec-pipeline
// ============================================================================

/**
 * Split awaiting-context items into re-judgeable vs grilled.
 *
 * Items carrying a VALID grill stamp (content unchanged since an interactive
 * grill finalized) must never be re-judged by the backfill LLM: the judge sees
 * only title+description — not the grill answers — so it reliably re-derives
 * "needs-grill" and demotes completed grills back to the holding pen (root
 * cause of the 2026-06-11 Canvas v2 demotion). A stale stamp (title or
 * description edited since the grill) is re-judgeable.
 */
export function partitionGrilledItems(items: QueueItem[]): {
  toJudge: QueueItem[];
  grillSkipped: QueueItem[];
} {
  const toJudge: QueueItem[] = [];
  const grillSkipped: QueueItem[] = [];
  for (const item of items) {
    (hasValidGrillStamp(item) ? grillSkipped : toJudge).push(item);
  }
  return { toJudge, grillSkipped };
}

// (triage-sweep CLI, classifyAndLog, RunLog/RunLogTask types, and main() were
// removed. Capture routing is now done by the agent workflows, not a TS router.)
