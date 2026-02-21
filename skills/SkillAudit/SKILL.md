---
name: SkillAudit
description: Deep skill analysis, evaluation, and optimization system. USE WHEN audit skill, evaluate skill, analyze skills, skill quality, skill review, consolidate skills, group workflows, abstraction analysis, improve skill, skill health, skill report.
---
# SkillAudit - Skill Analysis & Optimization System

**PURPOSE:** Deep dissection, evaluation, and optimization of Kaya skills. Assess utility, implementation quality, integration patterns, and identify opportunities for improvement, consolidation, and workflow grouping.

---

## Voice Notification

→ Use `notifySync()` from `skills/CORE/Tools/NotificationService.ts`

---

## Workflow Routing

### Core Audit Workflows

| Workflow | Trigger | Purpose | File |
|----------|---------|---------|------|
| **AuditSingle** | "audit [skill]", "evaluate [skill]", "review [skill]" | Deep audit of one skill with 5-dimension scoring | `Workflows/AuditSingle.md` |
| **AuditAll** | "audit all skills", "skill ecosystem health", "full skill audit" | Audit entire skill ecosystem with parallel agents | `Workflows/AuditAll.md` |
| **DeepTechnicalAnalysis** | "deep analysis of [skill]", "technical audit [skill]", "how does [skill] work" | Comprehensive technical implementation analysis | `Workflows/DeepTechnicalAnalysis.md` |

### Strategic Analysis

| Workflow | Trigger | Purpose | File |
|----------|---------|---------|------|
| **AnalyzeEcosystem** | "analyze ecosystem", "skill groupings", "consolidate skills", "abstraction analysis", "organize skills by domain", "which skills should merge" | Unified strategic analysis (domain grouping, abstraction assessment, consolidation recommendations) | `Workflows/AnalyzeEcosystem.md` |

### Research & Comparison

| Workflow | Trigger | Purpose | File |
|----------|---------|---------|------|
| **ResearchBestPractices** | "compare to industry", "skill best practices", "how others do it" | Research external implementations | `Workflows/ResearchBestPractices.md` |

---

## Evaluation Framework

### The Five Dimensions

Every skill audit evaluates across five dimensions, each scored 1-10:

| Dimension | What It Measures | Key Questions |
|-----------|------------------|---------------|
| **Utility** | Value delivered | Is it useful? How often used? What problems does it solve? |
| **Implementation** | Code/structure quality | Follows conventions? Has workflows, tools, examples? |
| **Integration** | System connectivity | How does it connect? Isolated or well-integrated? |
| **Abstraction** | Scope appropriateness | Too broad? Too narrow? Right level of specificity? |
| **Potential** | Unrealized capability | What could it do? What's the gap to ideal? |

### Scoring Guidelines

| Score | Meaning | Action Required |
|-------|---------|-----------------|
| 9-10 | Exemplary | Document as canonical example |
| 7-8 | Good | Minor polish opportunities |
| 5-6 | Adequate | Specific improvements needed |
| 3-4 | Deficient | Major rework required |
| 1-2 | Broken/useless | Consider deletion or complete rebuild |

---

## Quick Reference

### Single Skill Audit Output

```markdown
# Skill Audit: [SkillName]

## Report Card
| Dimension | Score | Notes |
|-----------|-------|-------|
| Utility | 7/10 | Good for X, missing Y |
| Implementation | 8/10 | Clean structure, needs examples |
| Integration | 5/10 | Isolated, should connect to Z |
| Abstraction | 6/10 | Slightly too broad |
| Potential | 9/10 | Could become essential with changes |

**Overall: 7.0/10**

## Findings
### Strengths
- [What's working well]

### Weaknesses
- [What needs improvement]

### Recommendations
1. [Specific actionable improvement]
2. [Another improvement]
3. [Another improvement]

## External Comparison
[How similar tools/skills work elsewhere]

## Consolidation/Grouping Notes
[Should this merge with another skill? Be grouped?]
```

### Ecosystem Audit Output

```markdown
# Kaya Skill Ecosystem Audit

## Health Summary
- Total Skills: N
- Healthy (7+): N
- Needs Work (4-6): N
- Critical (<4): N

## Top Performers
1. [Skill] - 9.2/10
2. [Skill] - 8.8/10

## Priority Improvements
1. [Skill] - [Why]
2. [Skill] - [Why]

## Consolidation Opportunities
- [Skill A] + [Skill B] → [New Combined Skill]

## Workflow Grouping Recommendations
- [Skills X, Y, Z] form natural "[Domain]" group

## Abstraction Issues
- Too Abstract: [Skills]
- Too Specific: [Skills]
```

---

## Implementation Quality Checklist

When auditing implementation, check:

