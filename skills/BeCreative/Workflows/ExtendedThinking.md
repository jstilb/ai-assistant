# Extended Thinking Workflow (Consolidated)

## Voice Notification

```bash
curl -s -X POST http://localhost:8888/notify \
  -H "Content-Type: application/json" \
  -d '{"message": "Running extended thinking in BeCreative with MODE mode"}' \
  > /dev/null 2>&1 &
```

---

## Core Technique

**Verbalized Sampling (Zhang et al., 2024):** In your thinking, generate 5 diverse responses with probabilities (p<0.10 each). Think deeply about each option. Select and output only the single best response.

---

## Mode Selection

Choose the appropriate mode based on the user's request, then apply the core technique with mode-specific thinking prompts.

### Standard (default)
**Triggers:** "be creative", "think creatively", general creative tasks
**Think about:** Unique perspectives, unconventional assumptions, unexpected cross-domain connections, counterintuitive possibilities.
**Best for:** Creative writing, high-stakes creative work, polished single-best output.

### Maximum
**Triggers:** "maximum creativity", "most creative", "radically different"
**Think about:** Unusual perspectives and genres, question EVERY assumption, experimental territory, deliberately avoid ALL cliched approaches, what would make this truly unique and memorable.
**Best for:** Fiction, unusual poetry, innovative products, unconventional solutions.

### Idea Generation
**Triggers:** "brainstorm", "ideas for", "solve this problem"
**Think about:** Assumptions underlying conventional solutions, solutions from different industries, inverted problems, counterintuitive approaches, hidden constraints and opportunities.
**Best for:** Strategic planning, business innovation, product development, process improvement.

### Tree of Thoughts
**Triggers:** "complex problem", "multi-factor", "explore paths"
**Process differs:** (1) Deep analysis of constraints and opportunities, (2) identify 3-5 fundamentally different approaches, (3) for each branch explore sub-approaches, (4) evaluate creativity and viability, (5) synthesize optimal solution combining best insights.
**Best for:** Complex strategic decisions, multi-constraint optimization, high-stakes innovation.

### Domain-Specific
**Triggers:** "artistic", "business innovation", domain-specific requests

**Artistic:** Explore bold/experimental approaches, question aesthetic assumptions, connections across art forms, emotional impact, push boundaries while maintaining coherence.

**Business:** Question business model assumptions, cross-industry approaches, customer psychology, scalability/sustainability, balance innovation with implementation.

### Technical (via Gemini)
**Triggers:** "technical creativity", "algorithm", "architecture", "performance optimization"
**Tool:** Uses `llm -m gemini-3-pro-preview` for engineering-focused creative generation.
**Process:** (1) Define problem with constraints, (2) prompt Gemini for 5-10 diverse technical solutions, (3) evaluate each on performance/complexity/cost/maintainability/innovation, (4) recommend with justification.

```bash
llm -m gemini-3-pro-preview "Generate 5-10 diverse creative technical solutions for:

PROBLEM: [technical challenge]
CONSTRAINTS: [requirements and limits]
SUCCESS CRITERIA: [measurable outcomes]

For each solution provide:
1. Core technical approach
2. Key innovation (what makes it non-obvious)
3. Trade-offs (performance vs complexity vs cost)
4. Implementation difficulty (1-10)
5. Why creative (cross-domain insight or novel combination)"
```

**Best for:** Algorithm design, system architecture, data structures, protocol design, performance optimization.

---

## Process (All Modes Except Technical)

1. Receive request from user
2. Select mode based on triggers above
3. Apply core technique: generate 5 diverse options internally (p<0.10 each)
4. Use mode-specific thinking prompts to guide exploration
5. Select the most innovative/appropriate option
6. Output single polished response
