#!/usr/bin/env bun
/**
 * SpecPipelineRunner.ts - Orchestrator for the spec-pipeline queue
 *
 * Manages the autonomous pipeline from context-provided items through research
 * and spec generation to the approvals queue. Handles:
 *   - Research orchestration (item in "researching" status)
 *   - Spec generation with complexity-adaptive routing (item in "generating-spec")
 *   - Transfer to approvals queue
 *   - Revision handling with feedback constraints
 *   - Escalation after 3 rejections
 *
 * Usage (CLI):
 *   bun run SpecPipelineRunner.ts process <id>       # Process a single item
 *   bun run SpecPipelineRunner.ts run                # Process all ready items
 *   bun run SpecPipelineRunner.ts research <id>      # Run research phase only
 *   bun run SpecPipelineRunner.ts gen-spec <id>      # Run spec generation only
 *
 * @module SpecPipelineRunner
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "fs";
import { basename, join } from "path";
import {
  QueueManager,
  loadQueueItems,
  saveQueueItems,
  archiveItems,
  generateId,
  hasValidGrillStamp,
  type QueueItem,
  type QueueItemSpec,
} from "./QueueManager.ts";
import { notifySync } from "../../../../lib/core/NotificationService.ts";
import { inference } from "../../../../lib/core/Inference.ts";
import { logFailure } from "../../../../lib/core/FailureLog.ts";
import { memoryStore } from "../../../../lib/core/MemoryStore.ts";
import { spawnAgentSync } from "../../../../lib/core/AgentSpawner.ts";
import { generateTestStrategy } from "./TestStrategyGenerator.ts";
import { getKayaHome } from "../../../../lib/core/KayaHome.ts";
import {
  shouldRunUXUI,
  planUXUIStage,
  type Effort,
  type StageStep,
} from "../../../Agents/SpecSheet/Tools/UXUIStage.ts"; // cross-skill-allowed: the spec pipeline invokes SpecSheet's stages by design — QueueRouter hosts the pipeline, SpecSheet owns spec-quality machinery
import {
  extractUXStructure,
  computeUXCompleteness,
  renderBehavioralISC,
  type UXStructureResult,
} from "../../../Agents/SpecSheet/Tools/SpecValidator.ts"; // cross-skill-allowed: the spec pipeline invokes SpecSheet's stages by design — QueueRouter hosts the pipeline, SpecSheet owns spec-quality machinery

/**
 * Load the concrete GrillMeLens implementation lazily.
 * Returns { generateDirectives } from Agents/SpecSheet/Tools/GrillMeLens.ts.
 * Type is omitted — the LLM infers item nature from title+description.
 */
async function getLensGenerator(): Promise<{
  generateDirectives: (title: string, description: string) => Promise<Array<{ lens: string; directive: string }>>;
}> {
  // cross-skill-allowed: the spec pipeline invokes SpecSheet's stages by design — QueueRouter hosts the pipeline, SpecSheet owns spec-quality machinery
  const m = await import("../../../Agents/SpecSheet/Tools/GrillMeLens.ts");
  return { generateDirectives: m.generateDirectives };
}

// ============================================================================
// Constants
// ============================================================================

// frozen at import; behavior-identical to prior frozen const
const KAYA_HOME = getKayaHome();
const WORK_DIR = join(KAYA_HOME, "MEMORY/WORK");
const SPECS_DIR = join(KAYA_HOME, "Plans", "Specs", "Queue");

/**
 * Model for the research subagent spawn. AgentSpawner requires every caller to
 * choose the model EXPLICITLY — and it strips CLAUDE_CODE_* env vars before
 * spawning (buildHardenedClaudeEnv), so a nested `claude -p` process can NEVER
 * inherit an ambient CLAUDE_CODE_SUBAGENT_MODEL default. (The prior version of
 * this comment claimed "sonnet" matched such a default; that was never true —
 * there is no inheritance path, only this explicit constant.)
 *
 * "opus" is a deliberate choice, not a default: this subagent's VERDICT
 * (implement/skip/defer) gates the entire spec pipeline — a wrong "skip"
 * silently discards real work with no downstream check — so it warrants the
 * strongest available model, unlike LiveVerifier's Explorer (sonnet), which
 * runs bounded, scripted scenarios rather than open-ended judgment.
 *
 * Tool-posture disclosure: allowedTools below is "Bash,Read,Glob,Grep" — the
 * same grant as LiveVerifier's Explorer. The prior comment called this a
 * "read-only" posture; that is not accurate — Bash is a general-purpose shell
 * tool and nothing at the tool layer prevents a write. The actual safety
 * boundary is the research prompt's instruction to verify/investigate only,
 * not a tool-level restriction.
 */
const RESEARCH_MODEL = "opus";

/**
 * Marks a thrown research error as an infrastructure condition (rate/usage/
 * credit-pool limit, or a pre-spawn gate) rather than a code/task failure —
 * routes attemptResearch's outer catch through the SAME defer/bounce path as
 * a timeout (decideTimeoutOutcome + awaiting-context) instead of the generic
 * "Research phase failed" message. See attemptResearch below.
 */
const INFRA_UNAVAILABLE_ERROR_PREFIX = "Research subagent infra-unavailable: ";

// ============================================================================
// Types
// ============================================================================

/** Complexity level for spec generation routing */
type Complexity = "low" | "medium" | "high";

/** Result from a pipeline processing step */
interface StepResult {
  success: boolean;
  message: string;
  data?: Record<string, unknown>;
}

/**
 * Verdict from the research phase — determines whether to proceed to spec generation.
 * "bounce" is a special sentinel (not emitted by the LLM) meaning the findings
 * contained no VERDICT token — the item is bounced to awaiting-context for
 * re-enrichment rather than fabricating a spec from incomplete research.
 */
type ResearchVerdict = "implement" | "skip" | "defer" | "bounce";

/** Research findings from parallel agents */
interface ResearchFindings {
  itemId: string;
  sessionId: string;
  artifactPath: string;
  findings: string;
  completedAt: string;
}

/**
 * Extract the research verdict from findings content.
 * Looks for a VERDICT line in the research output (e.g., "VERDICT: skip").
 *
 * When NO VERDICT token is present the verdict is "bounce" — the item is
 * returned to awaiting-context for re-enrichment. Fabricating a spec from
 * verdict-less research (the old "default to implement" behavior) produced
 * junk specs from incomplete findings. This is the safe outcome.
 *
 * When VERDICT IS present, behavior is unchanged — the LLM's explicit
 * verdict (implement/skip/defer) drives routing exactly as before.
 */
