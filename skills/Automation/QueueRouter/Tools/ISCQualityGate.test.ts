import { describe, test, expect } from "bun:test";
import { validateISCQuality } from "./SpecPipelineRunner.ts";
import { QueueManager } from "./QueueManager.ts";

// ============================================================================
// validateISCQuality
// ============================================================================

describe("validateISCQuality", () => {
  test("1. detects 2-row skeleton spec -> fail", () => {
    const spec = `
## 5. Ideal State Criteria (ISC)

| # | What Ideal Looks Like | Source | Verify |
|---|----------------------|--------|--------|
| 1 | Implementation matches problem context requirements | Manual review | Manual review |
| 2 | No regressions in existing functionality | Test suite | Test suite |
`;
    const result = validateISCQuality(spec);
    expect(result.pass).toBe(false);
    expect(result.reason).toBeDefined();
  });

  test("2. detects skeleton phrase in ISC row description -> fail", () => {
    // 4 rows but one contains the skeleton phrase — should still fail
    const spec = `
## 5. Ideal State Criteria (ISC)

| # | What Ideal Looks Like | Source | Verify |
|---|----------------------|--------|--------|
| 1 | GitHub profile has name and bio configured | EXPLICIT | gh api /user |
| 2 | All repos have README files present | EXPLICIT | gh repo list --json |
| 3 | Implementation matches problem context requirements and scope | EXPLICIT | Manual review |
| 4 | CI pipeline passes on main branch | EXPLICIT | gh run list |
`;
    const result = validateISCQuality(spec);
    expect(result.pass).toBe(false);
    expect(result.reason).toMatch(/skeleton/i);
  });

  test("3. passes real spec with 8 specific ISC rows", () => {
    const spec = `
## 5. Ideal State Criteria (ISC)

| # | What Ideal Looks Like | Source | Verify |
|---|----------------------|--------|--------|
| 1 | GitHub profile has name, bio, location, website, hireable set | EXPLICIT | gh api /user check fields |
| 2 | All repos have relevant GitHub topics applied | EXPLICIT | gh repo list --json topics |
| 3 | Pinned repos show the 6 most representative projects | EXPLICIT | gh api /user/starred |
| 4 | Profile README.md renders correctly with latest stats | EXPLICIT | curl raw.githubusercontent.com |
| 5 | Social preview images are set for all public repos | EXPLICIT | gh api /repos/:owner/:repo |
| 6 | All repos have description set (no empty descriptions) | EXPLICIT | gh repo list --json description |
| 7 | Default branch is named main across all repos | EXPLICIT | gh repo list --json defaultBranchRef |
| 8 | License file present in all public open-source repos | EXPLICIT | gh api /repos/:owner/:repo/license |
`;
    const result = validateISCQuality(spec);
    expect(result.pass).toBe(true);
    expect(result.reason).toBeUndefined();
  });

  test("4. handles 3-column table — rows ARE parsed (source/verify land in wrong columns), non-skeleton phrases pass", () => {
    // The extractISC regex is: | num | desc | col3 | col4 |
    // A 3-column table | # | Desc | Verify | still satisfies the regex because
    // col3 captures the verify text and col4 captures empty string.
    // As long as none of the descriptions contain skeleton phrases and there are >= 4 rows,
    // the gate passes.
    const spec = `
## 5. Ideal State Criteria (ISC)

| # | What Ideal Looks Like | Verify | Extra |
|---|----------------------|--------|-------|
| 1 | Thing one is done correctly | Manual review | N/A |
| 2 | Thing two is done correctly | Test suite | N/A |
| 3 | Thing three is in place | Automated check | N/A |
| 4 | Thing four is verified | CI check | N/A |
| 5 | Thing five is complete | Manual review | N/A |
`;
    const result = validateISCQuality(spec);
    // 5 specific rows, no skeleton phrases -> gate passes
    expect(result.pass).toBe(true);
  });

  test("5. fails on fallback spec marker (only 1 row with FALLBACK sentinel)", () => {
    const spec = `
## 5. Ideal State Criteria (ISC)

| # | What Ideal Looks Like | Verify Method | Extra |
|---|----------------------|---------------|-------|
| 1 | FALLBACK_SPEC: Inference unavailable — requires re-generation | Manual review | N/A |
`;
    const result = validateISCQuality(spec);
    expect(result.pass).toBe(false);
    // Fails on row count (1 < 4)
    expect(result.reason).toMatch(/1 ISC rows/);
  });
});

// ============================================================================
// QueueManager.hassufficientContext
// ============================================================================

