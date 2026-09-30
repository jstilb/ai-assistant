#!/usr/bin/env bun
/**
 * label-isc-quality-golden.ts
 *
 * Builds the ISC-quality golden set via REAL ensemble labeling.
 *
 * For each spec's ISC content, runs the EnsembleLabelGrader (fast + standard + smart)
 * using the ISC quality rubric from ensemble-known-truth.yaml (the isc bucket).
 * Writes one JSONL line per case to:
 *   skills/Intelligence/Evals/Data/golden/isc-quality-golden.jsonl
 *
 * Consensus cases  → { specId, quality: "pass"|"fail", source: 'ensemble', labeled_at, criteria_version, real }
 * Divergent cases  → { specId, quality: null, divergent: true, votes, source: 'ensemble', labeled_at, criteria_version, real }
 *
 * Corpus:
 *   - 10 REAL specs from ~/.claude/plans/Specs/Queue/ (ISC extracted/truncated to 2500 chars)
 *   - 8 SYNTHETIC barren/skeleton specs (constructed to test fail path)
 *
 * Usage:
 *   bun skills/Intelligence/Evals/scripts/label-isc-quality-golden.ts
 *   bun skills/Intelligence/Evals/scripts/label-isc-quality-golden.ts --dry-run   # print corpus, no LLM calls
 */

import { inference } from "../../../../lib/core/Inference.ts";
import { getKayaHome } from "../../../../lib/core/KayaHome.ts";
import { writeFileSync, mkdirSync, existsSync, readFileSync } from "fs";
import { join, dirname } from "path";

// ============================================================================
// Config
// ============================================================================

const CRITERIA_VERSION = 1;
const OUTPUT_PATH = join(import.meta.dir, "../Data/golden/isc-quality-golden.jsonl");
const SPECS_DIR = join(getKayaHome(), "plans", "Specs", "Queue");
const MAX_ISC_CHARS = 2500;

// ============================================================================
// ISC Quality rubric (mirrors ensemble-known-truth.yaml isc bucket)
// ============================================================================

const ISC_SYSTEM_PROMPT = `You are an ISC (Ideal State Criteria) quality classifier. Given ISC content
from a software spec, determine whether it is RICH (pass) or BARREN (fail).

Quality rules:
- pass: The ISC contains concrete, observable outcomes with real verification
  commands or steps (e.g., \`bun test path/to.test.ts\`, \`grep "expected" file\`,
  specific exit codes, browser URL checks, launchctl commands, file existence checks).
  A reviewer could run or follow the verification without ambiguity. The criteria
  describe WHAT the system does, not just THAT it does something.
- fail: The ISC is BARREN — vague phrases like "It works", "Tests pass",
  "Quality is good", "Feature complete", or checklist items with no concrete verify
  method, no real commands, and no observable artifact. A reviewer would not know
  what to actually check. Includes: stub tables with "TBD", checklist items with no
  verify step, criteria that only say "done" or "looks good".

Return: {"quality": "pass" | "fail"}`;

const CANDIDATE_FIELD = "quality";
const VALID_QUALITIES = new Set(["pass", "fail"]);

// ============================================================================
// Helper: extract ISC section from a spec markdown file
// ============================================================================

function extractISCContent(specPath: string): string | null {
  try {
    const content = readFileSync(specPath, "utf-8");

    // Try to find ISC section by various headings (with/without numbering prefix)
    const iscPatterns = [
      /##\s*(?:[0-9]+\.\s*)?Ideal State Criteria[^\n]*\n([\s\S]*?)(?=\n## |\n---\n|$)/i,
      /##\s*(?:[0-9]+\.\s*)?ISC[^\n]*\n([\s\S]*?)(?=\n## |\n---\n|$)/i,
      /##\s*(?:[0-9]+\.\s*)?Success Criteria[^\n]*\n([\s\S]*?)(?=\n## |\n---\n|$)/i,
      /##\s*(?:[0-9]+\.\s*)?Acceptance[^\n]*\n([\s\S]*?)(?=\n## |\n---\n|$)/i,
    ];

    for (const pattern of iscPatterns) {
      const match = content.match(pattern);
      if (match?.[1]) {
        const section = match[1].trim();
        if (section.length > 50) {
          // Truncate to MAX_ISC_CHARS
          return section.length > MAX_ISC_CHARS
            ? section.slice(0, MAX_ISC_CHARS) + "\n... [truncated]"
            : section;
        }
      }
    }
    return null;
  } catch {
    return null;
  }
}