export function parseResearchVerdict(findings: string): { verdict: ResearchVerdict; reason: string } {
  const verdictMatch = findings.match(/^##?\s*VERDICT:\s*(implement|skip|defer)\b/im)
    || findings.match(/\bVERDICT:\s*(implement|skip|defer)\b/i);

  if (!verdictMatch) {
    return { verdict: "bounce", reason: "No explicit VERDICT token found — bouncing to awaiting-context for re-enrichment rather than generating a spec from incomplete research" };
  }

  const verdict = verdictMatch[1].toLowerCase() as ResearchVerdict;

  // Extract the reason line that follows the verdict
  const afterVerdict = findings.slice(findings.indexOf(verdictMatch[0]) + verdictMatch[0].length);
  const reasonMatch = afterVerdict.match(/^\s*[-—:]\s*(.+?)(?:\n|$)/m)
    || afterVerdict.match(/^\s+(.+?)(?:\n|$)/m);
  const reason = reasonMatch?.[1]?.trim() || "No reason provided";

  return { verdict, reason };
}

/**
 * Decide what to do with a research artifact after the subagent hit its
 * wall-clock cap. The kill must not discard recoverable work — the cap
 * otherwise selects against exactly the big (grilled) items that need the
 * most research.
 *
 *   - "salvage-success": artifact carries an EXPLICIT verdict — research
 *     actually finished; treat as a normal success, no timeout strike.
 *   - "resume-partial": substantial findings but no verdict — preserve the
 *     artifact and resume from it on the next attempt.
 *   - "hard-timeout": nothing worth keeping — bounce as before.
 *
 * NOTE: must re-test the raw VERDICT pattern rather than trust
 * parseResearchVerdict, which now returns "bounce" when absent — trusting
 * it would still falsely classify verdict-less prose as salvage-success.
 */
export function decideTimeoutOutcome(
  artifactContent: string | null
): "salvage-success" | "resume-partial" | "hard-timeout" {
  if (!artifactContent || artifactContent.trim().length === 0) return "hard-timeout";
  if (/\bVERDICT:\s*(implement|skip|defer)\b/i.test(artifactContent)) return "salvage-success";
  if (artifactContent.trim().length > 500) return "resume-partial";
  return "hard-timeout";
}

// ============================================================================
// Helpers
// ============================================================================

function ensureDir(dirPath: string): void {
  if (!existsSync(dirPath)) {
    mkdirSync(dirPath, { recursive: true });
  }
}

/**
 * Get the session ID for a work session, creating a new one if none exists.
 * Format: YYYYMMDD-HHMMSS_spec-pipeline
 */
function getOrCreateSessionId(itemId: string): string {
  const now = new Date();
  const dateStr = now.toISOString().replace(/[-:T.Z]/g, "").slice(0, 15);
  return `${dateStr}_spec-pipeline-${itemId.slice(0, 8)}`;
}

/**
 * Extract context fields from a pipeline item's payload.context.
 */
function extractItemContext(item: QueueItem): {
  notes: string;
  researchGuidance: string;
  scopeHints?: string;
  lucidTaskId?: string;
  revisionCount: number;
  lastRejectionReason?: string;
  previousResearchPath?: string;
  previousSpecPath?: string;
  autoRouted: boolean;
} {
  const ctx = (item.payload.context || {}) as Record<string, unknown>;
  const meta = (ctx._meta || {}) as Record<string, unknown>;

  return {
    notes: (ctx.notes as string) || item.payload.description || "",
    researchGuidance: (ctx.researchGuidance as string) || item.payload.description || "",
    scopeHints: ctx.scopeHints as string | undefined,
    lucidTaskId: ctx.lucidTaskId as string | undefined,
    revisionCount: (meta.revisionCount as number) || 0,
    lastRejectionReason: meta.lastRejectionReason as string | undefined,
    previousResearchPath: meta.researchArtifactPath as string | undefined,
    previousSpecPath: meta.specPath as string | undefined,
    autoRouted: (meta.autoRouted as boolean) || false,
  };
}

/**
 * All items default to "medium" complexity (Sonnet + generous timeout).
 * Regex-based tier routing was removed: keyword signals don't reliably
 * correlate with actual spec complexity, and the LLM generates comparable
 * quality at the standard tier. All research runs get the generous (high)
 * timeout cap — cheap insurance against real scope variance.
 */
function getComplexity(_item: QueueItem): Complexity {
  return "medium";
}

// ============================================================================
// LLM Spec-Quality Judge
// ============================================================================

/**
 * Result from the LLM spec-quality judge.
 *
 * pass:    true  → spec is substantive and ready for approvals
 *          false → spec needs improvement (see reasons)
 * reasons: human-readable list of specific issues found (empty on pass)
 * verdict: raw disposition string from the judge ("PASS" or "NEEDS_REVIEW" or
 *          "FAIL") — preserved for logging/debugging
 */
export interface SpecQualityJudgment {
  pass: boolean;
  reasons: string[];
  verdict: "PASS" | "FAIL" | "NEEDS_REVIEW" | "JUDGE_UNAVAILABLE";
}

/**
 * System prompt for the spec-quality judge.
 *
 * Design principles:
 * - Provide the full spec as context (no anchoring on any single signal)
 * - Consistent criteria expressed as questions, not regex keywords
 * - Rich context → no over-anchoring on row counts or keyword presence
 * - Judge unavailability → NEEDS_REVIEW (surface, don't silently pass or reject)
 */
const SPEC_QUALITY_JUDGE_SYSTEM = `You are a spec-quality judge for an autonomous engineering pipeline. Your job is to determine whether a generated specification is substantive enough to proceed to human approval, or whether it should be sent back for improvement.

You will evaluate the spec against these criteria:

**ISC Substantiveness:**
- Does the spec have SPECIFIC, measurable Ideal State Criteria (ISC)? Each criterion should describe a concrete observable outcome — not generic boilerplate like "implementation matches requirements" or "no regressions."
- Do the ISC rows contain specific artifacts, commands, counts, behaviors, or acceptance tests? Vague phrases without specifics indicate a skeleton/placeholder spec.
- Does the spec have enough ISC rows to meaningfully describe the work? A real spec should have multiple distinct criteria.

**Phase 1 Demoability (if the spec has multiple phases):**
- If the spec decomposes work into multiple phases, is Phase 1 a demoable vertical slice? It should deliver observable end-to-end behavior — something a human can see, run, or verify — not just scaffolding, infrastructure setup, or database migrations with no user-visible outcome.
- Exception: if Phase 1 explicitly justifies being a setup-only phase (e.g., an irreducible migration every later slice depends on), that is acceptable.
- Single-phase specs and flat specs (no phase decomposition) always pass this criterion.

**UX/UI Quality (only for specs with a "## UX/UI Specification" section):**
- Do the screen sections contain real acceptance criteria (e.g., Given/When/Then or equivalent)? Placeholder-only screen sections without behavioral criteria are incomplete.
- Does the spec document accessibility intent (e.g., keyboard nav, ARIA roles, contrast) at least briefly? Specs that describe UI without any a11y consideration are incomplete.
- Are design tokens/colors referenced by semantic name rather than raw hex values? Raw hex values (#ff0000, #abc) indicate premature low-level specification.
- Does the spec contain lorem ipsum or similar placeholder text? Placeholder copy blocks should be replaced with realistic bracketed placeholders.
- Specs without a UX/UI section are unaffected by these criteria.

**Overall Completeness:**
- Does the spec describe what success looks like concretely, not just what will be built?
- Does it have enough context to actually implement the work?

Respond ONLY with a JSON object in this exact format:
{
  "verdict": "PASS" | "FAIL" | "NEEDS_REVIEW",
  "reasons": ["reason 1", "reason 2"]
}

Use "PASS" when the spec is substantive and ready for approval.
Use "FAIL" when the spec clearly has skeleton/placeholder ISC or an unjustified infrastructure-only Phase 1, or when a UX/UI spec is clearly incomplete by the criteria above.
Use "NEEDS_REVIEW" only if you genuinely cannot determine quality (ambiguous spec with mixed signals).
On PASS, reasons should be empty [].
On FAIL or NEEDS_REVIEW, reasons must list the specific issues.`;

/**
 * LLM judge for spec quality.
 *
 * Replaces the deleted deterministic validateISCQuality + validateSliceShape
 * gates which produced false-positive rejections on real grilled specs (see
 * project_isc_barren_spec_parser_false_positive.md and the dedeterminize plan
 * Slice 2a). Spec quality is a content judgment — the LLM is the right tool.
 *
 * Failure behavior:
 * - Inference failure → logs via logFailure() → returns NEEDS_REVIEW (surfaces
 *   to the pipeline, never silently passes or silently rejects)
 * - Malformed JSON response → same: log + NEEDS_REVIEW
 * - "NEEDS_REVIEW" verdict from judge → pipeline treats as failing gate (sends
 *   back for context enrichment), which is the safe-side default
 *
 * @param specMarkdown - Full spec content (no truncation — full context avoids anchoring)
 * @param itemId       - Queue item ID for failure log context
 */
export async function judgeSpecQuality(
  specMarkdown: string,
  itemId?: string
): Promise<SpecQualityJudgment> {
  let result;
  try {
    result = await inference({
      systemPrompt: SPEC_QUALITY_JUDGE_SYSTEM,
      userPrompt: `Please evaluate the following spec for quality:\n\n${specMarkdown}`,
      level: "standard",
      expectJson: true,
      retries: 1,
      retryDelayMs: 4000,
    });
  } catch (err) {
    logFailure("SpecPipelineRunner:judgeSpecQuality", err, {
      itemId,
      phase: "judge-inference-throw",
    });
    return {
      pass: false,
      reasons: ["Spec quality judge unavailable — inference threw an exception. Item needs review."],
      verdict: "JUDGE_UNAVAILABLE",
    };
  }

  if (!result.success || !result.parsed) {
    logFailure("SpecPipelineRunner:judgeSpecQuality", new Error(result.error ?? "inference failed"), {
      itemId,
      phase: "judge-inference-failed",
      output: result.output?.slice(0, 500),
    });
    return {
      pass: false,
      reasons: ["Spec quality judge unavailable — inference returned no result. Item needs review."],
      verdict: "JUDGE_UNAVAILABLE",
    };
  }

  // Parse and validate the JSON response
  const parsed = result.parsed as Record<string, unknown>;
  const verdict = parsed["verdict"];
  const reasons = Array.isArray(parsed["reasons"]) ? (parsed["reasons"] as string[]) : [];

  if (verdict !== "PASS" && verdict !== "FAIL" && verdict !== "NEEDS_REVIEW") {
    logFailure("SpecPipelineRunner:judgeSpecQuality", new Error("Unexpected verdict value"), {
      itemId,
      phase: "judge-unexpected-verdict",
      verdict,
    });
    return {
      pass: false,
      reasons: ["Spec quality judge returned an unexpected verdict format. Item needs review."],
      verdict: "JUDGE_UNAVAILABLE",
    };
  }

  return {
    pass: verdict === "PASS",
    reasons,
    verdict,
  };
}

// ============================================================================
// Learning Integration
// ============================================================================

/**
 * Load recent queue decisions from MemoryStore for prompt enrichment.
 * Returns a formatted markdown section, or empty string if no entries found.
 */
async function loadQueueLearnings(): Promise<string> {
  try {
    const entries = await memoryStore.search({
      type: ['decision', 'learning'],
      tags: ['queuerouter'],
      limit: 5,
      since: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000),
    });
    if (!entries.length) return '';
    const lines = entries.map(e => `- ${e.title}: ${e.content?.slice(0, 200)}`).join('\n');
    return `\n## Past Queue Decisions\n${lines}\n`;
  } catch {
    return '';
  }
}

// ============================================================================
// Domain Vocabulary Injection (GrillWithDocs loop closure)
// ============================================================================
//
// The interactive grill (GrillWithDocs) sharpens each domain's CONTEXT.md
// glossary. This closes the loop on the *generation* side: spec-gen resolves the
// item's primary-domain CONTEXT.md and injects its canonical vocabulary into the
// spec prompt, so generated specs use the sharpened terms — and items in a
// documented domain benefit even when they were never grilled. Purely additive:
// when no documented domain matches, the prompt is unchanged.

/** A skill directory that owns a CONTEXT.md glossary. */
interface SkillContext {
  /** Directory name, e.g. "SpecSheet". */
  skill: string;
  /** Parent category, e.g. "Agents". */
  category: string;
  /** Absolute path to the CONTEXT.md. */
  path: string;
}

/**
 * Build a loose match regex from a (possibly camelCase) skill directory name.
 * "SpecSheet" -> /\bspec[\s_-]?sheet\b/i, so it matches "SpecSheet", "spec sheet",
 * and "spec-sheet" in free text.
 */
export function skillNameToRegex(skill: string): RegExp {
  const tokens = skill
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2") // split camelCase
    .split(/[\s_-]+/)
    .map((t) => t.replace(/[^a-zA-Z0-9]/g, ""))
    .filter(Boolean)
    .map((t) => t.toLowerCase());
  const pattern = tokens.join("[\\s_-]?");
  return new RegExp(`\\b${pattern}\\b`, "i");
}

/**
 * Root of this checkout's skills/ tree, resolved from this module's own file
 * location rather than KAYA_HOME. CONTEXT.md glossaries are versioned repo
 * content, not runtime state — when this code runs from a worktree (a
 * separate git checkout with its own skills/), KAYA_HOME still points at the
 * shared live installation (~/.claude) by design (see KayaHome.ts), so a
 * KAYA_HOME-based lookup would silently read the OTHER checkout's docs
 * instead of this one's. import.meta.dir keeps the lookup pinned to whichever
 * checkout is actually executing.
 */
const THIS_CHECKOUT_SKILLS_ROOT = join(import.meta.dir, "..", "..", "..");

/**
 * Find all skills that own a CONTEXT.md glossary (skills/<Category>/<Skill>/CONTEXT.md).
 * Impure (filesystem). Returns [] on any read error.
 */
