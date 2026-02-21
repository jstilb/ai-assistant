---
name: Shopping
description: Smart shopping assistant with multi-agent research AND cart automation. USE WHEN shopping, buy, purchase, need to find, looking for product, gift ideas, price comparison, what should I get, best [product], add to cart, shopping list, OR user mentions needing something to buy.
---

# Shopping - Multi-Agent Shopping Research & Cart Automation

Intelligent shopping assistance using parallel research agents AND browser automation for adding items to cart. Master agent coordinates specialized subagents to explore brands, materials, styles, and price ranges, then synthesizes findings into actionable recommendations. **New:** Can now process shopping lists and add items to cart at supported retailers.

---

## Personal Context (CRITICAL)

**Before any shopping task, READ the user's shopping profile:**

```
Read ${KAYA_DIR}/skills/Shopping/ShoppingProfile.md
```

This contains sizes, brand preferences, gift cards, and loyalty programs. **Never recommend sizes without checking this file first.**

---

## Workflow Routing

| Workflow | Trigger | File |
|----------|---------|------|
| **AddToCart** | "Add to cart", "shopping list", list of items to buy | `Workflows/AddToCart.md` |
| **Research** | "I need a [product]", deep shopping research | `Workflows/Research.md` |
| **QuickRecommend** | "Best [product]", quick recommendation | `Workflows/QuickRecommend.md` |
| **TrackPrice** | "Track price", "when should I buy" | `Workflows/TrackPrice.md` |
| **GiftShopping** | "Gift for [person]", gift ideas | `Workflows/GiftShopping.md` |

---

## Multi-Agent Architecture

```
User Request
    │
    ▼
┌─────────────────┐
│  MASTER AGENT   │  ← Orchestrates entire flow
└────────┬────────┘
         │
    ┌────┴────┐ Phase 1: Parallel Research
    ▼         ▼
┌────────┐ ┌────────┐ ┌────────┐ ┌────────┐
│ Brand  │ │Material│ │ Style  │ │ Price  │
│ Agent  │ │ Agent  │ │ Agent  │ │ Agent  │
└────────┘ └────────┘ └────────┘ └────────┘
    │         │          │          │
    └─────────┴────┬─────┴──────────┘
                   ▼
         ┌─────────────────┐
         │   SYNTHESIS     │  ← Presents paths to user
         │   + DECISION    │
         └────────┬────────┘
                  │ (user chooses path)
                  ▼
         ┌─────────────────┐
         │  DEEP RESEARCH  │  ← 3 agents on specifics
         └────────┬────────┘
                  ▼
         ┌─────────────────┐
         │   SPOTCHECK     │  ← Validates findings
         └────────┬────────┘
                  ▼
         ┌─────────────────┐
         │ RECOMMENDATION  │  ← Final output
         └─────────────────┘
```

### Agent Traits

| Role | Traits | Purpose |
|------|--------|---------|
| Brand Researcher | research, analytical, thorough | Brand landscape |
| Material Expert | technical, meticulous, systematic | Specs/materials |
| Style Advisor | creative, empathetic, comparative | Aesthetics |
| Price Analyst | finance, pragmatic, comparative | Value analysis |
| Deep Researcher | research, enthusiastic, exploratory | Specific products |
| Spotchecker | skeptical, meticulous, adversarial | Validation |

### Agent Composition via AgentFactory

Use AgentFactory to dynamically compose shopping research agents:

```bash
# Brand Researcher - landscape analysis
bun run ~/.claude/skills/Agents/Tools/AgentFactory.ts \
  --task "Research the brand landscape for winter jackets" \
  --traits "research,analytical,thorough"

# Material Expert - technical evaluation
bun run ~/.claude/skills/Agents/Tools/AgentFactory.ts \
  --task "Analyze materials and specifications for outdoor jackets" \
  --traits "technical,meticulous,systematic"

# Style Advisor - aesthetics and fit
bun run ~/.claude/skills/Agents/Tools/AgentFactory.ts \
  --task "Evaluate style options and visual appeal" \
  --traits "creative,empathetic,comparative"

# Price Analyst - value optimization
bun run ~/.claude/skills/Agents/Tools/AgentFactory.ts \
  --task "Analyze pricing, sales timing, and value proposition" \
  --traits "finance,pragmatic,comparative"

# Spotchecker - validation
bun run ~/.claude/skills/Agents/Tools/AgentFactory.ts \
  --task "Validate findings and check for inconsistencies" \
  --traits "skeptical,meticulous,adversarial"
```

