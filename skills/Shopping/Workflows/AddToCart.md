# AddToCart Workflow

Process shopping lists and add items to cart using **universal** automation that works on ANY e-commerce site.

---

## Prerequisites

1. **Read ShoppingProfile.md** - Get sizes, preferences, gift cards
2. **Parse shopping list** - Extract items, retailers, quantities
3. **Choose approach** - Tier 2 (browser automation) or Tier 3 (links)

---

## Constitutional Principle (MANDATORY)

```
Article X: Checkout Protection Gate

No agent may initiate checkout without:
1. Visual screenshot review presented to user
2. Explicit principal approval ("yes, proceed")
3. Audit log entry in MEMORY/shopping-audit.jsonl

This is HARDCODED, not configurable.
```

**Never bypass this gate. Never auto-checkout. Always wait for confirmation.**

---

## Execution Flow

### Step 1: Parse Shopping List

```typescript
// Example inputs and their parsing:

// Natural language
"I need a hiking pack from REI and a fleece from Patagonia size M"
→ [
    { name: "hiking pack", retailer: "rei" },
    { name: "fleece", size: "M", retailer: "patagonia" }
  ]

// Structured list
"REI: Flash 22 Pack, hiking socks
Patagonia: Better Sweater (M)
Nordstrom: dress shoes"
→ [
    { name: "Flash 22 Pack", retailer: "rei" },
    { name: "hiking socks", retailer: "rei" },
    { name: "Better Sweater", size: "M", retailer: "patagonia" },
    { name: "dress shoes", retailer: "nordstrom" }
  ]
```

### Step 2: Apply Profile Defaults

```typescript
// Load ShoppingProfile.md
const profile = await loadShoppingProfile()

// Apply default sizes for items without explicit size
for (const item of items) {
  if (!item.size && isClothing(item)) {
    item.size = profile.sizes.tops  // M
  }
}
```

### Step 3: Choose Automation Level

```typescript
// Tier 2: Universal browser automation - works on ANY retailer
// Uses AI-vision to find search boxes, products, and add-to-cart buttons
// No site-specific code needed

// Tier 3: Fallback links - always works, zero credentials
// Generates curated search URLs for manual clicking

// User preference determines which to use:
// - Tier 2 for hands-free automation with visual verification
// - Tier 3 for quick link generation (faster, simpler)
```

### Step 4: Process Tier 3 (Links)

Generate curated search links for retailers without automation:

```bash
bun run Shopping.ts list "Patagonia: Better Sweater (M), Nordstrom: dress shoes"
```

Output:
```markdown
## Shopping List: Ready to Add

### Patagonia (patagonia.com)
- [Better Sweater](https://patagonia.com/search?q=better+sweater+M) - Size: M

### Nordstrom (nordstrom.com)
- [dress shoes](https://nordstrom.com/sr?keyword=dress+shoes) - Size: 8
  - *You have a Nordstrom gift card*

**Click links to add to cart manually.**
```

### Step 5: Process Tier 2 (Universal Browser Automation)

Works on **ANY** e-commerce site - no site-specific code needed:

```bash
# 1. Check if we have a saved session
bun run Shopping.ts patagonia status

# 2. If no session, login and save cookies
bun run Shopping.ts patagonia login

# 3. Add item with visual verification (works on ANY site)
bun run Shopping.ts patagonia add "Better Sweater" --size M
```

**The generic add flow:**
1. Navigate to retailer's homepage
2. Screenshot → Find search input (common patterns)
3. Type product query → Wait for results
4. Screenshot → Click first matching product
5. Screenshot → Find size selector + add to cart button
6. **VISUAL VERIFICATION GATE** (show user, get confirmation)
7. Click add to cart only if confirmed
8. Screenshot → Verify success
9. Log action to audit trail

**Works on ANY retailer:**
```bash
bun run Shopping.ts rei add "Flash 22 Pack"
bun run Shopping.ts nordstrom add "dress shoes" --size 8
bun run Shopping.ts arcteryx add "Atom LT Hoody" --size M
bun run Shopping.ts uniqlo add "heattech shirt"
```

### Step 6: Report Results

```markdown
## Shopping List Results

### Successfully Added (Tier 2)
- ✅ REI: Flash 22 Pack (added to cart)
- ✅ REI: hiking socks (added to cart)

### Links Generated (Tier 3)
- 🔗 Patagonia: Better Sweater - [click to add](url)
- 🔗 Nordstrom: dress shoes - [click to add](url)

### Next Steps
- Review REI cart: https://rei.com/cart
- Complete Patagonia/Nordstrom manually via links above
- **Checkout requires manual action** (security policy)
```

---

## Error Handling

| Error | Action |
|-------|--------|
| Session expired | Prompt user to run `rei login` |
| Item not found | Fall back to Tier 3 link |
| Add to cart failed | Log error, report to user, continue with other items |
| User rejects confirmation | Skip item, log rejection, continue |

---

## Agent Integration

When user provides a shopping list:

```
1. Parse list into structured items
2. Load ShoppingProfile for sizes/preferences
3. Route items by tier
4. Process Tier 3 first (always succeeds)
5. Process Tier 2 with user confirmation for each item
6. Report consolidated results
7. NEVER initiate checkout - link to cart only
```

### Example Agent Flow

```
User: "Add these to my cart: REI Flash pack, Patagonia fleece (M)"

Agent:
1. Parses: [{name: "Flash pack", retailer: "rei"}, {name: "fleece", size: "M", retailer: "patagonia"}]
2. Loads profile: tops=M, gift cards=[REI, Nordstrom]
3. Both retailers support Tier 2 automation

4. For REI (Flash pack):
   🌐 Navigating to rei.com...
   🔍 Searching for: Flash pack
   🎯 Selecting first product match
   📸 Screenshot saved: ready-to-add.png
   🛒 Ready to add: Flash 22 Pack - $54.95
   Proceed? [y/N]: y
   ✅ Added to REI cart

5. For Patagonia (fleece):
   🌐 Navigating to patagonia.com...
   🔍 Searching for: fleece M
   🎯 Selecting first product match
   📏 Selecting size: M
   📸 Screenshot saved: ready-to-add.png
   🛒 Ready to add: Better Sweater - $139
   Proceed? [y/N]: y
   ✅ Added to Patagonia cart

6. Results:
   ✅ REI: Flash 22 Pack - added to cart
   ✅ Patagonia: Better Sweater (M) - added to cart

   View carts:
   - https://rei.com/cart
   - https://patagonia.com/shop/cart
```

---

## Security Checklist

Before completing this workflow, verify:

- [ ] ShoppingProfile was read for sizes
- [ ] All Tier 2 adds had visual verification
- [ ] User confirmed each add operation
- [ ] All actions logged to shopping-audit.jsonl
- [ ] No checkout was initiated
- [ ] Cart links provided (not checkout links)
