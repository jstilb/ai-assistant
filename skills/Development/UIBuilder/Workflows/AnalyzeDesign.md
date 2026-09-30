---
name: AnalyzeDesign
description: Visual analysis of designs without code generation
---
# Analyze Design

Extract design patterns from screenshots or URLs without generating code.

## Input

- Screenshot file path OR URL
- Optional: Focus areas (colors, layout, typography, etc.)

## Output

- Comprehensive design analysis
- Design tokens extracted
- Component inventory
- NO code generation

## Workflow

### Step 1: Analyze Source

**For Screenshot:**
```bash
# Call gemini-analyze-image
# Parameters:
# - imagePath: <screenshot-path>
# - query: "Provide a comprehensive design analysis including: 1) Complete color palette with hex codes, 2) Layout structure and grid system, 3) Spacing scale (all padding, margin, gap values), 4) Typography (font families, sizes, weights, line heights), 5) Border radius values, 6) Shadow definitions, 7) Component inventory, 8) Visual hierarchy analysis"
# - detectObjects: true
# - mediaResolution: "high"
```

**For URL:**
```bash
# Call gemini-analyze-url
# Parameters:
# - urls: [url]
# - question: "Provide a comprehensive design system analysis of this website..."
```

### Step 2: Structure Analysis Results

Organize Gemini's output into structured format:

```markdown
# Design Analysis

## Color System

### Primary Palette
- Primary: #3B82F6 (hsl(217, 91%, 60%))
- Primary Hover: #2563EB (hsl(221, 83%, 53%))
- Primary Text: #FFFFFF

### Neutral Palette
- Background: #FFFFFF
- Foreground: #18181B (gray-900)
- Muted Background: #F4F4F5 (gray-100)
- Muted Foreground: #71717A (gray-500)
- Border: #E4E4E7 (gray-200)

### Semantic Colors
- Success: #10B981 (green-500)
- Warning: #F59E0B (amber-500)
- Error: #EF4444 (red-500)
- Info: #3B82F6 (blue-500)

## Typography

### Font Families
- Headings: Inter, system-ui, sans-serif
- Body: Inter, system-ui, sans-serif
- Mono: 'Fira Code', monospace

### Type Scale
| Element | Size | Weight | Line Height |
|---------|------|--------|-------------|
| H1 | 36px (2.25rem) | 700 | 1.2 |
| H2 | 30px (1.875rem) | 600 | 1.3 |
| H3 | 24px (1.5rem) | 600 | 1.4 |
| Body Large | 18px (1.125rem) | 400 | 1.6 |
| Body | 16px (1rem) | 400 | 1.5 |
| Body Small | 14px (0.875rem) | 400 | 1.5 |
| Caption | 12px (0.75rem) | 400 | 1.4 |

## Spacing Scale

- 4px (0.25rem) - tight spacing
- 8px (0.5rem) - compact spacing
- 12px (0.75rem) - cozy spacing
- 16px (1rem) - default spacing
- 24px (1.5rem) - comfortable spacing
- 32px (2rem) - relaxed spacing
- 48px (3rem) - loose spacing
- 64px (4rem) - section spacing

## Layout

### Grid System
- Columns: 12-column grid
- Gutter: 24px (1.5rem)
- Max Width: 1280px (80rem)
- Breakpoints:
  - Mobile: < 640px
  - Tablet: 640px - 1024px
  - Desktop: > 1024px

### Container Padding
- Mobile: 16px
- Tablet: 24px
- Desktop: 32px

## Border Radius

- Small: 4px (0.25rem) - badges, small buttons
- Default: 8px (0.5rem) - buttons, inputs
- Medium: 12px (0.75rem) - cards, modals
- Large: 16px (1rem) - large cards, containers

## Shadows

```css
--shadow-sm: 0 1px 2px 0 rgb(0 0 0 / 0.05);
--shadow: 0 1px 3px 0 rgb(0 0 0 / 0.1);
--shadow-md: 0 4px 6px -1px rgb(0 0 0 / 0.1);
--shadow-lg: 0 10px 15px -3px rgb(0 0 0 / 0.1);
--shadow-xl: 0 20px 25px -5px rgb(0 0 0 / 0.1);
```

## Component Inventory

### Navigation
- Type: Sticky header
- Height: 64px
- Elements: Logo (left), Nav links (center), CTA button (right)
- Background: White with bottom border

### Cards
- Padding: 24px
- Border: 1px solid #E4E4E7
- Border Radius: 12px
- Shadow: shadow-sm on hover

### Buttons
**Primary:**
- Background: #3B82F6
- Text: White
- Padding: 12px 24px
- Border Radius: 8px
- Hover: #2563EB

**Secondary:**
- Background: Transparent
- Text: #3B82F6
- Border: 1px solid #3B82F6
- Padding: 12px 24px

### Forms
- Input Height: 44px
- Input Padding: 12px 16px
- Input Border: 1px solid #E4E4E7
- Focus Border: #3B82F6
- Border Radius: 8px

### Tables
- Row Height: 48px
- Header Background: #F4F4F5
- Border: 1px solid #E4E4E7
- Hover: #FAFAFA

## Visual Hierarchy

### Primary Hierarchy
1. Large hero heading (H1, 36px, bold)
2. Section headings (H2, 30px, semibold)
3. Body text (16px, regular)
4. Caption text (14px, muted)

### Color Hierarchy
1. High Contrast: #18181B on #FFFFFF (text on background)
2. Medium Contrast: #71717A (muted text)
3. Low Contrast: #E4E4E7 (borders)

### Spacing Hierarchy
1. Between sections: 64px
2. Between components: 32px
3. Within components: 16px
4. Between elements: 8px

## Responsive Behavior

### Mobile (< 640px)
- Single column layouts
- Stacked navigation (hamburger menu)
- Reduced spacing (16px → 12px)
- Smaller typography (H1: 28px instead of 36px)

### Tablet (640-1024px)
- 2-column grids
- Horizontal navigation
- Standard spacing
- Standard typography

### Desktop (> 1024px)
- 3-4 column grids
- Full navigation
- Generous spacing
- Full typography scale

## Notable Patterns

- **Hover States:** Subtle shadow increase + slight color darkening
- **Focus States:** 2px blue ring with offset
- **Transitions:** 150ms ease for all interactions
- **Loading States:** Skeleton screens with shimmer animation
- **Empty States:** Centered icon + text + CTA button
```

