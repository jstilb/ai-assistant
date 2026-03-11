# TestStrategy Workflow

**Generate a test strategy document from a CurrentWork spec's ISC rows.**

Use when:
- A CurrentWork spec has been generated and needs test-level classification
- Preparing work for execution via AutonomousWork
- Reviewing test coverage strategy before implementation

## Philosophy

> "The spec defines *what* done looks like. The test strategy defines *how* to verify it."

TestStrategy bridges the gap between acceptance criteria (ISC rows) and test implementation by deciding: what kind of test does each criterion need? What should fail fast? What existing behavior must survive?

## Prerequisites

- A CurrentWork spec with ISC rows (minimum 2 rows)
- ISC rows should have Source and Verify Method columns populated

---

## The Six-Step Protocol

### Step 1: Load Spec and Extract ISC

**Goal:** Parse the spec and extract all ISC rows with their metadata.

**Process:**

1. Read the spec file at the provided path
2. Extract ISC rows from the Section 4 table:
   - Row number, description, source, verify method, priority (if present)
3. Extract Section 6.2 Test Strategy table (if present) for context
4. Note total row count and source distribution (EXPLICIT/INFERRED/IMPLICIT)

**Output:** ISC row inventory with metadata

---

### Step 2: Classify Each ISC Row by Test Level

**Goal:** Assign each ISC row to the appropriate test level.

**Decision heuristic (apply in order, first match wins):**

| Priority | Signal | Test Level |
|----------|--------|-----------|
| 1 | Verify method contains `bun test <specific-file>` where file is `*.test.ts` | `unit` |
| 2 | Verify method contains `bun test <specific-file>` where file is `*.integration.test.ts` | `integration` |
| 3 | Description mentions API, endpoint, database, service, or multi-component interaction | `integration` |
| 4 | Description mentions UI, workflow, user flow, browser, page, or end-to-end | `e2e` |
| 5 | Verify method is `manual` or `existence` | `manual` |
| 6 | Verify method is `test -f` (existence check) | `manual` |
| 7 | Category is `"implementation"` with `bun test` verify | `unit` |
| 8 | Category is `"testing"` | `unit` |
| 9 | Default | `unit` |

**Test Level Definitions:**

| Level | Scope | Speed | Cost |
|-------|-------|-------|------|
| `unit` | Single function/module in isolation | Fast (<1s) | Free |
| `integration` | Multiple modules, APIs, DB interactions | Medium (1-10s) | Low |
| `e2e` | Full user workflow, browser/CLI | Slow (10-60s) | Medium |
| `manual` | Human judgment, visual review | N/A | High |

**Output:** Each ISC row annotated with `testLevel`

---

### Step 3: Define Test Artifacts

**Goal:** Map test levels to concrete test file patterns and frameworks.

| Test Level | Artifact Pattern | Framework | Location |
|-----------|-----------------|-----------|----------|
| `unit` | `*.test.ts` | bun:test | Co-located with source in `__tests__/` |
| `integration` | `*.integration.test.ts` | bun:test | `Tests/` or `__tests__/` |
| `e2e` | `*.e2e.test.ts` or Browse.ts scripts | Browser skill / bun:test | `Tests/E2E/` |
| `manual` | Verification checklist in spec | Human review | Spec Section 7 |

For each test level present in the classification, note the expected artifact pattern. This guides the Builder agent on where to create test files.

**Output:** Test artifact mapping

---

### Step 4: Define Smoke Subset

**Goal:** Identify the fast-fail verification subset.

**Process:**

1. Pull ISC rows with `priority: smoke` from the spec
2. If spec didn't mark any smoke rows, auto-select up to 4 rows using this heuristic:
   - Prefer rows with source `EXPLICIT` over `INFERRED` over `IMPLICIT`
   - Prefer rows with category `implementation` over `testing`
   - Prefer rows with executable verification commands over manual
3. Order smoke rows by execution speed (commands with `test -f` first, then `bun test`, then others)

**Output:** Ordered smoke execution list with commands

---

### Step 5: Define Regression Baseline

**Goal:** Identify what existing behavior must be preserved.

**Process:**

1. Pull ISC rows matching regression patterns:
   - Description contains "Existing * continues to work"
   - Description contains "No regression" or "backward compatible"
   - Source is `INFERRED` and description references existing functionality
