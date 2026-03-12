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

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import {
  QueueManager,
  loadQueueItems,
  generateId,
  type QueueItem,
  type QueueItemSpec,
} from "./QueueManager.ts";
import { notifySync } from "../../../../lib/core/NotificationService.ts";
import { inference } from "../../../../lib/core/Inference.ts";
import { memoryStore } from "../../../../lib/core/MemoryStore.ts";
import { extractISC, inferCategory } from "../../AutonomousWork/Tools/SpecParser.ts";
import type { ISCCriterion } from "../../AutonomousWork/Tools/SpecParser.ts";

// ============================================================================
// Constants
// ============================================================================

const KAYA_HOME = process.env.KAYA_HOME || join(homedir(), ".claude");
const WORK_DIR = join(KAYA_HOME, "MEMORY/WORK");
const SPECS_DIR = join(KAYA_HOME, "plans/Specs/Queue");

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

/** Research findings from parallel agents */
interface ResearchFindings {
  itemId: string;
  sessionId: string;
  artifactPath: string;
  findings: string;
  completedAt: string;
}

// ============================================================================
// Test Strategy Generation
// ============================================================================

/** Test level classification for an ISC row */
type TestLevel = "unit" | "integration" | "e2e" | "manual";

/**
 * Classify an ISC row's appropriate test level based on description and verify method.
 * Decision heuristic applied in priority order — first match wins.
 */
function classifyTestLevel(row: ISCCriterion): TestLevel {
  const desc = row.description.toLowerCase();
  const verify = (row.verifyMethod || "").toLowerCase();

  // Check verify method for specific test file references
  if (/bun test\s+\S+\.integration\.test\.\w+/.test(verify)) return "integration";
  if (/bun test\s+\S+\.test\.\w+/.test(verify)) return "unit";

  // Description-based signals
  if (/\b(?:api|endpoint|database|service|db\b|multi-component|cross-service)\b/.test(desc)) return "integration";
  if (/\b(?:ui|workflow|user flow|browser|page|end.to.end|e2e|dashboard|form)\b/.test(desc)) return "e2e";

  // Verify method signals
  if (/^manual$|^existence$/.test(verify.trim())) return "manual";
  if (/^test -f\b/.test(verify.trim())) return "manual";

  // Category-based defaults
  const category = inferCategory(row.description, row.source);
  if (category === "documentation" || category === "deployment") return "manual";

  return "unit";
}

/**
 * Generate a TestStrategy markdown document from spec content.
 * Returns null if the spec has fewer than 2 ISC rows.
 */
