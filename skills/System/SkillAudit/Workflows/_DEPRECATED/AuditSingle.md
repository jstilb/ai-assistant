# AuditSingle Workflow

Deep audit of a single Kaya skill with comprehensive evaluation across all five dimensions.

---

## Trigger

- "audit [skill name]"
- "evaluate [skill name]"
- "review [skill name]"
- "skill report for [skill name]"

---

## Execution

### Phase 1: Discovery

Use the shared SkillInventory tool for discovery:

```bash
# Get complete skill inventory
bun run ~/.claude/skills/System/SkillAudit/Tools/SkillInventory.ts [SkillName]
```

This provides:
- File inventory (SKILL.md, Workflows/, Tools/, other .md)
- Metrics (line count, word count, workflow count, tool count)
- Dependencies (uses, feeds into, MCPs)
- Triggers extracted from SKILL.md
- Complexity assessment (simple/moderate/complex)

**Also read all content manually** to understand the skill deeply.

### Phase 2: Structural Analysis

Use SkillScorer for automated structure checks:

```bash
bun run ~/.claude/skills/System/SkillAudit/Tools/SkillScorer.ts [SkillName]
```

Evaluate against CreateSkill standards:

**Check Structure:**
- [ ] TitleCase directory name
- [ ] SKILL.md exists with proper frontmatter
- [ ] Customization section present
- [ ] Voice notification pattern present
- [ ] Flat folder structure (max 2 levels)

**Check Content:**
- [ ] Clear description with USE WHEN triggers
- [ ] Workflow routing table exists
- [ ] Workflows/ directory has at least one workflow
- [ ] Examples section with 2+ concrete examples
- [ ] Quick reference section

**Check Functionality:**
- [ ] Referenced tools exist
- [ ] Workflows are actionable (not just documentation)
- [ ] Integration points documented

### Phase 3: Dimension Scoring

Score each dimension 1-10 with justification:

#### Utility (Is it valuable?)
Questions to answer:
- What problem does this skill solve?
- How frequently would this be invoked?
- Is the problem important to the user?
- Does it save significant time/effort?
- Are there alternatives that are easier?

#### Implementation (Is it well-built?)
Questions to answer:
- Does it follow Kaya conventions?
- Is the code/structure clean?
- Are there bugs or issues?
- Is it documented well?
- Would a new user understand how to use it?

#### Integration (Is it connected?)
Questions to answer:
- What other skills does it use?
- What skills use it?
- Is it isolated or well-integrated?
- Does it share resources appropriately?
- Are there missing integration opportunities?

#### Abstraction (Is scope appropriate?)
Questions to answer:
- Is it trying to do too many things?
- Is it too narrow/specific?
- Are the workflows coherent?
- Could it be split or merged beneficially?
- Do users know when to invoke it?

#### Potential (What could it become?)
Questions to answer:
- What's the gap between current and ideal?
- What features are missing?
- What would make this skill exceptional?
- Is there unrealized value?
- What would "euphoric surprise" look like for this skill?

### Phase 4: External Research

**Research how others implement similar functionality:**

1. Spawn research agent:
   ```
   Task({
     subagent_type: "ClaudeResearcher",
     prompt: "Research best practices for [skill domain]. How do LangChain, Semantic Kernel, MCP servers, and other AI frameworks implement similar functionality? What patterns are we missing?"
   })
   ```

2. Identify:
   - Industry best practices
   - Missing features
   - Alternative approaches
   - Patterns to adopt

### Phase 5: Consolidation/Grouping Analysis

**Check for consolidation opportunities:**
- Are there other skills with similar triggers?
- Does this skill overlap significantly with another?
- Could this be a workflow in a larger skill?

**Check for grouping opportunities:**
- What natural domain does this belong to?
- What skills would it chain with?
- Is there a pipeline this fits into?

### Phase 6: Generate Report

Output the full audit report:

```markdown
# Skill Audit: [SkillName]

**Audited:** [Date]
**Version:** [from frontmatter if exists]

---

## Report Card

| Dimension | Score | Notes |
|-----------|-------|-------|
| Utility | X/10 | [Brief justification] |
| Implementation | X/10 | [Brief justification] |
| Integration | X/10 | [Brief justification] |
| Abstraction | X/10 | [Brief justification] |
| Potential | X/10 | [Brief justification] |

**Overall Score: X.X/10**

---

## Findings

### Strengths
1. [Strength with specific evidence]
2. [Strength with specific evidence]
3. [Strength with specific evidence]

### Weaknesses
1. [Weakness with specific evidence]
2. [Weakness with specific evidence]
3. [Weakness with specific evidence]

### Structural Issues
- [Any CreateSkill convention violations]

---

## Recommendations

### High Priority
1. **[Recommendation]**
   - Why: [Justification]
   - How: [Specific steps]

### Medium Priority
1. **[Recommendation]**
   - Why: [Justification]
   - How: [Specific steps]

### Nice to Have
1. **[Recommendation]**
   - Why: [Justification]
   - How: [Specific steps]

---

## External Comparison

### Industry Best Practices
[What we learned from research]

### Patterns to Adopt
- [Pattern 1]
- [Pattern 2]

### Our Advantages
- [What we do better]

---

## Consolidation/Grouping Notes

### Related Skills
- [Skill 1] - [Relationship]
- [Skill 2] - [Relationship]

### Consolidation Recommendation
[Should this merge with another skill? Details.]

### Grouping Recommendation
[What workflow group does this belong to?]

---

## Path to Excellence

**Current State:** [Brief description]

**Ideal State:** [What excellence looks like for this skill]

**Gap:** [What's missing]

**Effort to Close Gap:** [LOW/MEDIUM/HIGH]
```

---

## Output Location

Save report to: `~/.claude/MEMORY/SkillAudits/[SkillName]-[YYYY-MM-DD].md`

---

## SkillInvoker Integration (2026-02-02)

For programmatic audit panel definitions and scoring checklists, use SkillInvoker:

```typescript
import { invokeSkill } from '~/.claude/lib/core/SkillInvoker.ts';

// Generate 5-agent audit panel from Roster template
const panelRoster = await invokeSkill({
  skill: 'Prompting',
  args: '--template Primitives/Roster.hbs --data audit-panel.yaml'
});

// Generate scoring checklist from Gate template
const scoringGate = await invokeSkill({
  skill: 'Prompting',
  args: '--template Primitives/Gate.hbs --data dimension-criteria.yaml'
});

// Generate structured audit report format
const reportStructure = await invokeSkill({
  skill: 'Prompting',
  args: '--template Primitives/Structure.hbs --data audit-report.yaml'
});

// Analyze audit findings with Fabric
const findingsAnalysis = await invokeSkill({
  skill: 'Fabric',
  args: 'analyze_claims < audit-findings.md'
});
```

**5-Agent Panel Definition (Roster.hbs):**

```yaml
# audit-panel.yaml
agents:
  - name: Architect
    role: System design evaluation
    focus: Integration, dependencies, scalability
  - name: Integrator
    role: Cross-skill connectivity
    focus: Integration points, data flow
  - name: Maintainer
    role: Long-term sustainability
    focus: Documentation, conventions, tech debt
  - name: User
    role: End-user experience
    focus: Usability, triggers, examples
  - name: Optimizer
    role: Performance and efficiency
    focus: Redundancy, consolidation, potential
```

---

## Success Criteria

- All five dimensions scored with justification
- At least 3 specific, actionable recommendations
- External research completed
- Consolidation/grouping analysis done
- Report saved to MEMORY
