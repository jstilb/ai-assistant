# AnalyzeAbstractions Workflow

Identify skills that are over-abstracted (too broad, unfocused) or under-abstracted (too narrow, should be generalized).

---

## Trigger

- "abstraction analysis"
- "too abstract"
- "too specific"
- "skill scope analysis"

---

## Abstraction Spectrum

```
UNDER-ABSTRACTED ←————————————————————→ OVER-ABSTRACTED
[Too Narrow]      [Just Right]          [Too Broad]
     ↓                  ↓                    ↓
Single use case   Clear domain      Does everything
Could be workflow Cohesive workflows   Unfocused
Easy to miss      Easy to invoke     Confusing triggers
```

---

## Indicators

### Over-Abstracted (Too Broad)

| Signal | Description | Example |
|--------|-------------|---------|
| **Many unrelated workflows** | >7 workflows with different domains | "Content" skill with video, audio, text, images |
| **Vague triggers** | Generic words that match too much | "create", "make", "do" |
| **No clear primary use** | Can't answer "what is this for?" | Utility skill that does 15 things |
| **Split personality** | Workflows serve different audiences | Dev tools + end user features |
| **Decision fatigue** | User must think hard to know when to use | "Should I use this or that?" |

### Under-Abstracted (Too Narrow)

| Signal | Description | Example |
|--------|-------------|---------|
| **Single workflow** | Only does one thing | "SendSlackMessage" skill |
| **Subset of another** | Fully contained in parent domain | "EmailDraft" when "Email" exists |
| **Highly specific triggers** | Only matches exact phrases | "create anki card from obsidian note" |
| **Could be a workflow** | Belongs inside another skill | Standalone "GitCommit" skill |
| **Low reuse** | No composition opportunities | One-off automation |

### Just Right (Ideal Abstraction)

| Signal | Description |
|--------|-------------|
| **3-7 cohesive workflows** | Related but distinct operations |
| **Clear domain boundary** | Obvious what belongs here |
| **Intuitive triggers** | Users naturally say these words |
| **Composable** | Can chain with other skills |
| **Distinct from peers** | No significant overlap with other skills |

---

## Execution

### Phase 1: Skill Inventory

For each skill, collect:
```
{
  "name": "SkillName",
  "workflow_count": N,
  "trigger_count": N,
  "trigger_specificity": "high|medium|low",
  "lines_of_code": N,
  "integration_count": N,
  "description_word_count": N
}
```

### Phase 2: Over-Abstraction Detection

**Heuristics:**
```python
over_abstracted_score = 0

if workflow_count > 7:
    over_abstracted_score += 2
if trigger_count > 20:
    over_abstracted_score += 2
if description has "and" > 3 times:
    over_abstracted_score += 1
if lines > 300:
    over_abstracted_score += 1
if workflows have no shared terminology:
    over_abstracted_score += 2

# Score > 4 = likely over-abstracted
```

**Manual checks:**
- Read the SKILL.md - is the purpose clear?
- Are all workflows related to the same domain?
- Could a user explain what this skill does in one sentence?

### Phase 3: Under-Abstraction Detection

**Heuristics:**
```python
under_abstracted_score = 0

if workflow_count == 1:
    under_abstracted_score += 3
if lines < 50:
    under_abstracted_score += 1
if trigger_count < 5:
    under_abstracted_score += 1
if skill name contains action verb:
    under_abstracted_score += 1
if exists similar skill with broader scope:
    under_abstracted_score += 2

# Score > 3 = likely under-abstracted
```

**Manual checks:**
- Could this be a workflow in another skill?
- Is there a broader category this belongs to?
- Does the name sound like a function rather than a domain?

### Phase 4: Relationship Analysis

For flagged skills:
- What skills share the same domain?
- What's the natural "parent" skill?
- What skills could be merged?
- What skills should be split?

### Phase 5: Generate Report

```markdown
# Abstraction Analysis Report

**Analyzed:** [Date]
**Total Skills:** [N]
**Issues Found:** [N]

---

## Summary

| Category | Count | Action Needed |
|----------|-------|---------------|
| Over-abstracted | N | Split into focused skills |
| Under-abstracted | N | Merge into parent skills |
| Just right | N | No action |

---

## Over-Abstracted Skills

### [Skill Name] - SPLIT RECOMMENDED

**Current State:**
- Workflows: [N]
- Triggers: [List]
- Description: "[Current description]"

**Problem:**
[Explanation of why this is too broad]

**Evidence:**
- [Specific evidence 1]
- [Specific evidence 2]

**Recommendation:**
Split into:
1. **[New Skill A]** - Focus on [domain]
   - Workflows: [List from current]
2. **[New Skill B]** - Focus on [domain]
   - Workflows: [List from current]

**Effort:** LOW/MEDIUM/HIGH

---

## Under-Abstracted Skills

### [Skill Name] - MERGE RECOMMENDED

**Current State:**
- Workflows: [N]
- Triggers: [List]
- Description: "[Current description]"

**Problem:**
[Explanation of why this is too narrow]

**Evidence:**
- [Specific evidence 1]
- [Specific evidence 2]

**Recommendation:**
Merge into **[Parent Skill]** as workflow **[WorkflowName]**

**Rationale:**
- [Why this belongs in parent]
- [How it fits the parent's domain]

**Effort:** LOW/MEDIUM/HIGH

---

## Edge Cases

Skills that are borderline:

| Skill | Leaning | Notes |
|-------|---------|-------|
| [Skill] | Slightly over | [Brief note] |
| [Skill] | Slightly under | [Brief note] |

---

## Recommendations Summary

### Immediate (This Week)
1. Merge [SkillA] into [SkillB] - LOW effort
2. Merge [SkillC] into [SkillD] - LOW effort

### Short-term (This Month)
1. Split [SkillE] into [SkillF] and [SkillG] - MEDIUM effort

### Deferred
1. Re-evaluate [SkillH] after usage data collected
```

---

## Output Location

Save to: `~/.claude/MEMORY/SkillAudits/abstractions-[YYYY-MM-DD].md`

---

## Success Criteria

- All skills categorized (over/under/just right)
- Specific split/merge recommendations for flagged skills
- Effort estimates for each recommendation
- Prioritized action list
