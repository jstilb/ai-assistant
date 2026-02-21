---
name: Cooking
description: Kitchen intelligence system with recipe search, seasonal produce, ingredient substitution, pantry tracking, meal planning, and grocery integration. USE WHEN cooking, recipe, meal plan, what to make, ingredients, meal prep, nutrition, kitchen, dinner ideas, grocery list, pantry, seasonal, substitution, what's in season.
---

# Cooking - Kitchen Intelligence System

Smart cooking assistant with tools for recipe search, seasonal produce awareness, ingredient substitution, pantry tracking, and meal planning. Integrates with Shopping, Instacart, CalendarAssistant, VoiceInteraction, and Obsidian for end-to-end kitchen management.

---

## Configuration

**Dietary Preferences:** (customize in `USER/dietary-preferences.yaml`)
- Default: No restrictions
- Cuisine preferences: Varied
- Allergens: None

**Kitchen Context:** (customize in `USER/kitchen-context.yaml`)
- Skill level: Home cook
- Time constraints: Weekday (30 min), Weekend (flexible)
- Equipment: Standard home kitchen
- People: 2 (default)

**Pantry Staples:** (customize in `USER/pantry-staples.yaml`)
- Always-on-hand items excluded from shopping lists
- Default: salt, pepper, olive oil, butter, garlic, onions

---

## Tools

| Tool | Purpose | Location |
|------|---------|----------|
| **RecipeSearch** | Multi-source recipe discovery via web search + CachedHTTPClient | `Tools/RecipeSearch.ts` |
| **SeasonalProduce** | Regional seasonal data (your region focus, USDA source) | `Tools/SeasonalProduce.ts` |
| **SubstitutionEngine** | Ingredient substitution logic with ratios and dietary alternatives | `Tools/SubstitutionEngine.ts` |
| **PantryTracker** | Track what's on hand via StateManager | `Tools/PantryTracker.ts` |
| **MealPlanner** | Weekly plan generation with Calendar integration | `Tools/MealPlanner.ts` |

### Tool Details

**RecipeSearch.ts**
- Searches multiple recipe sources via WebSearch
- Deduplicates and ranks results by relevance, rating, and source quality
- Extracts structured recipe data (ingredients, steps, timing, nutrition)
- Caches results via CachedHTTPClient for repeat queries
- Usage: `bun Tools/RecipeSearch.ts "chicken tikka masala" --cuisine indian --time 45`

**SeasonalProduce.ts**
- USDA-sourced seasonal availability data for your region region
- Returns what's in peak season, coming into season, and going out
- Price trend awareness (cheaper when in season)
- Pairs with recipe search for seasonal recipe suggestions
- Usage: `bun Tools/SeasonalProduce.ts --month february --region san-diego`

**SubstitutionEngine.ts**
- Maps ingredients by role (flavor, texture, structure, moisture, leavening)
- Returns ranked substitutes with ratio adjustments
- Handles dietary restrictions (vegan, gluten-free, dairy-free, etc.)
- Notes any technique changes needed for the substitute
- Usage: `bun Tools/SubstitutionEngine.ts "buttermilk" --dietary vegan`

**PantryTracker.ts**
- StateManager-backed inventory of what's on hand
- Add/remove items with optional expiration dates
- "What can I make?" queries against current inventory
- Flags items approaching expiration
- Excludes pantry-staples from shopping lists
- Usage: `bun Tools/PantryTracker.ts add "chicken thighs" --expires 2026-02-08`
- Usage: `bun Tools/PantryTracker.ts list`
- Usage: `bun Tools/PantryTracker.ts expiring --days 3`

**MealPlanner.ts**
- Generates weekly meal plans based on preferences, season, and pantry
- Considers dietary preferences, time constraints per day, and variety
- Aggregates ingredients across meals for consolidated grocery lists
- Integrates with CalendarAssistant to block meal prep time
- Usage: `bun Tools/MealPlanner.ts generate --days 7 --meals dinner`

---

## Workflow Routing