### Step 3: Present Analysis

Provide the complete analysis without offering to generate code:

```
I've analyzed the design. Here's what I found:

[Complete analysis above]

This design system uses:
- A blue-based color palette (#3B82F6 primary)
- Inter font family throughout
- 8px base spacing scale
- Consistent 8px border radius
- Shadow system for depth
- 12-column responsive grid

Would you like me to:
1. Generate components using this design system?
2. Export this as a design system config file?
3. Analyze a specific aspect in more detail?
```

## Export Options

### Export as shadcn Theme

```typescript
// tailwind.config.ts
export default {
  theme: {
    extend: {
      colors: {
        primary: {
          DEFAULT: '#3B82F6',
          foreground: '#FFFFFF',
        },
        // ... extracted colors
      },
      fontSize: {
        // ... extracted type scale
      },
      spacing: {
        // ... extracted spacing scale
      },
      borderRadius: {
        // ... extracted radius values
      },
    },
  },
}
```

### Export as CSS Variables

```css
:root {
  --color-primary: 217 91% 60%;
  --color-foreground: 240 10% 10%;
  /* ... all extracted tokens */
}
```

### Export as Design Tokens JSON

```json
{
  "color": {
    "primary": {
      "value": "#3B82F6",
      "type": "color"
    }
  },
  "fontSize": {
    "h1": {
      "value": "36px",
      "type": "dimension"
    }
  }
}
```

## Decision Points

**Q: User wants specific aspect only?**
A: Focus analysis on requested area (e.g., "just colors" or "just typography").

**Q: Analysis is too detailed?**
A: Provide summary, offer full details on request.

**Q: User wants to generate code after analysis?**
A: Transition to BuildFromScreenshot or BuildFromText workflow.

---

**Last Updated:** 2026-02-13
