# ResearchBestPractices Workflow

Research how external platforms implement similar functionality to identify best practices, missing features, and improvement opportunities.

---

## Trigger

- "compare to industry"
- "skill best practices"
- "how others do it"
- "external skill implementations"

---

## Research Targets

### AI Agent Frameworks

| Framework | Focus | Research Questions |
|-----------|-------|-------------------|
| **LangChain** | Tool composition | How do they structure tools? Evaluation? |
| **Semantic Kernel** | Enterprise skills | Plugin architecture? Reusability patterns? |
| **MCP (Model Context Protocol)** | Standardization | Server structure? Tool definitions? |
| **AutoGen** | Multi-agent | Agent composition? Skill sharing? |
| **CrewAI** | Task orchestration | Role definitions? Skill handoffs? |

### Evaluation Frameworks

| Framework | Focus | Research Questions |
|-----------|-------|-------------------|
| **LangSmith** | LLM evaluation | How do they measure quality? |
| **DeepEval** | Agent testing | What metrics do they use? |
| **GAIA Benchmark** | Task completion | How do they score complex tasks? |

### Plugin Systems

| System | Focus | Research Questions |
|--------|-------|-------------------|
| **OpenAI Plugins** | Tool definitions | Schema patterns? Discovery? |
| **ChatGPT Actions** | API integration | How do they structure actions? |
| **Copilot Extensions** | IDE integration | Context handling? |

---

## Execution

### Phase 1: Select Research Focus

Based on the specific skill or domain being analyzed, select relevant research targets.

**For a specific skill:**
```
What domain does [Skill] serve?
→ Map to external implementations of same domain
→ Research those specifically
```

**For ecosystem-wide:**
```
Research general patterns across all frameworks
Focus on: structure, evaluation, composition
```

### Phase 2: Spawn Research Agents

```
# For each research target, spawn an agent
Task({
  subagent_type: "ClaudeResearcher",
  prompt: "Research [Framework]'s approach to [Domain].
           Focus on:
           1. How do they structure similar functionality?
           2. What evaluation metrics do they use?
           3. What patterns could Kaya adopt?
           4. What do they do better than Kaya?
           5. What does Kaya do better?

           Return specific, actionable findings."
})
```

### Phase 3: Synthesize Findings

Combine research from multiple sources:
- Common patterns across frameworks
- Unique innovations worth adopting
- Anti-patterns to avoid
- Gaps in Kaya's current approach

### Phase 4: Map to Kaya Context

For each finding:
1. Is this relevant to Kaya's design philosophy?
2. How would this translate to Kaya's skill structure?
3. What's the implementation effort?
4. What's the expected benefit?

### Phase 5: Generate Report

```markdown
# Best Practices Research Report

**Research Focus:** [Skill/Domain/Ecosystem]
**Date:** [Date]
**Sources Consulted:** [N]

---

## Executive Summary

[2-3 paragraph summary of key findings]

---

## Framework Analysis

### LangChain

**How They Do It:**
[Description of their approach]

**Strengths:**
- [Strength 1]
- [Strength 2]

**Patterns to Adopt:**
- [Pattern 1] - [How to implement in Kaya]
- [Pattern 2] - [How to implement in Kaya]

**Not Applicable:**
- [Pattern that doesn't fit Kaya] - [Why]

---

### Semantic Kernel

**How They Do It:**
[Description of their approach]

**Strengths:**
- [Strength 1]
- [Strength 2]

**Patterns to Adopt:**
- [Pattern 1] - [How to implement in Kaya]

---

### MCP (Model Context Protocol)

**How They Do It:**
[Description of their approach]

**Strengths:**
- [Strength 1]
- [Strength 2]

**Patterns to Adopt:**
- [Pattern 1] - [How to implement in Kaya]

---

## Common Patterns Across Frameworks

| Pattern | LangChain | SK | MCP | Kaya Current | Kaya Should |
|---------|-----------|-----|-----|-------------|------------|
| [Pattern] | ✓ | ✓ | ✓ | ✗ | ADOPT |
| [Pattern] | ✓ | ✗ | ✓ | ✓ | KEEP |
| [Pattern] | ✓ | ✓ | ✗ | ✓ | ENHANCE |

---

## Evaluation Best Practices

### Industry Standard Metrics

| Metric | What It Measures | Kaya Equivalent |
|--------|------------------|----------------|
| Task Completion Rate | End-to-end success | [Current or needed] |
| Tool Call Accuracy | Correct tool selection | [Current or needed] |
| Intent Resolution | Understanding user needs | [Current or needed] |
| Response Completeness | Full answers | [Current or needed] |

### Recommended Additions

1. **[Metric]**
   - What: [Description]
   - Why: [Rationale]
   - How: [Implementation approach]

---

## Gaps in Kaya

### Missing Capabilities

| Gap | Industry Standard | Impact | Effort |
|-----|-------------------|--------|--------|
| [Gap] | [How others do it] | HIGH/MED/LOW | HIGH/MED/LOW |

### Enhancement Opportunities

| Current | Enhanced | Benefit |
|---------|----------|---------|
| [Current approach] | [Better approach] | [Expected benefit] |

---

## Kaya Advantages

Things Kaya does better than others:

1. **[Advantage]**
   - How Kaya does it: [Description]
   - Why it's better: [Rationale]

2. **[Advantage]**
   - How Kaya does it: [Description]
   - Why it's better: [Rationale]

---

## Recommendations

### Adopt Immediately (Low Effort, High Value)
1. [Recommendation] from [Source]
   - Implementation: [Steps]
   - Effort: LOW

### Adopt Soon (Medium Effort, High Value)
1. [Recommendation] from [Source]
   - Implementation: [Steps]
   - Effort: MEDIUM

### Consider Later (Higher Effort)
1. [Recommendation] from [Source]
   - Implementation: [Steps]
   - Effort: HIGH
   - Dependencies: [What needs to happen first]

### Don't Adopt (Not Aligned)
1. [Pattern] from [Source]
   - Why not: [Rationale]

---

## Sources

- [Source 1](URL) - [Brief description]
- [Source 2](URL) - [Brief description]
- [Source 3](URL) - [Brief description]
```

---

## Output Location

Save to: `~/.claude/MEMORY/SkillAudits/best-practices-[YYYY-MM-DD].md`

---

## Related Research Sources

- [AI Agent Evaluation Guide](https://www.confident-ai.com/blog/definitive-ai-agent-evaluation-guide)
- [LangChain Evaluation Concepts](https://docs.langchain.com/langsmith/evaluation-concepts)
- [Agent Evaluation in 2025](https://orq.ai/blog/agent-evaluation)
- [MCP Integration Patterns](https://www.getknit.dev/blog/integrating-mcp-with-popular-frameworks-langchain-openagents)
- [Azure AI Agent Observability](https://azure.microsoft.com/en-us/blog/agent-factory-top-5-agent-observability-best-practices-for-reliable-ai/)

---

## Success Criteria

- At least 3 external frameworks researched
- Specific patterns identified (not generic advice)
- Clear mapping to Kaya implementation
- Prioritized recommendations with effort estimates
- Sources documented
