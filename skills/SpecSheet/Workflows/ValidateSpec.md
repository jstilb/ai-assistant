# ValidateSpec Workflow

**Validate an existing specification against best practices.**

Use when:
- Reviewing a spec before implementation
- Auditing existing agent documentation
- Ensuring completeness

## Validation Checklist

### Completeness Check

For each of the 6 core areas, verify:

| Area | Required Elements | Status |
|------|-------------------|--------|
| Commands & Capabilities | Primary capability defined | ⬜ |
| | Supporting capabilities listed | ⬜ |
| | Tools/APIs specified | ⬜ |
| Testing & Validation | Success criteria defined | ⬜ |
| | Test cases provided | ⬜ |
| | Failure modes documented | ⬜ |
| Structure & Context | Input format specified | ⬜ |
| | Output format specified | ⬜ |
| | Required context listed | ⬜ |
| Style & Behavior | Tone defined | ⬜ |
| | Verbosity level set | ⬜ |
| Workflow & Process | Steps documented | ⬜ |
| | Decision points identified | ⬜ |
| | Escalation triggers defined | ⬜ |
| Boundaries & Guardrails | Always actions listed | ⬜ |
| | Ask-first actions listed | ⬜ |
| | Never actions listed | ⬜ |

### Quality Check

| Quality Criterion | Check | Status |
|-------------------|-------|--------|
| **Specificity** | Commands are executable, not vague | ⬜ |
| **Measurability** | Success criteria have numbers | ⬜ |
| **Testability** | Test cases are concrete | ⬜ |
| **Clarity** | No ambiguous language | ⬜ |
| **Boundaries** | Three-tier system complete | ⬜ |
| **Examples** | Input/output examples provided | ⬜ |

### Anti-Pattern Detection

Flag if found:

| Anti-Pattern | Example | Why Bad |
|--------------|---------|---------|
| Vague capability | "Handle things well" | Not actionable |
| Missing boundaries | No "Never" section | Safety risk |
| No failure modes | Only happy path | Unrealistic |
| Unmeasurable success | "Works correctly" | Can't validate |
| No examples | Abstract descriptions only | Hard to implement |

### spec-kit Quality Checklist

Validate the spec against spec-kit standards:

| # | Check | Status |
|---|-------|--------|
| 1 | **No implementation details** — spec doesn't mention specific libraries/frameworks | ⬜ |
| 2 | **Requirements testable** — every requirement has a verification method | ⬜ |
| 3 | **Success criteria tech-agnostic** — measurable without knowing tech stack | ⬜ |
| 4 | **No unresolved markers** — no `{{PLACEHOLDER}}` or `⚠️ INFERRED` remain | ⬜ |
| 5 | **User stories independent** — each testable alone | ⬜ |
| 6 | **Priorities justified** — every P1/P2/P3 has rationale | ⬜ |
| 7 | **Given/When/Then complete** — all acceptance criteria in BDD format | ⬜ |
| 8 | **FR IDs traceable** — every FR maps to a user story | ⬜ |

**Severity Levels:**

| Finding | Severity |
|---------|----------|
| Missing user stories | **Critical** — block for Grounded Ideal tier |
| Tech-leaking success criteria | **Warning** |
| Missing Given/When/Then | **Warning** |
| Untraceable FRs | **Info** |

## Validation Report

Generate report:

```markdown
# Spec Validation Report: {{SPEC_NAME}}

## Summary
- **Completeness:** {{X}}/18 required elements
- **Quality Score:** {{SCORE}}/100
- **Risk Level:** Low / Medium / High

## Findings

### ✅ Strengths
- {{STRENGTH_1}}
- {{STRENGTH_2}}

### ⚠️ Warnings
- {{WARNING_1}}: {{RECOMMENDATION}}
- {{WARNING_2}}: {{RECOMMENDATION}}

### 🚫 Critical Gaps
- {{GAP_1}}: {{WHY_CRITICAL}}
- {{GAP_2}}: {{WHY_CRITICAL}}

## Recommendations

1. {{RECOMMENDATION_1}}
2. {{RECOMMENDATION_2}}

## Next Steps
- [ ] Address critical gaps
- [ ] Review warnings
- [ ] Re-validate after changes
```

## Severity Levels

| Level | Criteria | Action |
|-------|----------|--------|
| **Critical** | Missing boundaries, no success criteria | Block implementation |
| **Warning** | Missing examples, vague descriptions | Recommend fix |
| **Info** | Missing optional sections | Note for improvement |
