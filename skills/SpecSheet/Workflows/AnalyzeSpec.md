# AnalyzeSpec Workflow

**Cross-artifact consistency analysis for spec sheets across the vision hierarchy.**

This workflow performs automated consistency checks across related specifications (Solarpunk, Grounded Ideal, Current Work) within the same domain, identifying duplicates, ambiguities, orphan requirements, and traceability gaps. Inspired by spec-kit's `/speckit.analyze`.

## Philosophy

> "A spec is only as good as its consistency with the specs around it."

AnalyzeSpec ensures that:
- Requirements don't duplicate or conflict across tiers
- Every functional requirement traces to a user story and ISC row
- Ambiguous or vague requirements are flagged before implementation
- Scope creep is detected early

## Prerequisites

- At least one spec in the domain (Current Work, Grounded Ideal, or Solarpunk Vision)
- Specs stored in standard locations (`~/.claude/Plans/Specs/`)

---

## The Four-Step Protocol

### Step 1: Load Related Specs

**Goal:** Load all related specifications for the domain using VisionSpecIndex.

**Process:**

1. **Use VisionSpecIndex to find domain specs:**
```bash
bun ~/.claude/skills/SpecSheet/Tools/VisionSpecIndex.ts --domain "{{DOMAIN}}"
```

2. **Load in hierarchy order:**
   - Solarpunk Vision (utopian north star)
   - Grounded Ideal (achievable excellence)
   - Current Work (implementation specs)

3. **Parse each spec:**
   - Extract user stories
   - Extract functional requirements (FRs)
   - Extract ISC rows
   - Extract priorities and phases
   - Extract Given/When/Then acceptance criteria

**Output:** `scratch/analyze-01-loaded-specs.md`

---

### Step 2: Cross-Artifact Checks

**Goal:** Run consistency checks across all loaded specs.

**Checks:**

| Check | Severity | Description |
|-------|----------|-------------|
| Duplicate requirements across tiers | Warning | Same FR appears in multiple specs without traceability link |
| Ambiguous/vague requirements | Critical | Requirements using words like "should", "might", "ideally", "as needed" without concrete criteria |
| Underspecified referenced features | Warning | A spec references a feature defined elsewhere but lacks sufficient detail to implement |
| Orphan FRs not linked to user stories | Warning | Functional requirements that exist without a parent user story |
| ISC rows without verification method | Critical | ISC criteria that have no defined way to verify completion |
| Priority conflicts between Grounded and CurrentWork | Warning | Same feature has different priority levels across tiers |
| Scope creep (CurrentWork items not in Grounded) | Info | Current Work spec includes items that don't trace back to the Grounded Ideal |
| Missing Given/When/Then | Warning | Acceptance criteria that lack structured Given/When/Then format |

**For each finding, capture:**

```markdown
## Finding: {{FINDING_TITLE}}

**Severity:** Critical | Warning | Info
**Location:** {{SPEC_NAME}} > {{SECTION}}
**Description:** {{WHAT_IS_WRONG}}
**Affected Items:** {{FR_IDS_OR_REQUIREMENTS}}
**Recommendation:** {{HOW_TO_FIX}}
```

**Output:** `scratch/analyze-02-findings.md`

---

### Step 3: Traceability Matrix

**Goal:** Generate a full traceability matrix showing how requirements flow through the hierarchy.

**Matrix Format:**

| User Story | FR IDs | ISC Rows | Phase | Tested? |
|------------|--------|----------|-------|---------|
| {{STORY}} | {{FR_1, FR_2}} | {{ISC_1, ISC_2}} | {{PHASE}} | Yes/No/Partial |

**Process:**

1. **Extract all user stories** from Grounded Ideal and Current Work specs
2. **Map each story to FRs** — identify which functional requirements implement it
3. **Map each FR to ISC rows** — identify which ISC criteria verify it
4. **Assign phase** — which implementation phase addresses this story
5. **Check test coverage** — does a verification method exist for each ISC row

**Flag gaps:**
- User stories with no mapped FRs
- FRs with no mapped ISC rows
- ISC rows with no verification method
- Phases with no assigned stories

**Output:** `scratch/analyze-03-traceability-matrix.md`

---

### Step 4: Analysis Report

**Goal:** Generate a comprehensive analysis report with all findings and recommendations.

**Report Template:**

```markdown
# Spec Analysis Report: {{DOMAIN}}

## Summary
- **Specs Analyzed:** {{COUNT}}
- **Total Findings:** {{TOTAL}}
- **Critical:** {{CRITICAL_COUNT}}
- **Warnings:** {{WARNING_COUNT}}
- **Info:** {{INFO_COUNT}}
- **Traceability Coverage:** {{PERCENTAGE}}%

## Critical Findings

{{CRITICAL_FINDINGS}}

## Warnings

{{WARNING_FINDINGS}}

## Informational

{{INFO_FINDINGS}}

## Traceability Matrix

{{MATRIX}}

## Recommendations

### Immediate Actions (Critical)
1. {{ACTION_1}}
2. {{ACTION_2}}

### Recommended Improvements (Warning)
1. {{IMPROVEMENT_1}}
2. {{IMPROVEMENT_2}}

### Notes (Info)
1. {{NOTE_1}}

## Next Steps
- [ ] Address critical findings before implementation
- [ ] Review warnings and incorporate into next spec revision
- [ ] Update traceability matrix after changes
- [ ] Re-run analysis to verify fixes
```

**Output:** Save to `~/.claude/Plans/Specs/{{Domain}}-analysis-report.md`

---

## Severity Levels

| Level | Criteria | Action |
|-------|----------|--------|
| **Critical** | Ambiguous requirements, unverifiable ISC rows | Block implementation until resolved |
| **Warning** | Duplicates, orphans, missing Given/When/Then | Recommend fix before implementation |
| **Info** | Scope creep, minor inconsistencies | Note for awareness |

---

## Example Usage

```
User: "Analyze spec consistency for personal knowledge management"

-> Step 1: Load PKM Solarpunk Vision, Grounded Ideal, and Current Work specs
-> Step 2: Run 8 cross-artifact checks
          Found: 2 critical (ambiguous FRs, unverifiable ISC)
          Found: 3 warnings (duplicates, orphan FRs, priority conflicts)
          Found: 1 info (scope creep in Current Work)
-> Step 3: Generate traceability matrix
          12 user stories, 34 FRs, 28 ISC rows
          Coverage: 82% (6 FRs missing ISC mapping)
-> Step 4: Compile analysis report with prioritized recommendations
```

---

**Last Updated:** 2026-02-13