| Workflow | Trigger | Action |
|----------|---------|--------|
| **WhatToMake** | "what should I make", "dinner ideas" | Check pantry + season, suggest meals |
| **RecipeFinder** | "recipe for [dish]", "how to make" | Search, synthesize, adapt recipes |
| **IngredientUse** | "I have [ingredients]", "use up" | Recipes from available ingredients |
| **MealPrep** | "meal prep", "batch cooking", "plan meals" | Weekly plan with calendar blocking |
| **GroceryList** | "grocery list", "shopping list" | Generate list → Shopping skill → Instacart |
| **Technique** | "how do I [technique]", "cooking method" | Cooking technique guidance |
| **Substitution** | "substitute for", "replace [ingredient]" | SubstitutionEngine lookup |
| **Scaling** | "scale recipe", "half recipe" | Adjust recipe quantities with ratio math |
| **Seasonal** | "what's in season", "seasonal produce" | SeasonalProduce lookup for current month |
| **Pantry** | "what do I have", "add to pantry", "expiring" | PantryTracker operations |
| **VideoRecipe** | "extract recipe from video", YouTube URL, "recipe from this video" | Extract structured recipes from YouTube videos via Gemini |

---

## Execution Steps

### WhatToMake Workflow

1. **Check PantryTracker** for what's on hand
2. **Check SeasonalProduce** for what's in peak season
3. **Gather context** (ask if not clear):
   - How much time?
   - How many people?
   - Cuisine preference?
   - Any dietary constraints today?
4. **Generate 3-5 suggestions** considering:
   - Pantry items that need using
   - Seasonal ingredients
   - Day of week (quick weekday vs elaborate weekend)
   - Recent meals from Obsidian (avoid repetition)
5. **On selection:** Provide full recipe via RecipeFinder

### RecipeFinder Workflow

1. **Search** via RecipeSearch tool
2. **Synthesize** best version from multiple sources
3. **Check pantry** for ingredients on hand
4. **Present recipe:**
   - Ingredient list with checkboxes (mark what you have)
   - Step-by-step instructions with timing cues
   - Tips for success and common mistakes
   - Suggested pairings
5. **Offer actions:**
   - Generate grocery list for missing items
   - Save to Obsidian
   - Scale up/down
   - Find substitutions

### GroceryList Workflow

1. **Gather meal plan** (from MealPlanner or manual)
2. **Extract all ingredients**
3. **Subtract pantry items** (PantryTracker + pantry-staples)
4. **Organize by store section:**
   - Produce | Meat/Protein | Dairy | Pantry | Frozen
5. **Pipe to Shopping skill** for price research
6. **Optionally pipe to Instacart** for direct ordering
7. **Save list** for reference

### Seasonal Workflow

1. Run `SeasonalProduce` for current month + region
2. Present:
   - **Peak season** items (best quality, lowest price)
   - **Coming into season** (available soon)
   - **Going out of season** (get them now)
3. Suggest recipes featuring peak-season produce
4. Note any items in PantryTracker that pair well

### Substitution Workflow

1. **Identify the ingredient** and its role (flavor, texture, structure, moisture)
2. Run `SubstitutionEngine` with any dietary constraints
3. **Present substitutes** ranked by:
   - Closest match in the recipe context
   - Common pantry items (check PantryTracker)
   - Dietary alternatives
4. **Note adjustments:** ratio changes, technique modifications

### MealPrep Workflow

1. **Determine scope:**
   - How many days/meals?
   - Dietary constraints?
   - Time available for prep?
2. **Generate plan** via MealPlanner:
   - Consider what's in season (SeasonalProduce)
   - Use pantry items (PantryTracker)
   - Balance variety and nutrition
3. **Create prep schedule** with order of operations
4. **Generate consolidated grocery list** (GroceryList workflow)
5. **Block prep time** via CalendarAssistant
6. **Save plan** to Obsidian

### VideoRecipe Workflow

1. **Accept YouTube URLs** — single URL or batch of URLs
2. **For each video, spawn a parallel agent** that:
   a. Uses `mcp__gemini__gemini-youtube` to get transcript/content
   b. Falls back to `WebFetch` on the YouTube URL for description recipes/links
   c. If description has a recipe link, fetch that directly
   d. If video is in another language, translate to English
3. **Extract structured recipe** in standard Cooking skill format:
   - Recipe title
   - Source (channel + video title + URL)
   - Servings, prep time, cook time
   - Ingredients list with quantities
   - Step-by-step instructions
   - Chef's tips and notes
4. **Save recipes** to `WORK/recipes-from-youtube-{date}.md`
5. **Offer actions:**
   - Save individual recipes to Obsidian
   - Generate grocery list for selected recipes
   - Add to meal plan

**Batch execution:** When multiple URLs provided, spawn one Intern agent per URL in parallel for efficiency. Each agent independently extracts its recipe and returns the structured result.

---

## Voice Integration

During active cooking, use VoiceInteraction for hands-free:
- "What's the ratio for béchamel?"
- "How long do I sear chicken thighs?"
- "What can I substitute for shallots?"
- "Set a timer for 15 minutes" (via system timer)
- "What temperature for medium-rare?"