function generateTestStrategy(specContent: string, title: string, specPath: string): string | null {
  const iscRows = extractISC(specContent);
  if (iscRows.length < 2) return null;

  // Classify each row
  const classified = iscRows.map((row) => ({
    ...row,
    testLevel: classifyTestLevel(row),
    category: inferCategory(row.description, row.source),
  }));

  // Count by level
  const counts = { unit: 0, integration: 0, e2e: 0, manual: 0 };
  for (const row of classified) {
    counts[row.testLevel]++;
  }

  // Build ISC classification table
  const classTable = classified.map((row) => {
    const desc = row.description.length > 60
      ? row.description.slice(0, 57) + "..."
      : row.description;
    const isSmoke = row.priority === "smoke" ? "yes" : "no";
    const artifact = row.testLevel === "unit" ? "*.test.ts"
      : row.testLevel === "integration" ? "*.integration.test.ts"
      : row.testLevel === "e2e" ? "*.e2e.test.ts"
      : "manual checklist";
    return `| ${row.number} | ${desc} | ${row.testLevel} | ${isSmoke} | ${artifact} |`;
  }).join("\n");

  // Build smoke subset
  const smokeRows = classified.filter((r) => r.priority === "smoke");
  const smokeList = smokeRows.length > 0
    ? smokeRows.map((r, i) => {
        const cmd = r.embeddedCommand || r.verifyMethod || "manual verification";
        return `${i + 1}. ISC #${r.number}: ${r.description} → \`${cmd}\``;
      }).join("\n")
    : "*No smoke rows designated in spec — consider marking 2-4 critical-path rows as smoke.*";

  // Build regression baseline
  const regressionRows = classified.filter((r) =>
    /existing\s+\w+\s+continues|no regression|backward compat/i.test(r.description)
  );
  const regressionTable = regressionRows.length > 0
    ? regressionRows.map((r) => {
        const cmd = r.embeddedCommand || r.verifyMethod || "manual check";
        return `| ${r.description} | ${r.testLevel} test | \`${cmd}\` |`;
      }).join("\n")
    : "| N/A — no regression criteria identified | — | — |";

  // Build non-functional section
  const nfRows = classified.filter((r) =>
    /performance|latency|throughput|security|xss|injection|auth|accessibility|a11y|wcag/i.test(r.description)
  );
  const nfTable = nfRows.length > 0
    ? nfRows.map((r) => {
        const cat = /performance|latency|throughput/i.test(r.description) ? "Performance"
          : /security|xss|injection|auth/i.test(r.description) ? "Security"
          : "Accessibility";
        const method = r.embeddedCommand || r.verifyMethod || "manual review";
        return `| ${cat} | ${r.number} | ${r.description} | \`${method}\` |`;
      }).join("\n")
    : "*(No non-functional ISC rows detected)*";

  const now = new Date().toISOString().split("T")[0];

  return `# Test Strategy: ${title}

**Spec:** ${specPath}
**Generated:** ${now}
**ISC Rows:** ${classified.length} (${counts.unit} unit, ${counts.integration} integration, ${counts.e2e} e2e, ${counts.manual} manual)

---

## ISC Test Classification

| ISC # | Description | Test Level | Smoke? | Test Artifact |
|-------|-------------|-----------|--------|---------------|
${classTable}

---

## Smoke Test Subset (Run First)

Execute these before any other verification — if any fail, stop.

${smokeList}

---

## Regression Baseline

| What Must Not Break | Verification | Command |
|---------------------|-------------|---------|
${regressionTable}

---

## Non-Functional Tests

| Category | ISC # | Requirement | How to Verify |
|----------|-------|-------------|---------------|
${nfTable}

---

## Test Execution Order

1. **Smoke pass** — Run smoke-priority ISC verification commands (fast-fail)
2. **Unit tests** — \`bun test\` for all unit-level ISC rows
3. **Integration tests** — Targeted integration test files
4. **Regression check** — Regression baseline commands
5. **E2E / Manual** — Full workflow verification and human review items

---

## Test Artifact Checklist

- [ ] Unit test files created for ISC rows classified as \`unit\`
- [ ] Integration test files created for ISC rows classified as \`integration\`
- [ ] E2E scripts created for ISC rows classified as \`e2e\`
- [ ] Manual verification checklist documented for \`manual\` rows
- [ ] All smoke subset commands pass
- [ ] All regression baseline commands pass
`;
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
  };
}

/**
 * Determine complexity from enrichment or default to "medium".
 */
function getComplexity(item: QueueItem): Complexity {
  const enrichmentComplexity = item.enrichment?.complexity;
  if (enrichmentComplexity === "low" || enrichmentComplexity === "medium" || enrichmentComplexity === "high") {
    return enrichmentComplexity;
  }
  return "medium";
}

// ============================================================================
// ISC Quality Gate
// ============================================================================

const SKELETON_PHRASES = [
  "implementation matches problem context",
  "no regressions in existing functionality",
];

/**
 * Validate that generated spec content has meaningful ISC rows.
 * Rejects skeleton specs and fallback specs before they reach approvals.
 */
