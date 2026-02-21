# AuditAll Workflow

Comprehensive audit of the entire Kaya skill ecosystem to assess overall health, identify patterns, and prioritize improvements.

---

## Trigger

- "audit all skills"
- "skill ecosystem health"
- "full skill audit"
- "skill health check"

---

## Execution Strategy

**This is a large task.** Use parallel agents to audit skills concurrently, then synthesize findings.

### Phase 1: Discovery

Use the shared SkillInventory tool:

```bash
# Get full ecosystem summary
bun run ~/.claude/skills/SkillAudit/Tools/SkillInventory.ts --summary

# Get detailed inventory as JSON
bun run ~/.claude/skills/SkillAudit/Tools/SkillInventory.ts --json
```

This provides:
- Total skills, public vs private breakdown
- Total workflows and tools
- Average workflows per skill
- Complex skills list (>7 workflows or >300 lines)
- Simple skills list (potential merge candidates)

**Categorize skills:**
- System skills (CORE, System, CreateSkill)
- Private skills (_ALLCAPS prefix)
- Domain skills (everything else)

### Phase 2: Parallel Quick Audits

Spawn parallel agents to perform quick audits (5 skills per agent):

```
For each batch of 5 skills:
  Task({
    subagent_type: "Intern",
    prompt: "Quick audit these 5 skills. For each, score 1-10 on:
      - Utility (is it valuable?)
      - Implementation (follows conventions?)
      - Integration (connected to ecosystem?)

      Read each SKILL.md and return:
      - Skill name
      - 3 scores
      - 1-sentence summary
      - Top issue (if any)

      Skills: [list]"
  })
```

### Phase 3: Identify Priority Skills

From quick audits, identify:
- **Critical issues** (any score <4)
- **High potential** (high utility + low implementation)
- **Consolidation candidates** (similar triggers/domains)

### Phase 4: Deep Audit Priority Skills

For skills with critical issues or high potential, run full AuditSingle:

```
Task({
  subagent_type: "Architect",
  prompt: "Deep audit [SkillName] following AuditSingle workflow.
           Return full report with all 5 dimensions scored."
})
```

### Phase 5: Ecosystem Analysis

#### Trigger Overlap Analysis
```bash
# Use TriggerAnalyzer tool
bun run ~/.claude/skills/SkillAudit/Tools/TriggerAnalyzer.ts
```

Identify skills with >60% trigger overlap → consolidation candidates.

#### Dependency Mapping
```bash
# Use DependencyMapper tool
bun run ~/.claude/skills/SkillAudit/Tools/DependencyMapper.ts
```

Identify:
- Hub skills (many connections)
- Isolated skills (no connections)
- Missing connections

#### Domain Clustering
Group skills by natural domain:
- **Productivity:** Calendar, Tasks, Email
- **Content:** Writing, Research, Publishing
- **Development:** CreateSkill, CreateCLI
- **Maintenance:** System, Upgrades
- etc.

### Phase 6: Generate Ecosystem Report

```markdown
# Kaya Skill Ecosystem Audit

**Audited:** [Date]
**Total Skills:** [N]
**Skills Analyzed:** [N]

---

## Health Summary

| Health Tier | Count | Percentage |
|-------------|-------|------------|
| Excellent (9-10) | N | X% |
| Good (7-8) | N | X% |
| Adequate (5-6) | N | X% |
| Needs Work (3-4) | N | X% |
| Critical (<3) | N | X% |

**Ecosystem Health Score: X.X/10**

---

## Top Performers

Skills that exemplify Kaya standards:

| Rank | Skill | Score | Why |
|------|-------|-------|-----|
| 1 | [Skill] | 9.X | [Brief reason] |
| 2 | [Skill] | 9.X | [Brief reason] |
| 3 | [Skill] | 8.X | [Brief reason] |

**Canonical Examples:**
- Best structure: [Skill]
- Best documentation: [Skill]
- Best integration: [Skill]

---

## Priority Improvements

Skills requiring immediate attention:

| Priority | Skill | Score | Top Issue | Effort |
|----------|-------|-------|-----------|--------|
| 1 | [Skill] | X.X | [Issue] | LOW/MED/HIGH |
| 2 | [Skill] | X.X | [Issue] | LOW/MED/HIGH |
| 3 | [Skill] | X.X | [Issue] | LOW/MED/HIGH |

---

## Consolidation Opportunities

Skills that should be merged:

| Candidate A | Candidate B | Overlap | Recommendation |
|-------------|-------------|---------|----------------|
| [Skill] | [Skill] | X% | Merge into [NewName] |
| [Skill] | [Skill] | X% | [Skill A] absorbs [Skill B] |

**Rationale for each:**
1. [Detailed explanation]
2. [Detailed explanation]

---

## Workflow Grouping Recommendations

Natural skill groupings for better organization:

### [Domain Name] Group
- Skills: [Skill1], [Skill2], [Skill3]
- Common theme: [Description]
- Potential workflow chain: [A] → [B] → [C]

### [Domain Name] Group
- Skills: [Skill1], [Skill2], [Skill3]
- Common theme: [Description]
- Potential workflow chain: [A] → [B] → [C]

---

## Abstraction Issues

### Over-Abstracted (too broad)
| Skill | Issue | Recommendation |
|-------|-------|----------------|
| [Skill] | [Why too broad] | Split into [X] and [Y] |

### Under-Abstracted (too narrow)
| Skill | Issue | Recommendation |
|-------|-------|----------------|
| [Skill] | [Why too narrow] | Merge into [Parent skill] |

---

## Dependency Map

### Hub Skills (>3 connections)
- [Skill]: Used by [N] skills, uses [M] skills

### Isolated Skills (0 connections)
- [Skill]: Consider integration with [Suggestion]

### Missing Connections
- [Skill A] should integrate with [Skill B] because [reason]

---

## Trend Analysis

### Patterns Observed
- [Pattern 1]
- [Pattern 2]

### Systemic Issues
- [Issue that affects multiple skills]

### Strengths
- [What the ecosystem does well]

---

## Recommended Actions

### This Week (Quick Wins)
1. [Action with low effort, high impact]
2. [Action with low effort, high impact]

### This Month (Medium Effort)
1. [Action requiring more work]
2. [Action requiring more work]

### Roadmap (Strategic)
1. [Longer-term improvement]
2. [Longer-term improvement]

---

## Metrics to Track

For future audits, track:
- Ecosystem health score trend
- Number of critical skills
- Average implementation score
- Consolidation progress
- Integration density
```

---

## Output Location

Save report to: `~/.claude/MEMORY/SkillAudits/ecosystem-[YYYY-MM-DD].md`

---

## Success Criteria

- All skills inventoried and categorized
- Quick audit scores for all skills
- Deep audits for priority skills
- Consolidation opportunities identified
- Workflow groupings recommended
- Actionable improvement roadmap generated
