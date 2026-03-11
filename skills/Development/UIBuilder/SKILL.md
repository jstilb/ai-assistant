---
name: UIBuilder
description: Zero-cost AI UI development workflow using Claude Code, Gemini MCP, Browse.ts CLI, and shadcn/ui. USE WHEN build ui, create component, ui builder, generate ui, design component, mockup, prototype ui, shadcn component, create page, create layout, build interface, ui workflow, recreate ui, clone ui, screenshot to code.
---
# UIBuilder - AI UI Development Workflow

Transforms UI requirements into production-quality React components using Claude Code + Gemini MCP + Browser skill (Browse.ts CLI) + shadcn/ui CLI.

## Overview

UIBuilder is a workflow-based skill that combines multiple AI and automation tools to create professional React components from text descriptions, screenshots, or URLs. It emphasizes spec-first development, browser verification, and iterative refinement.

## Voice Notification

Use `notifySync()` from `lib/core/NotificationService.ts`

## Commands

| Command | Description |
|---------|-------------|
| "build ui from [description]" | Generate components from text description |
| "recreate this UI [screenshot]" | Generate components from screenshot |
| "clone [URL] design" | Generate components inspired by URL |
| "iterate on [component]" | Make single-change refinements |
| "preview [component]" | Browser preview at multiple breakpoints |
| "analyze [screenshot/URL]" | Visual analysis without code generation |
| "scaffold new ui project" | Set up new Next.js + shadcn project |

## Workflow Routing

| Trigger | Workflow |
|---------|----------|
| "build ui", "create component", "generate ui from text" | `Workflows/BuildFromText.md` |
| "screenshot to code", "recreate ui", "clone screenshot" | `Workflows/BuildFromScreenshot.md` |
| "clone design", "build from url", "recreate [url]" | `Workflows/BuildFromUrl.md` |
| "iterate", "change", "update component" | `Workflows/Iterate.md` |
| "preview", "show component", "verify ui" | `Workflows/Preview.md` |
| "install component", "add shadcn component" | `Workflows/InstallComponents.md` |
| "analyze design", "extract design tokens" | `Workflows/AnalyzeDesign.md` |
| "scaffold project", "new ui project", "setup shadcn" | `Workflows/ScaffoldProject.md` |

## Tools

### Gemini MCP Tools
- **gemini-analyze-image** - Extract design patterns from screenshots
- **gemini-analyze-url** - Extract design patterns from live URLs
- **gemini-analyze-code** - Analyze generated component code
- **gemini-brainstorm** - Brainstorm component architecture
- **gemini-query** - Generate component specifications

### Browser Skill (Browse.ts CLI + Stagehand.ts)

**Browse.ts** - Deterministic, $0 cost:
- `bun run Browse.ts <url>` - Navigate with full diagnostics (screenshot + console + network)
- `bun run Browse.ts screenshot [path]` - Capture component at breakpoints
- `bun run Browse.ts eval "..."` - Execute JavaScript for viewport resizing
- `bun run Browse.ts snapshot` - Save accessibility tree as YAML with element refs
- `bun run Browse.ts errors` - Check console errors

**Stagehand.ts** - AI-driven, ~$0.001/action:
- `bun run Stagehand.ts act "<description>"` - Click/interact with dynamic React components
- `bun run Stagehand.ts observe "<question>"` - Analyze component rendering and state
- `bun run Stagehand.ts extract "<description>"` - Extract component data from varying layouts

**Tool Routing for UIBuilder (from routing-rules.yaml):**
| Task | Tool |
|------|------|
| Screenshot at breakpoints | `Browse.ts screenshot` |
| Navigate to local dev server | `Browse.ts http://localhost:3000` |
| Check console errors after change | `Browse.ts errors` |
| Interact with shadcn dropdown/select | `Stagehand.ts act "Select..."` (React Select requires Stagehand) |
| Verify component text rendering | `Browse.ts eval "document.querySelector(...).textContent"` |
| Test dynamic component states | `Stagehand.ts act "Click to open/toggle..."` |

Full routing rules: `~/.claude/skills/Development/Browser/routing-rules.yaml`

### shadcn CLI
- `npx shadcn@latest init` - Initialize shadcn in project
- `npx shadcn@latest add [component]` - Install shadcn components

### Browser Skill
- `Browse.ts` integration for debug-first verification

## Key Principles

