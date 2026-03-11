import { describe, test, expect } from "bun:test";
import { readFileSync, existsSync } from "fs";
import { join } from "path";
import { homedir } from "os";

import {
  validateSpecPipelineTransition,
  SPEC_PIPELINE_TRANSITIONS,
  QueueManager,
} from "./QueueManager.ts";

import {
  validateISCQuality,
  generateFallbackSpec,
  isAutoRoutedGuidance,
} from "./SpecPipelineRunner.ts";

// ============================================================================
// 1. Transition Validation (pure, no I/O) — 8 tests
// ============================================================================

describe("validateSpecPipelineTransition", () => {
  test("1. awaiting-context -> researching (allowed)", () => {
    expect(validateSpecPipelineTransition("awaiting-context", "researching")).toBeNull();
  });

  test("2. awaiting-context -> generating-spec (NOT allowed)", () => {
    const result = validateSpecPipelineTransition("awaiting-context", "generating-spec");
    expect(result).toBeString();
    expect(result).toContain("Invalid");
  });

  test("3. researching -> generating-spec (allowed)", () => {
    expect(validateSpecPipelineTransition("researching", "generating-spec")).toBeNull();
  });

  test("4. generating-spec -> revision-needed (allowed)", () => {
    expect(validateSpecPipelineTransition("generating-spec", "revision-needed")).toBeNull();
  });

  test("5. revision-needed -> researching (allowed)", () => {
    expect(validateSpecPipelineTransition("revision-needed", "researching")).toBeNull();
  });

  test("6. revision-needed -> escalated (allowed)", () => {
    expect(validateSpecPipelineTransition("revision-needed", "escalated")).toBeNull();
  });

  test("7. escalated -> researching (terminal, NOT allowed)", () => {
    const result = validateSpecPipelineTransition("escalated", "researching");
    expect(result).toBeString();
    expect(result).toContain("terminal");
  });

  test("8. unknown status -> any (not a spec-pipeline status, ignored)", () => {
    expect(validateSpecPipelineTransition("pending", "researching")).toBeNull();
    expect(validateSpecPipelineTransition("in_progress", "completed")).toBeNull();
    expect(validateSpecPipelineTransition("custom-status", "anything")).toBeNull();
  });
});

// ============================================================================
// 2. Quality Gate Edge Cases (pure, no I/O) — 6 tests
// ============================================================================

describe("validateISCQuality edge cases", () => {
  test("9. 0 ISC rows (empty spec, no table) -> fail", () => {
    const result = validateISCQuality("# Empty Spec\n\nNo ISC table here.");
    expect(result.pass).toBe(false);
    expect(result.reason).toMatch(/0 ISC rows/);
  });

  test("10. Exactly 3 rows (boundary -1) -> fail", () => {
    const spec = `## 5. Ideal State Criteria (ISC)

| # | What Ideal Looks Like | Source | Verify |
|---|----------------------|--------|--------|
| 1 | Feature A works correctly | EXPLICIT | Unit test |
| 2 | Feature B deployed to prod | EXPLICIT | curl check |
| 3 | Docs updated with new API | EXPLICIT | Read docs |
`;
    const result = validateISCQuality(spec);
    expect(result.pass).toBe(false);
    expect(result.reason).toMatch(/3 ISC rows/);
  });

  test("11. Exactly 4 rows, all specific -> pass", () => {
    const spec = `## 5. Ideal State Criteria (ISC)

| # | What Ideal Looks Like | Source | Verify |
|---|----------------------|--------|--------|
| 1 | API endpoint returns 200 for valid token | EXPLICIT | curl -H "Auth: token" |
| 2 | Rate limiter triggers at 100 req/min | EXPLICIT | ab -n 150 benchmark |
| 3 | Database index reduces query from 2s to <50ms | EXPLICIT | EXPLAIN ANALYZE |
| 4 | Error responses follow RFC 7807 format | EXPLICIT | JSON schema validation |
`;
    const result = validateISCQuality(spec);
    expect(result.pass).toBe(true);
  });

  test("12. 4 rows but one has skeleton phrase -> fail", () => {
    const spec = `## 5. Ideal State Criteria (ISC)

| # | What Ideal Looks Like | Source | Verify |
|---|----------------------|--------|--------|
| 1 | API endpoint returns 200 for valid token | EXPLICIT | curl check |
| 2 | Rate limiter triggers at 100 req/min | EXPLICIT | benchmark |
| 3 | Implementation matches problem context requirements | EXPLICIT | Manual review |
| 4 | Error responses follow RFC 7807 format | EXPLICIT | JSON schema |
`;
    const result = validateISCQuality(spec);
    expect(result.pass).toBe(false);
    expect(result.reason).toMatch(/skeleton/i);
  });

  test("13. Fallback spec with FALLBACK_SPEC marker -> fail (1 row)", () => {
    const spec = `## 5. Ideal State Criteria (ISC)

| # | What Ideal Looks Like | Verify Method |
|---|----------------------|---------------|
| 1 | FALLBACK_SPEC: Inference unavailable — requires re-generation | Manual review |
`;
    const result = validateISCQuality(spec);
    expect(result.pass).toBe(false);
    expect(result.reason).toMatch(/1 ISC rows/);
  });

  test("14. Real queue spec (mlzhpwzj-jgdswl-spec.md) -> pass", () => {
    const KAYA_HOME = process.env.KAYA_HOME || join(homedir(), ".claude");
    const specPath = join(KAYA_HOME, "plans/Specs/Queue/mlzhpwzj-jgdswl-spec.md");
    if (!existsSync(specPath)) {
      console.log("Skipping: spec file not found (CI environment)");
      return;
    }
    const content = readFileSync(specPath, "utf-8");
    const result = validateISCQuality(content);
    expect(result.pass).toBe(true);
  });
});