### Structure (from CreateSkill standards)
- [ ] TitleCase naming (directory, files)
- [ ] Flat folder structure (max 2 levels)
- [ ] SKILL.md with proper frontmatter
- [ ] Customization section present
- [ ] Voice notification pattern included

### Content
- [ ] Clear description with USE WHEN triggers
- [ ] Workflow routing table
- [ ] At least one workflow in Workflows/
- [ ] Examples section with 2+ examples
- [ ] Quick reference section

### Functionality
- [ ] Workflows are executable (not just documentation)
- [ ] Tools exist if referenced
- [ ] Integration points documented
- [ ] Error handling considered

---

## Integration Analysis

### Connection Types

| Type | Description | Health Indicator |
|------|-------------|------------------|
| **Feeds Into** | Skill outputs feed another skill | Good integration |
| **Uses** | Skill invokes/depends on another | Normal dependency |
| **Isolated** | No connections | Potential problem |
| **Circular** | Mutual dependency | Architecture smell |
| **Hub** | Many skills connect here | Core skill, high importance |

### Integration Map Generation

The audit generates a skill dependency map showing:
- Which skills are hubs (many connections)
- Which skills are leaves (few connections)
- Which skills are isolated (no connections)
- Potential missing connections

---

## Abstraction Analysis

### Signs of Over-Abstraction
- Skill does many unrelated things
- Vague, broad triggers
- No clear primary use case
- Many workflows with little coherence
- Users don't know when to invoke it

### Signs of Under-Abstraction
- Very narrow single use case
- Could easily be a workflow in another skill
- Duplicates functionality with slight variation
- Triggers overlap significantly with another skill

### Ideal Abstraction
- Clear domain boundary
- 3-7 related workflows
- Obvious when to invoke
- Distinct from other skills
- Composable with other skills

---

## Consolidation Criteria

Skills should be consolidated when:

1. **Trigger Overlap >60%** - Users can't tell them apart
2. **Same Domain** - Both serve same problem space
3. **One is Subset** - Skill A fully contains Skill B's functionality
4. **Combined <150 lines** - Small skills better merged
5. **Shared Tools** - Both use same underlying tools

Skills should NOT be consolidated when:
- Different user intents despite similar domain
- One is system-level, other is user-facing
- Different complexity/effort levels
- Active divergent evolution

---

## Workflow Grouping Patterns

### Natural Groupings to Identify

| Pattern | Description | Example |
|---------|-------------|---------|
| **Pipeline** | Skills that naturally chain | Research → Write → Publish |
| **Domain** | Same problem space | Calendar + Tasks + Email = Productivity |
| **Resource** | Same underlying resource | All Google API skills |
| **Audience** | Same user type | All developer-focused skills |
| **Cadence** | Same usage pattern | All daily/weekly maintenance skills |

### Grouping Benefits
- Easier discovery for users
- Shared context loading
- Natural workflow composition
- Reduced redundancy

---

## Examples

**Example 1: Audit a single skill**
```
User: "Audit the Browser skill"
→ Invokes AuditSingle workflow
→ Reads Browser/SKILL.md and all contents
→ Evaluates against 5 dimensions
→ Researches browser automation best practices
→ Generates report card with recommendations
```

**Example 2: Full ecosystem health check**
```
User: "Run a full skill audit"
→ Invokes AuditAll workflow
→ Scans all 47 skills
→ Generates health summary
→ Identifies consolidation opportunities
→ Recommends workflow groupings
→ Prioritizes improvement work
```

**Example 3: Strategic ecosystem analysis**
```
User: "Analyze the skill ecosystem"
→ Invokes AnalyzeEcosystem workflow
→ Collects all skill inventories
→ Identifies domain groups and pipeline chains
→ Assesses abstraction levels
→ Recommends consolidations with evidence
→ Generates comprehensive strategic report
```

**Example 4: Deep technical analysis**
```
User: "How does the Browser skill actually work?"
→ Invokes DeepTechnicalAnalysis workflow
→ Catalogs all files and dependencies
→ Compares expected vs actual vs ideal behavior
→ Maps execution flows and decision points
→ Identifies redundancies and technical debt
→ Generates path to ideal state
```

---

## Multi-Agent Evaluation

For deeper analysis, spawn specialized auditor agents with distinct perspectives to provide balanced assessments.

### Auditor Agent Roles

| Agent | Traits | Focus | Evaluates |
|-------|--------|-------|-----------|
| **Structure Critic** | `meticulous,systematic,analytical` | Implementation | Files, conventions, patterns |
| **Value Assessor** | `pragmatic,analytical,consultative` | Utility | Use cases, frequency, ROI |
| **Potential Spotter** | `enthusiastic,exploratory,creative` | Potential | Unrealized capabilities, gaps |
| **Integration Analyst** | `technical,systematic,thorough` | Integration | Dependencies, connections |
| **Skeptic** | `skeptical,contrarian,adversarial` | Abstraction | Over/under-engineering |