2. For each regression row, determine the verification approach:
   - If existing test file is referenced → run that test
   - If existing behavior is described → create new regression test
   - If neither → manual verification checklist entry
3. If no regression rows exist, note "N/A — greenfield work"

**Output:** Regression baseline with verification commands

---

### Step 6: Synthesize Document

**Goal:** Compile all analysis into a structured TestStrategy document.

**Output Template:**

```markdown
# Test Strategy: {{SPEC_TITLE}}

**Spec:** {{SPEC_PATH}}
**Generated:** {{DATE}}
**ISC Rows:** {{TOTAL}} ({{UNIT}} unit, {{INTEGRATION}} integration, {{E2E}} e2e, {{MANUAL}} manual)

---

## ISC Test Classification

| ISC # | Description | Test Level | Smoke? | Test Artifact |
|-------|-------------|-----------|--------|---------------|
| {{N}} | {{DESC_TRUNCATED_60}} | {{LEVEL}} | {{yes/no}} | {{ARTIFACT_PATH}} |

---

## Smoke Test Subset (Run First)

Execute these before any other verification — if any fail, stop.

1. ISC #{{N}}: {{description}} → `{{command}}`
2. ISC #{{N}}: {{description}} → `{{command}}`

---

## Regression Baseline

| What Must Not Break | Verification | Command |
|---------------------|-------------|---------|
| {{existing behavior}} | {{test file or assertion}} | `{{command}}` |

---

## Non-Functional Tests

| Category | ISC # | Requirement | How to Verify |
|----------|-------|-------------|---------------|
| Performance | {{N}} | {{requirement}} | {{method}} |
| Security | {{N}} | {{requirement}} | {{method}} |
| Accessibility | {{N}} | {{requirement}} | {{method}} |

*(Empty sections omitted if no non-functional ISC rows exist)*

---

## Test Execution Order

1. **Smoke pass** — Run smoke-priority ISC verification commands (fast-fail)
2. **Unit tests** — `bun test` for all unit-level ISC rows
3. **Integration tests** — Targeted integration test files
4. **Regression check** — Regression baseline commands
5. **E2E / Manual** — Full workflow verification and human review items

---

## Test Artifact Checklist

- [ ] Unit test files created for ISC rows classified as `unit`
- [ ] Integration test files created for ISC rows classified as `integration`
- [ ] E2E scripts created for ISC rows classified as `e2e`
- [ ] Manual verification checklist documented for `manual` rows
- [ ] All smoke subset commands pass
- [ ] All regression baseline commands pass
```

---

## Output Location

Save to: `~/.claude/plans/Specs/Queue/{{item-id}}-test-strategy.md` (alongside the spec)

Or if invoked standalone: `~/.claude/plans/Specs/{{spec-name}}-test-strategy.md`

---

## Integration Points

- **SpecPipelineRunner** generates this document automatically after spec generation
- **AutonomousWork** reads it during `prepare()` to annotate ISC rows with `testLevel` and `priority`
- **BuilderPrompt** receives it as `{{TEST_STRATEGY}}` to guide test creation
- **VerifierPrompt** uses it to check the Builder wrote the correct test types
- **SkepticalVerifier** evaluates work against it in Phase 2 judgment

---

## Example Usage

```
User: "Generate test strategy for the auth-endpoint spec"

→ Step 1: Load spec, extract 8 ISC rows
→ Step 2: Classify:
          #1 "JWT validation returns 401 for expired tokens" → unit
          #2 "API endpoint accepts POST /auth/login" → integration
          #3 "Login flow works end-to-end from form to dashboard" → e2e
          #4 "Existing /api/users endpoint continues to work" → unit (regression)
          #5 "Rate limiting rejects >100 requests/minute" → integration
          #6 "No XSS in login form inputs" → integration (security)
          #7 "Password field is not logged" → unit (security)
          #8 "SKILL.md documents the auth commands" → manual
→ Step 3: Map artifacts: 3 unit tests, 3 integration tests, 1 e2e, 1 manual
→ Step 4: Smoke subset: #1 (JWT), #2 (API endpoint), #4 (regression)
→ Step 5: Regression baseline: #4 → `bun test src/api/__tests__/users.test.ts`
→ Step 6: Compile document
→ Output: ~/.claude/plans/Specs/Queue/auth-endpoint-test-strategy.md
```

---

**Last Updated:** 2026-03-03