export function validateISCQuality(specContent: string): { pass: boolean; reason?: string } {
  const isc = extractISC(specContent);
  const primary = isc.filter((r) => r.number < 100);

  if (primary.length < 4) {
    return { pass: false, reason: `Only ${primary.length} ISC rows (need >=4)` };
  }

  const hasSkeleton = primary.some((r) =>
    SKELETON_PHRASES.some((s) => r.description.toLowerCase().includes(s))
  );
  if (hasSkeleton) {
    return { pass: false, reason: "Contains skeleton/generic ISC phrases" };
  }

  return { pass: true };
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
// Phase 1: Research Orchestration
// ============================================================================

/**
 * Execute the research phase for an item in "researching" status.
 *
 * Builds a research prompt from the item context, invokes the Inference tool
 * to synthesize research findings, saves findings to the MEMORY/WORK session
 * artifact, and transitions the item to "generating-spec".
 *
 * For Phase 3 implementation: research is done via direct Inference call with
 * structured research prompts. In production, this would spawn parallel
 * Task agents (ClaudeResearcher, GeminiResearcher) — the infrastructure for
 * that lives in AgentOrchestrator.ts.
 */
async function runResearchPhase(item: QueueItem, qm: QueueManager): Promise<StepResult> {
  const ctx = extractItemContext(item);
  const sessionId = getOrCreateSessionId(item.id);
  const sessionDir = join(WORK_DIR, sessionId);
  ensureDir(sessionDir);

  const artifactPath = join(sessionDir, `research-${item.id}.md`);

  notifySync(`Researching: ${item.payload.title}`);

  // Build research prompt incorporating any rejection feedback
  const revisionContext = ctx.lastRejectionReason
    ? `\n\n## Previous Spec Rejection Feedback\n${ctx.lastRejectionReason}\n\nAddress the above concerns in research findings.`
    : "";

  // Detect auto-routed items (research needed but not manually guided) and use ISC-directed synthesis
  const isAutoRouted = isAutoRoutedGuidance(ctx.researchGuidance);

  const taskSection = isAutoRouted
    ? `## Task
Transform this description into structured findings that enable ISC generation:

1. **Deliverables** — List each discrete deliverable as an atomic outcome
2. **Acceptance criteria** — What "done" looks like for each, measurable
3. **Verification methods** — test / existence / runtime / manual for each
4. **Dependencies and risks** — What can block each deliverable
5. **Constraints** — Explicit boundaries from the description

Format each deliverable as: | Deliverable | Done-when | Verify |`
    : `## Task
Conduct thorough research on this topic. Provide:
1. Key findings relevant to the problem
2. Best practices and industry standards
3. Technical approaches and trade-offs
4. Specific recommendations for spec generation
5. Potential risks and mitigations

Format as structured markdown with clear sections.`;

  // Load past learnings for prompt enrichment
  const learnings = await loadQueueLearnings();

  const researchPrompt = `# Research Task: ${item.payload.title}

## Problem Context
${ctx.notes}

## Research Guidance
${isAutoRouted ? ctx.notes : ctx.researchGuidance}

${ctx.scopeHints ? `## Scope Constraints\n${ctx.scopeHints}\n` : ""}${revisionContext}${learnings}

${taskSection}`;

  try {
    // Invoke Inference library for research synthesis
    const result = await inference({
      systemPrompt: "You are a research analyst synthesizing findings for a technical specification.",
      userPrompt: researchPrompt,
      level: "smart",
    });

    const findings = result.success && result.output.trim()
      ? result.output.trim()
      : `# Research Findings: ${item.payload.title}\n\n## Context\n${ctx.notes}\n\n## Research Guidance Applied\n${ctx.researchGuidance}\n\n## Note\nDirect research synthesis — expand with domain-specific investigation before finalizing spec.`;

    // Write research artifact
    const artifactContent = `# Research Findings: ${item.payload.title}

**Item ID:** ${item.id}
**Session:** ${sessionId}
**Researched At:** ${new Date().toISOString()}
**Research Guidance:** ${ctx.researchGuidance}

---

${findings}
`;

    writeFileSync(artifactPath, artifactContent);

    // Update item metadata with research artifact path
    await qm.updateSpecPipelineStatus(item.id, "generating-spec", undefined, {
      researchArtifactPath: artifactPath,
      sessionId,
      researchedAt: new Date().toISOString(),
    });

    notifySync(`Research complete for: ${item.payload.title}`);

    return {
      success: true,
      message: `Research findings saved to ${artifactPath}`,
      data: { artifactPath, sessionId },
    };
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    return {
      success: false,
      message: `Research phase failed: ${errMsg}`,
    };
  }
}

