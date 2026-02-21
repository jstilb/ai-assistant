---
name: BuildFromScreenshot
description: Generate React components by analyzing screenshots
---
# Build UI From Screenshot

Analyze screenshots to extract design patterns and generate matching React components.

## Input

- Screenshot file path
- Optional: Specific elements to focus on

## Output

- Visual analysis (colors, layout, spacing, typography)
- Structured specification
- Generated TypeScript React components
- Side-by-side comparison (original vs generated)

## Workflow

### Step 1: Analyze Screenshot with Gemini

Use Gemini MCP's `gemini-analyze-image` to extract design patterns:

```bash
# Call gemini-analyze-image
# Parameters:
# - imagePath: <screenshot-path>
# - query: "Analyze this UI screenshot and extract: 1) Color palette with hex codes, 2) Layout structure (grid, flex, sections), 3) Spacing scale (padding, margins, gaps), 4) Typography (font sizes, weights, hierarchy), 5) Component types (cards, buttons, forms, tables, etc.), 6) Visual hierarchy and grouping"
# - detectObjects: true (for bounding boxes)
# - mediaResolution: "high" (for detail)
```

**Expected Analysis Output:**
```markdown
## Color Palette
- Primary: #3B82F6 (blue-500)
- Background: #FFFFFF
- Text Primary: #1F2937 (gray-800)
- Text Secondary: #6B7280 (gray-500)
- Border: #E5E7EB (gray-200)
- Accent: #10B981 (green-500)

## Layout Structure
- Container: max-width 1280px, centered
- Grid: 3 columns on desktop, 1 on mobile
- Sections: Header (sticky), Stats Grid, Content Area, Footer

## Spacing
- Container padding: 24px (p-6)
- Card padding: 24px (p-6)
- Grid gap: 16px (gap-4)
- Section margins: 48px (my-12)

## Typography
- Headings: 24px/semibold (text-2xl), 18px/medium (text-lg)
- Body: 14px/normal (text-sm), 16px/normal (text-base)
- Color hierarchy: gray-900 → gray-700 → gray-500

## Components Identified
- 4x Stat Cards (icon, label, value, change indicator)
- Data Table (headers, rows, badges for status)
- Action Buttons (primary, secondary, icon-only)
- Navigation Bar (logo, links, user menu)

## Visual Hierarchy
- Top: Navigation (sticky header)
- Stats Grid (equal-height cards, 4 columns)
- Main Content (table with pagination)
- Footer (contact, links)
```

### Step 2: Map to shadcn Components

Translate visual analysis to shadcn/ui components:

**Mapping Table:**
| Visual Element | shadcn Component | Notes |
|---------------|------------------|-------|
| Stat Cards | Card, CardHeader, CardContent | Compose with icon |
| Data Table | Table, TableHeader, TableBody, TableRow, TableCell | Built-in |
| Status Badges | Badge | variant="default" or "secondary" |
| Action Buttons | Button | variant="default", "outline", "ghost" |
| Navigation | Custom nav element | Compose with Button |
| User Menu | DropdownMenu | shadcn primitive |

### Step 3: Generate Spec Matching Screenshot

Create specification that mirrors the screenshot:

```markdown
## Component Hierarchy
- AppLayout
  - Navigation (sticky header)
  - DashboardPage
    - StatsGrid (responsive grid)
      - StatCard × 4 (reusable)
    - DataSection
      - DataTable
    - Footer

## shadcn Components Required
card, button, table, badge, dropdown-menu

## Design Tokens (Mapped from Screenshot)
- Primary color: Use hsl(221.2 83.2% 53.3%) (closest to #3B82F6)
- Background: bg-background (white/dark mode compatible)
- Text: text-foreground, text-muted-foreground
- Spacing: Match screenshot (p-6, gap-4, my-12)

## Responsive Breakpoints
- Mobile (< 768px): Single column, stack stats
- Tablet (768-1024px): 2-column stats grid
- Desktop (>= 1024px): 4-column stats grid (matches screenshot)

## Component Details

### StatCard
- Props: icon (React.ReactNode), label (string), value (string | number), change (number)
- Layout: Icon left, label/value stacked right
- Badge for change indicator (green if positive, red if negative)

### DataTable
- Props: data (array), columns (config)
- Features: Sortable headers, status badges, row actions
- Matches screenshot pagination (10 items per page)
```

