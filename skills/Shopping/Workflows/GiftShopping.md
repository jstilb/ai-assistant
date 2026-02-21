# GiftShopping Workflow

Gift-focused research with recipient context.

---

## When to Use

- "Gift for [person]"
- "Birthday/holiday gift ideas"
- "What should I get [person]?"
- Shopping for someone else

---

## Pre-Flight

### Step 1: Check Contacts

```
Read ${KAYA_DIR}/skills/CORE/USER/CONTACTS.md
```

Look for recipient info:
- Known interests/hobbies
- Previous gifts (avoid repeats)
- Style preferences
- Any notes about them

### Step 2: Read Shopping Profile

```
Read ${KAYA_DIR}/skills/Shopping/ShoppingProfile.md
```

Get:
- Gift budget preferences
- Available gift cards (may work for recipient too)

### Step 3: Clarify Context

If recipient not in contacts, ask:
- Relationship (close friend, colleague, family)
- Their interests/hobbies
- Occasion (birthday, holiday, thank you)
- Budget range

---

## Research Phase

### Launch Creative + Research Agents

```
Task 1: Gift Ideator
- description: "Gift ideas for [RECIPIENT]"
- prompt: Generate 10+ gift ideas for someone who:
  - Interests: [INTERESTS]
  - Occasion: [OCCASION]
  - Relationship to buyer: [RELATIONSHIP]
  - Budget: $[RANGE]

  Consider:
  - Experiential vs physical gifts
  - Personalized vs practical
  - Consumable vs lasting

  Return diverse list across categories.
- subagent_type: "general-purpose"
- model: "sonnet"

Task 2: Gift Researcher
- description: "Research top gift options"
- prompt: For someone interested in [INTERESTS], research:
  - Top-rated gifts in $[BUDGET] range
  - Highly-reviewed items on gift guides
  - Unique/thoughtful options

  Focus on items available at common retailers.
- subagent_type: "general-purpose"
- model: "sonnet"
```

### Filter & Curate

From combined results, select top 5 that:
- Match recipient's interests
- Fit budget
- Are available for purchase
- Aren't generic/impersonal

---

## Output Format

```markdown
## Gift Ideas for [Recipient] - [Occasion]

**Their interests:** [Summary]
**Budget:** $[range]

---

### Top Pick: [Gift Name]
- **Price:** $[amount]
- **Where:** [Retailer with link/search term]
- **Why they'll love it:** [Personal connection to their interests]
- **Gift card opportunity:** [If applicable]

### Experiential Option: [Gift Name]
- **Price:** $[amount]
- **What it is:** [Description]
- **Why:** [Experience-based reasoning]

### Practical Option: [Gift Name]
- **Price:** $[amount]
- **Why:** [Useful + thoughtful angle]

### Unique/Personal: [Gift Name]
- **Price:** $[amount]
- **Why:** [What makes it special]

### Budget-Friendly: [Gift Name]
- **Price:** $[amount]
- **Why:** [Great value, still thoughtful]

---

### Presentation Ideas
- [Wrapping/presentation suggestion]
- [Card message idea if appropriate]
```

---

## Follow-Up

After presenting ideas, offer:
- "Want me to research any of these deeper?"
- "Should I check pricing and availability?"
- "Want more options in a specific direction?"

If user selects an option, can use QuickRecommend or TrackPrice workflow to finalize.