// ============================================================================
// Phase 2: Spec Generation
// ============================================================================

/**
 * Generate a spec for an item in "generating-spec" status.
 *
 * Uses complexity-adaptive routing:
 *   - low: Haiku model via CurrentWork SpecSheet workflow
 *   - medium: Sonnet model via SpecFromDescription + CurrentWork
 *   - high: Opus model via GroundedIdeal + CurrentWork
 *
 * Saves spec to Plans/Specs/Queue/{item-id}-spec.md and transfers item
 * to the approvals queue.
 */
async function runSpecGenerationPhase(item: QueueItem, qm: QueueManager): Promise<StepResult> {
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

  const specPrompt = `# Generate Spec: ${item.payload.title}

## Complexity Level
${complexity} (using ${modelForComplexity} model)

## Problem Context
${ctx.notes}
${scopeSection}${revisionFeedback}
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

6. **Implementation Approach** — Technical decisions and steps (or research methodology for non-code tasks)
7. **Verification Plan** — How to verify each ISC criterion
8. **Risks and Mitigations** — Key risks with mitigations

Use numbered section headings (## 1. Summary, ## 2. Current State Analysis, etc.).
Format as structured markdown. This spec will be reviewed by Jm before execution.`;

  const inferenceMode = complexity === "low" ? "fast" : complexity === "high" ? "smart" : "standard";

  try {
    const result = await inference({
      systemPrompt: "You are a specification writer creating detailed, structured specs for implementation, research, and discovery tasks.",
      userPrompt: specPrompt,
      level: inferenceMode as "fast" | "standard" | "smart",
    });

    const specContent = result.success && result.output.trim()
      ? result.output.trim()
      : generateFallbackSpec(item, ctx, complexity, researchContent);

    // ISC Quality Gate — reject skeleton/weak specs before they reach approvals
    const iscCheck = validateISCQuality(specContent);
    if (!iscCheck.pass) {
      const rejectReason = `ISC quality gate failed: ${iscCheck.reason}`;
      notifySync(`[QUALITY GATE] ${item.payload.title}: ${rejectReason}`);

      // Return item to awaiting-context with the rejection reason
      await qm.updateSpecPipelineStatus(item.id, "awaiting-context", {
        researchGuidance: `Quality gate rejection: ${iscCheck.reason}. Re-enrich description with specific deliverables, acceptance criteria, and verification methods before re-running pipeline.`,
      });

      return {
        success: false,
        message: rejectReason,
        data: { qualityGateRejection: true, reason: iscCheck.reason },
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
    const testStrategyContent = generateTestStrategy(specContent, item.payload.title, specPath);
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
 * Check if research guidance was auto-generated by the routing system.
 * Auto-routed items get ISC-directed synthesis prompts instead of general research.
 */
export function isAutoRoutedGuidance(guidance: string): boolean {
  return guidance.startsWith("Research needed:")
    || guidance.startsWith("Auto-advanced:");
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
export async function processAll(): Promise<{
  processed: number;
  succeeded: number;
  failed: number;
  results: Array<{ id: string; status: string; result: StepResult }>;
}> {
  const items = loadQueueItems("spec-pipeline");

  // Pre-pass: re-evaluate awaiting-context items for auto-advance
  // State machine only allows awaiting-context → researching, so always
  // advance to "researching". The normal processItem flow will then handle
  // researching → generating-spec (skipping research if canDeriveISCDirectly).
  const qm = new QueueManager();
  const awaitingItems = items.filter((i) => i.status === "awaiting-context");
  let advanced = 0;
  for (const item of awaitingItems) {
    if (qm.hassufficientContext(item.payload, item.payload.context)) {
      await qm.updateSpecPipelineStatus(item.id, "researching");
      console.log(`[spec-pipeline] Pre-pass: advanced ${item.id} to researching`);
      advanced++;
    }
  }

  // Re-load after pre-pass to include newly advanced items
  const refreshedItems = advanced > 0 ? loadQueueItems("spec-pipeline") : items;
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