### 1. Spec First
ALWAYS generate and present a structured specification BEFORE writing code:
- Component hierarchy
- Design tokens (colors, spacing, typography)
- State management requirements
- Responsive breakpoints
- Accessibility requirements

User must approve the spec before code generation.

### 2. One Change at a Time
During iteration, make EXACTLY ONE change per cycle:
- User provides feedback
- Pick highest priority change
- Apply only that change
- Preview in browser
- Present for review
- Repeat

Never batch multiple changes. Isolate each variable.

### 3. Two-Brain Pattern
Use Gemini MCP for visual analysis and design extraction, Claude Code for implementation:
- Gemini: "What design patterns are in this screenshot?"
- Claude: Implement the extracted patterns with shadcn/ui

Leverage each AI's strengths.

### 4. Browser Verification Required
NEVER claim a component is "ready" without browser verification:
- Take screenshots at 3 breakpoints (375px, 768px, 1440px)
- Check console for errors
- Verify visual correctness
- Only then report as complete

### 5. Component-Driven
Build using shadcn/ui primitives as building blocks:
- Compose primitives, don't rebuild them
- Install required components via CLI
- Follow shadcn composition patterns
- Reference `ComponentPatterns.md` for common compositions

### 6. Security by Default
Generated components follow strict TypeScript:
- NO `any` types
- NO inline styles
- NO hardcoded colors
- NO unwarranted type assertions
- Always accept `className` prop
- Mobile-first responsive design

## Design System Defaults

**Framework:** Next.js 15+ with App Router
**Styling:** Tailwind CSS + shadcn/ui design system
**TypeScript:** Strict mode, no escape hatches
**Component Structure:**
```typescript
"use client" // Only if hooks/events needed

import { cn } from "@/lib/utils"
import { Card } from "@/components/ui/card"

interface ComponentProps {
  className?: string
  // ... other props
}

export function Component({ className, ...props }: ComponentProps) {
  return (
    <Card className={cn("w-full", className)}>
      {/* ... */}
    </Card>
  )
}
```

**See:** `DesignSystem.md` for full token system

## Examples

**Example 1: Build dashboard from text**
```
User: "Build a dashboard with user stats, recent activity table, and quick actions"

1. Load Workflows/BuildFromText.md
2. Use gemini-query to generate structured spec
3. Present spec: components needed, layout, shadcn primitives
4. User approves spec
5. Install via: npx shadcn@latest add card table badge button
6. Generate TypeScript React components
7. Run tsc --noEmit to verify
8. Preview via Playwright at 3 breakpoints
9. Present screenshots for review
```

**Example 2: Clone a screenshot**
```
User: "Recreate this login page [screenshot path]"

1. Load Workflows/BuildFromScreenshot.md
2. Use gemini-analyze-image to extract: colors, spacing, typography, layout
3. Generate spec mapping visual elements to shadcn primitives
4. Follow same generation flow as BuildFromText
5. Side-by-side comparison: original screenshot vs generated component
```

**Example 3: Iterate on feedback**
```
User: "Make the header sticky and increase spacing"

1. Load Workflows/Iterate.md
2. Two changes requested - pick highest priority: sticky header
3. Apply ONLY sticky header change
4. Re-render via Playwright
5. Present screenshot
6. User reviews
7. Now apply spacing change (second iteration)
8. Re-render and present
```

**Example 4: Analyze design without generating**
```
User: "What design patterns are used in this screenshot?"

1. Load Workflows/AnalyzeDesign.md
2. Use gemini-analyze-image
3. Extract and present:
   - Color palette (hex codes)
   - Layout grid (columns, gaps)
   - Component types (cards, buttons, forms)
   - Typography (font sizes, weights)
   - Spacing scale
4. No code generation
```

## Customization

**Design System Override:**
Edit `DesignSystem.md` to customize default tokens, colors, spacing scale.

**Component Patterns:**
Add custom composition patterns to `ComponentPatterns.md` for project-specific components.

**Accessibility Standards:**
Modify `AccessibilityGuide.md` to enforce stricter WCAG requirements if needed.

## Integration

### Uses
- **Gemini MCP** - Visual analysis and design extraction
- **Browser skill (Browse.ts CLI)** - Browser automation and verification
- **shadcn/ui CLI** - Component installation

### Feeds Into
- **Designer agent** - Professional UX review after generation
- **QA agent** - Accessibility and responsive testing
- **Development skill** - Component integration into larger apps

### MCPs Used
- **gemini** - All gemini-* tools for AI analysis

---

**Last Updated:** 2026-02-13