export function findSkillContexts(skillsRoot = THIS_CHECKOUT_SKILLS_ROOT): SkillContext[] {
  const out: SkillContext[] = [];
  let categories: string[];
  try {
    categories = readdirSync(skillsRoot, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    return out;
  }
  for (const category of categories) {
    let skills: string[];
    try {
      skills = readdirSync(join(skillsRoot, category), { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => d.name);
    } catch {
      continue;
    }
    for (const skill of skills) {
      const ctxPath = join(skillsRoot, category, skill, "CONTEXT.md");
      if (existsSync(ctxPath)) out.push({ skill, category, path: ctxPath });
    }
  }
  return out;
}

/**
 * Pick the documented domain whose skill name appears in `text`. When several
 * match, prefer the most specific (longest skill name). Pure. Returns null when
 * no documented domain matches.
 */
export function matchDomainContext(text: string, candidates: SkillContext[]): SkillContext | null {
  const haystack = text.toLowerCase();
  const matches = candidates.filter((c) => skillNameToRegex(c.skill).test(haystack));
  if (matches.length === 0) return null;
  matches.sort((a, b) => b.skill.length - a.skill.length);
  return matches[0];
}

/**
 * Extract the canonical-vocabulary sections (`## Language`, `## Relationships`)
 * from a CONTEXT.md for prompt injection. Pure. Returns "" if neither is present.
 * Caps total length so a large glossary can't blow up the spec prompt.
 */
export function extractDomainVocabulary(contextMd: string, maxChars = 4000): string {
  const section = (heading: string): string => {
    const re = new RegExp(`^##\\s+${heading}\\b.*$`, "im");
    const m = contextMd.match(re);
    if (!m || m.index === undefined) return "";
    const rest = contextMd.slice(m.index + m[0].length);
    const nextH2 = rest.search(/^##\s+/m);
    const body = nextH2 === -1 ? rest : rest.slice(0, nextH2);
    return (m[0] + body).trim();
  };
  const joined = [section("Language"), section("Relationships")].filter(Boolean).join("\n\n");
  return joined.length > maxChars ? joined.slice(0, maxChars) + "\n…(truncated)" : joined;
}

/**
 * Resolve the item's primary-domain CONTEXT.md and return its canonical-vocabulary
 * block formatted for prompt injection. Returns "" when no documented domain matches
 * (preserves current behavior — additive). Never throws.
 */
export function loadDomainVocabularyForItem(item: QueueItem): string {
  try {
    const ctx = extractItemContext(item);
    const text = `${item.payload.title} ${ctx.notes} ${ctx.scopeHints ?? ""}`;
    const match = matchDomainContext(text, findSkillContexts());
    if (!match) return "";
    const vocab = extractDomainVocabulary(readFileSync(match.path, "utf-8"));
    if (!vocab) return "";
    return `\n## Domain Vocabulary (canonical — use these terms exactly; avoid the listed aliases)\n\nSource: ${match.category}/${match.skill}/CONTEXT.md\n\n${vocab}\n`;
  } catch {
    return "";
  }
}

// ============================================================================
// UX/UI Stage (Slice 6)
// ============================================================================

/**
 * Maps pipeline Complexity to the UX/UI Stage Effort tier (ADR 0006).
 *   low    → Small  (lean scope — UXDesigner + UIDesigner, Sonnet)
 *   medium → Medium (default   — UXDesigner + UIDesigner + Designer review, Sonnet)
 *   high   → Large  (full      — UXDesigner + UIDesigner + Designer review, Opus)
 */
function complexityToEffort(complexity: Complexity): Effort {
  if (complexity === "low") return "Small";
  if (complexity === "high") return "Large";
  return "Medium";
}

/**
 * Injectable subagent spawn function type.
 * `model` mirrors StageStep.model; the default implementation maps it to an
 * inference level (Opus → smart, Sonnet/undefined → standard).
 * Returns the agent's output text, or throws on failure / timeout / empty output.
 */
export type SpawnSubagentFn = (opts: {
  prompt: string;
  timeoutMs: number;
  model?: "Sonnet" | "Opus";
}) => Promise<string>;

/**
 * Default spawn implementation: single-shot inference() call, no tools.
 *
 * Replaces the previous nested tool-capable `claude -p` subprocess (SpecSheet
 * ADR 0007): tool-capable nested spawns hang in interactive sessions even with
 * a hardened env, while inference() (--tools '', fd-redirected output) works
 * in every session type. The agents needed tools only to self-read their
 * static context docs, which buildUXUIAgentPrompt now inlines into the prompt.
 */
async function defaultSpawnSubagent(opts: {
  prompt: string;
  timeoutMs: number;
  model?: "Sonnet" | "Opus";
}): Promise<string> {
  const result = await inference({
    systemPrompt:
      "You are a UX/UI specification writer. Produce only the requested spec section. No preamble, no commentary.",
    userPrompt: opts.prompt,
    level: opts.model === "Opus" ? "smart" : "standard",
    // Must be passed explicitly — inference level defaults (standard=90s)
    // would otherwise spuriously time out a multi-minute generation step.
    timeout: opts.timeoutMs,
  });

  if (!result.success) {
    throw new Error(
      result.error?.startsWith("Timeout")
        ? `UX/UI agent timed out after ${opts.timeoutMs / 1000}s`
        : `UX/UI agent exited with error: ${(result.error ?? "unknown").slice(0, 500)}`
    );
  }
  if (!result.output.trim()) {
    throw new Error("UX/UI agent returned empty output");
  }
  return result.output.trim();
}

/**
 * One file in an agent's inlined context bundle.
 * `fallback` covers known stale paths (docs referencing moved files);
 * `cap` bounds the chars contributed per file (dilution control, not API limit).
 */
export interface BundleFile {
  path: string;
  fallback?: string;
  cap: number;
}

/**
 * Load a context bundle: read each file (falling back / skipping when missing),
 * cap its length, and join sections under `### <basename>` headers.
 * Missing files are silently skipped — the completeness gates downstream are
 * the quality net, and a partial bundle still beats a hung tool-spawn.
 */
export function loadBundle(files: BundleFile[]): string {
  const sections: string[] = [];
  for (const f of files) {
    const resolved = existsSync(f.path)
      ? f.path
      : f.fallback && existsSync(f.fallback)
        ? f.fallback
        : undefined;
    if (!resolved) continue;
    let content: string;
    try {
      content = readFileSync(resolved, "utf-8");
    } catch {
      continue;
    }
    if (content.length > f.cap) {
      content = content.slice(0, f.cap) + "\n[... truncated ...]";
    }
    sections.push(`### ${basename(resolved)}\n\n${content}`);
  }
  return sections.join("\n\n");
}

// Shared docs across bundles
const UXUI_FORMAT_DOC = join(KAYA_HOME, "skills/Agents/SpecSheet/UXUISpecFormat.md");
const SPECSHEET_CONTEXT_DOC = join(KAYA_HOME, "skills/Agents/SpecSheet/CONTEXT.md");
const UXSPEC_DIR = join(KAYA_HOME, "skills/Development/UXSpec");
const UISPEC_DIR = join(KAYA_HOME, "skills/Development/UISpec");

/** Context bundle for the UXDesigner generation step (~35KB capped). */
export const UX_DESIGNER_BUNDLE: BundleFile[] = [
  { path: join(KAYA_HOME, "skills/Agents/UXDesignerContext.md"), cap: 10_000 },
  { path: UXUI_FORMAT_DOC, cap: 10_000 },
  { path: join(UXSPEC_DIR, "SKILL.md"), cap: 10_000 },
  // UXDesignerContext.md references this workflow doc; Templates/ is the
  // fallback in case the file moves back (the context doc's path history
  // shows both locations).
  {
    path: join(UXSPEC_DIR, "Workflows/GenerateUXSpec.md"),
    fallback: join(UXSPEC_DIR, "Templates/GenerateUXSpec.md"),
    cap: 10_000,
  },
  { path: join(UXSPEC_DIR, "Templates/screen-inventory.yaml"), cap: 4_000 },
  { path: join(UXSPEC_DIR, "Templates/per-screen-section.md"), cap: 6_000 },
  { path: join(UXSPEC_DIR, "Templates/user-flow-guidance.md"), cap: 4_000 },
  { path: SPECSHEET_CONTEXT_DOC, cap: 8_000 },
  { path: join(UXSPEC_DIR, "Templates/example-ux-spec.md"), cap: 6_000 },
];

/** Context bundle for the UIDesigner realization step (~44KB capped). */
export const UI_DESIGNER_BUNDLE: BundleFile[] = [
  { path: join(KAYA_HOME, "skills/Agents/UIDesignerContext.md"), cap: 6_000 },
  { path: UXUI_FORMAT_DOC, cap: 4_500 },
  { path: join(UISPEC_DIR, "SKILL.md"), cap: 5_000 },
  { path: join(UISPEC_DIR, "Workflows/GenerateUISpec.md"), cap: 7_000 },
  { path: join(UISPEC_DIR, "References/DesignTokens.md"), cap: 6_000 },
  { path: join(UISPEC_DIR, "References/AccessibilityGuide.md"), cap: 6_000 },
  { path: join(UISPEC_DIR, "References/ComponentPatterns.md"), cap: 6_000 },
  { path: join(UISPEC_DIR, "References/WireframeFormat.md"), cap: 6_000 },
  { path: SPECSHEET_CONTEXT_DOC, cap: 5_000 },
];

/** Context bundle for the Designer review pass (~6.5KB capped). */
export const DESIGNER_BUNDLE: BundleFile[] = [
  { path: join(KAYA_HOME, "skills/Agents/DesignerContext.md"), cap: 4_000 },
  { path: UXUI_FORMAT_DOC, cap: 4_500 },
];

/**
 * Build the prompt for a single UX/UI Stage step.
 *
 * Inlines the agent's context documents directly into the prompt (SpecSheet
 * ADR 0007) — the inference() transport has no tools, so the agent cannot
 * self-read its *Context.md chain. The docs themselves are unchanged and
 * interactive workflows still read them from disk (ADR 0004).
 *
 * Per UXUISpecFormat.md:
 *   - UXDesigner: writes the full `## UX/UI Specification` section
 *   - UIDesigner:  edits each `## Screen:` in place, adds State wireframes/components/a11y
 *   - Designer:    appends review notes after the existing UX/UI section
 */
export function buildUXUIAgentPrompt(
  step: StageStep,
  specContent: string,
  itemTitle: string
): string {
  const bundle = step.agent === "UXDesigner"
    ? loadBundle(UX_DESIGNER_BUNDLE)
    : step.agent === "UIDesigner"
      ? loadBundle(UI_DESIGNER_BUNDLE)
      : loadBundle(DESIGNER_BUNDLE);

  const agentInstruction = step.agent === "UXDesigner"
    ? `You are the UXDesigner agent. Your context documents are included below.

Your task: Given the spec below, produce the \`## UX/UI Specification\` section for it.
Follow UXUISpecFormat.md exactly:
  1. Write the \`## UX/UI Specification\` H2 heading.
  2. Write a fenced \`\`\`yaml screen-inventory block with all screens.
  3. Optionally write a \`### User Flows\` Mermaid diagram.
  4. Write one \`## Screen: <Name> (\`<id>\`)\` section per screen with:
     - Purpose / Entry / Exits (one line)
     - Acceptance Criteria: at least one Given/When/Then bullet per screen.

Return ONLY the \`## UX/UI Specification\` section and its Screen sections. No preamble.`
    : step.agent === "UIDesigner"
      ? `You are the UIDesigner agent. Your context documents are included below.

Your task: Given the spec + existing UX/UI section below, EDIT each \`## Screen:\` section
in place, inserting for every state listed in the screen-inventory:
  - \`### State: <state>\` wireframe (annotated HTML+Tailwind, tokens by name, no raw hex)
  - \`### Component Inventory\` table
  - \`### Accessibility (WCAG 2.2 AA)\` subsection mentioning ARIA roles AND contrast.

Return the COMPLETE updated \`## UX/UI Specification\` section (all screens, all states). No preamble.`
      : `You are the Designer agent (review pass). Your context documents are included below.

Your task: Review the UX/UI section below and append brief review notes.
Append a \`### Designer Review\` subsection after the last screen section.
Surface any UX flow gaps, token violations, or a11y issues. Return ONLY the appended notes.`;

  return `${agentInstruction}

## Context Documents

${bundle}

## Spec Being Processed: ${itemTitle}

---

${specContent}`;
}

/**
 * Run the UX/UI Stage for a pipeline item whose surface is browser or native.
 *
 * Exported for testing. Call with a mock `_spawnFn` to avoid real LLM calls.
 *
 * Returns an object with:
 *   - uxuiSection: the produced `## UX/UI Specification` section text (empty for non-UI)
 *   - skipped: true when shouldRunUXUI(surface) is false
 *
 * Throws on agent failure (caller handles and bounces item to awaiting-context).
 */
export async function runUXUIStageForPipeline(opts: {
  specContent: string;
  surface: string | undefined;
  complexity: Complexity;
  itemTitle: string;
  _spawnFn?: SpawnSubagentFn;
}): Promise<{ uxuiSection: string; skipped: boolean }> {
  const { specContent, surface, complexity, itemTitle, _spawnFn } = opts;
  const spawnFn = _spawnFn ?? defaultSpawnSubagent;

  // Surface gate — non-UI items skip the stage entirely
  const surfaceTyped = surface as Parameters<typeof shouldRunUXUI>[0];
  if (!shouldRunUXUI(surfaceTyped)) {
    return { uxuiSection: "", skipped: true };
  }

  const effort = complexityToEffort(complexity);
  const plan = planUXUIStage({ surface: surfaceTyped, effort });

  // 8 minute timeout per agent (generous; UX/UI generation is heavier than research)
  const AGENT_TIMEOUT_MS = 8 * 60 * 1000;

  let currentContent = specContent;
  let uxuiSection = "";

  for (const step of plan) {
    const prompt = buildUXUIAgentPrompt(step, currentContent, itemTitle);
    // Thread the effort-tier model (ADR 0006) so the spawned agent runs at the
    // routed tier — Sonnet for Small/Medium generators, Opus for Large + Designer review.
    const output = await spawnFn({ prompt, timeoutMs: AGENT_TIMEOUT_MS, model: step.model });

    if (step.agent === "UXDesigner") {
      // UXDesigner returns the full ## UX/UI Specification section
      uxuiSection = output;
      currentContent = specContent + "\n\n" + uxuiSection;
    } else if (step.agent === "UIDesigner") {
      // UIDesigner returns the updated ## UX/UI Specification section
      uxuiSection = output;
      currentContent = specContent + "\n\n" + uxuiSection;
    } else {
      // Designer appends review notes to existing UX/UI section
      uxuiSection = uxuiSection + "\n\n" + output;
      currentContent = specContent + "\n\n" + uxuiSection;
    }
  }

  return { uxuiSection, skipped: false };
}

// ============================================================================
// Phase 1: Research Orchestration
// ============================================================================

/**
 * Execute the research phase for an item in "researching" status.
 *
 * Spawns a claude -p subagent with Read/Grep/Glob/Bash access to verify
 * assumptions against the actual codebase before producing findings.
 * If the subagent finds the premise is false (bug doesn't exist, feature
 * already implemented), the item is held at awaiting-context as a false
 * positive rather than proceeding to spec generation.
 */
async function runResearchPhase(item: QueueItem, qm: QueueManager): Promise<StepResult> {
  const ctx = extractItemContext(item);
  const itemMeta = (item.payload.context?._meta as Record<string, unknown>) || {};
  // Resumable session: reuse a persisted session id so research RESUMES into the
  // same artifact dir across retries, instead of minting a fresh dir each run.
  // A new id every run orphaned completed findings and forced heavy items to
  // re-research from scratch until they wedged at researchTimeouts>=2. The id is
  // persisted on the timeout-bounce paths below (and by dispatchResearchVerdict
  // on success); the pre-pass re-advance preserves _meta via merge.
  const sessionId =
    typeof itemMeta.sessionId === "string" && itemMeta.sessionId.length > 0
      ? itemMeta.sessionId
      : getOrCreateSessionId(item.id);

  // ── Grill-provided findings short-circuit (ADR 0002) ─────────────────────
  // The interactive grill session already did the research in-session and
  // wrote the findings artifact. Skip the claude -p spawn and dispatch the
  // artifact's verdict directly. Falls through to the spawn on: deep-research
  // opt-in, missing artifact, or revision re-entry (rejection feedback needs
  // fresh research — which now receives the prior findings, see below).
  const grillArtifactPath = itemMeta.researchArtifactPath;
  if (
    Boolean(itemMeta.grillFindingsProvided) &&
    !itemMeta.deepResearchRequested &&
    !ctx.lastRejectionReason &&
    typeof grillArtifactPath === "string" &&
    existsSync(grillArtifactPath)
  ) {
    const findings = readFileSync(grillArtifactPath, "utf-8");
    notifySync(`Research short-circuit: using grill-provided findings for "${item.payload.title}"`);
    return dispatchResearchVerdict(item, qm, findings, grillArtifactPath, sessionId);
  }
  // ── End short-circuit ─────────────────────────────────────────────────────

  const sessionDir = join(WORK_DIR, sessionId);
  ensureDir(sessionDir);

  const artifactPath = join(sessionDir, `research-${item.id}.md`);

  notifySync(`Researching: ${item.payload.title}`);

  // Build research prompt incorporating any rejection feedback
  const revisionContext = ctx.lastRejectionReason
    ? `\n\nPrevious Spec Rejection Feedback:\n${ctx.lastRejectionReason}\nAddress the above concerns in your research.`
    : "";

  // Resume from a prior partial artifact if the last attempt timed out with
  // substantial findings (see decideTimeoutOutcome) — never restart blind.
  const lastArtifact = itemMeta.lastResearchArtifact;
  const priorFindingsSection =
    typeof lastArtifact === "string" && existsSync(lastArtifact)
      ? `\n\n## Prior Partial Findings (RESUME)\n\nA previous research attempt timed out after producing the partial findings below. CONTINUE from them — verify anything still open, fill the gaps, and produce the final verdict. Do NOT redo verification already marked [RESOLVED].\n\n${readFileSync(lastArtifact, "utf-8").slice(0, 8000)}`
      : "";

  const researchGuidanceSection = ctx.autoRouted
    ? ctx.notes
    : ctx.researchGuidance;

  // GrillMe lens analysis — adds directed research questions (~2s Haiku call).
  // Type classification is omitted: the LLM infers item nature from title+description.
  let grillDirectivesSection = "";
  try {
    const { generateDirectives } = await getLensGenerator();
    const directives = await generateDirectives(
      item.payload.title,
      ctx.notes ?? item.payload.description
    );

    if (directives.length > 0) {
      grillDirectivesSection = `\n\n## Directed Investigation\n\nApply these analytical lenses during research:\n\n${directives
        .map((d) => `**${d.lens}:** ${d.directive}`)
        .join("\n")}`;
    }
  } catch {
    // GrillMeLens failure is non-fatal — continue without directives
  }

  // Domain vocabulary (GrillWithDocs loop closure) — research previously
  // started blind to the very CONTEXT.md the grill writes. Empty when no
  // documented domain matches.
  const domainVocabSection = loadDomainVocabularyForItem(item);

  // Prior COMPLETED research artifact — revision re-runs previously started
  // blind. Distinct from priorFindingsSection, which resumes timeout partials.
  const priorCompletedSection =
    typeof ctx.previousResearchPath === "string" &&
    ctx.previousResearchPath !== lastArtifact &&
    existsSync(ctx.previousResearchPath)
      ? `\n\n## Prior Research (already completed)\n\nThis item was previously researched. Findings below are context (e.g., a revision run) — do NOT redo them; focus on the new guidance or rejection feedback.\n\n${readFileSync(ctx.previousResearchPath, "utf-8").slice(0, 6000)}`
      : "";

  // Sanitize title: strip prompt-injection patterns before embedding in prompt
  // Per QueueRouter spec ISC #10.
  const safeTitle = item.payload.title
    .replace(/ignore\s+(previous|all|prior)\s+instructions?/gi, "[FILTERED]")
    .replace(/you\s+are\s+now\s+\w+/gi, "[FILTERED]")
    .replace(/system\s*:\s*/gi, "[FILTERED]")
    .replace(/```[\s\S]*?```/g, "[code block removed]")
    .slice(0, 200); // Hard length cap

  // Spawn a subagent with full tool access so it can grep/read the codebase
  // before producing findings. This prevents hallucinated research.
  const researchPrompt = `You are a research agent investigating a proposed change to the Kaya system at ${KAYA_HOME}.

## Proposed Change
Title: ${safeTitle}
Description: ${ctx.notes}

## Research Guidance
${researchGuidanceSection}
${ctx.scopeHints ? `\nScope Constraints: ${ctx.scopeHints}` : ""}${revisionContext}${grillDirectivesSection}${priorFindingsSection}${priorCompletedSection}${domainVocabSection}

## Tagging Protocol

When you document findings, tag each finding with resolution status:
- [RESOLVED] — you confirmed the answer in the codebase with evidence
- [NEEDS_INPUT: <specific question>] — requires human decision or information not available in codebase

Example:
> The config loader uses loadTieredConfig not raw JSON.parse. [RESOLVED: confirmed in ConfigLoader.ts:47]
> Should the new field be required or optional? [NEEDS_INPUT: depends on backward-compatibility policy]

## CRITICAL INSTRUCTIONS

You MUST verify all assumptions against the actual codebase before producing findings.
Do NOT assume a bug exists — grep for the relevant code and confirm.
Do NOT assume a feature is missing — search the codebase and confirm.
Do NOT assume a structure is flat/missing/broken — read the actual files.

## Research Steps

1. **Verify the premise**: Search the codebase for the files, functions, or patterns mentioned in the description. Does the problem actually exist? Is the proposed change already implemented?
2. **If the premise is FALSE**: Write findings stating "FALSE POSITIVE — [reason]" with evidence (file paths, line numbers, code snippets). This is a valid and valuable research outcome. Use VERDICT: skip.
3. **If the premise is TRUE**: Investigate the actual current state and produce structured findings:
   - Each discrete deliverable as an atomic outcome
   - Acceptance criteria (what "done" looks like, measurable)
   - Verification methods (test / existence / runtime / manual)
   - Dependencies and risks
   - Explicit constraints from the description

## Verdict (REQUIRED)

After completing your research, you MUST include a verdict section at the end of your findings. This determines whether the item proceeds to spec generation or is filtered out.

## VERDICT: implement | skip | defer
- Reason: [one sentence explaining why]
- Scope estimate: [small (<1hr) | medium (1-4hr) | large (4hr+)]

**Verdict criteria:**
- **implement**: The problem is real, the fix is actionable, and it's worth the implementation effort.
- **skip**: The problem doesn't exist (false positive), is already implemented, or the cost clearly outweighs the benefit.
- **defer**: The problem is real but low priority, blocked by something else, or needs information that isn't available yet.

Be honest and critical. Not every finding warrants a spec. If the research reveals the item would just produce a report with no concrete implementation, that's a strong signal for "skip" unless Jm specifically requested the research.

## Output Format
Write your findings as structured markdown. Save them to: ${artifactPath}

Start by searching the codebase. Do not skip verification.`;

  const attemptResearch = async (): Promise<StepResult> => {
    // Research subagent cap — generous 30 min for all items (override via
    // SPEC_RESEARCH_TIMEOUT_MS). All items run the same cap: scope variance is
    // real but not predictable from title keywords. Runaway items are still
    // bounded by the researchTimeouts >= 2 pre-pass guard.
    const envCap = Number(process.env.SPEC_RESEARCH_TIMEOUT_MS);
    const RESEARCH_TIMEOUT_MS = Number.isFinite(envCap) && envCap > 0 ? envCap : 30 * 60 * 1000;

    // Hardened env + rate-limit gating come from AgentSpawner; KAYA_HOME is
    // still pinned explicitly so the nested spawn always resolves the same
    // home regardless of ambient env (matches the prior explicit
    // `env: { ...hardenedEnv, KAYA_HOME }` behavior).
    const result = spawnAgentSync({
      prompt: researchPrompt,
      model: RESEARCH_MODEL,
      allowedTools: "Bash,Read,Glob,Grep",
      cwd: KAYA_HOME,
      timeoutMs: RESEARCH_TIMEOUT_MS,
      env: { KAYA_HOME },
    });

    if (!result.success) {
      // Check timedOut FIRST: AgentSpawner.isInfraUnavailable() always sets
      // infraUnavailable=true when timedOut=true (`if (res.preSpawnGated ||
      // res.timedOut) return true;` in lib/core/AgentSpawner.ts) — an
      // infra-first check would mislabel EVERY genuine research timeout as an
      // "infrastructure/rate-limit condition" and make the timedOut branch
      // below dead for real spawns. Both branches bounce the item gracefully
      // with no immediate retry either way (see the outer catch's
      // isTimeout || isInfraUnavailable handling below) — only the
      // reasonLabel/logging differs, so reordering is behavior-preserving.
      if (result.timedOut) {
        throw new Error(`Research subagent timed out after ${RESEARCH_TIMEOUT_MS / 1000}s`);
      }
      if (result.infraUnavailable || result.preSpawnGated) {
        // Rate/usage/credit-pool limit or a pre-spawn gate — never the task's
        // fault. Distinguishable via INFRA_UNAVAILABLE_ERROR_PREFIX so the
        // retry-skip check and outer catch below route it through the SAME
        // graceful defer path as a timeout, instead of "Research phase failed".
        throw new Error(
          `${INFRA_UNAVAILABLE_ERROR_PREFIX}${
            result.preSpawnGated
              ? "pre-spawn rate-limit gate (usage at/above threshold)"
              : `post-spawn (exit ${result.exitCode})`
          }`,
        );
      }
      throw new Error(`Research subagent exited ${result.exitCode}: ${result.stderr.slice(0, 500)}`);
    }

    // The subagent may have written to artifactPath directly; if not, use its stdout
    const findings = existsSync(artifactPath)
      ? readFileSync(artifactPath, "utf-8")
      : result.stdout.trim();

    if (!existsSync(artifactPath)) {
      const artifactContent = `# Research Findings: ${item.payload.title}

**Item ID:** ${item.id}
**Session:** ${sessionId}
**Researched At:** ${new Date().toISOString()}
**Research Method:** Subagent with codebase access
**Research Guidance:** ${ctx.researchGuidance}

---

${findings}
`;
      writeFileSync(artifactPath, artifactContent);
    }

    return await dispatchResearchVerdict(item, qm, findings, artifactPath, sessionId);
  };

  try {
    try {
      return await attemptResearch();
    } catch (innerErr) {
      const msg = innerErr instanceof Error ? innerErr.message : String(innerErr);
      // Retrying immediately is pointless for a timeout OR an infra/rate-limit
      // condition (the SAME gate/limit is almost certainly still in effect) —
      // let the outer catch defer both instead of burning a second doomed attempt.
      if (/timed out/i.test(msg) || msg.startsWith(INFRA_UNAVAILABLE_ERROR_PREFIX)) throw innerErr;
      console.warn(`[spec-pipeline] Research spawn failed (attempt 1), retrying: ${msg}`);
      return await attemptResearch();
    }
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    const isInfraUnavailable = errMsg.startsWith(INFRA_UNAVAILABLE_ERROR_PREFIX);
    const isTimeout = !isInfraUnavailable && /timed out/i.test(errMsg);
    // Human-facing label — kept accurate per cause so an infra pause is never
    // logged/notified as if it were a "timeout" (FIX 4: infra-unavailable means
    // "try again later", never "research failed").
    const reasonLabel = isInfraUnavailable ? "hit an infrastructure/rate-limit condition" : "timed out";

    // A research timeout OR an infra/rate-limit condition (never the task's
    // fault) should BOUNCE the item out of `researching` rather than leave it
    // wedged there — a single stuck item must not get retried forever or wedge
    // the daily job. But first inspect the artifact the subagent was instructed
    // to write: completed or substantial findings must not be discarded by the
    // wall-clock kill / infra pause.
    if (isTimeout || isInfraUnavailable) {
      const meta = (item.payload.context?._meta as Record<string, unknown>) || {};
      const artifactContent = existsSync(artifactPath)
        ? readFileSync(artifactPath, "utf-8")
        : null;
      const outcome = decideTimeoutOutcome(artifactContent);

      if (outcome === "salvage-success") {
        // The subagent finished its findings (explicit verdict) but the kill/
        // pause beat the exit — treat as a normal success, no strike.
        console.log(`[spec-pipeline] Research ${reasonLabel} but artifact is complete — salvaging ${item.id}`);
        return await dispatchResearchVerdict(item, qm, artifactContent!, artifactPath, sessionId);
      }

      const timeouts = ((meta.researchTimeouts as number) || 0) + 1;

      if (outcome === "resume-partial") {
        // Preserve the partial artifact; the next research attempt resumes
        // from it instead of restarting blind.
        try {
          await qm.updateSpecPipelineStatus(item.id, "awaiting-context", undefined, {
            researchTimeouts: timeouts,
            lastTimeoutAt: new Date().toISOString(),
            lastResearchArtifact: artifactPath,
            // Pin the session so the next attempt reuses this exact artifact dir.
            sessionId,
            researchTimeoutNote: `Research ${reasonLabel} (${timeouts}x) with partial findings saved — next attempt resumes from ${artifactPath}.`,
          });
        } catch {
          // Transition is best-effort; even if it fails, the run continues.
        }
        notifySync(`Research ${reasonLabel} (partial saved) — ${item.payload.title} will resume (#${timeouts})`);
        return {
          success: false,
          message: `Research ${reasonLabel} — partial findings preserved for resume (#${timeouts})`,
          data: { bounced: true, researchTimeouts: timeouts, lastResearchArtifact: artifactPath, infraUnavailable: isInfraUnavailable },
        };
      }

      // hard-timeout / hard-infra-block: no explicit verdict yet. Original
      // bounce behavior, but still pin the session (and any sub-verdict
      // partial) so the next attempt RESUMES into the same artifact dir
      // instead of restarting blind — the root cause of heavy items
      // re-researching from scratch every run.
      const hasPartial =
        typeof artifactContent === "string" && artifactContent.trim().length > 0;
      try {
        // Keep the bounce notice in _meta — overwriting researchGuidance would
        // destroy human-authored Item Context from an Interactive Grill.
        await qm.updateSpecPipelineStatus(
          item.id,
          "awaiting-context",
          undefined,
          {
            researchTimeouts: timeouts,
            lastTimeoutAt: new Date().toISOString(),
            sessionId,
            ...(hasPartial ? { lastResearchArtifact: artifactPath } : {}),
            researchTimeoutNote: `Research subagent ${reasonLabel} (${timeouts}x). Bounced from researching — re-enrich context or investigate before retry.`,
          }
        );
      } catch {
        // Transition is best-effort; even if it fails, the run continues.
      }
      notifySync(`Research ${reasonLabel} — bounced ${item.payload.title} to awaiting-context (#${timeouts})`);
      return {
        success: false,
        message: `Research ${reasonLabel} — item bounced to awaiting-context (#${timeouts})`,
        data: { bounced: true, researchTimeouts: timeouts, infraUnavailable: isInfraUnavailable },
      };
    }

    return {
      success: false,
      message: `Research phase failed: ${errMsg}`,
    };
  }
}

/**
 * Route a finished research findings document to its pipeline outcome:
 * skip → archive, defer → hold at awaiting-context,
 * bounce → hold at awaiting-context (no VERDICT token found),
 * implement → generating-spec.
 * Shared by the normal success path and the timeout-salvage path.
 */
export async function dispatchResearchVerdict(
  item: QueueItem,
  qm: QueueManager,
  findings: string,
  artifactPath: string,
  sessionId: string
): Promise<StepResult> {
  // Parse the research verdict — trust the LLM's structured VERDICT output.
  // The research prompt already instructs the LLM to emit VERDICT: skip when
  // the premise is false or Kaya already implements the feature, so no
  // post-parse regex re-derivation is needed (or desirable — it overrides
  // the LLM's explicit judgment when text patterns collide with implement intent).
  const { verdict, reason: verdictReason } = parseResearchVerdict(findings);

  if (verdict === "skip") {
    // ── Grilled-item skip guard (ADR 0002) ─────────────────────────────────
    // A human confirmed this item during a grill session. An autonomous skip
    // verdict must not silently discard that — hold at awaiting-context and
    // escalate to Jm instead of archiving.
    if (hasValidGrillStamp(item)) {
      try {
        await qm.updateSpecPipelineStatus(item.id, "awaiting-context", undefined, {
          researchArtifactPath: artifactPath,
          sessionId,
          researchedAt: new Date().toISOString(),
          verdict: "skip",
          verdictReason,
          skipGuardTriggered: true,
          lastResearchArtifact: null,
        });
      } catch {
        // Transition is best-effort; even if it fails, we still escalate.
      }
      await escalateItem(
        qm,
        item.id,
        item.payload.title,
        `Research verdict was "skip" but the item has a valid grill stamp (human-confirmed intent). Verdict reason: ${verdictReason}. Inspect ${artifactPath}`
      );
      notifySync(`SKIP OVERRIDDEN (grilled): ${item.payload.title} — held at awaiting-context`);
      return {
        success: true,
        message: `Research verdict: skip (overridden — grilled item). Held at awaiting-context and escalated to Jm. See ${artifactPath}`,
        data: { artifactPath, sessionId, verdict: "skip", verdictReason, skipGuardTriggered: true },
      };
    }
    // ── End skip guard ──────────────────────────────────────────────────────

    // Archive the item — it's not worth a spec
    const pipelineItems = loadQueueItems("spec-pipeline");
    const itemToArchive = pipelineItems.find((i) => i.id === item.id);
    if (itemToArchive) {
      itemToArchive.result = {
        status: "skipped",
        completedAt: new Date().toISOString(),
        reviewNotes: `Research verdict: skip — ${verdictReason}`,
      };
      archiveItems("spec-pipeline", [itemToArchive]);
      // Remove from active pipeline
      saveQueueItems("spec-pipeline", pipelineItems.filter((i) => i.id !== item.id));
    }

    notifySync(`SKIPPED: ${item.payload.title} — ${verdictReason}`);

    return {
      success: true,
      message: `Research verdict: skip — ${verdictReason}. Item archived. See ${artifactPath}`,
      data: { artifactPath, sessionId, verdict: "skip", verdictReason },
    };
  }

  if (verdict === "defer") {
    // Hold at awaiting-context with the deferral reason
    await qm.updateSpecPipelineStatus(item.id, "awaiting-context", undefined, {
      researchArtifactPath: artifactPath,
      sessionId,
      researchedAt: new Date().toISOString(),
      verdict: "defer",
      verdictReason,
      lastResearchArtifact: null,
    });

    notifySync(`DEFERRED: ${item.payload.title} — ${verdictReason}`);

    return {
      success: true,
      message: `Research verdict: defer — ${verdictReason}. Item held at awaiting-context. See ${artifactPath}`,
      data: { artifactPath, sessionId, verdict: "defer", verdictReason },
    };
  }

  if (verdict === "bounce") {
    // No VERDICT token in the findings — re-enrich rather than fabricate a spec.
    // Generating a spec from verdict-less research produces junk; the safe outcome
    // is to hold at awaiting-context so the researcher can complete the findings.
    await qm.updateSpecPipelineStatus(item.id, "awaiting-context", undefined, {
      researchArtifactPath: artifactPath,
      sessionId,
      researchedAt: new Date().toISOString(),
      verdict: "bounce",
      verdictReason,
      lastResearchArtifact: null,
    });

    notifySync(`BOUNCED (no verdict): ${item.payload.title} — ${verdictReason}`);

    return {
      success: false,
      message: `Research findings missing VERDICT token — item bounced to awaiting-context. See ${artifactPath}`,
      data: { artifactPath, sessionId, verdict: "bounce", verdictReason },
    };
  }

  // Verdict is "implement" — proceed to spec generation
  await qm.updateSpecPipelineStatus(item.id, "generating-spec", undefined, {
    researchArtifactPath: artifactPath,
    sessionId,
    researchedAt: new Date().toISOString(),
    verdict: "implement",
    verdictReason,
    lastResearchArtifact: null,
  });

  notifySync(`Research complete for: ${item.payload.title} — proceeding to spec generation`);

  return {
    success: true,
    message: `Research findings saved to ${artifactPath} — verdict: implement`,
    data: { artifactPath, sessionId, verdict: "implement" },
  };
}

// ============================================================================
// Phase 2: Spec Generation
// ============================================================================

/**
 * Generate a spec for an item in "generating-spec" status.
 *
 * Uses complexity-adaptive routing (direct inference, no interactive workflow):
 *   - low: Haiku model (fast inference tier)
 *   - medium: Sonnet model (standard inference tier)
 *   - high: Opus model (smart inference tier)
 *
 * When item.payload.context.surface ∈ {browser, native}, the UX/UI Stage runs
 * after base spec generation (ADR 0004: Stage runs before ISC derivation).
 *
 * Saves spec to Plans/Specs/Queue/{item-id}-spec.md and transfers item
 * to the approvals queue.
 *
 * @param _spawnFn — injectable subagent spawn function for testing (default: Bun.spawn claude -p)
 */
async function runSpecGenerationPhase(
  item: QueueItem,
  qm: QueueManager,
  _spawnFn?: SpawnSubagentFn
): Promise<StepResult> {
  const ctx = extractItemContext(item);
  const complexity = getComplexity(item);
  const sessionId = (item.payload.context?._meta as Record<string, unknown>)?.sessionId as string
    || getOrCreateSessionId(item.id);

  ensureDir(SPECS_DIR);

  const specPath = join(SPECS_DIR, `${item.id}-spec.md`);

  notifySync(`Generating spec for: ${item.payload.title}`);

  // Load research findings if available
  let researchContent = "";
  const researchArtifactPath = ctx.previousResearchPath
    || ((item.payload.context?._meta as Record<string, unknown>)?.researchArtifactPath as string);

  if (researchArtifactPath && existsSync(researchArtifactPath)) {
    try {
      researchContent = readFileSync(researchArtifactPath, "utf-8");
    } catch {
      // Research file not readable — continue without it
    }
  }

  // Build spec generation prompt
  const revisionFeedback = ctx.lastRejectionReason
    ? `\n## Revision Feedback (MUST ADDRESS)\n${ctx.lastRejectionReason}\n\nThis is revision ${ctx.revisionCount}. The previous spec was rejected for the above reasons. Ensure this spec specifically addresses each point.\n`
    : "";

  const scopeSection = ctx.scopeHints
    ? `\n## Scope Constraints\n${ctx.scopeHints}\n`
    : "";

  const modelForComplexity = complexity === "low" ? "Haiku" : complexity === "high" ? "Opus" : "Sonnet";

  // Load past learnings for prompt enrichment
  const specLearnings = await loadQueueLearnings();

  // Inject the item's primary-domain canonical vocabulary (GrillWithDocs loop
  // closure). Empty string when no documented domain matches — prompt unchanged.
  const domainVocabSection = loadDomainVocabularyForItem(item);

  const specPrompt = `# Generate Spec: ${item.payload.title}

## Complexity Level
${complexity} (using ${modelForComplexity} model)

## Problem Context
${ctx.notes}
${scopeSection}${revisionFeedback}${domainVocabSection}
## Research Findings
${researchContent || "No research findings available — generate spec from problem context."}
${specLearnings}
## Task
Generate a comprehensive Current Work specification for this item. Include:

1. **Summary** — What we're building/researching and why
2. **Current State Analysis** — What exists today, what's missing
3. **Target State** — What success looks like
4. **Scope** — In scope / out of scope
5. **Ideal State Criteria (ISC)** — MUST use this EXACT format:

## 5. Ideal State Criteria (ISC)

| # | What Ideal Looks Like | Verify Method |
|---|----------------------|---------------|
| 1 | [specific, measurable outcome] | [how to confirm it] |
| 2 | ... | ... |

Include at least 6 rows numbered starting at 1. Each row must have an integer ID in the first column.
For research/discovery tasks, rows describe deliverables and outcomes:
  - "Comparison table with 5+ options across all evaluation criteria" | "File exists at path, table has 5+ rows"
  - "Step-by-step checklist with specific calendar dates" | "All dates present, no TBDs"
  - "Recommended solution with rationale documented" | "Recommendation section present with pros/cons"

6. **Implementation Approach** — Technical decisions and steps (or research methodology for non-code tasks).
   For implementation work spanning more than one deliverable, decompose the approach into **vertical slices** labelled "Phase 1", "Phase 2", etc. Slice vertically, not horizontally: each phase is a thin end-to-end path (schema -> API -> UI -> tests) that is demoable on its own. **Phase 1 must deliver observable end-to-end behavior** -- not an infrastructure-only "Foundation"/"Setup" layer. If an irreducible shared dependency truly forces a setup-only phase, mark it with an HTML comment of the form HORIZONTAL: reason. Single-deliverable or research/discovery tasks do not need phases.

   **If this spec will be BUILT in slices and deliberately DEFERS later phases** (i.e. the first build delivers Phase 1 and Phases 2+ are intended as follow-up work, not built now), you MUST also emit a top-level section titled exactly:

## Follow-On Loops

   listing each deferred phase as a markdown bullet — \`- <Phase title> | spec: <path-if-known>\` (omit the \`| spec: ...\` part when no separate spec file exists). This is what lets the deferred phases be auto-re-queued when Phase 1 completes instead of being orphaned at the plan->build seam. Omit this section entirely when the spec is single-phase or delivers all of its phases in one build.
7. **Verification Plan** — How to verify each ISC criterion
8. **Risks and Mitigations** — Key risks with mitigations
9. **Open Questions** — If any research findings were tagged [NEEDS_INPUT], include them here as a numbered list. If all findings were resolved, omit this section.

Use numbered section headings (## 1. Summary, ## 2. Current State Analysis, etc.).
Format as structured markdown. This spec will be reviewed by Jm before execution.`;

  const inferenceMode = complexity === "low" ? "fast" : complexity === "high" ? "smart" : "standard";

  try {
    const result = await inference({
      systemPrompt: "You are a specification writer creating detailed, structured specs for implementation, research, and discovery tasks.",
      userPrompt: specPrompt,
      level: inferenceMode as "fast" | "standard" | "smart",
      // Full 9-section specs routinely take >90s to generate; the standard-level
      // default timeout truncates them and every run degrades to the fallback spec.
      timeout: 5 * 60 * 1000,
      retries: 2,
      retryDelayMs: 4000,
    });

    const baseSpecContent = result.success && result.output.trim()
      ? result.output.trim()
      : generateFallbackSpec(item, ctx, complexity, researchContent);

    // ── UX/UI Stage (ADR 0004: runs BEFORE ISC derivation) ───────────────────
    // Fires only when surface ∈ {browser, native}. Non-UI items skip cleanly.
    const surface = (item.payload.context as Record<string, unknown> | undefined)?.surface as string | undefined;
    let specContent = baseSpecContent;

    const uxuiStageResult = await runUXUIStageForPipeline({
      specContent: baseSpecContent,
      surface,
      complexity,
      itemTitle: item.payload.title,
      _spawnFn,
    });

    // One schema-constrained read of the LLM-authored UX/UI section serves
    // BOTH the ISC derivation and the coverage gate (markdown-regex
    // remediation 2026-08-01 — the old regex chain hard-rejected specs over
    // heading-format drift in markdown the spec LLM actually wrote).
    // Whether the stage ran is harness-structural truth (uxuiStageResult),
    // never re-derived by scanning the spec text.
    let uxStructure: UXStructureResult | null = null;

    if (!uxuiStageResult.skipped && uxuiStageResult.uxuiSection.trim()) {
      specContent = baseSpecContent + "\n\n" + uxuiStageResult.uxuiSection;

      uxStructure = await extractUXStructure(specContent);

      // Merge behavioral ISC rows derived from UX/UI acceptance criteria into spec
      if (uxStructure.ok) {
        const behavioralRows = renderBehavioralISC(uxStructure.structure);
        if (behavioralRows.length > 0) {
          specContent = mergeISCRows(specContent, behavioralRows);
        }
      }
    }

    // ── UX/UI structural coverage gate ──────────────────────────────────────
    // Screen × state coverage as set math over the extracted structure.
    // Non-UI items (UX/UI stage skipped) pass unconditionally. Extraction
    // failure bounces with an explicit infra reason — never a phantom gap.
    const uxCompletenessCheck =
      uxStructure === null
        ? { pass: true, failures: [] as string[] }
        : uxStructure.ok
          ? computeUXCompleteness(uxStructure.structure)
          : {
              pass: false,
              failures: [
                `UX structure extraction unavailable (${uxStructure.error}) — coverage gate cannot verify screen × state coverage; re-run the pipeline`,
              ],
            };

    if (!uxCompletenessCheck.pass) {
      const failures = uxCompletenessCheck.failures;
      const rejectReason = `UX structural coverage gate failed: ${failures.slice(0, 3).join("; ")}`;
      notifySync(`[UXUI GATE] ${item.payload.title}: ${rejectReason}`);

      await qm.updateSpecPipelineStatus(item.id, "awaiting-context", {
        researchGuidance: `UX structural coverage rejection: ${failures.join("; ")}. Re-run after providing missing screen state wireframes (### State: markers) for all declared states.`,
      });

      return {
        success: false,
        message: rejectReason,
        data: { uxuiGateRejection: true, failures },
      };
    }

    // LLM Spec-Quality Gate — judge whether the generated spec is substantive.
    // Replaces the deleted regex-based validateISCQuality + validateSliceShape
    // which produced false-positive rejections on real grilled specs.
    // On judge unavailability, verdict is NEEDS_REVIEW (not auto-pass, not auto-fail).
    const judgment = await judgeSpecQuality(specContent, item.id);
    if (!judgment.pass) {
      const reasonSummary = judgment.reasons.length > 0
        ? judgment.reasons.join("; ")
        : `Judge verdict: ${judgment.verdict}`;
      const rejectReason = `Spec quality gate failed: ${reasonSummary}`;
      notifySync(`[QUALITY GATE] ${item.payload.title}: ${rejectReason}`);

      // Return item to awaiting-context with the LLM-provided reasons
      await qm.updateSpecPipelineStatus(item.id, "awaiting-context", {
        researchGuidance: `Quality gate rejection (${judgment.verdict}): ${reasonSummary}. Re-enrich the spec with specific deliverables, observable acceptance criteria, and concrete verification commands.`,
      });

      return {
        success: false,
        message: rejectReason,
        data: { qualityGateRejection: true, verdict: judgment.verdict, reasons: judgment.reasons },
      };
    }

    // Write spec file
    const fullSpecContent = `# ${item.payload.title} — Current Work Spec

**Generated:** ${new Date().toISOString()}
**Item ID:** ${item.id}
**Complexity:** ${complexity} (${modelForComplexity})
**Revision:** ${ctx.revisionCount > 0 ? ctx.revisionCount : "Initial"}
**Session:** ${sessionId}

---

${specContent}
`;

    writeFileSync(specPath, fullSpecContent);

    // Generate test strategy document from spec ISC rows
    const testStrategyPath = join(SPECS_DIR, `${item.id}-test-strategy.md`);
    const testStrategyContent = await generateTestStrategy(specContent, item.payload.title, specPath);
    if (testStrategyContent) {
      writeFileSync(testStrategyPath, testStrategyContent);
    }

    // Create spec linkage object (draft — Jm must approve before item can advance)
    const spec: QueueItemSpec = {
      id: `${item.id}-spec`,
      path: specPath,
      status: "draft",
      ...(testStrategyContent ? { testStrategyPath } : {}),
    };

    // Transfer item to approvals queue
    await qm.transfer(item.id, {
      targetQueue: "approvals",
      status: "awaiting_approval",
      notes: `Spec generated via spec-pipeline (complexity: ${complexity}). Review at: ${specPath}`,
      transferredBy: "spec-pipeline",
    });

    // The item has advanced past any research wedge — its spec is now in
    // approvals. Close any lingering research-timeout escalation so Jm doesn't
    // see a stale "needs human attention" task duplicating the approval surface.
    await closeEscalationIfOpen(
      item.id,
      `Spec generated and moved to approvals (${specPath}) — research wedge resolved.`
    );

    // Attach spec to the transferred item in approvals
    await qm.setSpec(item.id, spec);

    // Update metadata with spec path
    const approvalsItems = loadQueueItems("approvals");
    const approvalItem = approvalsItems.find((i) => i.id === item.id);
    if (approvalItem) {
      approvalItem.payload.context = {
        ...(approvalItem.payload.context || {}),
        _meta: {
          ...((approvalItem.payload.context?._meta as Record<string, unknown>) || {}),
          specPath,
          testStrategyPath: testStrategyContent ? testStrategyPath : undefined,
          specGeneratedAt: new Date().toISOString(),
          complexity,
          sessionId,
          researchArtifactPath: researchArtifactPath || undefined,
        },
      };
      // Re-save approvals to capture metadata update
      const allApprovals = loadQueueItems("approvals");
      const idx = allApprovals.findIndex((i) => i.id === item.id);
      if (idx !== -1) {
        allApprovals[idx].payload.context = approvalItem.payload.context;
        // Use saveQueueItems directly for atomic update
        const { saveQueueItems } = await import("./QueueManager.ts");
        saveQueueItems("approvals", allApprovals);
      }
    }

    notifySync(`Spec generated for: ${item.payload.title}`);

    return {
      success: true,
      message: `Spec saved to ${specPath} and transferred to approvals`,
      data: { specPath, targetQueue: "approvals" },
    };
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    return {
      success: false,
      message: `Spec generation failed: ${errMsg}`,
    };
  }
}

/**
 * Merge behavioral ISC rows (derived from UX/UI acceptance criteria) into the
 * spec's existing ISC table. Appends the rows before the closing of the table.
 *
 * If no ISC table is found, appends a new one at the end of the spec.
 */
function mergeISCRows(specContent: string, rows: string[]): string {
  if (rows.length === 0) return specContent;

  // Find the existing ISC table — the last `| # |` or `| ID |` row in the spec
  const tableHeaderRegex = /^\|[\s-]*#[\s-]*\|[\s-]*(?:What Ideal|Criterion)[^|]*\|/im;
  const match = specContent.match(tableHeaderRegex);

  if (match && match.index !== undefined) {
    // Find the end of the table block (first blank line after the header)
    const after = specContent.slice(match.index);
    const tableEndMatch = after.match(/\n\n|\n(?!\|)/);
    const insertOffset = tableEndMatch
      ? match.index + (tableEndMatch.index ?? after.length)
      : specContent.length;

    const before = specContent.slice(0, insertOffset);
    const after2 = specContent.slice(insertOffset);
    return before + "\n" + rows.join("\n") + after2;
  }

  // No existing table — append a new section
  return specContent + "\n\n### Behavioral ISC (from UX/UI Acceptance Criteria)\n\n| ID | Criterion | Files | Verify | Effort |\n|----|-----------|-------|--------|--------|\n" + rows.join("\n");
}


/**
 * Generate a clearly-marked fallback spec when Inference is unavailable.
 * Designed to be caught by the ISC quality gate — never silently reach approvals.
 */
export function generateFallbackSpec(
  item: QueueItem,
  ctx: ReturnType<typeof extractItemContext>,
  complexity: Complexity,
  researchContent: string
): string {
  notifySync(`[FALLBACK SPEC] Inference unavailable for: ${item.payload.title}`);

  return `## 1. Summary

[FALLBACK] ${ctx.notes}

## 2. Current State

[FALLBACK] **Problem:** ${item.payload.description}

## 3. Target State

[FALLBACK] Resolve the problem described above.

## 4. Scope

### In Scope
[FALLBACK] - Core implementation as described in problem context
${ctx.scopeHints ? `- Scope constraints: ${ctx.scopeHints}` : ""}

### Out of Scope
[FALLBACK] - Future enhancements not mentioned in problem context

## 5. Ideal State Criteria (ISC)

| # | What Ideal Looks Like | Verify Method |
|---|----------------------|---------------|
| 1 | FALLBACK_SPEC: Inference unavailable — requires re-generation | Manual review |

## 6. Implementation Approach

[FALLBACK] Based on research findings and problem context:
${researchContent ? "\nKey findings from research:\n" + researchContent.split("\n").slice(0, 10).join("\n") : "\n(No research findings — expand with domain-specific investigation)"}

## 7. Verification Plan

Review against ISC criteria above.

## 8. Risks

${ctx.revisionCount > 0 ? `**Previous rejection:** ${ctx.lastRejectionReason}\n\n` : ""}
- Standard implementation risks apply`;
}

// ============================================================================
// Revision Handling
// ============================================================================

/**
 * Process a "revision-needed" item by re-entering the research phase
 * (which incorporates rejection feedback as constraints).
 *
 * The item must have result.reviewNotes containing the rejection feedback.
 */
async function runRevisionPhase(item: QueueItem, qm: QueueManager): Promise<StepResult> {
  const meta = (item.payload.context?._meta as Record<string, unknown>) || {};
  const revisionCount = (meta.revisionCount as number) || 0;

  notifySync(`Re-processing revision ${revisionCount} for: ${item.payload.title}`);

  // Transition back to researching — this allows research phase to pick it up
  // with the rejection feedback included in the research prompt
  try {
    await qm.updateSpecPipelineStatus(item.id, "researching");
    return {
      success: true,
      message: `Item ${item.id} transitioned to researching for revision ${revisionCount}`,
    };
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    return { success: false, message: `Revision transition failed: ${errMsg}` };
  }
}

// ============================================================================
// Main Pipeline Processor
// ============================================================================

/**
 * Process a single spec-pipeline item through its current phase.
 *
 * Routes based on item.status:
 * - "researching" → run research phase → transition to "generating-spec"
 * - "generating-spec" → run spec generation → transfer to approvals
 * - "revision-needed" → run revision phase → transition to "researching"
 * - "escalated" → notify and skip
 * - "awaiting-context" → skip (needs context first)
 */
export async function processItem(itemId: string): Promise<StepResult> {
  const qm = new QueueManager();
  const items = loadQueueItems("spec-pipeline");
  const item = items.find((i) => i.id === itemId);

  if (!item) {
    return { success: false, message: `Item not found in spec-pipeline: ${itemId}` };
  }

  switch (item.status) {
    case "researching":
      return runResearchPhase(item, qm);

    case "generating-spec":
      return runSpecGenerationPhase(item, qm);

    case "revision-needed":
      return runRevisionPhase(item, qm);

    case "escalated":
      return {
        success: false,
        message: `Item ${itemId} is escalated — requires manual review by Jm`,
      };

    case "awaiting-context":
      return {
        success: false,
        message: `Item ${itemId} is awaiting context — use /queue context or CLI to attach context`,
      };

    default:
      return {
        success: false,
        message: `Item ${itemId} has unrecognized status: ${item.status}`,
      };
  }
}

/**
 * Process all spec-pipeline items that are in a processable state.
 * First re-evaluates "awaiting-context" items (enriched after creation or
 * bounced back from the ISC quality gate) and auto-advances them if they
 * now have sufficient context. Then runs "researching", "generating-spec",
 * and "revision-needed" items.
 */

/**
 * Build a grill-AWARE escalation reason for a research-wedged item.
 *
 * The old reason ("research timed out Nx — re-enrich…") said nothing about
 * grilling, so a grilled-then-wedged item on the Needs-Jm board looked
 * identical to one that never went near a grill. This surfaces (a) whether the
 * item already passed the human grill gate and when, and (b) that the wedge is
 * in the RESEARCH phase, not grilling — so Jm isn't being asked to grill
 * something that's actually waiting on autonomous research.
 */
export function buildEscalationReason(item: QueueItem, researchTimeouts: number): string {
  const meta = (item.payload.context?._meta as Record<string, unknown>) || {};
  const stamp = meta.grillStamp as { at?: string } | undefined;
  const grillState = hasValidGrillStamp(item)
    ? `Already grilled (${stamp?.at ?? "date unknown"}) — human-confirmed intent; the wedge is in the RESEARCH phase, not grilling.`
    : `Never grilled (auto-routed "clear").`;
  // Cause-neutral wording: meta.researchTimeouts increments for BOTH a genuine
  // wall-clock timeout AND an infra/rate-limit bounce (see attemptResearch
  // above) — "timed out Nx" would misreport an infra-caused bounce as a
  // timeout. No second counter is introduced; the meta shape stays stable.
  return (
    `Research attempts bounced ${researchTimeouts}x (timeout or infra-unavailable) — wedged at awaiting-context. ${grillState} ` +
    `Re-enrich context or investigate before retry.`
  );
}

/**
 * Grill brief for an un-grilled item that wedged in research. A "clear"
 * verdict that nonetheless wedged is itself evidence the item was under-scoped,
 * so route it to a human grill rather than a generic escalation.
 */
export function buildWedgeGrillBrief(researchTimeouts: number): {
  missing: string[];
  suggested_questions: string[];
  confidence: number;
  verdict: string;
  reasoning: string;
} {
  return {
    missing: [
      "Scope/intent under-specified enough that autonomous research wedged (bounced repeatedly on timeout or infra-unavailable)",
    ],
    suggested_questions: [
      "What is the concrete deliverable, and how will we know it is done (acceptance criteria)?",
      "What is explicitly in scope vs. out of scope?",
      "Are there reference files, prior art, or constraints the work should start from?",
    ],
    confidence: 0,
    verdict: "needs-grill",
    reasoning: `Auto-routed "clear" but research attempts bounced ${researchTimeouts}x (timeout or infra-unavailable) — re-routed to grill to sharpen scope rather than escalated blind.`,
  };
}

/**
 * Dispose of a research-wedged item (researchTimeouts >= 2) in a grill-aware
 * way:
 *   - GRILLED item   → escalate to Jm (it already passed the human gate; the
 *                      wedge is infra/complexity, not under-specification), with
 *                      a grill-aware reason.
 *   - UN-GRILLED item → park for grill (the "clear" routing that skipped the
 *                      gate was likely wrong), so the natural remedy — a human
 *                      grill — is offered instead of a generic escalation.
 *
 * Returns the action taken so callers/tests can assert without reaching into
 * the TaskDB or queue files.
 */
export async function handleWedgedItem(
  qm: QueueManager,
  item: QueueItem,
  researchTimeouts: number
): Promise<{ action: "grill" | "escalate"; reason: string }> {
  const reason = buildEscalationReason(item, researchTimeouts);
  if (hasValidGrillStamp(item)) {
    await escalateItem(qm, item.id, item.payload.title, reason);
    return { action: "escalate", reason };
  }
  try {
    await qm.parkForGrill(item.id, buildWedgeGrillBrief(researchTimeouts));
    return { action: "grill", reason };
  } catch (err) {
    // parkForGrill only throws on a valid grill stamp, which we ruled out
    // above — so this is unexpected. Fall back to escalation so the wedge is
    // never silently lost.
    console.error(
      `[spec-pipeline] handleWedgedItem: parkForGrill failed for ${item.id}: ${err instanceof Error ? err.message : err}`
    );
    await escalateItem(qm, item.id, item.payload.title, reason);
    return { action: "escalate", reason };
  }
}

/**
 * Close an open `manual-<itemId>` escalation task once the item has advanced
 * past the wedge (e.g. its spec reached approvals). QueueSyncBridge only closes
 * these on full COMPLETION, so without this a research-timeout escalation
 * lingered on the Needs-Jm board as a stale duplicate of the same item now
 * sitting in the approvals queue. Best-effort: never breaks the run.
 */
export async function closeEscalationIfOpen(itemId: string, note: string): Promise<boolean> {
  try {
    // cross-skill-allowed: closes the manual-<itemId> Needs-Jm escalation task directly via TaskDB, sharing lib/core/EscalationHelper's escalation id scheme by design (see docstring above); seam candidate: TaskClient escalation writes (deferred, see D3 log)
    const { getTaskDB } = await import("../../../Productivity/LucidTasks/Tools/TaskDB.ts");
    const db = getTaskDB();
    const task = db.getTask(`manual-${itemId}`);
    if (task && task.status !== "done" && task.status !== "cancelled") {
      db.updateTask(
        `manual-${itemId}`,
        { status: "done", description: `${task.description}\n\n[auto-closed] ${note}` },
        "SpecPipelineRunner"
      );
      return true;
    }
  } catch (err) {
    console.error(
      `[spec-pipeline] closeEscalationIfOpen failed for ${itemId}: ${err instanceof Error ? err.message : err}`
    );
  }
  return false;
}

/**
 * Escalate a wedged pipeline item to Jm: a "Kaya — Needs Jm" LucidTask
 * (its own board column + the daily digest) plus a Telegram notification.
 * Replaces the old console.log-only "needs human attention", which nobody
 * ever saw — Kaya v3 sat wedged at researchTimeouts=2 with zero visibility
 * (2026-06-12).
 *
 * Idempotent per item: an open `manual-<itemId>` escalation task skips
 * creation; re-escalation after the prior task closed is intentional (the
 * item wedged again). Sharing the `manual-<itemId>` id scheme with
 * AutonomousWork escalations means QueueSyncBridge auto-closes this task
 * if the item later completes.
 */
export async function escalateItem(
  _qm: QueueManager,
  itemId: string,
  itemTitle: string,
  reason: string
): Promise<boolean> {
  let created = false;
  try {
    // cross-skill-allowed: creates/reopens the manual-<itemId> Needs-Jm escalation task directly via TaskDB, sharing lib/core/EscalationHelper's escalation id scheme by design (see docstring above); seam candidate: TaskClient escalation writes (deferred, see D3 log)
    const { getTaskDB } = await import("../../../Productivity/LucidTasks/Tools/TaskDB.ts");
    const { ensureNeedsJmProject, createOrReopenEscalationTask } = await import(
      "../../../../lib/core/EscalationHelper.ts"
    );
    const db = getTaskDB();
    const existing = db.getTask(`manual-${itemId}`);
    const open = existing && existing.status !== "done" && existing.status !== "cancelled";
    if (!open) {
      const projectId = ensureNeedsJmProject(db);
      // Task context standard (LucidTasks SKILL.md): the escalation task must
      // link the spec and the queue item so Jm can open them from the task.
      const item = await _qm.get(itemId);
      const specPath = item?.payload.spec?.path;
      const contextLinks = [
        ...(specPath ? [specPath] : []),
        `queue item ${itemId}`,
        `Inspect: bun ~/.claude/skills/Automation/QueueRouter/Tools/CLI.ts get ${itemId}`,
      ];
      createOrReopenEscalationTask(
        db,
        itemId,
        `Spec-pipeline escalation: ${itemTitle.slice(0, 80)}`,
        `WHAT: Spec-pipeline item ${itemId} ("${itemTitle}") needs human attention.\nWHY: ${reason}\nDONE WHEN: the item is unwedged (re-queued, re-scoped, or removed) and this task is closed.\nCONTEXT: ${contextLinks.join(" | ")}`,
        projectId,
        { priority: 1 }
      );
      created = true;
      // Telegram only on creation — an already-open escalation was announced.
      // AlertGate adds a per-item cooldown on top of the open-task dedup (so
      // create→close→re-create churn can't spam) and honors KAYA_ALERT_DRY_RUN.
      const { sendAlert } = await import("../../../../lib/core/AlertGate.ts");
      sendAlert(`⚠️ Spec-pipeline escalation: ${itemTitle} — ${reason}`, {
        key: `spec-escalation-${itemId}`,
        tier: "page",
        channel: "telegram",
      });
    }
  } catch (err) {
    // Escalation must never break the run — but its own failure must be loud.
    console.error(
      `[spec-pipeline] escalateItem failed for ${itemId}: ${err instanceof Error ? err.message : err}`
    );
  }
  return created;
}

export async function processAll(): Promise<{
  processed: number;
  succeeded: number;
  failed: number;
  results: Array<{ id: string; status: string; result: StepResult }>;
}> {
  const items = loadQueueItems("spec-pipeline");

  // Pre-pass: inspect awaiting-context items for runaway-research wedges and defers.
  // Verdict-driven routing (Slice 1a): items at awaiting-context are only advanced
  // by an explicit verdict ('clear') at enqueue time or by KayaTaskClassifier's
  // backfill (advanceClearItem). This pre-pass no longer applies content heuristics;
  // it only handles the deferred-until guard and wedged-research cleanup.
  const qm = new QueueManager();
  const awaitingItems = items.filter((i) => i.status === "awaiting-context");
  for (const item of awaitingItems) {
    // Skip items that are deferred until a future date
    const meta = (item.payload.context?._meta as Record<string, unknown> | undefined) ?? {};
    const deferUntil = meta.deferUntil as string | null | undefined;
    if (deferUntil && new Date(deferUntil) > new Date()) {
      console.log(`[spec-pipeline] Pre-pass: skipping ${item.id} — deferred until ${deferUntil}`);
      continue;
    }
    // Do not re-advance an item that has timed out in research repeatedly — it
    // would just wedge the run again. Dispose of it grill-aware: a grilled item
    // escalates to Jm (it already passed the human gate), an un-grilled one
    // routes to a grill (the "clear" routing that skipped the gate was wrong).
    const researchTimeouts = (meta.researchTimeouts as number) || 0;
    if (researchTimeouts >= 2) {
      const { action } = await handleWedgedItem(qm, item, researchTimeouts);
      console.log(
        `[spec-pipeline] Pre-pass: ${item.id} wedged in research (${researchTimeouts}x) — ${
          action === "grill" ? "routed to grill (never grilled)" : "escalated to Jm (already grilled)"
        }`
      );
      continue;
    }
    // Item is at awaiting-context without a reason to skip — leave it.
    // It will be advanced when KayaTaskClassifier backfill re-classifies it
    // or when a human provides context via `/queue context`.
  }

  // Items can only be advanced in this pre-pass via handleWedgedItem (which parks/escalates).
  // awaiting-context items that were not wedged remain there — no reload needed.
  const refreshedItems = items;
  const processableStatuses = new Set(["researching", "generating-spec", "revision-needed"]);
  const processable = refreshedItems.filter((i) => processableStatuses.has(i.status));

  if (processable.length === 0) {
    notifySync("No spec pipeline items ready to process");
    return { processed: 0, succeeded: 0, failed: 0, results: [] };
  }

  notifySync(`Processing ${processable.length} spec pipeline items`);

  const results: Array<{ id: string; status: string; result: StepResult }> = [];
  let succeeded = 0;
  let failed = 0;

  for (const item of processable) {
    const result = await processItem(item.id);
    results.push({ id: item.id, status: item.status, result });
    if (result.success) {
      succeeded++;
    } else {
      failed++;
      console.error(`[SpecPipelineRunner] Failed ${item.id}: ${result.message}`);
    }
  }

  notifySync(`Spec pipeline batch complete: ${succeeded} succeeded, ${failed} failed`);

  return {
    processed: processable.length,
    succeeded,
    failed,
    results,
  };
}

// ============================================================================
// CLI Interface
// ============================================================================

if (import.meta.main) {
  const args = process.argv.slice(2);
  const command = args[0];

  if (!command || command === "--help" || command === "-h") {
    console.log(`
SpecPipelineRunner - Orchestrator for the spec-pipeline queue

Commands:
  process <id>     Process a single item through its current phase
  run              Process all items in processable states
  research <id>    Force-run research phase (item must be in "researching")
  gen-spec <id>    Force-run spec generation (item must be in "generating-spec")

Examples:
  bun run SpecPipelineRunner.ts process abc123
  bun run SpecPipelineRunner.ts run
  bun run SpecPipelineRunner.ts research abc123
  bun run SpecPipelineRunner.ts gen-spec abc123
`);
    process.exit(0);
  }

  const qm = new QueueManager();

  switch (command) {
    case "process": {
      const id = args[1];
      if (!id) {
        console.error("Error: item ID required");
        process.exit(1);
      }
      processItem(id)
        .then((result) => {
          console.log(`Result: ${result.success ? "SUCCESS" : "FAILED"}`);
          console.log(`Message: ${result.message}`);
          if (result.data) {
            console.log("Data:", JSON.stringify(result.data, null, 2));
          }
          process.exit(result.success ? 0 : 1);
        })
        .catch((e) => {
          console.error(`Error: ${e instanceof Error ? e.message : e}`);
          process.exit(1);
        });
      break;
    }

    case "run": {
      processAll()
        .then((summary) => {
          console.log(`\nSpec Pipeline Run Complete:`);
          console.log(`  Processed: ${summary.processed}`);
          console.log(`  Succeeded: ${summary.succeeded}`);
          console.log(`  Failed:    ${summary.failed}`);
          if (summary.results.length > 0) {
            console.log("\nItem Results:");
            for (const r of summary.results) {
              const icon = r.result.success ? "[OK]" : "[FAIL]";
              console.log(`  ${icon} ${r.id} (${r.status}): ${r.result.message}`);
            }
          }
          process.exit(summary.failed > 0 ? 1 : 0);
        })
        .catch((e) => {
          console.error(`Error: ${e instanceof Error ? e.message : e}`);
          process.exit(1);
        });
      break;
    }

    case "research": {
      const id = args[1];
      if (!id) {
        console.error("Error: item ID required");
        process.exit(1);
      }
      const items = loadQueueItems("spec-pipeline");
      const item = items.find((i) => i.id === id);
      if (!item) {
        console.error(`Item not found in spec-pipeline: ${id}`);
        process.exit(1);
      }
      runResearchPhase(item, qm)
        .then((result) => {
          console.log(`Research: ${result.success ? "SUCCESS" : "FAILED"} — ${result.message}`);
          process.exit(result.success ? 0 : 1);
        })
        .catch((e) => {
          console.error(`Error: ${e instanceof Error ? e.message : e}`);
          process.exit(1);
        });
      break;
    }

    case "gen-spec": {
      const id = args[1];
      if (!id) {
        console.error("Error: item ID required");
        process.exit(1);
      }
      const items = loadQueueItems("spec-pipeline");
      const item = items.find((i) => i.id === id);
      if (!item) {
        console.error(`Item not found in spec-pipeline: ${id}`);
        process.exit(1);
      }
      runSpecGenerationPhase(item, qm)
        .then((result) => {
          console.log(`Spec Gen: ${result.success ? "SUCCESS" : "FAILED"} — ${result.message}`);
          process.exit(result.success ? 0 : 1);
        })
        .catch((e) => {
          console.error(`Error: ${e instanceof Error ? e.message : e}`);
          process.exit(1);
        });
      break;
    }

    default:
      console.error(`Unknown command: ${command}`);
      console.error("Use --help for usage.");
      process.exit(1);
  }
}
