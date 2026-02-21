# AnalyzeGroupings Workflow

Identify natural workflow groupings across skills to improve discoverability, enable composition, and reduce redundancy.

---

## Trigger

- "group workflows"
- "workflow patterns"
- "skill groupings"
- "organize skills by domain"

---

## Grouping Patterns

### Pattern Types

| Pattern | Description | How to Identify |
|---------|-------------|-----------------|
| **Pipeline** | Skills that naturally chain A→B→C | Output of one is input to another |
| **Domain** | Same problem space | Similar triggers, shared terminology |
| **Resource** | Same underlying resource | Same APIs, same data sources |
| **Audience** | Same user type | Developer vs end-user focus |
| **Cadence** | Same usage pattern | Daily, weekly, on-demand |

---

## Execution

### Phase 1: Extract Skill Metadata

For each skill, extract:
```
{
  "name": "SkillName",
  "triggers": ["trigger1", "trigger2"],
  "workflows": ["Workflow1", "Workflow2"],
  "uses": ["OtherSkill1", "OtherSkill2"],
  "feeds_into": ["OtherSkill3"],
  "domain_keywords": ["keyword1", "keyword2"]
}
```

### Phase 2: Trigger Clustering

Group skills by trigger similarity:

```
# Analyze trigger overlap
1. Build trigger→skill mapping
2. Find skills sharing >30% triggers
3. Cluster into candidate groups
```

### Phase 3: Domain Analysis

Identify domain groups:

**Content Creation Domain:**
- Research, Writing, Blogging, Newsletter
- Common pattern: gather → create → publish

**Productivity Domain:**
- Calendar, Tasks, Email, AsanaTriage
- Common pattern: input → organize → execute

**Development Domain:**
- CreateSkill, CreateCLI, Browser
- Common pattern: design → build → test

**Maintenance Domain:**
- System, Upgrades, PAISync
- Common pattern: check → fix → document

**Learning Domain:**
- NotesToAnki, StudyPlanner, Anki
- Common pattern: capture → structure → review

### Phase 4: Pipeline Detection

Find natural workflow chains:

```
For each skill with "Feeds Into":
  Trace the full chain
  Identify: Entry points → Intermediate → Terminal
```

Example chains:
- Research → Write → Publish
- Capture → Process → Store → Retrieve

### Phase 5: Gap Analysis

For each group:
- What's missing from the pipeline?
- Are there isolated skills that should join?
- Are there forced groupings that don't make sense?

### Phase 6: Generate Report

```markdown
# Skill Grouping Analysis

**Analyzed:** [Date]
**Total Skills:** [N]
**Groups Identified:** [N]

---

## Domain Groups

### [Domain Name]
**Skills:** [Skill1], [Skill2], [Skill3]
**Common Theme:** [Description]
**Workflow Chain:** [A] → [B] → [C]
**Missing Link:** [What would complete this group]

### [Domain Name]
**Skills:** [Skill1], [Skill2], [Skill3]
**Common Theme:** [Description]
**Workflow Chain:** [A] → [B] → [C]
**Missing Link:** [What would complete this group]

---

## Pipeline Chains

### [Pipeline Name]
```
[Entry Skill] → [Process Skill] → [Output Skill]
     ↓               ↓                ↓
  [Input]        [Transform]       [Result]
```
**Use case:** [When to use this chain]

---

## Orphan Skills

Skills that don't fit any group:

| Skill | Reason | Recommendation |
|-------|--------|----------------|
| [Skill] | [Why isolated] | [What to do] |

---

## Forced Groupings

Skills currently grouped that shouldn't be:

| Skill | Current Group | Better Fit |
|-------|---------------|------------|
| [Skill] | [Current] | [Recommended] |

---

## Recommendations

### Create New Groups
1. **[Group Name]:** Combine [Skills] because [reason]

### Strengthen Existing Groups
1. **[Group]:** Add [Skill] to complete the pipeline

### Split Over-Grouped
1. **[Current Group]:** Split into [Group A] and [Group B]

---

## Implementation Suggestions

### Shared Context Files
Groups could share context files for:
- Common terminology
- Shared configurations
- Cross-skill documentation

### Meta-Skills
Consider creating meta-skills that orchestrate groups:
- "Content Creation" skill that chains Research→Write→Publish
- "Productivity Suite" skill that coordinates Calendar+Tasks+Email
```

---

## Output Location

Save to: `~/.claude/MEMORY/SkillAudits/groupings-[YYYY-MM-DD].md`

---

## Success Criteria

- All skills assigned to at least one group
- Pipeline chains identified
- Orphan skills flagged with recommendations
- Actionable grouping improvements proposed