// ============================================================================
// Corpus definition
// ============================================================================

interface SpecCase {
  specId: string;
  /** true = extracted from real spec file; false = synthetic */
  real: boolean;
  /** Inline ISC content (for synthetic cases) */
  inlineContent?: string;
  /** Path to real spec file */
  specPath?: string;
  /** Expected label for human reference (ensemble may differ) */
  expectedHint?: "pass" | "fail";
}

// Real specs from plans/Specs/Queue/ — these should be PASS (grilled/rich)
// The 2 known grilled specs: mq5vmjmh, mq647gx0
const REAL_SPEC_CASES: SpecCase[] = [
  {
    specId: "mq5vmjmh",
    real: true,
    specPath: `${SPECS_DIR}/mq5vmjmh-8rf97i-spec.md`,
    expectedHint: "pass",
  },
  {
    specId: "mq647gx0",
    real: true,
    specPath: `${SPECS_DIR}/mq647gx0-6suifr-spec.md`,
    expectedHint: "pass",
  },
  {
    specId: "kaya-evals-001",
    real: true,
    specPath: `${SPECS_DIR}/kaya-evals-001-spec.md`,
    expectedHint: "pass",
  },
  {
    specId: "eval-regression-kaya-security",
    real: true,
    specPath: `${SPECS_DIR}/eval-regression-kaya-security-spec.md`,
    expectedHint: "pass",
  },
  {
    specId: "eval-regression-kaya-coding-performance",
    real: true,
    specPath: `${SPECS_DIR}/eval-regression-kaya-coding-performance-spec.md`,
    expectedHint: "pass",
  },
  {
    specId: "eval-regression-kaya-execution-fidelity",
    real: true,
    specPath: `${SPECS_DIR}/eval-regression-kaya-execution-fidelity-spec.md`,
    expectedHint: "pass",
  },
  {
    specId: "iv-native-receive-deeplink",
    real: true,
    specPath: `${SPECS_DIR}/iv-native-receive-deeplink-spec.md`,
    expectedHint: "pass",
  },
  {
    specId: "kaya-dnd-001",
    real: true,
    specPath: `${SPECS_DIR}/kaya-dnd-001-spec.md`,
    expectedHint: "pass",
  },
  {
    specId: "eval-regression-kaya-personal-alignment",
    real: true,
    specPath: `${SPECS_DIR}/eval-regression-kaya-personal-alignment-spec.md`,
    expectedHint: "pass",
  },
  {
    specId: "eval-regression-kaya-regression",
    real: true,
    specPath: `${SPECS_DIR}/eval-regression-kaya-regression-spec.md`,
    expectedHint: "pass",
  },
  // Additional rich/grilled specs to ensure ≥8 PASS in golden
  {
    specId: "ml8ys0j2",
    real: true,
    specPath: `${SPECS_DIR}/ml8ys0j2-53b0ir-spec.md`,
    expectedHint: "pass",
  },
  {
    specId: "mlajm205",
    real: true,
    specPath: `${SPECS_DIR}/mlajm205-09a4sl-spec.md`,
    expectedHint: "pass",
  },
  {
    specId: "mlajuu8f",
    real: true,
    specPath: `${SPECS_DIR}/mlajuu8f-457bvk-spec.md`,
    expectedHint: "pass",
  },
];

