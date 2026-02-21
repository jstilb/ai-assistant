# Skill Evaluation Criteria

Detailed scoring rubrics for each dimension of skill evaluation.

---

## Dimension 1: Utility (Is it valuable?)

**Question:** Does this skill solve real problems and deliver meaningful value?

### Scoring Rubric

| Score | Description | Indicators |
|-------|-------------|------------|
| **10** | Essential | Used daily, critical to workflows, irreplaceable |
| **9** | Highly valuable | Used weekly, significant time savings, strong user demand |
| **8** | Very useful | Regular use, clear problem solved, good ROI |
| **7** | Useful | Periodic use, solves specific problems well |
| **6** | Moderately useful | Occasional use, nice to have |
| **5** | Somewhat useful | Rare use, marginal benefit |
| **4** | Limited utility | Rarely invoked, unclear benefit |
| **3** | Minimal utility | Almost never used, weak value proposition |
| **2** | Questionable | No clear use case, may be obsolete |
| **1** | No utility | Never used, should be deleted |

### Evaluation Questions

1. How often is this skill invoked? (Daily/Weekly/Monthly/Rarely/Never)
2. What problem does it solve?
3. How much time/effort does it save?
4. Are there alternatives that are easier?
5. Would users miss it if removed?
6. Does it enable capabilities that wouldn't exist otherwise?

---

## Dimension 2: Implementation (Is it well-built?)

**Question:** Does the skill follow Kaya conventions and function correctly?

### Scoring Rubric

| Score | Description | Indicators |
|-------|-------------|------------|
| **10** | Exemplary | Perfect structure, comprehensive docs, robust error handling |
| **9** | Excellent | Follows all conventions, well-documented, reliable |
| **8** | Very good | Minor issues only, good documentation |
| **7** | Good | Follows most conventions, functional |
| **6** | Adequate | Some convention violations, works but rough |
| **5** | Passable | Multiple issues, functional but needs polish |
| **4** | Deficient | Significant issues, unreliable |
| **3** | Poor | Major convention violations, buggy |
| **2** | Very poor | Barely functional, major problems |
| **1** | Broken | Non-functional, should be rebuilt |

### Checklist Items

**Structure (max 3 points):**
- [ ] TitleCase naming throughout
- [ ] Flat folder structure (max 2 levels)
- [ ] SKILL.md with proper frontmatter

**Content (max 3 points):**
- [ ] Clear description with USE WHEN triggers
- [ ] Workflow routing table
- [ ] Examples section (2+)

**Functionality (max 4 points):**
- [ ] Workflows are actionable
- [ ] Tools exist if referenced
- [ ] Error handling present
- [ ] Integration points documented

---

## Dimension 3: Integration (Is it connected?)

**Question:** How well does this skill connect with the rest of the Kaya ecosystem?

### Scoring Rubric

| Score | Description | Indicators |
|-------|-------------|------------|
| **10** | Hub skill | Many skills depend on it, central to ecosystem |
| **9** | Well-integrated | Multiple connections, clear role in workflows |
| **8** | Good integration | Uses and is used by other skills appropriately |
| **7** | Moderate integration | Some connections, could be more integrated |
| **6** | Light integration | Few connections, mostly standalone |
| **5** | Minimal integration | 1-2 connections only |
| **4** | Isolated | No outgoing connections |
| **3** | Island | No connections at all |
| **2** | Conflicting | Integration attempts cause problems |
| **1** | Incompatible | Cannot integrate with ecosystem |

### Integration Types

| Type | Weight | Description |
|------|--------|-------------|
| **Uses** | 1 | Skill invokes another skill |
| **Feeds Into** | 2 | Skill output is input to another |
| **Shares Resources** | 1 | Common tools, data, or config |
| **Composes** | 3 | Part of a larger workflow chain |

### Evaluation Questions

1. What skills does this invoke?
2. What skills invoke this?
3. Could it share resources with related skills?
4. Is it part of a natural workflow chain?
5. Are there missing integration opportunities?

---

