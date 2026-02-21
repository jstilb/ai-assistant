---
name: Designer
description: Interior design intelligence with room analysis, style matching, color palettes, room state tracking, and furniture search. USE WHEN interior design, decorate, room layout, furniture, cozy, color scheme, reading nook, home decor, style room, room analysis, mood board, lighting, cozify.
---

# Designer - Interior Design Intelligence

Smart interior design assistant with tools for room photo analysis, style matching, color palette generation, room inventory tracking, and furniture search. Integrates with Shopping, Art, Gemini MCP, Obsidian, and CalendarAssistant for end-to-end design workflow.

---

## Configuration

**Style Preferences:** (customize in `USER/style-preferences.yaml`)
- Aesthetic: Cozy, warm, lived-in
- Colors: Warm neutrals with pops of color
- Budget: Moderate (mix high/low)
- Avoid: Ultra-modern, industrial, sterile

**Space Context:** (customize in `USER/rooms.yaml`)
- Current focus: Adding coziness and color
- Interest areas: Reading nooks, ambient lighting

**Design Goals:** (customize in `USER/design-goals.yaml`)
- Active projects and priorities

---

## Tools

| Tool | Purpose | Location |
|------|---------|----------|
| **RoomAnalyzer** | 3-tier vision analysis: Gemini → Claude → Text inference fallback | `Tools/RoomAnalyzer.ts` |
| **StyleMatcher** | Match photos/descriptions to design style taxonomy | `Tools/StyleMatcher.ts` |
| **ColorPalette** | Generate cohesive palettes with paint brand recommendations | `Tools/ColorPalette.ts` |
| **RoomState** | Track room inventories, measurements, plans via StateManager | `Tools/RoomState.ts` |
| **FurnitureSearch** | Curated product DB (210 products, 8 styles, 10 categories) + inference fallback | `Tools/FurnitureSearch.ts` |
| **AnalysisCache** | StateManager-backed SHA-256 keyed analysis cache with 7-day TTL | `Tools/AnalysisCache.ts` |
| **DesignerConfig** | Load user preferences from YAML (style, colors, budget, rooms, goals) | `Tools/DesignerConfig.ts` |
| **OutputFormatter** | JSON + Markdown output with budget calculation by category/impact | `Tools/OutputFormatter.ts` |

### Tool Details

**RoomAnalyzer.ts**
- 3-tier vision fallback: Gemini (standard) → Claude (smart) → Text inference (fast)
- Image validation: JPG/PNG/WebP only, ≤10MB, SHA-256 hashing for cache keys
- Returns structured analysis with `confidence` (0-1) and `analysisMethod` fields
- Identifies issues: empty corners, poor lighting, lack of cohesion, missing textures
- Suggests improvements ranked by impact-to-cost ratio
- Usage: `bun Tools/RoomAnalyzer.ts analyze /path/to/room-photo.jpg [--focus area] [--validate]`

**StyleMatcher.ts**
- Analyzes inspiration images or text descriptions
- Maps to design style taxonomy (Hygge, Japandi, Boho, Modern Cozy, Cottagecore, Mid-Century, Scandinavian, etc.)
- Compares inspiration to current room state → generates gap analysis
- Returns key elements, colors, materials, and product categories needed
- Usage: `bun Tools/StyleMatcher.ts match --inspiration /path/to/photo.jpg --room living-room`

**ColorPalette.ts**
- Generates cohesive color schemes using color theory
- Applies 60-30-10 rule (wall, furniture, accent)
- Returns specific paint recommendations by brand (Benjamin Moore, Sherwin-Williams)
- Considers existing fixed elements (flooring, countertops)
- Includes color psychology reasoning
- Usage: `bun Tools/ColorPalette.ts generate --style "warm cozy" --fixed-elements "oak floors, white trim"`