### Effort Scaling

| Effort | Agents | Trigger |
|--------|--------|---------|
| QUICK | 1 | "Quick rec", "best X under $Y" |
| STANDARD | 4 parallel → 3 deep | Normal research |
| THOROUGH | 4 parallel → 5 deep + spotcheck | Important purchases |

---

## Cart Automation Architecture

```
Shopping List
    │
    ▼
┌─────────────────┐
│   LIST PARSER   │  ← Extracts items, retailers, quantities
└────────┬────────┘
         │
    ┌────┴────┐ Route by tier
    ▼         ▼
┌────────┐ ┌────────┐
│ Tier 2 │ │ Tier 3 │
│  Auto  │ │  Links │
└────────┘ └────────┘
    │         │
    ▼         ▼
┌────────────────────────────────────┐
│     VISUAL VERIFICATION GATE       │  ← Constitutional requirement
│  (User confirms before cart add)   │
└────────────────────────────────────┘
    │
    ▼
┌─────────────────┐
│  AUDIT LOGGING  │  ← MEMORY/shopping-audit.jsonl
└─────────────────┘
```

### Automation Tiers

| Tier | Method | Retailers | Reliability |
|------|--------|-----------|-------------|
| **Tier 2** | Universal browser automation (Playwright + AI-vision) | **ANY site** | High (adapts to any layout) |
| **Tier 3** | Curated search links | All | Always works (no browser needed) |

**Tier 2 is universal** - uses common UI patterns (search boxes, product cards, add-to-cart buttons) that work across all e-commerce sites. No site-specific code needed.

### Security (Constitutional)

**Article X: Checkout Protection Gate** — No agent may initiate checkout without:
1. Visual screenshot review presented to user
2. Explicit principal approval ("yes, proceed")
3. Audit log entry in MEMORY/shopping-audit.jsonl

**This is HARDCODED, not configurable.**

### CLI Tool

```bash
# Tier 3: Generate links for any retailer
bun run Tools/Shopping.ts list "REI: hiking pack, Patagonia: fleece (M)"

# Tier 2: Universal browser automation (works on ANY retailer)
bun run Tools/Shopping.ts <retailer> login         # Login and save session
bun run Tools/Shopping.ts <retailer> add "item"    # Add to cart (with visual verification)
bun run Tools/Shopping.ts <retailer> cart          # View cart
bun run Tools/Shopping.ts <retailer> status        # Check session validity

# Examples - works on any e-commerce site:
bun run Tools/Shopping.ts rei add "Flash 22 Pack"
bun run Tools/Shopping.ts patagonia add "Better Sweater" --size M
bun run Tools/Shopping.ts nordstrom add "dress shoes" --size 8
bun run Tools/Shopping.ts arcteryx add "Atom LT Hoody" --size M
bun run Tools/Shopping.ts uniqlo add "heattech shirt"
```

---

## Output Format

```markdown
## Shopping Recommendation: [Product]

### Top Pick: [Name]
- **Price:** $[amount] ([sale info if applicable])
- **Size for you:** [Size with fit notes]
- **Where to buy:** [Store] ([gift card savings if applicable])
- **Why:** [Key benefits]

### Runner Up: [Name]
- **Price:** $[amount]
- **Why:** [Different strengths]

### Budget Pick: [Name]
- **Price:** $[amount]
- **Why:** [Value proposition]

### When to Buy
- **Best time:** [Seasonal/sale timing]
- **Current opportunity:** [Active sales]
```

---

## Examples

