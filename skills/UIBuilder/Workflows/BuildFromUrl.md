---
name: BuildFromUrl
description: Generate React components inspired by live URL designs
---
# Build UI From URL

Analyze live websites to extract design patterns and generate inspired React components.

## Input

- URL to analyze
- Optional: Specific sections to focus on

## Output

- Design pattern analysis
- Structured specification
- Generated components inspired by the URL

## Workflow

### Step 1: Analyze URL with Gemini

```bash
# Call gemini-analyze-url
# Parameters:
# - urls: [url]
# - question: "Analyze this website's UI design and extract: 1) Color palette and design system, 2) Layout patterns and grid structure, 3) Component types used (navigation, cards, forms, etc.), 4) Typography scale and hierarchy, 5) Spacing and padding patterns, 6) Responsive design approach, 7) Notable UI patterns or interactions"
# - useGoogleSearch: false
```

### Step 2: Extract Key Patterns

From Gemini's analysis, identify:
- **Color System:** Primary, secondary, accent colors
- **Layout:** Grid systems, container widths, breakpoints
- **Components:** Navigation patterns, card designs, form styles
- **Typography:** Font families, sizes, weights
- **Spacing:** Consistent padding/margin scales
- **Interactions:** Hover states, transitions, animations

### Step 3: Adapt (Not Clone)

**IMPORTANT:** Generate components *inspired by* the URL, not pixel-perfect clones.

**Adaptations:**
- Use shadcn/ui components (not exact replicas)
- Apply similar color schemes using shadcn tokens
- Adopt layout patterns (grid, spacing, hierarchy)
- Maintain similar visual weight and balance

**Example:**
```
URL shows: Custom dropdown with rounded corners, blue accent, shadow
Generated: shadcn DropdownMenu with similar styling via className
```

### Step 4: Generate Spec

Create specification documenting inspiration:

```markdown
## Inspiration Source
URL: https://example.com
Section: Homepage hero and feature cards

## Adapted Patterns
- Hero layout: Large heading, subtext, CTA buttons (similar to URL)
- Card grid: 3-column responsive grid (matches URL)
- Color scheme: Blue primary, gray neutrals (inspired by URL's palette)
- Typography: Large headings, readable body (similar hierarchy to URL)

## shadcn Components
card, button, input, badge

## Implementation Notes
- URL uses custom components → Using shadcn equivalents
- URL has complex animations → Simplified to CSS transitions
- URL's exact fonts → Using system font stack
```

### Step 5: Follow BuildFromText Workflow

Complete steps 3-7 from BuildFromText.md:
1. Install shadcn components
2. Generate TypeScript React components
3. TypeScript compilation check
4. Browser preview at 3 breakpoints
5. Present results

### Step 6: Attribution & Comparison

Document inspiration clearly:

```
## Design Inspiration
Source: [URL]

## What We Adapted
✅ Layout structure (3-column grid, centered container)
✅ Color palette (blue primary, gray text)
✅ Typography hierarchy (large headings, readable body)
✅ Component patterns (stat cards with icons)

## What We Changed
⚠️ Using shadcn/ui components (not custom components)
⚠️ Simplified animations (CSS transitions only)
⚠️ Enhanced accessibility (ARIA attributes, keyboard nav)
⚠️ Dark mode support (automatic via shadcn tokens)
```

## Decision Points

**Q: URL requires authentication?**
A: Ask user to provide screenshot instead, use BuildFromScreenshot workflow.

**Q: URL has complex, proprietary interactions?**
A: Simplify to standard web patterns. Note in spec:
```
Original has complex parallax scrolling → Using simple fade-in on scroll
```

**Q: URL uses non-web technologies (Flash, Canvas animations)?**
A: Explain limitations, propose modern alternatives:
```
Original uses Canvas for animations → Proposing CSS animations or Framer Motion
```

**Q: URL's design system is unclear?**
A: Extract what's visible, fill gaps with shadcn defaults. Document assumptions.

## Failure Recovery

### If gemini-analyze-url fails:
- Take screenshot of URL manually
- Use BuildFromScreenshot workflow instead

### If URL is too complex:
- Focus on specific sections: "Let me analyze the header navigation first"
- Generate components incrementally

## Legal/Ethical Notes

**CRITICAL:** We generate *inspired by* designs, not clones.

- DO: Extract patterns, color schemes, layout approaches
- DO: Adapt to shadcn/ui components
- DO: Add improvements (accessibility, dark mode, responsiveness)
- DON'T: Copy exact implementations
- DON'T: Use proprietary assets (logos, images, fonts)
- DON'T: Replicate unique, trademarked designs

If user asks to "exactly clone" a site, explain:
```
I can create components inspired by [URL]'s design patterns, using similar:
- Layout structure
- Color palette
- Typography hierarchy
- Component compositions

But I'll implement using shadcn/ui components with improvements for:
- Accessibility (WCAG 2.1 AA)
- Dark mode support
- Responsive design
- TypeScript type safety

This gives you a professional, legally safe implementation.
```

## Integration Points

- **Uses:** Gemini MCP (`gemini-analyze-url`), follows BuildFromText workflow
- **Alternative:** If URL inaccessible, use BuildFromScreenshot
- **Next:** Iterate workflow for refinements

---

**Last Updated:** 2026-02-13
