---
name: BuildFromText
description: Generate production React components from text descriptions
---
# Build UI From Text Description

Transform natural language UI requirements into production-quality React components.

## Input

Text description of desired UI/component (e.g., "Build a dashboard with user stats, recent activity table, and quick actions").

## Output

- Structured specification (for approval)
- Generated TypeScript React components
- Browser screenshots at 3 breakpoints
- Ready for iteration

## Workflow

### Step 1: Generate Structured Specification

Use Gemini MCP to generate a comprehensive spec:

```bash
# Call gemini-query with the user's description
```

**Spec must include:**
1. **Component Hierarchy** - What components are needed, how they nest
2. **shadcn Components Required** - Which primitives to install (button, card, table, etc.)
3. **Design Tokens** - Colors (semantic only), spacing, typography
4. **State Management** - What state is needed, where it lives
5. **Responsive Breakpoints** - Mobile, tablet, desktop variations
6. **Accessibility Requirements** - ARIA attributes, keyboard nav, focus management
7. **Props/Interfaces** - TypeScript interfaces for each component

**Example Spec:**
```markdown
## Component Hierarchy
- DashboardLayout (container)
  - StatsGrid (4 stat cards)
    - StatCard (reusable)
  - RecentActivitySection
    - ActivityTable (shadcn table)
  - QuickActionsCard
    - ActionButton (shadcn button)

## shadcn Components
- card, button, table, badge

## Design Tokens
- Background: bg-background
- Cards: bg-card with border-border
- Text: text-foreground, text-muted-foreground
- Spacing: gap-4 for grids, p-6 for cards

## State
- stats: Array<{label: string, value: number}>
- activities: Array<{id, user, action, timestamp}>
- No local state needed (presentational)

## Responsive
- Mobile (< 640px): Single column, stack all sections
- Tablet (640-1024px): 2-column stats grid
- Desktop (>= 1024px): 4-column stats grid

## Accessibility
- Semantic HTML (<main>, <section>, headings)
- Table with caption for screen readers
- All buttons have visible focus indicators

## TypeScript Interfaces
interface DashboardProps {
  stats: Stat[]
  activities: Activity[]
  className?: string
}

interface Stat {
  label: string
  value: number
  change?: number
}

interface Activity {
  id: string
  user: string
  action: string
  timestamp: Date
}
```

### Step 2: Present Spec for Approval

Present the generated spec to the user:

```
I've generated a specification for the [component name]:

[Display the full spec]

This will use the following shadcn components:
- [list components]

Does this match your vision? Any changes before I generate the code?
```

**Wait for user approval. DO NOT proceed to code generation without approval.**

### Step 3: Install Required shadcn Components

Once approved, install shadcn components:

```bash
# List components to install
COMPONENTS="card button table badge"

# Install via shadcn CLI
npx shadcn@latest add $COMPONENTS
```

Verify installation:
```bash
# Check if components exist
ls -la components/ui/
```

### Step 4: Generate TypeScript React Components

Generate components following the spec, adhering to code standards:

**For each component:**

1. **File Header**
```typescript
"use client" // ONLY if using hooks, events, or browser APIs
```

2. **Imports**
```typescript
import { cn } from "@/lib/utils"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
// ... other shadcn imports
```

3. **TypeScript Interface**
```typescript
interface ComponentProps {
  // Explicit types, NO any
  className?: string // REQUIRED
}
```

4. **Component Implementation**
```typescript
export function Component({ className, ...props }: ComponentProps) {
  return (
    <div className={cn("base-classes", className)}>
      {/* ... */}
    </div>
  )
}
```

**Code Quality Checklist:**
- [ ] NO `any` types
- [ ] NO inline styles
- [ ] NO hardcoded colors (use semantic tokens)
- [ ] `className` prop on all components
- [ ] Mobile-first responsive design
- [ ] Proper ARIA attributes (see AccessibilityGuide.md)
- [ ] Semantic HTML elements
- [ ] cn() for class composition