### Step 4: Present Analysis & Spec for Approval

Show user the analysis and proposed implementation:

```
I've analyzed the screenshot and identified:

**Components:**
- Navigation bar (sticky header)
- 4 stat cards in a responsive grid
- Data table with status badges
- Action buttons (primary, secondary)

**Design System:**
- Primary color: Blue (#3B82F6) → using shadcn primary token
- Spacing: 24px card padding, 16px grid gaps
- Typography: 24px headings, 14px body text

**shadcn components I'll use:**
card, button, table, badge, dropdown-menu

Does this match what you see? Any adjustments needed before I generate the code?
```

**Wait for user approval.**

### Step 5: Generate Components

Follow BuildFromText workflow steps 3-7:
1. Install shadcn components
2. Generate TypeScript React components
3. TypeScript compilation check
4. Browser preview at 3 breakpoints

**Additional for screenshots:**

### Step 6: Side-by-Side Comparison

Create comparison to show original vs generated:

```bash
# Take screenshot of generated component at same viewport as original
bun run ~/.claude/skills/Browser/Tools/Browse.ts eval "await page.setViewportSize({width: 1440, height: 900})"
bun run ~/.claude/skills/Browser/Tools/Browse.ts screenshot /tmp/component-generated.png

# Present side-by-side:
```

```
## Original vs Generated

**Original Screenshot:**
[Display original]

**Generated Component:**
[Display Playwright screenshot]

**Match Analysis:**
✅ Layout structure: Matches
✅ Color scheme: Close match (using shadcn tokens)
✅ Spacing: Matches
✅ Typography: Matches
⚠️ Icons: Using lucide-react (original may differ)
✅ Responsive behavior: Improved (works on all screen sizes)
```

### Step 7: Present Results

Show user:

1. **Visual comparison** (original vs generated)
2. **Code generated** (component files)
3. **Deviations noted** (e.g., exact fonts may differ, icons replaced)
4. **Improvements made** (responsive design, dark mode support, accessibility)

## Decision Points

**Q: Screenshot quality is poor?**
A: Ask user for higher resolution or clarify specific areas.

**Q: Screenshot shows proprietary fonts/assets?**
A: Use closest web-safe alternatives. Document in comparison:
```
⚠️ Font: Original uses "Custom Font" → Using system font stack
⚠️ Icons: Original uses custom icons → Using lucide-react
```

**Q: Screenshot has complex interactions (animations, hover states)?**
A: Extract what's visible, ask user about interactions:
- "I see a hover state in the screenshot - what should happen on interaction?"
- "Should this dropdown be triggered on click or hover?"

**Q: Screenshot shows mobile or desktop only?**
A: Generate responsive version that works at all breakpoints, note in comparison:
```
✅ Responsive: Generated version works on mobile, tablet, and desktop (original shows desktop only)
```

**Q: Multiple screenshots provided?**
A: Analyze each separately, then:
1. Identify if they're different views of same component
2. If yes: combine into single responsive component
3. If no: generate separate components

**Q: Color extraction is ambiguous?**
A: Map to closest shadcn semantic token. If user wants exact color:
```typescript
// Add to globals.css
:root {
  --custom-blue: 221.2 83.2% 53.3%; /* Exact match to #3B82F6 */
}

// Use in component
className="bg-[hsl(var(--custom-blue))]"
```

## Failure Recovery

### If Gemini analysis is incomplete:
- Re-run with more specific query focusing on missing details
- Ask user to clarify ambiguous areas

### If screenshot is too complex:
- Break into sections: "Let me analyze the header first, then the main content"
- Generate components incrementally

### If exact visual match is impossible:
- Document deviations clearly
- Explain why (e.g., proprietary assets, complex animations)
- Offer alternatives

## Integration Points

- **Follows:** BuildFromText workflow (steps 3-7)
- **Uses:** Gemini MCP (`gemini-analyze-image`), Browser skill Browse.ts CLI (comparison screenshots)
- **Next:** Iterate workflow for refinements

---

**Last Updated:** 2026-02-13
