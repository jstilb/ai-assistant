/**
 * TestStrategyGenerator.ts — Standalone test strategy document generator.
 *
 * Extracted from SpecPipelineRunner.ts per QueueRouter spec Decision E / ISC #6.
 * Generates a TestStrategy markdown document from ISC rows extracted from a spec.
 *
 * This is content generation — it is not a pipeline orchestration concern and
 * does not belong in SpecPipelineRunner.
 *
 * Phase 6 (de-determinize): classifyTestLevel/inferCategoryInline keyword/regex
 * chains removed. category + testLevel are now emitted by comprehendSpec (LLM-derived)
 * per Rule 8 in LLMSpecComprehension.ts. Rows without those fields (comprehensions
 * produced before Phase 6) fall back to safe defaults: category="general", testLevel="unit".
 */

// cross-skill-allowed: shared spec-comprehension engine, deliberate reuse; lift candidate: lib/core
import { comprehendSpec } from "../../AutonomousWork/Tools/LLMSpecComprehension.ts";
// cross-skill-allowed: shared spec-comprehension engine, deliberate reuse; lift candidate: lib/core
import type { ComprehendSpecOpts } from "../../AutonomousWork/Tools/LLMSpecComprehension.ts";
import type { ISCCriterion } from "../../../../lib/interfaces/SpecParserInterface.ts";

// ============================================================================
// Types
// ============================================================================

/** Test level classification for an ISC row */
type TestLevel = "unit" | "integration" | "e2e" | "manual";

// ============================================================================
// Helpers
// ============================================================================

/**
 * Map a ComprehendedRow to the ISCCriterion shape used by this module.
 * Carries the LLM-emitted category/testLevel through so the generator can
 * consume them directly without re-running keyword heuristics.
 */
function toISCCriterion(row: {
  id: number;
  description: string;
  verifyCommand: string | null;
  humanRequired: boolean;
  native: boolean;
  category?: string;
  testLevel?: "unit" | "integration" | "e2e" | "manual";
}): ISCCriterion & { llmCategory?: string; llmTestLevel?: TestLevel } {
  return {
    number: row.id,
    description: row.description,
    verifyMethod: row.verifyCommand ?? undefined,
    embeddedCommand: row.verifyCommand ?? undefined,
    source: "EXPLICIT",
    priority: undefined,
    // Carry LLM-emitted fields through for downstream consumption
    llmCategory: row.category,
    llmTestLevel: row.testLevel,
  };
}

/**
 * Resolve a row's test level.
 * Consumes the LLM-emitted testLevel from comprehendSpec (Rule 8) when present.
 * Falls back to "unit" for rows from pre-Phase-6 comprehensions — NO keyword
 * re-interpretation as a fallback.
 */
function resolveTestLevel(row: ISCCriterion & { llmTestLevel?: TestLevel }): TestLevel {
  return row.llmTestLevel ?? "unit";
}

/**
 * Resolve a row's category.
 * Consumes the LLM-emitted category from comprehendSpec (Rule 8) when present.
 * Falls back to "general" for rows from pre-Phase-6 comprehensions.
 */
function resolveCategory(row: ISCCriterion & { llmCategory?: string }): string {
  return row.llmCategory ?? "general";
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Generate a TestStrategy markdown document from spec content.
 *
 * @param specContent - Raw markdown content of the spec
 * @param title - Item title (used in document header)
 * @param specPath - Path to the spec file (used in document header)
 * @param opts - Optional comprehendSpec overrides (e.g. inferenceFn for testing)
 * @returns Markdown string, or null if the spec has fewer than 2 ISC rows
 */
export async function generateTestStrategy(
  specContent: string,
  title: string,
  specPath: string,
  opts?: ComprehendSpecOpts
): Promise<string | null> {
  let comprehended;
  try {
    comprehended = await comprehendSpec(specContent, opts);
  } catch {
    // comprehendSpec throws on persistently-empty/invalid — no usable ISC, fail closed.
    return null;
  }

  const iscRows = comprehended.rows.map(toISCCriterion);
  if (iscRows.length < 2) return null;

  // Resolve category and testLevel from LLM-emitted fields (Phase 6).
  // No keyword/regex re-interpretation — use the LLM's judgment or safe defaults.
  const classified = iscRows.map((row) => ({
    ...row,
    testLevel: resolveTestLevel(row),
    category: resolveCategory(row),
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