### Step 5: TypeScript Compilation Check

Verify code compiles without errors:

```bash
cd [project-directory]
tsc --noEmit
```

If errors exist:
1. Fix errors
2. Re-run tsc
3. Repeat until clean

**DO NOT proceed if compilation fails.**

### Step 6: Browser Preview (MANDATORY)

Use Browse.ts CLI to preview at 3 breakpoints:

**For each breakpoint:**
1. **Mobile (375px):**
   ```bash
   bun run ~/.claude/skills/Browser/Tools/Browse.ts eval "await page.setViewportSize({width: 375, height: 812})"
   bun run ~/.claude/skills/Browser/Tools/Browse.ts http://localhost:3000/component
   # Saves screenshot + reports console errors + network stats
   ```

2. **Tablet (768px):**
   ```bash
   bun run ~/.claude/skills/Browser/Tools/Browse.ts eval "await page.setViewportSize({width: 768, height: 1024})"
   bun run ~/.claude/skills/Browser/Tools/Browse.ts http://localhost:3000/component
   ```

3. **Desktop (1440px):**
   ```bash
   bun run ~/.claude/skills/Browser/Tools/Browse.ts eval "await page.setViewportSize({width: 1440, height: 900})"
   bun run ~/.claude/skills/Browser/Tools/Browse.ts http://localhost:3000/component
   ```

**Check for issues:**
- Console errors (JavaScript errors)
- Failed network requests (404s, 500s)
- Visual glitches (overlapping text, broken layouts)
- Missing content

### Step 7: Present Results

Show the user:

1. **Code generated:**
```
Created components:
- /components/custom/Dashboard.tsx
- /components/custom/StatCard.tsx
- /components/custom/ActivityTable.tsx
```

2. **Screenshots at all 3 breakpoints:**
```
Mobile (375px): [display screenshot]
Tablet (768px): [display screenshot]
Desktop (1440px): [display screenshot]
```

3. **Diagnostic Summary:**
```
✅ TypeScript compilation: Clean
✅ Console errors: None
✅ Network requests: All successful
✅ Responsive layout: Working at all breakpoints
```

4. **Next Steps:**
```
The component is ready for review. Would you like to:
- Make changes? (Use Iterate workflow)
- Add more components?
- Integrate into your app?
```

## Failure Recovery

### If spec generation fails:
- Retry with more specific prompt
- Break complex requests into smaller components
- Ask user for clarification

### If shadcn install fails:
- Check if project has shadcn initialized: `ls components/ui`
- If not initialized: Direct user to ScaffoldProject workflow
- Verify component name is valid (check shadcn docs)

### If compilation fails:
- Review TypeScript errors
- Fix type issues
- DO NOT use `any` as escape hatch
- Ask user for guidance if complex types needed

### If browser preview fails:
- Verify dev server is running
- Check component route exists
- Verify component exports correctly
- Use Browser skill's Browse.ts for debugging

## Decision Points

**Q: User description is vague?**
A: Ask clarifying questions before generating spec:
- "Should this be a single component or multiple components?"
- "What data will this display?"
- "Any specific shadcn components you want to use?"

**Q: Spec requires components not in shadcn?**
A: Either:
1. Use existing shadcn components creatively (compose primitives)
2. Ask user: "Would you like me to build a custom [component] or use [shadcn alternative]?"

**Q: User wants changes after seeing spec?**
A: Regenerate spec with changes, present again. Loop until approved.

**Q: Browser preview shows issues?**
A: Report issues to user with screenshots, ask if they want fixes before proceeding.

## Integration Points

- **Next Workflow:** `Iterate.md` - Single-change refinements
- **Uses:** Gemini MCP (spec generation), Browser skill Browse.ts CLI (preview), shadcn CLI (components)
- **Feeds Into:** Designer agent (UX review), QA agent (accessibility testing)

---

**Last Updated:** 2026-02-13
