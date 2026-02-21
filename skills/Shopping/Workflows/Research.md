# Research Workflow

Full multi-agent shopping research for a product category.

---

## Pre-Flight

1. **Read ShoppingProfile.md** - Capture sizes, preferences, gift cards
2. **Clarify scope** - What exactly is user looking for? Use case?
3. **Determine effort** - STANDARD (4 agents) or THOROUGH (expanded)

---

## Phase 1: Branch Research

### Launch 4 Parallel Agents

**CRITICAL: All 4 agents must be launched in a SINGLE message for true parallelism.**

```
In a single response, call all 4 Task tools:

Task 1: Brand Researcher
- description: "Brand research: [PRODUCT]"
- prompt: Research top brands for [PRODUCT]. Focus on:
  - Market leaders and their positioning
  - Quality/reputation assessment
  - Warranty and customer service
  - Price tier each brand occupies
  Return: Top 5 brands with brief analysis
- subagent_type: "general-purpose"
- model: "sonnet"

Task 2: Material Expert
- description: "Material research: [PRODUCT]"
- prompt: Analyze materials and specifications for [PRODUCT]. Focus on:
  - Key material choices and trade-offs
  - Durability factors
  - Performance characteristics
  - What specs matter most for this category
  Return: Material decision guide
- subagent_type: "general-purpose"
- model: "sonnet"

Task 3: Style Advisor
- description: "Style research: [PRODUCT]"
- prompt: Explore style options for [PRODUCT]. Focus on:
  - Available style categories
  - Use case alignment (casual, professional, active)
  - Current trends vs timeless options
  - Versatility considerations
  Return: Style options with use cases
- subagent_type: "general-purpose"
- model: "sonnet"

Task 4: Price Analyst
- description: "Price research: [PRODUCT]"
- prompt: Analyze price ranges for [PRODUCT]. Focus on:
  - Budget tier ($X-Y): What you get
  - Mid tier ($X-Y): Value sweet spot
  - Premium tier ($X+): When it's worth it
  - Price-to-quality inflection points
  Return: Price tier analysis with recommendations
- subagent_type: "general-purpose"
- model: "sonnet"
```

---

## Phase 2: Synthesis & Decision Point

### Combine Results

After all 4 agents return, synthesize into this format:

```markdown
## Research Summary: [PRODUCT]

### Brand Landscape
[Top 3-5 brands with positioning from Brand Researcher]

### Material Trade-offs
[Key decisions from Material Expert]

### Style Options
[Categories from Style Advisor]

### Price Analysis
[Tiers from Price Analyst]

---

## Recommended Paths

Based on your profile (quality over price, sustainable brands preferred):

**Path A: [Name]** - [One sentence summary]
- Focus: [Brand/material/style direction]
- Price range: $X-Y
- Why it fits you: [Connection to profile]

**Path B: [Name]** - [One sentence summary]
- Focus: [Different direction]
- Price range: $X-Y
- Why it fits you: [Connection to profile]

**Path C: [Name]** - [One sentence summary]
- Focus: [Budget or alternative angle]
- Price range: $X-Y
- Why it fits you: [Connection to profile]

Which direction should I explore deeper? (Or ask a question)
```

### WAIT for user input before proceeding.

---

## Phase 3: Deep Dive

Based on user's chosen path, launch 3 targeted research agents:

```
Task 1: Deep Research - Product 1
- description: "Research [SPECIFIC PRODUCT 1]"
- prompt: Deep research on [PRODUCT 1]. Find:
  - Current price at multiple retailers
  - Size availability (user needs size [SIZE])
  - Recent reviews and common complaints
  - Warranty/return policy
  - Any active sales or coupons
- subagent_type: "general-purpose"
- model: "sonnet"

Task 2: Deep Research - Product 2
- description: "Research [SPECIFIC PRODUCT 2]"
- prompt: [Same format for second product]
- subagent_type: "general-purpose"
- model: "sonnet"

Task 3: Alternatives
- description: "Research alternatives in [PRICE RANGE]"
- prompt: Find 2-3 alternatives to [PRODUCTS 1&2] in the $X-Y range.
  Consider user's preferences: [BRAND PREFERENCES from profile]
  Check availability at: REI, Nordstrom (user has gift cards)
- subagent_type: "general-purpose"
- model: "sonnet"
```

---

## Phase 4: Spotcheck & Finalize

### Run Spotcheck

```
Task: Spotcheck
- description: "Spotcheck shopping research"
- prompt: Verify these product recommendations for user with profile:
  - Size: [SIZE from profile]
  - Gift cards at: REI, Nordstrom
  - Prefers: Quality, sustainable brands

  Products to verify:
  [Product 1 details]
  [Product 2 details]
  [Alternative details]

  Check:
  1. Prices are current (not outdated)
  2. Sizes available match user's size
  3. No contradictory claims between products
  4. Gift card stores prioritized where possible
  5. Brands align with user preferences

  Flag any issues found.
- subagent_type: "general-purpose"
- model: "haiku"
```

### Generate Final Recommendation

Use the Output Format from SKILL.md. Include:
- Top Pick with gift card optimization
- Runner Up
- Budget Pick
- Timing advice (from PriceTracking.md knowledge)