// Synthetic BARREN specs — these should be FAIL
const SYNTHETIC_BARREN_CASES: SpecCase[] = [
  {
    specId: "synthetic-barren-001-checkbox-no-verify",
    real: false,
    expectedHint: "fail",
    inlineContent: `## Success Criteria

- [ ] The feature works correctly
- [ ] Tests pass
- [ ] Code quality is good
- [ ] Performance is acceptable
- [ ] Documentation updated`,
  },
  {
    specId: "synthetic-barren-002-vague-table",
    real: false,
    expectedHint: "fail",
    inlineContent: `## ISC

| # | Criterion | Verify |
|---|-----------|--------|
| 1 | Feature complete | Done |
| 2 | It works | Check it |
| 3 | Quality good | Review |`,
  },
  {
    specId: "synthetic-barren-003-stub-placeholder",
    real: false,
    expectedHint: "fail",
    inlineContent: `## Ideal State Criteria

| Criterion | Expected Outcome | Verify Method |
|-----------|-----------------|---------------|
| Implementation | TBD | TBD |
| Testing | TBD | TBD |
| Deployment | TBD | TBD |`,
  },
  {
    specId: "synthetic-barren-004-no-commands",
    real: false,
    expectedHint: "fail",
    inlineContent: `## Acceptance Criteria

The system should be working as expected when:
- Users can log in
- Data is stored properly
- The UI looks correct
- No errors appear in console`,
  },
  {
    specId: "synthetic-barren-005-minimal-output",
    real: false,
    expectedHint: "fail",
    inlineContent: `## ISC

| # | What Ideal Looks Like | Verify Method |
|---|----------------------|---------------|
| 1 | It works | Run it |
| 2 | Tests pass | Run tests |`,
  },
  {
    specId: "synthetic-barren-006-design-only",
    real: false,
    expectedHint: "fail",
    inlineContent: `## Success Criteria

This is complete when the design is approved and documented.
- [ ] Architecture diagram created
- [ ] Documentation written
- [ ] Team reviewed`,
  },
  {
    specId: "synthetic-barren-007-single-vague-row",
    real: false,
    expectedHint: "fail",
    inlineContent: `| Criterion | Verify |
|-----------|--------|
| Feature complete | Done |`,
  },
  {
    specId: "synthetic-barren-008-generic-outcomes",
    real: false,
    expectedHint: "fail",
    inlineContent: `## 4. Ideal State Criteria

| # | Criterion | Expected Outcome | Verify Method |
|---|-----------|-----------------|---------------|
| 1 | It works  | Yes             | Check it      |
| 2 | Tests pass | Looks good     | Run tests     |
| 3 | Quality   | High            | Review code   |
| 4 | Performance | Fast           | Benchmark     |`,
  },
];

// ============================================================================
// Build full corpus
// ============================================================================

interface CorpusEntry {
  specId: string;
  real: boolean;
  iscContent: string;
  expectedHint?: "pass" | "fail";
}

function buildCorpus(): CorpusEntry[] {
  const entries: CorpusEntry[] = [];

  for (const c of REAL_SPEC_CASES) {
    const content = extractISCContent(c.specPath!);
    if (!content) {
      console.warn(`  SKIP ${c.specId}: no ISC section found`);
      continue;
    }
    entries.push({
      specId: c.specId,
      real: true,
      iscContent: content,
      expectedHint: c.expectedHint,
    });
  }

  for (const c of SYNTHETIC_BARREN_CASES) {
    entries.push({
      specId: c.specId,
      real: false,
      iscContent: c.inlineContent!,
      expectedHint: c.expectedHint,
    });
  }

  return entries;
}

// ============================================================================
// Ensemble labeler
// ============================================================================

type InferenceLevel = "fast" | "standard" | "smart";
const LEVELS: InferenceLevel[] = ["fast", "standard", "smart"];

interface EnsembleResult {
  specId: string;
  label: string | null;
  divergent: boolean;
  votes: Record<string, number>;
}

async function ensembleLabel(specId: string, iscContent: string): Promise<EnsembleResult> {
  const rawResults = await Promise.all(
    LEVELS.map((level) =>
      inference({
        systemPrompt: ISC_SYSTEM_PROMPT,
        userPrompt: iscContent,
        level,
        expectJson: true,
        retries: 2,
      })
    )
  );

  // Tally votes
  const votes: Record<string, number> = {};
  let voterCount = 0;

  for (const result of rawResults) {
    const raw =
      result.success && result.parsed != null
        ? (result.parsed as Record<string, unknown>)[CANDIDATE_FIELD]
        : undefined;

    if (typeof raw === "string" && VALID_QUALITIES.has(raw)) {
      votes[raw] = (votes[raw] ?? 0) + 1;
      voterCount++;
    }
  }

  if (voterCount === 0) {
    return { specId, label: null, divergent: true, votes };
  }

  // Simple majority: top vote must have >50% of voter count
  let topLabel: string | undefined;
  let topCount = 0;
  for (const [label, count] of Object.entries(votes)) {
    if (count > topCount) {
      topCount = count;
      topLabel = label;
    }
  }

  const hasMajority = topLabel !== undefined && topCount * 2 > voterCount;

  if (hasMajority && topLabel !== undefined) {
    return { specId, label: topLabel, divergent: false, votes };
  }

  return { specId, label: null, divergent: true, votes };
}

// ============================================================================
// Main
// ============================================================================

const isDryRun = process.argv.includes("--dry-run");

const corpus = buildCorpus();
const realCount = corpus.filter((c) => c.real).length;
const syntheticCount = corpus.filter((c) => !c.real).length;