**RoomState.ts**
- StateManager-backed room inventory and tracking
- Stores per-room: dimensions, current furniture, planned changes, budget spent/remaining
- Tracks design projects and completion status
- Links to photos (before/after)
- Usage: `bun Tools/RoomState.ts add-room "living room" --dimensions "14x18" --budget 2000`
- Usage: `bun Tools/RoomState.ts list-rooms`
- Usage: `bun Tools/RoomState.ts add-item "living room" "floor lamp" --cost 150 --status purchased`

**FurnitureSearch.ts**
- Curated product DB (210 products) with inference fallback for sparse results
- 10 categories (sofa, chair, lighting, rug, desk, etc.) across 8 styles (modern, scandinavian, mid-century, boho, cozy, japandi, industrial, traditional)
- Filters by style, dimensions, material, price range, width constraints
- Multi-retailer: West Elm, CB2, IKEA, Wayfair, Target, Article, Pottery Barn, Anthropologie, etc.
- Returns structured results with style match scoring
- Usage: `bun Tools/FurnitureSearch.ts search "reading chair" --style cozy --budget 500 --width-max 30`

**AnalysisCache.ts**
- StateManager-backed cache for room analysis results
- SHA-256 image hash as cache key with 7-day TTL
- Automatic expiry cleanup on read; array-based storage
- Usage: imported by RoomAnalyzer.ts internally

**DesignerConfig.ts**
- Loads user preferences from `USER/style-preferences.yaml`, `USER/rooms.yaml`, `USER/design-goals.yaml`
- Falls back to sensible defaults when files are missing
- Returns typed `DesignerConfig` with aesthetic, colors, budget, avoidStyles, rooms, goals
- Usage: `bun Tools/DesignerConfig.ts` (CLI dumps config as JSON)

**OutputFormatter.ts**
- Formats design recommendations as JSON or Markdown
- Includes budget calculation by category (textiles, lighting, rugs) and impact tier (low, medium, high)
- Markdown output includes room assessment, priority actions table, budget breakdown, and product recommendations
- Usage: imported by workflow orchestrators

---

## Workflow Routing

| Workflow | Trigger | Action |
|----------|---------|--------|
| **RoomAnalysis** | "analyze my room", "what's wrong with" | Photo analysis via RoomAnalyzer + recommendations |
| **ColorScheme** | "color palette", "what colors" | ColorPalette generation with paint brands |
| **Cozify** | "make it cozy", "add warmth" | Cozy transformation plan with tiered budget |
| **ReadingNook** | "reading nook", "reading corner" | Design reading space with product search |
| **Lighting** | "lighting ideas", "ambient light" | Layered lighting design and product recs |
| **FurnitureLayout** | "arrange furniture", "room layout" | Optimize placement based on room dimensions |
| **ShoppingList** | "what to buy", "decor shopping" | FurnitureSearch → Shopping skill pipeline |
| **StyleMatch** | "style like", "similar to" | StyleMatcher analysis with gap recommendations |
| **MoodBoard** | "mood board", "visualize room" | Art skill generates visual concept board |
| **RoomInventory** | "what's in my room", "room status" | RoomState lookup and project tracking |

---

## Design Principles

### The Cozy Formula
1. **Layers:** Textiles, textures, and depth
2. **Lighting:** Multiple sources at different heights
3. **Nature:** Plants, natural materials, organic shapes
4. **Personal:** Items with meaning and memory
5. **Comfort:** Softness where you sit and rest

### Color Psychology
| Color | Effect | Best For |
|-------|--------|----------|
| Warm whites | Inviting, clean | Any room |
| Soft greens | Calming, natural | Bedrooms, offices |
| Terracotta | Grounding, warm | Living areas |
| Navy/deep blue | Sophisticated, cozy | Accent walls, furniture |
| Mustard yellow | Cheerful, energizing | Accents, pillows |

### Budget Tiers
| Tier | Range | Examples |
|------|-------|---------|
| Quick Wins | Under $50 | Throw blankets, candles, plants, warm bulbs |
| Medium Impact | $50-200 | Layered rugs, lamps, curtains, pillow refresh |
| Transformative | $200+ | Statement furniture, wallpaper accent, quality bedding |