// ============================================================================
// 3. Dual-Gate Routing via predicates — 5 tests
// ============================================================================

describe("Dual-Gate Routing Logic", () => {
  const qm = new QueueManager();

  /**
   * Simulates the routing decision in addSpecPipelineItem.
   * Tests the exact same predicate chain without file I/O.
   */
  function routingDecision(
    payload: { description: string },
    context?: Record<string, unknown>
  ): "awaiting-context" | "researching" | "generating-spec" {
    if (!qm.hassufficientContext(payload, context)) return "awaiting-context";
    if (qm.canDeriveISCDirectly(payload, context)) return "generating-spec";
    return "researching";
  }

  test("15. Insufficient context -> stays awaiting-context", () => {
    const result = routingDecision({
      description: "Add a new feature to the dashboard.",
    });
    expect(result).toBe("awaiting-context");
  });

  test("16. Sufficient + NOT ISC-derivable -> researching", () => {
    // 400+ chars, enumerated deliverables + constraint keywords (signals >=2),
    // but NO acceptance-criteria phrase, NO table format, NO 4+ numbered constraints with (N) format
    const desc = [
      "Implement a queue router context enrichment system with the following deliverables:",
      "1. QueueManager.hassufficientContext method that scores description richness",
      "2. SpecPipelineRunner quality gate that rejects skeleton specs on generation",
      "3. Integration tests in ISCQualityGate.test.ts covering all edge cases",
      "The system must block weak items before they reach the approvals queue.",
      "It must never pass skeleton phrases like generic boilerplate content.",
      "Only items with >= 4 specific ISC rows should be allowed through the gate.",
      "This gate must run on every spec generated by SpecPipelineRunner tool.",
    ].join(" ");

    expect(desc.length).toBeGreaterThanOrEqual(400);
    const result = routingDecision({ description: desc });
    expect(result).toBe("researching");
  });

  test("17. Sufficient + ISC-derivable -> generating-spec", () => {
    const desc = [
      "Build a file upload service with the following acceptance criteria:",
      "1. Maximum file size 10MB with validation error for oversized files",
      "2. Only accept PNG, JPG, PDF formats verified by magic bytes",
      "3. Virus scan via ClamAV before storage — reject infected files",
      "4. Return CDN URL after upload within 500ms P95 latency target",
      "5. Rate limit 100 uploads per hour per API key with 429 responses",
      "The service must use the existing auth middleware in src/middleware/auth.ts.",
      "Deploy to the staging environment first. All endpoints must have OpenAPI specs.",
    ].join(" ");

    expect(desc.length).toBeGreaterThanOrEqual(400);
    const result = routingDecision({ description: desc });
    expect(result).toBe("generating-spec");
  });

  test("18. Pre-supplied context shortcut -> researching", () => {
    const result = routingDecision(
      { description: "Add dark mode toggle." },
      {
        notes: "Dashboard has no dark mode support. Users on OLED screens need it.",
        researchGuidance: "Research CSS custom properties vs Tailwind dark mode.",
      }
    );
    expect(result).toBe("researching");
  });

  test("19. ISC-derivable via context.researchFindings -> generating-spec", () => {
    const result = routingDecision(
      { description: "Short description" },
      {
        notes: "Some notes",
        researchGuidance: "Some guidance",
        researchFindings: "Prior research completed with detailed findings",
      }
    );
    expect(result).toBe("generating-spec");
  });
});

// ============================================================================
// 4. Fallback Spec -> Quality Gate Integration — 3 tests
// ============================================================================