console.log(`\n=== ISC Quality Golden Labeler ===`);
console.log(`Corpus: ${corpus.length} cases (${realCount} real, ${syntheticCount} synthetic)`);
console.log(`Levels: ${LEVELS.join(", ")} (${corpus.length * LEVELS.length} total inference calls)`);
console.log(`Output: ${OUTPUT_PATH}`);
console.log(`Mode: ${isDryRun ? "DRY-RUN (no LLM calls)" : "LIVE"}\n`);

if (isDryRun) {
  console.log("Corpus (dry-run):");
  corpus.forEach((c, i) =>
    console.log(
      `  ${i + 1}. [${c.real ? "REAL" : "SYNTHETIC"}] ${c.specId} (hint: ${c.expectedHint ?? "?"})`
    )
  );
  process.exit(0);
}

// Run labeling
const lines: string[] = [];
let consensusCount = 0;
let divergentCount = 0;
let passCount = 0;
let failCount = 0;
let realPassCount = 0;
const labeledAt = new Date().toISOString();

// Track whether the 2 known grilled specs got PASS
const knownGrilledSpecs = new Set(["mq5vmjmh", "mq647gx0"]);
const grilledResults: Record<string, string | null> = {};

console.log("Labeling cases...\n");

for (let i = 0; i < corpus.length; i++) {
  const { specId, real, iscContent, expectedHint } = corpus[i];
  process.stdout.write(
    `[${i + 1}/${corpus.length}] [${real ? "REAL" : "SYNTHETIC"}] ${specId.slice(0, 50)}${specId.length > 50 ? "…" : ""} `
  );

  try {
    const result = await ensembleLabel(specId, iscContent);

    if (result.divergent) {
      divergentCount++;
      process.stdout.write(`→ DIVERGENT (votes: ${JSON.stringify(result.votes)})\n`);
      lines.push(
        JSON.stringify({
          specId,
          quality: null,
          divergent: true,
          votes: result.votes,
          real,
          expected_hint: expectedHint,
          source: "ensemble",
          labeled_at: labeledAt,
          criteria_version: CRITERIA_VERSION,
        })
      );
    } else {
      consensusCount++;
      const quality = result.label! as "pass" | "fail";
      if (quality === "pass") {
        passCount++;
        if (real) realPassCount++;
      } else {
        failCount++;
      }

      if (knownGrilledSpecs.has(specId)) {
        grilledResults[specId] = quality;
      }

      process.stdout.write(`→ ${quality.toUpperCase()}${expectedHint && expectedHint !== quality ? ` (MISMATCH: expected ${expectedHint})` : ""}\n`);
      lines.push(
        JSON.stringify({
          specId,
          quality,
          real,
          expected_hint: expectedHint,
          source: "ensemble",
          labeled_at: labeledAt,
          criteria_version: CRITERIA_VERSION,
        })
      );
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    divergentCount++;
    process.stdout.write(`→ ERROR: ${msg}\n`);
    lines.push(
      JSON.stringify({
        specId,
        quality: null,
        divergent: true,
        error: msg,
        real,
        expected_hint: expectedHint,
        source: "ensemble",
        labeled_at: labeledAt,
        criteria_version: CRITERIA_VERSION,
      })
    );
  }
}

// Write output
const outputDir = dirname(OUTPUT_PATH);
if (!existsSync(outputDir)) {
  mkdirSync(outputDir, { recursive: true });
}
writeFileSync(OUTPUT_PATH, lines.join("\n") + "\n", "utf-8");

// Report
console.log(`\n=== Results ===`);
console.log(`Total:      ${corpus.length}`);
console.log(`Consensus:  ${consensusCount} (${passCount} pass, ${failCount} fail)`);
console.log(`Divergent:  ${divergentCount}`);
console.log(`Real specs: ${realCount} (${realPassCount} labeled pass)`);
console.log(`Synthetic:  ${syntheticCount}`);

console.log(`\n=== Known Grilled Spec Results ===`);
for (const specId of knownGrilledSpecs) {
  const label = grilledResults[specId];
  if (label === null || label === undefined) {
    console.log(`  ${specId}: DIVERGENT — FINDING: ensemble did not reach consensus on this known-grilled spec`);
  } else if (label === "pass") {
    console.log(`  ${specId}: PASS ✓ (correct — confirmed as rich/grilled spec)`);
  } else {
    console.log(`  ${specId}: FAIL ✗ — FINDING: ensemble labeled this known-grilled spec as BARREN (false negative)`);
  }
}

console.log(`\nGolden set written to: ${OUTPUT_PATH}`);