---

## Execution Steps

### RoomAnalysis Workflow

1. **Request room photo** (or accept detailed description)
2. **Run RoomAnalyzer** → structured analysis from Gemini
3. **Check RoomState** for existing room data
4. **Assess:**
   - Natural light sources and quality
   - Traffic flow and functional zones
   - Focal points (or lack thereof)
   - Scale and proportion issues
   - Current color palette coherence
   - Missing texture layers
5. **Prioritize improvements** by impact-to-cost ratio
6. **Present action plan** with specific product suggestions
7. **Save analysis** to Obsidian + update RoomState

### Cozify Workflow

1. **Evaluate warmth factors** (textiles, lighting, nature, personal)
2. **Check RoomState** for current inventory and budget
3. **Generate recommendations** in three tiers:
   - Quick Wins (under $50)
   - Medium Impact ($50-200)
   - Transformative ($200+)
4. **Run FurnitureSearch** for specific product options
5. **Create shopping list** with links and alternatives
6. **Update RoomState** with planned purchases

### ReadingNook Workflow

1. **Identify potential locations** (ask or analyze photo):
   - Window seats, corners, under-stair, bay windows, alcoves
2. **Design elements needed:**
   - Seating (chair, bench, floor cushions)
   - Lighting (reading lamp, natural light)
   - Storage (books, blankets)
   - Comfort (pillows, throw)
   - Side surface (small table, shelf)
3. **Run FurnitureSearch** for each element at multiple price points
4. **Create detailed plan** with dimensions
5. **Generate mood board** via Art skill

### ColorScheme Workflow

1. **Gather context:**
   - Room purpose
   - Fixed elements (flooring, counters, large furniture)
   - Mood/feeling desired
2. **Run ColorPalette** with constraints
3. **Apply 60-30-10 rule:**
   - Walls (60%) — base color
   - Furniture (30%) — supporting color
   - Accents (10%) — pop color
4. **Provide specific paint names** by brand
5. **Suggest coordinating textiles and accents**
6. **Generate mood board** via Art skill

### Lighting Workflow

1. **Map current lighting:**
   - Overhead/ambient sources
   - Task lighting (desk, reading)
   - Accent lighting (highlights, mood)
2. **Apply layered lighting principle:**
   - Ambient: Overall room illumination (overhead, recessed)
   - Task: Specific activities (reading lamp, under-cabinet)
   - Accent: Mood and highlights (candles, LED strips, fairy lights)
3. **Recommend specific fixtures** matching room style
4. **Provide placement guidance** with heights
5. **Note bulb temperature** (2700K for cozy, 3000K for working)

### MoodBoard Workflow

1. **Gather design direction** from conversation or StyleMatcher
2. **Compile elements:** colors, textures, furniture styles, materials
3. **Generate visual** via Art skill (Gemini or Flux image generation)
4. **Present mood board** with annotations
5. **Save to Obsidian** for reference

### ShoppingList Workflow

1. **Gather items needed** from room analysis or active project
2. **Run FurnitureSearch** for each item
3. **Present options** at multiple price points per item
4. **Calculate total** against budget (from RoomState)
5. **Pipe to Shopping skill** for detailed research
6. **Track purchases** in RoomState

---

## Output Format

### Room Analysis
```markdown
## Room Analysis: [Room Name]

### Current Assessment
- **Strengths:** What's working
- **Opportunities:** What could improve
- **Style direction:** Detected aesthetic
- **Lighting:** [Assessment]
- **Color coherence:** [Assessment]

### Priority Actions
1. [Highest impact change] — Est. $XX
2. [Second priority] — Est. $XX
3. [Third priority] — Est. $XX

### Shopping List
| Item | Purpose | Budget Range | Where to Look |
|------|---------|--------------|---------------|
| Item 1 | Why needed | $XX-$XX | Retailer |
```