describe("Fallback Spec -> Quality Gate", () => {
  const mockItem = {
    id: "test-fallback-001",
    created: new Date().toISOString(),
    updated: new Date().toISOString(),
    source: "test" as const,
    priority: 2 as const,
    status: "generating-spec" as const,
    type: "task" as const,
    queue: "spec-pipeline",
    payload: {
      title: "Test Fallback Item",
      description: "Build a monitoring dashboard for microservices.",
    },
    routing: { targetQueue: "spec-pipeline" },
  };

  const mockCtx = {
    notes: "Build a monitoring dashboard for microservices.",
    researchGuidance: "Research Prometheus + Grafana integration patterns.",
    scopeHints: undefined as string | undefined,
    lucidTaskId: undefined as string | undefined,
    revisionCount: 0,
    lastRejectionReason: undefined as string | undefined,
    previousResearchPath: undefined as string | undefined,
    previousSpecPath: undefined as string | undefined,
  };

  test("20. Fallback spec output has [FALLBACK] markers", () => {
    const content = generateFallbackSpec(mockItem as any, mockCtx, "medium", "");
    expect(content).toContain("[FALLBACK]");
    expect(content).toContain("FALLBACK_SPEC:");
  });

  test("21. Fallback spec fails validateISCQuality (1 row)", () => {
    const content = generateFallbackSpec(mockItem as any, mockCtx, "medium", "");
    const result = validateISCQuality(content);
    expect(result.pass).toBe(false);
    expect(result.reason).toMatch(/1 ISC rows/);
  });

  test("22. Fallback spec ISC contains FALLBACK_SPEC: sentinel", () => {
    const content = generateFallbackSpec(mockItem as any, mockCtx, "medium", "");
    const iscLine = content.split("\n").find((l) => l.includes("FALLBACK_SPEC:"));
    expect(iscLine).toBeDefined();
    expect(iscLine!).toContain("Inference unavailable");
  });
});

// ============================================================================
// 5. Research Prompt Selection (isAutoRouted) — 4 tests
// ============================================================================

describe("isAutoRoutedGuidance", () => {
  test('23. "Research needed: ..." -> true', () => {
    expect(
      isAutoRoutedGuidance("Research needed: structure description into ISC-ready findings")
    ).toBe(true);
  });

  test('24. "Auto-advanced: ..." -> true', () => {
    expect(
      isAutoRoutedGuidance("Auto-advanced: description meets sufficiency threshold")
    ).toBe(true);
  });

  test('25. "Direct: ..." -> false', () => {
    expect(
      isAutoRoutedGuidance("Direct: description contains ISC-derivable structure")
    ).toBe(false);
  });

  test('26. "Investigate the API..." (manual guidance) -> false', () => {
    expect(
      isAutoRoutedGuidance("Investigate the API rate limiting behavior under load")
    ).toBe(false);
  });
});

// ============================================================================
// 6. Real Spec Quality Gate Sweep — 1 test
// ============================================================================

describe("Real Spec Quality Gate Sweep", () => {
  test("27. All mlzh* queue specs pass quality gate", () => {
    const KAYA_HOME = process.env.KAYA_HOME || join(homedir(), ".claude");
    const specsDir = join(KAYA_HOME, "plans/Specs/Queue");

    const mlzhSpecs = [
      "mlzhpwzj-jgdswl-spec.md",
      "mlzhq70o-vyvhxa-spec.md",
      "mlzhqd9w-0dar19-spec.md",
      "mlzhqk41-g5qbyz-spec.md",
      "mlzhqtdo-kylj4r-spec.md",
      "mlzhr0i4-q5p2ir-spec.md",
      "mlzhr6ve-8zpdob-spec.md",
      "mlzhrg3i-pvwqds-spec.md",
      "mlzhrnb3-cpuk2x-spec.md",
      "mlzhrv9a-0ubyae-spec.md",
      "mlzhs5up-ypvqtq-spec.md",
      "mlzhsdw8-g0p8il-spec.md",
      "mlzhsk2c-u09v5l-spec.md",
    ];

    const results: { file: string; pass: boolean; reason?: string }[] = [];

    for (const file of mlzhSpecs) {
      const path = join(specsDir, file);
      if (!existsSync(path)) {
        results.push({ file, pass: false, reason: "File not found" });
        continue;
      }
      const content = readFileSync(path, "utf-8");
      const check = validateISCQuality(content);
      results.push({ file, pass: check.pass, reason: check.reason });
    }

    const failures = results.filter((r) => !r.pass);
    if (failures.length > 0) {
      console.log("Quality gate failures:");
      for (const f of failures) {
        console.log(`  x ${f.file}: ${f.reason}`);
      }
    }

    expect(failures.length).toBe(0);
  });
});
