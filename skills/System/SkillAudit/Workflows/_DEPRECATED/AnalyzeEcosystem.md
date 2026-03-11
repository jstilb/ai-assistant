# AnalyzeEcosystem Workflow

Unified strategic analysis of the Kaya skill ecosystem. Combines domain grouping analysis, abstraction level assessment, and consolidation recommendations into a single comprehensive workflow.

---

## Trigger

- "analyze ecosystem"
- "skill ecosystem analysis"
- "skill groupings"
- "consolidate skills"
- "abstraction analysis"
- "organize skills by domain"
- "workflow patterns"
- "which skills should merge"

---

## Purpose

This workflow consolidates three previously separate analyses into one unified strategic assessment:

1. **Domain Grouping Analysis** - Find natural skill clusters and pipeline chains
2. **Abstraction Level Assessment** - Identify over/under-abstracted skills
3. **Consolidation Recommendations** - Suggest specific skill merges

**When to use:** For ecosystem-wide strategic planning, not individual skill evaluation (use AuditSingle for that).

---

## Tools Used

This workflow uses the following SkillAudit tools:

| Tool | Purpose |
|------|---------|
| `SkillInventory.ts` | Collect metrics for all skills |
| `TriggerAnalyzer.ts` | Analyze trigger overlap |
| `DependencyMapper.ts` | Map skill connections |
| `RedundancyDetector.ts` | Find cross-skill redundancies |

---

## Execution

### Phase 1: Skill Inventory Collection

**1.1 Collect all skill inventories**

```bash
bun run ~/.claude/skills/System/SkillAudit/Tools/SkillInventory.ts --summary
```

**1.2 Extract key metrics for analysis**

For each skill, capture:
- Name, type (private/public)
- Workflow count
- Tool count
- Trigger count
- Complexity level (simple/moderate/complex)
- Dependencies (uses, feeds into)

---

### Phase 2: Domain Grouping Analysis

**2.1 Identify domain clusters**

Group skills by natural domain affinity:

| Domain | Common Characteristics |
|--------|----------------------|
| **Content Creation** | Research, writing, publishing workflows |
| **Productivity** | Calendar, tasks, email, organization |
| **Development** | Code generation, skill creation, CLIs |
| **Maintenance** | System health, audits, upgrades |
| **Learning** | Anki, notes, knowledge management |
| **Security** | Recon, assessment, red team |
| **Automation** | Proactive tasks, scheduling, queues |

**2.2 Detect pipeline chains**

Find skills that naturally chain together:

```
Pipeline Pattern:
[Entry Skill] → [Processing Skill] → [Output Skill]
     ↓               ↓                   ↓
  (Input)        (Transform)         (Deliver)
```

Use DependencyMapper to trace:
```bash
bun run ~/.claude/skills/System/SkillAudit/Tools/DependencyMapper.ts --format mermaid
```

**2.3 Identify orphan skills**

Skills with no domain fit:
- No "Uses" or "Feeds Into" connections
- Triggers don't align with any domain
- Isolated functionality

---

### Phase 3: Abstraction Level Assessment

**3.1 Over-abstraction indicators**

A skill is likely **over-abstracted** when:

| Signal | Threshold | Score |
|--------|-----------|-------|
| Many unrelated workflows | >7 workflows | +2 |
| Excessive triggers | >20 triggers | +2 |
| Vague purpose | "and" >3x in description | +1 |
| Large SKILL.md | >300 lines | +1 |
| Incoherent workflow names | No shared terminology | +2 |

**Over-abstracted score >4 = recommend split**

**3.2 Under-abstraction indicators**

A skill is likely **under-abstracted** when:

| Signal | Threshold | Score |
|--------|-----------|-------|
| Single workflow | 1 workflow | +3 |
| Tiny SKILL.md | <50 lines | +1 |
| Few triggers | <5 triggers | +1 |
| Action verb name | Name sounds like function | +1 |
| Subset of another | Parent skill exists | +2 |

**Under-abstracted score >3 = recommend merge**

**3.3 Ideal abstraction characteristics**

- 3-7 cohesive workflows
- Clear domain boundary
- Intuitive triggers
- Distinct from peer skills
- Composable with other skills

---

### Phase 4: Consolidation Recommendations

**4.1 Run trigger overlap analysis**

```bash
bun run ~/.claude/skills/System/SkillAudit/Tools/TriggerAnalyzer.ts --threshold 40
```

**4.2 Run ecosystem redundancy detection**

```bash
bun run ~/.claude/skills/System/SkillAudit/Tools/RedundancyDetector.ts --ecosystem
```

**4.3 Consolidation criteria**

| Criterion | Threshold | Action |
|-----------|-----------|--------|
| Trigger overlap | >60% | Strong merge candidate |
| Same domain | Identical | Consider merge |
| Subset relationship | A ⊂ B | A absorbed by B |
| Combined size | <150 lines | Better merged |
| Shared tools | Same tooling | Reduce maintenance |

