/**
 * SpecParser.test.ts — Tests for ISC extraction patterns
 *
 * Covers: Pattern 7 (numbered implementation steps), deduplication,
 * extractISC basic behavior.
 */

import { describe, it, expect } from "bun:test";
import { extractISC, inferCategory, getISCForPhase, detectPhasedSpec, scoreISCPhaseMatch, semanticISCAssignment } from "./SpecParser.ts";
import type { ParsedSpec, ISCCriterion, SpecPhase, PhaseISCResult, PhaseInfo } from "./SpecParser.ts";

// ---------------------------------------------------------------------------
// Pattern 7: Numbered implementation steps
// ---------------------------------------------------------------------------

describe("extractISC Pattern 7: numbered steps", () => {
  it("extracts numbered bold steps with dash descriptions", () => {
    const content = `
## Implementation Steps

1. **Remove MCP plugin** -- Delete Playwright MCP config and switch to Browse.ts CLI
2. **Add snapshot command** -- YAML accessibility snapshots via Browse.ts
3. **Add state persistence** -- Save/load cookies and storage
`;
    const isc = extractISC(content);
    const pattern7 = isc.filter(r => r.number >= 600);

    expect(pattern7.length).toBe(3);
    expect(pattern7[0].description).toContain("Remove MCP plugin");
    expect(pattern7[0].description).toContain("Delete Playwright MCP config");
    expect(pattern7[1].description).toContain("Add snapshot command");
    expect(pattern7[2].description).toContain("Add state persistence");
  });

  it("extracts steps with em-dash separator", () => {
    const content = `
1. **YAML accessibility snapshots** — Add snapshot command to Browse.ts
2. **State save/load** — Add state-save and state-load commands
`;
    const isc = extractISC(content);
    const pattern7 = isc.filter(r => r.number >= 600);

    expect(pattern7.length).toBe(2);
    expect(pattern7[0].description).toContain("YAML accessibility snapshots");
    expect(pattern7[1].description).toContain("State save/load");
  });

  it("extracts steps with colon separator", () => {
    const content = `
1. **Configure auth**: Set up JWT tokens for API access
2. **Deploy service**: Push to production
`;
    const isc = extractISC(content);
    const pattern7 = isc.filter(r => r.number >= 600);

    expect(pattern7.length).toBe(2);
    expect(pattern7[0].description).toContain("Configure auth");
    expect(pattern7[0].description).toContain("Set up JWT tokens");
  });

  it("extracts steps without description (bold name only)", () => {
    const content = `
1. **Remove legacy code**
2. **Update dependencies**
`;
    const isc = extractISC(content);
    const pattern7 = isc.filter(r => r.number >= 600);

    expect(pattern7.length).toBe(2);
    expect(pattern7[0].description).toBe("Remove legacy code");
    expect(pattern7[1].description).toBe("Update dependencies");
  });

  it("deduplicates against existing ISC rows", () => {
    // Pattern 1 (checkbox) and Pattern 7 (numbered step) both match similar content
    const content = `
## ISC
- [ ] Remove MCP plugin config from settings

## Steps
1. **Remove MCP plugin config from settings** -- Clean up old config
`;
    const isc = extractISC(content);
    // Should not have duplicate entries for "Remove MCP plugin config"
    const descriptions = isc.map(r => r.description);
    const removeMcpRows = descriptions.filter(d => d.includes("Remove MCP plugin config"));
    expect(removeMcpRows.length).toBe(1);
  });

  it("marks Pattern 7 rows as EXPLICIT source with inferred verify", () => {
    const content = `
1. **Add error handling** -- Wrap API calls in try/catch
`;
    const isc = extractISC(content);
    const pattern7 = isc.filter(r => r.number >= 600);

    expect(pattern7.length).toBe(1);
    expect(pattern7[0].source).toBe("EXPLICIT");
    expect(pattern7[0].verifyMethod).toBe("inferred");
    expect(pattern7[0].isChecked).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// extractISC with real-ish spec content
// ---------------------------------------------------------------------------

describe("extractISC real spec patterns", () => {
  it("extracts ISC from browser-automation-upgrade style content", () => {
    const content = `
# Browser Automation Upgrade

## Phase 1: Foundation

### ISC
- [ ] Browse.ts snapshot command outputs YAML
- [ ] State save/load persists cookies
- [x] Tracing captures network requests

### Implementation Steps

1. **YAML accessibility snapshots** -- Add snapshot command to Browse.ts that saves ARIA snapshot
2. **State save/load** -- Add state-save and state-load commands to Browse.ts for full cookie/storage persistence
3. **Tracing** -- Add trace start / trace stop commands to Browse.ts for Playwright trace recording

### Verification
\`\`\`bash
bun test Browse.test.ts
\`\`\`
`;
    const isc = extractISC(content);

    // Should have Pattern 1 checkbox rows + Pattern 7 numbered steps (deduplicated)
    expect(isc.length).toBeGreaterThanOrEqual(3);

    // The checkbox rows should be present
    const checkboxRows = isc.filter(r => r.number < 600);
    expect(checkboxRows.length).toBeGreaterThanOrEqual(3);

    // Pattern 7 should add non-duplicate rows
    const pattern7Rows = isc.filter(r => r.number >= 600);
    // Some may be deduped against checkbox rows
    expect(pattern7Rows.length).toBeGreaterThanOrEqual(0);
  });
});

// ---------------------------------------------------------------------------
// Tier B suppression: P4/P7 gated by SUPPLEMENTAL_THRESHOLD (8)
// ---------------------------------------------------------------------------

describe("extractISC Tier B suppression", () => {
  it("suppresses P4/P7 when Tier A produces >= 8 rows via P1 ISC table", () => {
    const content = `
## 1. Ideal State Criteria

| # | Description | Source | Verify |
|---|-------------|--------|--------|
| 1 | Auth module loads | EXPLICIT | test |
| 2 | JWT tokens validate | EXPLICIT | test |
| 3 | Refresh tokens rotate | EXPLICIT | test |
| 4 | Sessions persist | EXPLICIT | test |
| 5 | Rate limiting works | EXPLICIT | test |
| 6 | CORS headers set | EXPLICIT | test |
| 7 | CSP policy enforced | EXPLICIT | test |
| 8 | Audit log captures events | EXPLICIT | test |

## File Structure

- src/auth.ts
- src/jwt.ts
- src/sessions.ts
- src/rate-limit.ts
- src/cors.ts

## Implementation Steps

1. **Set up auth module** -- Create base auth structure
2. **Add JWT validation** -- Implement token checks
3. **Add rate limiting** -- Per-endpoint limits
`;
    const isc = extractISC(content);

    // P1 table rows should be present (8 rows)
    const p1Rows = isc.filter(r => r.number >= 1 && r.number <= 8);
    expect(p1Rows.length).toBe(8);

    // P4 file structure rows should be suppressed (tierACount >= 8)
    const p4Rows = isc.filter(r => r.number >= 300 && r.number < 400);
    expect(p4Rows.length).toBe(0);

    // P7 numbered steps should be suppressed (tierACount >= 8)
    const p7Rows = isc.filter(r => r.number >= 600);
    expect(p7Rows.length).toBe(0);
  });

  it("allows P4 when Tier A produces < 8 rows (7 checkboxes)", () => {
    const content = `
## Success Criteria
- [ ] Auth module loads
- [ ] JWT tokens validate
- [ ] Refresh tokens rotate
- [ ] Sessions persist
- [ ] Rate limiting works
- [ ] CORS headers set
- [ ] CSP policy enforced

## File Structure

- src/auth.ts
- src/jwt.ts
- src/sessions.ts
`;
    const isc = extractISC(content);

    // P2 checkbox rows present (7 rows, numbers starting at 100)
    const p2Rows = isc.filter(r => r.number >= 100 && r.number < 200);
    expect(p2Rows.length).toBe(7);

    // P4 should fire because 7 < 8
    const p4Rows = isc.filter(r => r.number >= 300 && r.number < 400);
    expect(p4Rows.length).toBeGreaterThan(0);
  });

  it("suppresses P7 when Tier A produces exactly 8 rows (8 checkboxes)", () => {
    const content = `
## Success Criteria
- [ ] Auth module loads
- [ ] JWT tokens validate
- [ ] Refresh tokens rotate
- [ ] Sessions persist
- [ ] Rate limiting works
- [ ] CORS headers set
- [ ] CSP policy enforced
- [ ] Audit log captures events

## Implementation Steps

1. **Set up auth module** -- Create base auth structure
2. **Add JWT validation** -- Implement token checks
3. **Add rate limiting** -- Per-endpoint limits
`;
    const isc = extractISC(content);

    // P2 checkbox rows present (8 rows)
    const p2Rows = isc.filter(r => r.number >= 100 && r.number < 200);
    expect(p2Rows.length).toBe(8);

    // P7 numbered steps should be suppressed (tierACount == 8 >= 8)
    const p7Rows = isc.filter(r => r.number >= 600);
    expect(p7Rows.length).toBe(0);
  });

  it("caps total rows at MAX_ISC_ROWS (30), preserving lowest numbers", () => {
    // Generate a spec with 35+ checkbox items (all unique, P2 pattern)
    const checkboxes = Array.from({ length: 35 }, (_, i) =>
      `- [ ] Unique criterion number ${i + 1} for testing cap behavior`
    ).join("\n");

    const content = `
## Success Criteria
${checkboxes}
`;
    const isc = extractISC(content);

    // Should be capped at 30
    expect(isc.length).toBeLessThanOrEqual(30);

    // Lowest-numbered rows should be preserved
    const numbers = isc.map(r => r.number);
    expect(numbers[0]).toBe(100); // First P2 row
  });
});

// ---------------------------------------------------------------------------
// inferCategory
// ---------------------------------------------------------------------------

describe("inferCategory", () => {
  it("classifies deployment steps", () => {
    expect(inferCategory("Deploy to production via launchctl")).toBe("deployment");
  });

  it("classifies documentation steps", () => {
    expect(inferCategory("Update SKILL.md with new commands")).toBe("documentation");
  });

  it("classifies cleanup steps", () => {
    expect(inferCategory("Remove legacy MCP plugin config")).toBe("cleanup");
  });

  it("classifies test steps", () => {
    expect(inferCategory("Add test coverage for new snapshot command")).toBe("testing");
  });

  it("defaults to implementation", () => {
    expect(inferCategory("Add snapshot command to Browse.ts")).toBe("implementation");
  });
});

// ---------------------------------------------------------------------------
// Helper: build a minimal ParsedSpec for phase tests
// ---------------------------------------------------------------------------

function makeISCCriteria(count: number, startNumber: number = 1): ISCCriterion[] {
  return Array.from({ length: count }, (_, i) => ({
    number: startNumber + i,
    description: `Criterion ${startNumber + i}`,
    source: "EXPLICIT",
    verifyMethod: "test",
    isChecked: false,
  }));
}

function makeSpec(overrides: Partial<ParsedSpec> = {}): ParsedSpec {
  return {
    title: "Test Spec",
    phases: [],
    isc: [],
    totalPhases: 0,
    ...overrides,
  };
}

function makePhase(overrides: Partial<SpecPhase> & { number: number }): SpecPhase {
  return {
    name: `Phase ${overrides.number}`,
    steps: [],
    iscNumbers: [],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// getISCForPhase — Strategy 1: Explicit mapping
// ---------------------------------------------------------------------------

describe("getISCForPhase explicit mapping", () => {
  it("returns ISC rows matching phase iscNumbers", () => {
    const isc = makeISCCriteria(6);
    const spec = makeSpec({
      isc,
      phases: [
        makePhase({ number: 1, iscNumbers: [1, 2, 3] }),
        makePhase({ number: 2, iscNumbers: [4, 5, 6] }),
      ],
    });

    const result = getISCForPhase(spec, 1);
    expect(result.rows.length).toBe(3);
    expect(result.rows.map(r => r.number)).toEqual([1, 2, 3]);
    expect(result.usedPositionalFallback).toBe(false);
    expect(result.phaseNumber).toBe(1);
    expect(result.phaseName).toBe("Phase 1");
  });

  it("returns empty for non-existent phase number", () => {
    const spec = makeSpec({
      isc: makeISCCriteria(4),
      phases: [makePhase({ number: 1, iscNumbers: [1, 2] })],
    });

    const result = getISCForPhase(spec, 99);
    expect(result.rows).toHaveLength(0);
    expect(result.phaseName).toBe("");
  });
});

// ---------------------------------------------------------------------------
// getISCForPhase — Strategy 2: Positional fallback
// ---------------------------------------------------------------------------

describe("getISCForPhase positional fallback", () => {
  it("evenly distributes ISC across phases when no explicit mapping", () => {
    const isc = makeISCCriteria(9);
    const spec = makeSpec({
      isc,
      phases: [
        makePhase({ number: 1 }),  // no iscNumbers
        makePhase({ number: 2 }),
        makePhase({ number: 3 }),
      ],
    });

    const r1 = getISCForPhase(spec, 1);
    const r2 = getISCForPhase(spec, 2);
    const r3 = getISCForPhase(spec, 3);

    // 9 ISC / 3 phases = 3 each
    expect(r1.rows.length).toBe(3);
    expect(r2.rows.length).toBe(3);
    expect(r3.rows.length).toBe(3);

    // All use positional fallback
    expect(r1.usedPositionalFallback).toBe(true);
    expect(r2.usedPositionalFallback).toBe(true);
    expect(r3.usedPositionalFallback).toBe(true);

    // No overlap
    const allNumbers = [...r1.rows, ...r2.rows, ...r3.rows].map(r => r.number);
    expect(new Set(allNumbers).size).toBe(9);
  });

  it("handles uneven distribution (last phase gets remainder)", () => {
    const isc = makeISCCriteria(10);
    const spec = makeSpec({
      isc,
      phases: [
        makePhase({ number: 1 }),
        makePhase({ number: 2 }),
        makePhase({ number: 3 }),
      ],
    });

    const r1 = getISCForPhase(spec, 1);
    const r2 = getISCForPhase(spec, 2);
    const r3 = getISCForPhase(spec, 3);

    // ceil(10/3) = 4 per chunk. Phase 1: 0-3 (4), Phase 2: 4-7 (4), Phase 3: 8-9 (2)
    expect(r1.rows.length).toBe(4);
    expect(r2.rows.length).toBe(4);
    expect(r3.rows.length).toBe(2);
  });

  it("returns empty when no ISC and no phases", () => {
    const spec = makeSpec({ isc: [], phases: [makePhase({ number: 1 })] });
    const result = getISCForPhase(spec, 1);
    expect(result.rows).toHaveLength(0);
    expect(result.usedPositionalFallback).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// getISCForPhase — Strategy 3: Partial mapping
// ---------------------------------------------------------------------------

describe("getISCForPhase partial mapping", () => {
  it("returns empty for unmapped phase when other phases have explicit mapping", () => {
    const isc = makeISCCriteria(6);
    const spec = makeSpec({
      isc,
      phases: [
        makePhase({ number: 1, iscNumbers: [1, 2, 3] }),  // explicit
        makePhase({ number: 2 }),  // no mapping
      ],
    });

    const r1 = getISCForPhase(spec, 1);
    const r2 = getISCForPhase(spec, 2);

    expect(r1.rows.length).toBe(3);
    expect(r1.usedPositionalFallback).toBe(false);

    // Phase 2 is partial mapping → empty
    expect(r2.rows).toHaveLength(0);
    expect(r2.usedPositionalFallback).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// detectPhasedSpec — threshold guards
// ---------------------------------------------------------------------------

describe("detectPhasedSpec threshold guards", () => {
  it("returns null when total ISC < threshold (7 ISC, 2 phases)", () => {
    const spec = makeSpec({
      isc: makeISCCriteria(7),
      phases: [
        makePhase({ number: 1, iscNumbers: [1, 2, 3] }),
        makePhase({ number: 2, iscNumbers: [4, 5, 6, 7] }),
      ],
    });

    expect(detectPhasedSpec(spec, 8, 2)).toBeNull();
  });

  it("returns null when phases < threshold (8 ISC, 1 phase)", () => {
    const spec = makeSpec({
      isc: makeISCCriteria(8),
      phases: [makePhase({ number: 1, iscNumbers: [1, 2, 3, 4, 5, 6, 7, 8] })],
    });

    expect(detectPhasedSpec(spec, 8, 2)).toBeNull();
  });

  it("returns PhaseInfo[] when both thresholds met (8 ISC, 2 phases)", () => {
    const spec = makeSpec({
      isc: makeISCCriteria(8),
      phases: [
        makePhase({ number: 1, iscNumbers: [1, 2, 3, 4] }),
        makePhase({ number: 2, iscNumbers: [5, 6, 7, 8] }),
      ],
    });

    const result = detectPhasedSpec(spec, 8, 2);
    expect(result).not.toBeNull();
    expect(result!.length).toBe(2);
    expect(result![0].phaseNumber).toBe(1);
    expect(result![0].iscNumbers).toEqual([1, 2, 3, 4]);
    expect(result![1].phaseNumber).toBe(2);
    expect(result![1].iscNumbers).toEqual([5, 6, 7, 8]);
  });

  it("filters out phases with zero ISC rows (3 phases, only 2 have rows)", () => {
    const spec = makeSpec({
      isc: makeISCCriteria(10),
      phases: [
        makePhase({ number: 1, iscNumbers: [1, 2, 3, 4, 5] }),
        makePhase({ number: 2 }),  // no mapping → empty (partial mapping rule)
        makePhase({ number: 3, iscNumbers: [6, 7, 8, 9, 10] }),
      ],
    });

    const result = detectPhasedSpec(spec, 8, 2);
    expect(result).not.toBeNull();
    // Phase 2 is filtered out (0 rows due to partial mapping rule)
    expect(result!.length).toBe(2);
    expect(result!.map(p => p.phaseNumber)).toEqual([1, 3]);
  });

  it("returns null when fewer than minPhases have ISC rows after filtering", () => {
    const spec = makeSpec({
      isc: makeISCCriteria(8),
      phases: [
        makePhase({ number: 1, iscNumbers: [1, 2, 3, 4, 5, 6, 7, 8] }),
        makePhase({ number: 2 }),  // empty due to partial mapping
      ],
    });

    // Only 1 phase has rows → below minPhases=2
    const result = detectPhasedSpec(spec, 8, 2);
    expect(result).toBeNull();
  });

  it("works with positional fallback (no explicit mapping)", () => {
    const spec = makeSpec({
      isc: makeISCCriteria(10),
      phases: [
        makePhase({ number: 1 }),
        makePhase({ number: 2 }),
      ],
    });

    const result = detectPhasedSpec(spec, 8, 2);
    expect(result).not.toBeNull();
    expect(result!.length).toBe(2);
    // Positional: 10/2 = 5 each
    expect(result![0].iscNumbers.length).toBe(5);
    expect(result![1].iscNumbers.length).toBe(5);
    expect(result![0].usedPositionalFallback).toBe(true);
    expect(result![1].usedPositionalFallback).toBe(true);
  });

  it("respects custom thresholds", () => {
    const spec = makeSpec({
      isc: makeISCCriteria(4),
      phases: [
        makePhase({ number: 1, iscNumbers: [1, 2] }),
        makePhase({ number: 2, iscNumbers: [3, 4] }),
      ],
    });

    // Default thresholds (8, 2) → null
    expect(detectPhasedSpec(spec)).toBeNull();
    // Custom lower threshold → not null
    expect(detectPhasedSpec(spec, 4, 2)).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Semantic ISC-to-Phase assignment (Strategy 2 upgrade)
// ---------------------------------------------------------------------------

describe("getISCForPhase semantic fallback", () => {
  it("assigns ISC to matching phase by keyword overlap", () => {
    const spec = makeSpec({
      isc: [
        { number: 1, description: "API endpoints return correct JSON responses", isChecked: false },
        { number: 2, description: "Database schema migrations run cleanly", isChecked: false },
        { number: 3, description: "Unit tests pass with full coverage", isChecked: false },
        { number: 4, description: "API documentation generated from endpoints", isChecked: false },
      ],
      phases: [
        { number: 1, name: "Database Setup", steps: ["Create schema", "Run migrations"], iscNumbers: [], content: "Set up database schema and run migrations for all tables" },
        { number: 2, name: "API Development", steps: ["Build endpoints", "Add JSON responses"], iscNumbers: [], content: "Build REST API endpoints with JSON response formatting" },
        { number: 3, name: "Testing and Documentation", steps: ["Write unit tests", "Generate docs"], iscNumbers: [], content: "Write unit tests and generate API documentation" },
      ],
    });

    const r1 = getISCForPhase(spec, 1);
    const r2 = getISCForPhase(spec, 2);
    const r3 = getISCForPhase(spec, 3);

    // ISC 2 (database, schema, migrations) → Phase 1 (Database Setup)
    expect(r1.rows.map(r => r.number)).toContain(2);
    // ISC 1 (API, endpoints, JSON) → Phase 2 (API Development)
    expect(r2.rows.map(r => r.number)).toContain(1);
    // ISC 3 (tests) and ISC 4 (documentation) → Phase 3
    expect(r3.rows.map(r => r.number)).toContain(3);
    expect(r3.rows.map(r => r.number)).toContain(4);

    // All use fallback flag
    expect(r1.usedPositionalFallback).toBe(true);
    expect(r2.usedPositionalFallback).toBe(true);
    expect(r3.usedPositionalFallback).toBe(true);
  });

  it("assigns verification ISC to last phase", () => {
    const spec = makeSpec({
      isc: [
        { number: 1, description: "Build the login form with email and password fields", isChecked: false },
        { number: 2, description: "Verify all pages render correctly with zero errors", isChecked: false },
        { number: 3, description: "Validate authentication works and passes all checks", isChecked: false },
      ],
      phases: [
        { number: 1, name: "Implementation", steps: ["Build login form"], iscNumbers: [], content: "Build the login form with email and password fields" },
        { number: 2, name: "Final Verification", steps: ["Verify rendering", "Run checks"], iscNumbers: [], content: "Verify everything renders and passes checks" },
      ],
    });

    const r1 = getISCForPhase(spec, 1);
    const r2 = getISCForPhase(spec, 2);

    // ISC 1 (build, login, form) → Phase 1 (Implementation)
    expect(r1.rows.map(r => r.number)).toContain(1);
    // ISC 2 and 3 (verify, validate) → Phase 2 (last phase, verification)
    expect(r2.rows.map(r => r.number)).toContain(2);
    expect(r2.rows.map(r => r.number)).toContain(3);
  });

  it("assigns zero-match ISC to last phase", () => {
    const spec = makeSpec({
      isc: [
        { number: 1, description: "Configure authentication module", isChecked: false },
        { number: 2, description: "Xylophone orchestration layer complete", isChecked: false },
      ],
      phases: [
        { number: 1, name: "Auth Setup", steps: ["Configure auth"], iscNumbers: [], content: "Set up authentication module and configure JWT" },
        { number: 2, name: "Deployment", steps: ["Deploy service"], iscNumbers: [], content: "Deploy the service to production" },
      ],
    });

    const r1 = getISCForPhase(spec, 1);
    const r2 = getISCForPhase(spec, 2);

    // ISC 1 (auth, configure, module) → Phase 1 (Auth Setup)
    expect(r1.rows.map(r => r.number)).toContain(1);
    // ISC 2 (no match anywhere) → Phase 2 (last phase, catch-all)
    expect(r2.rows.map(r => r.number)).toContain(2);
  });

  it("falls back to positional when no semantic signal exists", () => {
    // Generic descriptions with no keyword overlap to phase names
    const isc = makeISCCriteria(9);
    const spec = makeSpec({
      isc,
      phases: [
        makePhase({ number: 1 }),
        makePhase({ number: 2 }),
        makePhase({ number: 3 }),
      ],
    });

    const r1 = getISCForPhase(spec, 1);
    const r2 = getISCForPhase(spec, 2);
    const r3 = getISCForPhase(spec, 3);

    // Should fall back to positional: 9/3 = 3 each
    expect(r1.rows.length).toBe(3);
    expect(r2.rows.length).toBe(3);
    expect(r3.rows.length).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// scoreISCPhaseMatch — unit tests
// ---------------------------------------------------------------------------

describe("scoreISCPhaseMatch", () => {
  it("scores higher for direct keyword overlap", () => {
    const isc: ISCCriterion = { number: 1, description: "Database schema validates correctly", isChecked: false };
    const phase1: SpecPhase = { number: 1, name: "Database Setup", steps: [], iscNumbers: [], content: "Create database schema" };
    const phase2: SpecPhase = { number: 2, name: "API Layer", steps: [], iscNumbers: [], content: "Build REST endpoints" };

    const s1 = scoreISCPhaseMatch(isc, phase1, false);
    const s2 = scoreISCPhaseMatch(isc, phase2, false);

    expect(s1).toBeGreaterThan(s2);
  });

  it("gives phase name match bonus", () => {
    const isc: ISCCriterion = { number: 1, description: "Testing framework configured", isChecked: false };
    const phase: SpecPhase = { number: 1, name: "Testing", steps: [], iscNumbers: [], content: "" };

    const score = scoreISCPhaseMatch(isc, phase, false);
    // "testing" appears in both ISC and phase name → word overlap (1) + name bonus (2) = 3
    expect(score).toBeGreaterThanOrEqual(3);
  });

  it("gives verification bonus for last phase", () => {
    const isc: ISCCriterion = { number: 1, description: "Verify all tests pass correctly", isChecked: false };
    const phase: SpecPhase = { number: 3, name: "Review", steps: [], iscNumbers: [], content: "" };

    const scoreAsLast = scoreISCPhaseMatch(isc, phase, true);
    const scoreNotLast = scoreISCPhaseMatch(isc, phase, false);

    expect(scoreAsLast).toBeGreaterThan(scoreNotLast);
    expect(scoreAsLast - scoreNotLast).toBe(3); // verification bonus
  });
});

// ---------------------------------------------------------------------------
// semanticISCAssignment — returns null when no signal
// ---------------------------------------------------------------------------

describe("semanticISCAssignment", () => {
  it("returns null for generic descriptions with no keyword overlap", () => {
    const spec = makeSpec({
      isc: makeISCCriteria(6),
      phases: [
        makePhase({ number: 1 }),
        makePhase({ number: 2 }),
      ],
    });

    expect(semanticISCAssignment(spec)).toBeNull();
  });

  it("returns assignment map when keyword signal exists", () => {
    const spec = makeSpec({
      isc: [
        { number: 1, description: "Database migrations run", isChecked: false },
        { number: 2, description: "API endpoints respond", isChecked: false },
      ],
      phases: [
        { number: 1, name: "Database", steps: [], iscNumbers: [], content: "Run database migrations" },
        { number: 2, name: "API", steps: [], iscNumbers: [], content: "Build API endpoints" },
      ],
    });

    const result = semanticISCAssignment(spec);
    expect(result).not.toBeNull();
    expect(result!.get(1)).toContain(1); // database ISC → database phase
    expect(result!.get(2)).toContain(2); // API ISC → API phase
  });
});

// ---------------------------------------------------------------------------
// 5-column ISC table parsing (Priority column)
// ---------------------------------------------------------------------------

describe("extractISC 5-column table with Priority", () => {
  it("extracts priority from 5-column ISC table", () => {
    const content = `
## 4. Ideal State Criteria

| # | What Ideal Looks Like | Source | Verify Method | Priority |
|---|----------------------|--------|---------------|----------|
| 1 | Core auth works | EXPLICIT | \`bun test\` | smoke |
| 2 | Error handling covers edge cases | INFERRED | \`bun test\` | full |
| 3 | API endpoint returns 200 | EXPLICIT | \`bun test src/api.test.ts\` | smoke |
`;
    const isc = extractISC(content);
    expect(isc.length).toBe(3);
    expect(isc[0].priority).toBe("smoke");
    expect(isc[1].priority).toBe("full");
    expect(isc[2].priority).toBe("smoke");
  });

  it("handles 4-column table without Priority (backward compat)", () => {
    const content = `
## 4. Ideal State Criteria

| # | What Ideal Looks Like | Source | Verify Method |
|---|----------------------|--------|---------------|
| 1 | File exists at path | EXPLICIT | \`test -f foo.ts\` |
| 2 | Tests pass | INFERRED | \`bun test\` |
`;
    const isc = extractISC(content);
    expect(isc.length).toBe(2);
    expect(isc[0].priority).toBeUndefined();
    expect(isc[1].priority).toBeUndefined();
    // Verify other fields still parse correctly
    expect(isc[0].source).toBe("EXPLICIT");
    expect(isc[0].description).toContain("File exists");
    expect(isc[0].embeddedCommand).toBe("test -f foo.ts");
  });

  it("handles 3-column table without Source or Priority (backward compat)", () => {
    const content = `
## 4. Ideal State Criteria

| # | What Ideal Looks Like | Verify Method |
|---|----------------------|---------------|
| 1 | All tests pass | \`bun test\` |
`;
    const isc = extractISC(content);
    expect(isc.length).toBe(1);
    expect(isc[0].priority).toBeUndefined();
    expect(isc[0].source).toBe("");
    expect(isc[0].embeddedCommand).toBe("bun test");
  });

  it("ignores invalid priority values", () => {
    const content = `
## 4. Ideal State Criteria

| # | What Ideal Looks Like | Source | Verify Method | Priority |
|---|----------------------|--------|---------------|----------|
| 1 | Auth works | EXPLICIT | \`bun test\` | critical |
| 2 | Tests pass | INFERRED | \`bun test\` | smoke |
`;
    const isc = extractISC(content);
    expect(isc.length).toBe(2);
    expect(isc[0].priority).toBeUndefined(); // "critical" is not valid
    expect(isc[1].priority).toBe("smoke");
  });
});
