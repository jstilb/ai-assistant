# RecommendConsolidations Workflow

Identify skills that should be merged or consolidated based on trigger overlap, domain similarity, and functional redundancy.

---

## Trigger

- "consolidate skills"
- "merge skills"
- "combine skills"
- "skill redundancy"
- "duplicate skills"

---

## Consolidation Criteria

### SHOULD Consolidate When:

| Criterion | Threshold | Rationale |
|-----------|-----------|-----------|
| **Trigger Overlap** | >60% | Users can't tell them apart |
| **Same Domain** | Identical | Fragmented user experience |
| **Subset Relationship** | A ⊂ B | Unnecessary separation |
| **Combined Size** | <150 lines | Small skills better merged |
| **Shared Tools** | Same tooling | Maintenance burden |
| **Same Author Intent** | Originally one concept | Accidental split |

### Should NOT Consolidate When:

| Criterion | Rationale |
|-----------|-----------|
| **Different User Intents** | Despite similar domain, users think differently |
| **System vs User** | Different audiences need separation |
| **Different Complexity** | Simple/complex should stay separate |
| **Active Divergence** | Skills evolving in different directions |
| **Team Ownership** | Different maintainers/expertise |

---

## Execution

### Phase 1: Trigger Overlap Analysis

```bash
# Run TriggerAnalyzer
bun run ~/.claude/skills/System/SkillAudit/Tools/TriggerAnalyzer.ts
```

Build overlap matrix:
```
              SkillA  SkillB  SkillC  SkillD
    SkillA      -      45%     12%     78%
    SkillB     45%      -      23%     34%
    SkillC     12%     23%      -      15%
    SkillD     78%     34%     15%      -
```

Flag pairs with >60% overlap.

### Phase 2: Domain Analysis

For flagged pairs:
1. Read both SKILL.md files
2. Compare:
   - Stated purposes
   - Workflow lists
   - Integration patterns
   - User intent language

### Phase 3: Functionality Comparison

| Aspect | Skill A | Skill B | Overlap? |
|--------|---------|---------|----------|
| Purpose | [X] | [Y] | YES/NO |
| Workflows | [List] | [List] | [Common] |
| Tools | [List] | [List] | [Common] |
| Integrations | [List] | [List] | [Common] |

### Phase 4: Consolidation Recommendations

For each candidate pair, determine:
1. **Merge strategy:**
   - A absorbs B (A is larger/more established)
   - B absorbs A (B is better implemented)
   - Create new C from A+B (both partial)

2. **What to keep:**
   - Which name?
   - Which workflows?
   - Which triggers?
   - Which tools?

3. **What to deprecate:**
   - Redundant workflows
   - Overlapping triggers
   - Duplicate tools

### Phase 5: Generate Report

```markdown
# Skill Consolidation Recommendations

**Analyzed:** [Date]
**Skills Compared:** [N]
**Consolidation Candidates:** [N]

---

## Trigger Overlap Matrix (>40% highlighted)

| | SkillA | SkillB | SkillC |
|-|--------|--------|--------|
| SkillA | - | **67%** | 12% |
| SkillB | **67%** | - | 23% |
| SkillC | 12% | 23% | - |

---

## Recommended Consolidations

### 1. [SkillA] + [SkillB] → [NewSkillName]

**Confidence:** HIGH/MEDIUM/LOW

**Evidence:**
- Trigger overlap: X%
- Domain: [Shared domain]
- Functional overlap: [Description]

**Current State:**
| Aspect | SkillA | SkillB |
|--------|--------|--------|
| Workflows | [N] | [M] |
| Lines | [N] | [M] |
| Last updated | [Date] | [Date] |

**Merge Strategy:** [A absorbs B / B absorbs A / Create new]

**Proposed Result:**
```
NewSkillName/
├── SKILL.md (combined, deduplicated)
├── Workflows/
│   ├── [Workflow from A]
│   ├── [Workflow from A]
│   ├── [Workflow from B]     # renamed if conflict
│   └── [Merged workflow]      # if similar
└── Tools/
    └── [Combined tools]
```

**Migration Steps:**
1. Create new combined SKILL.md
2. Move workflows (rename if needed)
3. Update skill-index.json
4. Add redirects from old names
5. Delete old skill directories

**Effort:** LOW/MEDIUM/HIGH
**Risk:** LOW/MEDIUM/HIGH

---

### 2. [SkillC] absorbed by [SkillD]

**Confidence:** HIGH/MEDIUM/LOW

**Evidence:**
- SkillC is subset of SkillD's domain
- SkillC has only [N] workflows
- All SkillC functionality can be SkillD workflows

**Migration:**
1. Move SkillC workflows to SkillD/Workflows/
2. Merge SkillC triggers into SkillD
3. Delete SkillC

**Effort:** LOW
**Risk:** LOW

---

## Not Recommended (Despite Overlap)

### [SkillE] and [SkillF]

**Overlap:** X%

**Why NOT consolidate:**
- [Reason 1]
- [Reason 2]

**Alternative:** [What to do instead]

---

## Consolidation Roadmap

### Phase 1 (Low Risk, High Value)
| Consolidation | Effort | Impact |
|--------------|--------|--------|
| A+B | LOW | HIGH |
| C→D | LOW | MEDIUM |

### Phase 2 (Medium Complexity)
| Consolidation | Effort | Impact |
|--------------|--------|--------|
| E+F | MEDIUM | HIGH |

### Deferred (Needs More Analysis)
| Candidates | Blocker |
|------------|---------|
| G+H | Different maintainers |
| I+J | Active divergence |

---

## Impact Summary

**Before:** [N] skills
**After:** [M] skills (reduction of [X])

**Benefits:**
- Simpler navigation
- Clearer user mental model
- Reduced maintenance burden
- Better trigger routing

**Risks:**
- [Any migration risks]
- [Any user confusion during transition]
```

---

## Output Location

Save to: `~/.claude/MEMORY/SkillAudits/consolidations-[YYYY-MM-DD].md`

---

## Success Criteria

- All skill pairs analyzed for overlap
- Clear YES/NO recommendation for each candidate
- Detailed merge strategy for approved consolidations
- Migration steps documented
- Roadmap with prioritization
