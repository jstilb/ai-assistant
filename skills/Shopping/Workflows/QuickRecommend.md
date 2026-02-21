# QuickRecommend Workflow

Fast, single-agent recommendation for simple shopping queries.

---

## When to Use

- "Best [product] under $X"
- "Quick rec for [product]"
- Simple, well-defined product category
- User doesn't need exhaustive research

---

## Execution

### Step 1: Read Context

```
Read ${KAYA_DIR}/skills/Shopping/ShoppingProfile.md
```

Extract relevant context:
- Sizes (if clothing/footwear)
- Budget philosophy
- Brand preferences
- Gift cards available

### Step 2: Quick Research

Use WebSearch directly (no subagent needed for QUICK effort):

```
WebSearch: "best [PRODUCT] [YEAR] under $[BUDGET]"
WebSearch: "[PRODUCT] reviews [YEAR]"
```

If clothing, also search:
```
WebSearch: "[PRODUCT] sizing [BRAND]"
```

### Step 3: Format Output

Return top 3 options:

```markdown
## Quick Recommendation: [PRODUCT]

### 1. [Product Name] - $[price]
**Why:** [One sentence - key strength]
**Where:** [Retailer] [gift card note if applicable]

### 2. [Product Name] - $[price]
**Why:** [Different strength]
**Where:** [Retailer]

### 3. [Product Name] - $[price]
**Why:** [Budget/alternative angle]
**Where:** [Retailer]

**Size note:** [If clothing - your size is X, this brand runs Y]
**Timing:** [If relevant sale upcoming]
```

---

## Complexity Escalation

If during quick research you discover:
- Significant trade-offs that need exploration
- User's requirements are more complex
- Multiple valid directions

Ask user: "This has more nuance than expected. Want me to do a full research pass?"

If yes, switch to Research.md workflow.