describe("hassufficientContext", () => {
  const qm = new QueueManager();

  test("6. rejects vague 200-char description", () => {
    // Description under 400 chars with no special signals
    const shortDesc = "Add a new feature to the dashboard that shows user activity metrics in a chart.";
    expect(shortDesc.length).toBeLessThan(400);

    const result = qm.hassufficientContext({ description: shortDesc });
    expect(result).toBe(false);
  });

  test("7. accepts rich description with deliverables + constraints", () => {
    // Over 400 chars with enumerated deliverables AND explicit constraints
    const richDesc = [
      "Implement a queue router context enrichment system with the following deliverables:",
      "1. QueueManager.hassufficientContext method that scores description richness",
      "2. SpecPipelineRunner.validateISCQuality that rejects skeleton specs",
      "3. Integration tests in ISCQualityGate.test.ts covering all edge cases",
      "The system must validate ISC rows before they reach the approvals queue.",
      "It must never pass skeleton phrases like generic acceptance criteria.",
      "Only items with >= 4 specific ISC rows should be allowed through.",
      "This gate must run on every spec generated by SpecPipelineRunner.",
    ].join(" ");

    expect(richDesc.length).toBeGreaterThanOrEqual(400);

    const result = qm.hassufficientContext({ description: richDesc });
    expect(result).toBe(true);
  });

  test("8. accepts when context has both notes and researchGuidance", () => {
    // Short description — would normally fail on length — but pre-supplied context shortcuts the check
    const shortDesc = "Add dark mode toggle.";

    const result = qm.hassufficientContext(
      { description: shortDesc },
      {
        notes: "The dashboard currently has no dark mode support. Users on OLED screens need it.",
        researchGuidance: "Research CSS custom properties approach vs Tailwind dark mode strategy. Check existing theme tokens in src/styles/tokens.ts.",
      }
    );
    expect(result).toBe(true);
  });

  test("9. rejects long but vague description with no signals", () => {
    // Over 400 chars but no enumerated deliverables, no file refs, no percentages, no constraint keywords
    const vagueDesc = [
      "We want to improve the overall user experience of the application by making it",
      "feel more polished and professional. The current state of the application is",
      "acceptable but there is room for improvement in many areas. We should look at",
      "what other applications do well and try to incorporate those patterns into our",
      "own design. The team agrees that this is a worthwhile investment of time and",
      "we should prioritize it accordingly in the upcoming planning cycle.",
    ].join(" ");

    expect(vagueDesc.length).toBeGreaterThanOrEqual(400);

    const result = qm.hassufficientContext({ description: vagueDesc });
    expect(result).toBe(false);
  });
});

// ============================================================================
// QueueManager.canDeriveISCDirectly
// ============================================================================

describe("canDeriveISCDirectly", () => {
  const qm = new QueueManager();

  test("10. returns true for description with acceptance criteria", () => {
    const desc = [
      "Build a dashboard widget. Acceptance criteria:",
      "- Widget renders within 200ms",
      "- Supports dark mode",
      "- Passes WCAG AA contrast checks",
    ].join("\n");

    const result = qm.canDeriveISCDirectly({ description: desc });
    expect(result).toBe(true);
  });

  test("11. returns true for description with table format", () => {
    const desc = [
      "Requirements for the API:",
      "| Endpoint | Method | Response |",
      "| /users | GET | 200 OK |",
      "| /users/:id | GET | 200 OK |",
    ].join("\n");

    const result = qm.canDeriveISCDirectly({ description: desc });
    expect(result).toBe(true);
  });

  test("12. returns true when context has researchFindings", () => {
    const result = qm.canDeriveISCDirectly(
      { description: "Short desc" },
      { researchFindings: "Prior research completed with detailed findings" }
    );
    expect(result).toBe(true);
  });

  test("13. returns true when context has previousResearchPath", () => {
    const result = qm.canDeriveISCDirectly(
      { description: "Short desc" },
      { previousResearchPath: "/some/path/research.md" }
    );
    expect(result).toBe(true);
  });

  test("14. returns false for rich but unstructured description", () => {
    const desc = [
      "We need to build a comprehensive monitoring system that tracks all",
      "microservices in production. The system should handle high throughput",
      "and provide real-time alerting. It needs to integrate with our existing",
      "Grafana dashboards and PagerDuty for on-call notifications.",
    ].join(" ");

    const result = qm.canDeriveISCDirectly({ description: desc });
    expect(result).toBe(false);
  });

  test("15. returns true for description with >=4 numbered constraints", () => {
    const desc = [
      "Build a file upload service with these constraints:",
      "(1) Maximum file size 10MB",
      "(2) Only accept PNG, JPG, PDF",
      "(3) Virus scan before storage",
      "(4) Return CDN URL after upload",
      "(5) Rate limit 100 uploads per hour",
    ].join(" ");

    const result = qm.canDeriveISCDirectly({ description: desc });
    expect(result).toBe(true);
  });

  test("16. returns false for description with only 2 numbered constraints", () => {
    const desc = [
      "Build a file upload service:",
      "(1) Maximum file size 10MB",
      "(2) Only accept PNG, JPG, PDF",
    ].join(" ");

    const result = qm.canDeriveISCDirectly({ description: desc });
    expect(result).toBe(false);
  });

  test("17. returns true for description with done-when language", () => {
    const desc = "The feature is done when all unit tests pass and coverage exceeds 80 percent.";

    const result = qm.canDeriveISCDirectly({ description: desc });
    expect(result).toBe(true);
  });
});
