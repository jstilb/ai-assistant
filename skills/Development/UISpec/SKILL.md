---
name: UISpec
description: Generate build-ready UI specifications — lo-fi wireframes (annotated HTML+Tailwind), component inventories (shadcn refs), design tokens by name, responsive behavior, and WCAG 2.2 AA accessibility specs — organized per screen from a UX Spec's Screen Inventory. USE WHEN ui spec, uispec, wireframe, component spec, design tokens, accessibility spec, generate ui spec, ui realization, ui wireframe, screen wireframe, component inventory, token spec, a11y spec, ui for feature.
---
# UISpec — UI Specification Generator

Produces a build-ready UI Spec from a UX Spec's Screen Inventory. For every screen and every state in the Screen×State Matrix, the UIDesigner produces: an annotated lo-fi wireframe (HTML+Tailwind skeleton), a component inventory (atomic; shadcn refs; custom flagged), design tokens by name (never raw hex/px), and WCAG 2.2 AA accessibility notes. All output is co-located into the same per-screen sections as the UX content, keyed to screen `id`s from the Screen Inventory.

## Voice Notification

Use `notifySync()` from `lib/core/NotificationService.ts`

## Workflow Routing

| Trigger | Workflow |
|---------|----------|
| "generate ui spec", "ui spec for [feature]", "create ui spec", "wireframe [screen]" | `Workflows/GenerateUISpec.md` |
| "component inventory", "what components", "shadcn refs" | `Workflows/GenerateUISpec.md` — component-only mode |
| "design tokens", "token spec", "what tokens" | `Workflows/GenerateUISpec.md` — tokens-only mode |
| "accessibility spec", "a11y for [screen]", "wcag check" | `Workflows/GenerateUISpec.md` — a11y-only mode |

## Key Artifacts

| Artifact | Description |
|----------|-------------|
| **Wireframe** | Lo-fi annotated HTML+Tailwind skeleton per screen×state; placeholder labels like `[Hero Headline]`; comments naming components (`<!-- <Button variant="primary"> -->`); NO lorem ipsum |
| **Component Inventory** | Atomic hierarchy (atom/molecule/organism); shadcn component refs; custom components flagged |
| **Design Tokens** | Color, spacing, type, radius, shadow — always by name (e.g. `bg-primary`, `text-muted-foreground`), never raw hex/px |
| **Accessibility** | WCAG 2.2 AA: focus order, ARIA roles, contrast 4.5:1 text / 3:1 UI, touch target ≥24×24, focus-not-obscured, drag alternatives |

## Effort Tier Behavior

| Tier | Scope | Depth |
|------|-------|-------|
| **Small** | Only screens touched by the change | Lean — single-state wireframe (default only) + component list + a11y essentials |
| **Medium** | All screens for the feature | Standard — wireframes for all screens × all declared states + component specs + responsive table |
| **Large** | All screens + full token audit | Full depth — all states + custom component specs + WCAG 2.2 AA per component + complete responsive breakdown |

Both UX and UI skills always run on browser/native surfaces. Effort tier changes scope and depth, never whether the UISpec runs.

## References

All reference docs are UISpec-owned (standalone copies, maintained independently of UIBuilder):

- `References/DesignTokens.md` — Token system (color/space/type/radius/shadow) with tokens-by-name rules
- `References/AccessibilityGuide.md` — WCAG 2.2 AA requirements (not 2.1)
- `References/ComponentPatterns.md` — shadcn/atomic component patterns
- `References/WireframeFormat.md` — Annotated HTML+Tailwind skeleton convention + per-state section structure

## Templates

- `Templates/per-screen-ui-section.md` — Co-located UI block template (wireframe + component inventory + tokens + a11y), one wireframe per state
- `Templates/example-ui-spec.md` — Complete example UI spec realizing the UXSpec example (every screen × every state)

## Integration

### Consumes
- **UXSpec output** — reads Screen Inventory via `skills/Agents/SpecSheet/Tools/ScreenInventory.ts` (`parseScreenInventory`, `listScreens`, `statesFor`)
- **Screen Inventory contract** — screens and states are fixed by the UX Spec; the UIDesigner renders, it does not invent screens

### Feeds Into
- **SpecPipelineRunner** (`skills/Automation/QueueRouter/Tools/SpecPipelineRunner.ts:662-696`) — the live consumer; bundles this skill's `SKILL.md`, `Workflows/GenerateUISpec.md`, and all 4 `References/*.md` into the UIDesigner agent's prompt to realize the co-located `## UX/UI Specification` section on queue spec items
- **SpecValidator** — Slice 5 coverage checks: every screen×state must have a `### State: <state>` wireframe subsection (machine-detectable)
- **Designer agent** — runs a review pass over the generated UI Spec on Medium+ effort

Note: UIBuilder does **not** consume this output — it runs its own independent Gemini-driven spec loop (`grep -rn "UISpec" skills/Development/UIBuilder/` → 0 matches) and has no awareness of the co-located spec format. There is no wired path from the finished UI Spec into generated code today.

### Depends On
- `skills/Agents/SpecSheet/Tools/ScreenInventory.ts` — shared parser
- `skills/Agents/SpecSheet/CONTEXT.md` — canonical vocabulary

### Agent
Run by the **UIDesigner** agent (`skills/Agents/UIDesignerContext.md`). The **Designer** agent reviews the output as a separate pass on Medium+ effort.