### Color Palette
```markdown
## Color Palette: [Room Name]

### Palette
- **Walls (60%):** [Color Name] — [Brand] [Code]
- **Furniture (30%):** [Color Name]
- **Accents (10%):** [Color Name]

### Why This Works
[Color psychology and harmony reasoning]

### Coordinating Items
- Pillows: [color/material]
- Throw: [color/material]
- Rug: [color/material]
```

---

## Style References

| Style | Key Elements | Colors |
|-------|--------------|--------|
| **Hygge** | Candles, knits, wood | Cream, grey, natural |
| **Japandi** | Minimal, natural, calm | White, beige, black |
| **Boho** | Patterns, plants, macrame | Terracotta, mustard, green |
| **Modern Cozy** | Clean lines + soft textiles | Navy, blush, brass |
| **Cottagecore** | Floral, vintage, handmade | Soft green, cream, rose |
| **Mid-Century** | Clean lines, organic curves | Teak, olive, burnt orange |
| **Scandinavian** | Light, functional, minimal | White, light wood, black |

---

## USER Override Files

| File | Purpose |
|------|---------|
| `USER/style-preferences.yaml` | Aesthetic preferences, colors, materials, budget ranges, avoid list |
| `USER/rooms.yaml` | Room dimensions, current furniture, natural light, photos |
| `USER/design-goals.yaml` | Active projects, priorities, timelines |

---

## Examples

**Example 1: Room analysis**
```
User: "Analyze my living room" (attaches photo)
-> RoomAnalyzer via Gemini: detects warm lighting, bare walls,
   no textiles on sofa, good natural light from south windows
-> Recommends: throw pillows + blanket ($80), gallery wall ($150),
   floor lamp for evening ($120)
-> Creates prioritized shopping list
-> Updates RoomState with analysis
```

**Example 2: Cozify request**
```
User: "My bedroom feels cold and sterile"
-> Checks RoomState for current inventory
-> Quick wins: warm LED bulbs ($15), candles ($25), throw blanket ($35)
-> Medium: layered rug ($150), curtains puddle length ($100)
-> Transformative: quality bedding set ($300)
-> Runs FurnitureSearch for specific products
```

**Example 3: Color help**
```
User: "I want to add color but I'm scared of it"
-> ColorPalette generates accent-only approach
-> Keep walls neutral, add color via pillows, throws, art, plants
-> Suggests: dusty sage + terracotta accent palette
-> Specific paint: Benjamin Moore "Sage Wisdom" for one accent wall
-> "You can always change pillows!"
```

**Example 4: Reading nook**
```
User: "I want a reading nook by my window"
-> Asks about window dimensions
-> Designs: window bench with storage, wall-mounted reading light,
   pile of pillows, floating shelf for current reads
-> FurnitureSearch finds options at 3 price points
-> Art skill generates mood board visualization
-> Saves plan to Obsidian
```

---

## Integration

### Uses
- **Shopping skill** — Multi-agent product research for furniture/decor
- **Art skill** — Mood board generation, room visualizations
- **Gemini MCP** — Room photo analysis (gemini-analyze-image)
- **Obsidian** — Save room plans, inspiration, before/after photos
- **CalendarAssistant** — Schedule furniture delivery, project timelines

### Feeds Into
- **RoomState** — `skills/Designer/data/room-state.json` (via StateManager)
- **Design project history** — Obsidian vault design collection
- **Shopping lists** — Shopping skill input

### MCPs Used
- **Gemini** — Room photo analysis (gemini-analyze-image), style matching
- **WebSearch** — Product discovery, design inspiration

---

## Customization

Extend via USER/ override files. SYSTEM defaults work for someone wanting to add warmth, coziness, and personality to their space on a moderate budget.

## Voice Notification

All workflow completions announce via `notifySync()` from `skills/CORE/Tools/NotificationService.ts`:
- "Room analysis complete with prioritized improvements"
- "Generated warm cozy color palette with four paint recommendations"
- "Found eight furniture results for reading chair"
- "Added floor lamp to living room inventory"
- "Style matched: top result is Hygge"