## Dimension 4: Abstraction (Is scope appropriate?)

**Question:** Is the skill at the right level of abstraction—not too broad, not too narrow?

### Scoring Rubric

| Score | Description | Indicators |
|-------|-------------|------------|
| **10** | Perfect scope | Clear domain, cohesive workflows, intuitive triggers |
| **9** | Excellent scope | Well-bounded, all workflows related |
| **8** | Good scope | Mostly cohesive, minor scope creep |
| **7** | Acceptable scope | Some unrelated elements, but manageable |
| **6** | Slightly off | Either a bit too broad or narrow |
| **5** | Moderately off | Clear abstraction issues |
| **4** | Over-abstracted | Too many unrelated things |
| **3** | Under-abstracted | Too narrow, should be workflow |
| **2** | Significantly off | Major restructuring needed |
| **1** | Wrong level | Completely misaligned |

### Over-Abstraction Indicators
- >7 workflows with different domains
- Vague, generic triggers
- Users confused about when to use
- "Does everything" syndrome

### Under-Abstraction Indicators
- Only 1 workflow
- Could be a workflow in another skill
- Triggers are too specific
- Subset of another skill's domain

### Ideal Abstraction Checklist
- [ ] 3-7 cohesive workflows
- [ ] Clear domain boundary
- [ ] Intuitive triggers
- [ ] Composable with other skills
- [ ] Distinct from peer skills

---

## Dimension 5: Potential (What could it become?)

**Question:** What's the gap between current state and what this skill could achieve?

### Scoring Rubric

| Score | Description | Indicators |
|-------|-------------|------------|
| **10** | Already ideal | Fully realized, no meaningful improvements possible |
| **9** | Near-ideal | Minor enhancements possible, mostly complete |
| **8** | High-performing | Some room for growth, strong foundation |
| **7** | Good with potential | Clear improvement path, solid base |
| **6** | Moderate potential | Several enhancement opportunities |
| **5** | Significant potential | Large gap to ideal, but achievable |
| **4** | High potential | Major improvements needed, could be great |
| **3** | Unrealized | Currently weak, but strong concept |
| **2** | Needs vision | Good idea, poor execution, needs rethink |
| **1** | Low ceiling | Limited potential even with improvements |

### Gap Analysis Questions

1. What features are missing?
2. What would make this skill exceptional?
3. What would "euphoric surprise" look like?
4. What do external implementations do that we don't?
5. What's blocking this skill from being great?

### Potential Categories

| Category | Description |
|----------|-------------|
| **Feature gaps** | Missing workflows or capabilities |
| **Quality gaps** | Works but could be more robust |
| **Integration gaps** | Could connect with more skills |
| **UX gaps** | Hard to use, confusing triggers |
| **Documentation gaps** | Poorly documented |

---

## Composite Scoring

### Overall Score Calculation

```
Overall = (Utility × 0.25) + (Implementation × 0.20) +
          (Integration × 0.15) + (Abstraction × 0.20) +
          (Potential × 0.20)
```

### Priority Weighting

For improvement prioritization:
```
Priority Score = (10 - Implementation) × Utility × Potential / 100
```

High priority = High utility skill with low implementation but high potential.

---

## Scoring Shortcuts

### Quick Assessment (5 minutes)

| Question | Score |
|----------|-------|
| Is it useful? | _/10 |
| Does it work? | _/10 |
| Is it connected? | _/10 |
| Is scope right? | _/10 |
| Could it be better? | _/10 |

### Red Flags (Immediate Attention)

- Any dimension < 4
- Utility < 5 AND Potential < 5
- Implementation < 5 AND Used frequently
- Integration = 0 (completely isolated)

---

## Benchmark Skills

### Canonical Examples (9+ overall)

Reference these as standards:
- **Browser** - Good structure, clear purpose, well-integrated
- **THEALGORITHM** - Comprehensive, well-documented
- **Research** - Multiple workflows, good integration

### Anti-Examples (< 5 overall)

Learn from these issues:
- [Document specific problematic skills after audit]