**Example 1: Full shopping research**
```
User: "I need a new winter jacket"
→ Reads ShoppingProfile.md for sizes (M) and preferences
→ Spawns 4 parallel agents (brand, material, style, price)
→ Synthesizes findings into 3 recommended paths
→ User selects "Best Value"
→ Spawns 3 agents for specific product research
→ Spotchecks for consistency
→ Presents final recommendations with sizes and where to buy (REI for gift card)
```

**Example 2: Quick recommendation**
```
User: "Best wireless earbuds under $200?"
→ Reads ShoppingProfile.md
→ Single agent quick research via WebSearch
→ Returns top 3 options with pros/cons
→ Notes best timing if sale is upcoming
```

**Example 3: Gift shopping**
```
User: "Gift for my sister's birthday, she likes cooking"
→ Checks CORE/USER/CONTACTS.md for sister's info
→ Reads ShoppingProfile.md for budget preferences
→ Spawns creative + research agents for gift ideas
→ Returns curated list with purchase links
```

**Example 4: Shopping list with cart automation**
```
User: "Add these to my cart: REI Flash 22 pack, Patagonia fleece (M), Nordstrom dress shoes"
→ Reads ShoppingProfile.md for sizes and gift cards
→ Parses list: 3 items across 3 retailers
→ Routes: REI → Tier 2, Patagonia/Nordstrom → Tier 3
→ Tier 3 output: Links for Patagonia and Nordstrom
→ Tier 2: Opens REI, searches "Flash 22 pack"
→ Shows screenshot, asks "Add to cart?"
→ User confirms → adds to cart, logs to audit
→ Returns consolidated results with cart links
```

**Example 5: Quick list processing**
```
User: "I need hiking socks and a rain jacket from REI"
→ Reads ShoppingProfile.md (sizes: M for jacket)
→ Parses: 2 items, both REI
→ Routes both to Tier 2
→ For each: search → screenshot → confirm → add
→ Returns: "✅ Both items added to REI cart"
```

---

## Key Patterns

### Research Patterns
1. **Always read ShoppingProfile.md first** - Context before research
2. **Parallel agent spawning** - All Phase 1 agents in single message
3. **User decision point** - Pause after synthesis, let user choose path
4. **Spotcheck mandatory** - Validate after parallel research
5. **Gift card optimization** - Prioritize stores where user has credit
6. **Size verification** - Match recommendations to profile, note brand fit quirks

### Cart Automation Patterns
7. **Tier 3 first** - Generate fallback links before attempting automation
8. **Visual verification always** - Never add to cart without user seeing screenshot
9. **No auto-checkout** - Constitutional; link to cart only, never checkout
10. **Audit everything** - All cart operations logged to shopping-audit.jsonl
11. **Session management** - Check session validity before automation, prompt for login if expired
12. **Rate limiting** - Max 5 actions/minute, 12s cooldown between operations

---

## Customization

Personalize this skill by editing:

- **`ShoppingProfile.md`** - Your sizes, brand preferences, excluded retailers, gift card balances, and loyalty programs. This file is read before every shopping task.
- **`RETAILER_SEARCH_URLS`** in `Tools/adapters/fallback.ts` - Add or remove retailer search URL patterns for Tier 3 link generation.
- **`RETAILER_URLS`** in `Tools/adapters/generic.ts` - Add retailer base URLs for Tier 2 browser automation.
- **Environment variable `SHOPPING_HEADLESS`** - Set to `'false'` to run browser automation in visible mode (default: headless).

---

## Voice Notification

-> Use `notifySync()` from `skills/CORE/Tools/NotificationService.ts`

---

## Integration

### Uses
- **Agents** - Multi-perspective research via AgentFactory (Brand, Material, Style, Price agents)
- **WebSearch** - Product research and price checking
- **Browser** - Cart automation and session management
- **Instacart** - Grocery-specific cart automation
- **ShoppingProfile.md** - Personal sizes, preferences, gift cards

### Feeds Into
- **MEMORY/shopping-audit.jsonl** - All cart operations logged
- **Instacart** - May trigger for grocery items
- **User cart** - Items added to retailer carts

### MCPs Used
- None (browser automation handled via Browser skill Browse.ts CLI)

---

**Last Updated:** 2026-01-20