### Agent Composition

```bash
# Structure Critic - checks implementation quality
bun run ~/.claude/skills/Agents/Tools/AgentFactory.ts \
  --task "Audit this skill's structure against Kaya conventions" \
  --traits "meticulous,systematic,analytical"

# Value Assessor - evaluates real-world utility
bun run ~/.claude/skills/Agents/Tools/AgentFactory.ts \
  --task "Assess the practical value and usage patterns of this skill" \
  --traits "pragmatic,analytical,consultative"

# Potential Spotter - identifies unrealized possibilities
bun run ~/.claude/skills/Agents/Tools/AgentFactory.ts \
  --task "Identify untapped potential and improvement opportunities" \
  --traits "enthusiastic,exploratory,creative"
```

### Parallel Audit Pattern

For AuditAll workflow, spawn 5 parallel evaluators per skill batch:

```
┌────────────────────────────────────────────────────────────────┐
│                      SKILL AUDIT PANEL                         │
├────────────┬────────────┬────────────┬────────────┬───────────┤
│  Structure │   Value    │  Potential │ Integration │  Skeptic  │
│   Critic   │  Assessor  │  Spotter   │  Analyst    │           │
├────────────┼────────────┼────────────┼────────────┼───────────┤
│ meticulous │ pragmatic  │ enthusiast │ technical  │ skeptical │
│ systematic │ analytical │ exploratory│ systematic │ contrarian│
│ analytical │ consultive │ creative   │ thorough   │ adversarial│
├────────────┼────────────┼────────────┼────────────┼───────────┤
│ Score:     │ Score:     │ Score:     │ Score:     │ Score:    │
│ Implement  │ Utility    │ Potential  │ Integration│ Abstract  │
└────────────┴────────────┴────────────┴────────────┴───────────┘
                              │
                              ▼
                    ┌──────────────────┐
                    │  Score Synthesis │
                    │  & Report Card   │
                    └──────────────────┘
```

### When to Use Multi-Agent Audit

| Scenario | Single Evaluator | Multi-Agent Panel |
|----------|-----------------|-------------------|
| Quick health check | ✓ | |
| Single dimension focus | ✓ | |
| Full skill audit | | ✓ |
| Ecosystem audit | | ✓ |
| Consolidation analysis | | ✓ |
| Abstraction review | | ✓ |

---

## Tools

### Foundation Tools

| Tool | Purpose | Command |
|------|---------|---------|
| **constants.ts** | Shared paths and configuration | Import: `import { SKILLS_DIR, MEMORY_DIR } from './constants'` |
| **utils.ts** | Shared utility functions | Import: `import { getSkillDirectories, ensureDirectory } from './utils'` |

### Analysis Tools

| Tool | Purpose | Command |
|------|---------|---------|
| **SkillInventory.ts** | Skill discovery and metrics | `bun run Tools/SkillInventory.ts [SkillName]` or `--summary` for all |
| **SkillScorer.ts** | Calculate dimension scores | `bun run Tools/SkillScorer.ts [SkillName]` |
| **DependencyMapper.ts** | Generate skill dependency graph | `bun run Tools/DependencyMapper.ts --format mermaid` |
| **TriggerAnalyzer.ts** | Analyze trigger overlap | `bun run Tools/TriggerAnalyzer.ts --threshold 40` |
| **BehaviorGapAnalyzer.ts** | Expected/Actual/Ideal comparison | `bun run Tools/BehaviorGapAnalyzer.ts [SkillName]` |
| **RedundancyDetector.ts** | Code duplication detection | `bun run Tools/RedundancyDetector.ts [SkillName]` or `--ecosystem` |

---

## Integration

### Uses
- **Agents** - Multi-perspective evaluation via trait-composed auditors
- **Research** - For best practices comparison
- **System** - For integrity checking
- **CreateSkill** - Standards reference

### Feeds Into
- **CreateSkill** - Improvement recommendations become creation work
- **System** - Audit findings inform integrity checks

### MCPs Used
- None (uses AgentFactory for auditor composition)

---

## Future: Automated Auditing

**Planned features:**
- Scheduled periodic audits (weekly skill health)
- Automatic detection of skill drift
- Usage analytics integration (which skills actually get invoked)
- Regression detection (skill quality declining)
- Auto-generated improvement PRs

---

## Related Documentation

- **CreateSkill** - Canonical skill structure standards
- **System** - Integrity check workflows
- **CORE/SYSTEM/SKILLSYSTEM.md** - Full skill system documentation