**4.4 Anti-consolidation criteria**

Do NOT merge when:
- Different user intents (despite similar domain)
- System vs user-facing split
- Different complexity levels
- Active divergent evolution
- Different maintainers

---

### Phase 5: Generate Comprehensive Report

```markdown
# Kaya Skill Ecosystem Analysis

**Generated:** [Date]
**Total Skills:** [N]
**Analysis Scope:** Domain Grouping + Abstraction + Consolidation

---

## Executive Summary

[2-3 paragraph summary of ecosystem health and key findings]

**Overall Ecosystem Health:** 🟢 GREEN / 🟡 YELLOW / 🔴 RED

---

## Domain Groups

### [Domain Name] Group
**Skills:** [Skill1], [Skill2], [Skill3]
**Common Theme:** [Description]
**Workflow Chain:** [A] → [B] → [C]
**Completeness:** [What's missing from this group]

### [Domain Name] Group
[Repeat for each domain]

---

## Pipeline Chains

### [Pipeline Name]
```
[Entry] → [Process] → [Output]
```
**Use Case:** [When to use this chain]
**Gaps:** [Missing links]

---

## Abstraction Analysis

### Over-Abstracted Skills (Recommend Split)

| Skill | Score | Indicators | Recommendation |
|-------|-------|------------|----------------|
| [Skill] | X/8 | [Why] | Split into [A] and [B] |

### Under-Abstracted Skills (Recommend Merge)

| Skill | Score | Indicators | Recommendation |
|-------|-------|------------|----------------|
| [Skill] | X/8 | [Why] | Merge into [Parent] |

### Ideal Abstraction (No Action)

[List of well-abstracted skills]

---

## Consolidation Opportunities

### High Confidence Merges

#### [SkillA] + [SkillB] → [NewName]

**Evidence:**
- Trigger overlap: X%
- Domain: [Same domain]
- Functional overlap: [Description]

**Merge Strategy:** [A absorbs B / B absorbs A / Create new]

**Migration Steps:**
1. [Step 1]
2. [Step 2]
3. [Step 3]

**Effort:** LOW/MEDIUM/HIGH

### Medium Confidence Merges

[Similar structure]

### Not Recommended (Despite Overlap)

| SkillA | SkillB | Overlap | Why NOT Merge |
|--------|--------|---------|---------------|
| [Skill] | [Skill] | X% | [Reason] |

---

## Orphan Skills

Skills that don't fit any group:

| Skill | Issue | Recommendation |
|-------|-------|----------------|
| [Skill] | [Why isolated] | [What to do] |

---

## Recommended Actions

### Immediate (This Week)
1. [Action] - LOW effort, HIGH impact
2. [Action] - LOW effort, HIGH impact

### Short-term (This Month)
1. [Action] - MEDIUM effort
2. [Action] - MEDIUM effort

### Strategic (This Quarter)
1. [Action] - Longer-term improvement
2. [Action] - Architectural change

---

## Impact Summary

**If All Recommendations Implemented:**

| Metric | Before | After | Change |
|--------|--------|-------|--------|
| Total Skills | [N] | [M] | -X |
| Orphan Skills | [N] | [M] | -X |
| Avg Workflows/Skill | [N] | [M] | +X |
| Trigger Conflicts | [N] | [M] | -X |

---

## Appendix: Full Domain Mapping

| Skill | Primary Domain | Secondary | Abstraction | Merge Candidate? |
|-------|---------------|-----------|-------------|------------------|
| [Skill] | [Domain] | [Domain] | [Over/Under/Ideal] | [Yes/No] |
```

---

## Output Location

Save to: `~/.claude/MEMORY/SkillAudits/ecosystem-[YYYY-MM-DD].md`

---

## Success Criteria

- [ ] All skills inventoried with metrics
- [ ] Domain groups identified with rationale
- [ ] Pipeline chains mapped
- [ ] Over/under-abstracted skills flagged
- [ ] Consolidation candidates identified with evidence
- [ ] Specific, actionable recommendations provided
- [ ] Report saved to MEMORY

---

## Relationship to Other Workflows

| Workflow | When to Use Instead |
|----------|---------------------|
| **AuditSingle** | Deep dive on one skill |
| **AuditAll** | Ecosystem health check with scores |
| **DeepTechnicalAnalysis** | Code-level implementation analysis |
| **ResearchBestPractices** | External comparison research |

**AnalyzeEcosystem** is for strategic restructuring decisions. Use **AuditSingle** for tactical skill improvements.

---

## Deprecated Workflows

This workflow replaces:
- `AnalyzeGroupings.md` → Now Phase 2
- `AnalyzeAbstractions.md` → Now Phase 3
- `RecommendConsolidations.md` → Now Phase 4

These deprecated workflows are preserved in `Workflows/_DEPRECATED/` for reference.