Voice responses are kept concise (under 16 words) for kitchen use.

---

## Output Format

### Recipe Format
```markdown
## [Dish Name]

**Time:** [Prep] + [Cook] = [Total]
**Serves:** [Number]
**Difficulty:** [Easy/Medium/Advanced]
**Season:** [Best time of year]

### Ingredients
- [x] Ingredient 1 - quantity (on hand)
- [ ] Ingredient 2 - quantity (need to buy)
...

### Instructions
1. [Step with timing cues]
2. [Step with visual cues]
...

### Tips
- Pro tip 1
- Common mistake to avoid

### Pairs Well With
- Side dish suggestions
- Wine/beverage pairing
```

### Meal Plan Format
```markdown
## Week of [Date] - Meal Plan

| Day | Meal | Dish | Time | Key Ingredients |
|-----|------|------|------|-----------------|
| Mon | Dinner | Chicken stir-fry | 25 min | chicken, broccoli, soy |
...

### Consolidated Grocery List
**Produce:** [items]
**Protein:** [items]
**Dairy:** [items]
**Pantry:** [items]

### Prep Schedule (Sunday)
1. [Task] - [time]
2. [Task] - [time]
```

---

## USER Override Files

| File | Purpose |
|------|---------|
| `USER/dietary-preferences.yaml` | Restrictions, allergens, favorite cuisines, disliked ingredients |
| `USER/pantry-staples.yaml` | Always-on-hand items (excluded from shopping lists) |
| `USER/kitchen-context.yaml` | Equipment, skill level, weekday/weekend time, people count |

---

## Cooking Principles

1. **Mise en place:** Prep everything before cooking
2. **Taste as you go:** Adjust seasoning throughout
3. **High heat for browning:** Don't crowd the pan
4. **Rest meats:** Let proteins rest before cutting
5. **Season in layers:** Salt at multiple stages
6. **Fresh herbs last:** Add delicate herbs at end
7. **Acid brightens:** A squeeze of lemon fixes most things
8. **Fat carries flavor:** Don't skip the fat in aromatics

---

## Examples

**Example 1: Seasonal dinner**
```
User: "What should I make for dinner?"
-> Checks pantry: chicken thighs, rice
-> Checks season: citrus, avocados, kale in peak (February, your region)
-> Suggests: Citrus-marinated chicken with kale rice bowl
-> Generates grocery list for missing items
-> Offers to add to Instacart
```

**Example 2: Use up ingredients**
```
User: "I have zucchini and feta that need to be used"
-> PantryTracker shows zucchini expires in 2 days
-> Suggests: Greek zucchini boats, Mediterranean pasta, fresh salad
-> Prioritizes recipes using zucchini fastest
```

**Example 3: Substitution during cooking**
```
User (voice): "I don't have buttermilk, what can I use?"
-> SubstitutionEngine: 1 cup milk + 1 tbsp lemon juice, let sit 5 min
-> Voice response: "Use one cup milk plus one tablespoon lemon juice. Let it sit five minutes."
```

**Example 4: Weekly meal prep**
```
User: "Help me meal prep for the week"
-> Asks about preferences and constraints
-> Generates 5-day plan using seasonal produce
-> Creates consolidated grocery list (minus pantry staples)
-> Blocks Sunday 2-4pm in calendar for prep
-> Saves plan to Obsidian
```

---

## Integration

### Uses
- **Shopping skill** — Multi-agent product research for grocery lists
- **Instacart skill** — Direct grocery ordering via browser automation
- **CalendarAssistant** — Block meal prep time, check dinner plans
- **VoiceInteraction** — Hands-free cooking assistance
- **Obsidian** — Save recipes, meal plans, cooking notes
- **Gemini MCP** — Analyze food photos, identify dishes/ingredients

### Feeds Into
- **PantryTracker state** — `MEMORY/State/pantry.json`
- **Meal history** — Obsidian vault recipes collection
- **Shopping lists** — Shopping skill input

### MCPs Used
- **WebSearch** — Recipe discovery
- **Gemini** — Food photo analysis (gemini-analyze-image), YouTube recipe extraction (gemini-youtube)

---

## Customization

Extend via USER/ override files. SYSTEM defaults work out of the box for a home cook in your region with no dietary restrictions.

## Voice Notification

All workflow completions announce via VoiceInteraction:
- "Meal plan created for the week with five dinners."
- "Grocery list ready. Twelve items across three sections."
- "Found three recipes for chicken tikka masala."
