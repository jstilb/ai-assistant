# TrackPrice Workflow

Price tracking and optimal timing recommendations.

---

## When to Use

- "When should I buy [product]?"
- "Track price on [product]"
- "Is this a good price for [product]?"
- User considering a purchase over $100

---

## Execution

### Step 1: Identify Product

Get specific product details:
- Exact product name/model
- Current price user is seeing
- Retailer they're looking at

### Step 2: Price Research

Use WebSearch to gather price intelligence:

```
WebSearch: "[PRODUCT] price history"
WebSearch: "[PRODUCT] sale [YEAR]"
WebSearch: "[RETAILER] [PRODUCT] price drop"
WebSearch: "best time to buy [PRODUCT CATEGORY]"
```

### Step 3: Check Sale Calendar

Reference PriceTracking.md for:
- Seasonal patterns for this category
- Upcoming sale events
- Historical discount percentages

### Step 4: Analyze & Recommend

```markdown
## Price Analysis: [Product]

### Current Situation
- **Current price:** $[amount] at [retailer]
- **Your reference:** [What user mentioned/asked about]

### Price Intelligence
- **Historical low:** $[amount] ([when/where])
- **Typical sale price:** $[amount] ([X]% off)
- **Current price assessment:** [Above average / Fair / Good deal]

### Timing Factors
- **Upcoming sales:** [List relevant events]
- **Seasonal pattern:** [When this category typically goes on sale]
- **Stock risk:** [If popular item that sells out]

### Recommendation

**[BUY NOW / WAIT / SET ALERT]**

[Reasoning in 2-3 sentences explaining why this timing makes sense given the data]

### If Waiting
- **Target price:** $[amount]
- **Expected timing:** [When]
- **Watch for:** [Specific sale event]

### If Buying Now
- **Best retailer:** [Where to buy]
- **Gift card opportunity:** [If applicable from profile]
- **Coupon check:** [Any active codes found]
```

---

## Buy Now Triggers

Recommend immediate purchase when:
- Price is at or within 10% of historical low
- Item is seasonal and season is ending (stock risk)
- Sale event just started (limited time)
- User has urgent need

## Wait Triggers

Recommend waiting when:
- Major sale event within 4 weeks
- Price is above typical sale price by 20%+
- User indicated no urgency
- New model releasing soon (current may drop)
