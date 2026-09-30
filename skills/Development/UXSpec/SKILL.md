---
name: UXSpec
description: Generate tech-agnostic UX specifications — user flows, screen inventory, screen×state matrix, microcopy, and Given/When/Then acceptance criteria organized per screen. USE WHEN ux spec, uxspec, user experience spec, user flows, screen inventory, screen state matrix, microcopy, acceptance criteria, ux document, generate ux, ux for feature, user flow diagram, information architecture.
---
# UXSpec — UX Specification Generator

Produces a development-ready UX Spec for a browser or native surface: per-screen user flows (Mermaid), a machine-checkable Screen Inventory, a Screen×State Matrix, microcopy, and Given/When/Then acceptance criteria. Effort tier controls scope and depth — both UX and UI skills always run on any UI surface (per ADR 0006).

## Overview

A UX Spec is the tech-agnostic experience specification — the "how it works / why / where." It hands a **Screen Inventory** and **Screen×State Matrix** to the UISpec skill, which renders the visual spec. These two specs are organized **per screen** so a downstream AI builder (v0, Cursor, AutonomousWork) can consume each screen section in isolation.

## Voice Notification

Use `notifySync()` from `lib/core/NotificationService.ts`

## Workflow Routing

| Trigger | Workflow |
|---------|----------|
| "generate ux spec", "ux spec for [feature]", "create ux spec" | `Workflows/GenerateUXSpec.md` |
| "user flows for [feature]", "mermaid flow", "flow diagram" | `Workflows/GenerateUXSpec.md` — flow-only mode |
| "screen inventory", "list screens", "what screens" | `Workflows/GenerateUXSpec.md` — inventory-only mode |
| "acceptance criteria", "given when then", "ux acceptance" | `Workflows/GenerateUXSpec.md` — criteria-only mode |

## Key Artifacts

| Artifact | Description |
|----------|-------------|
| **User Flow** | Mermaid `flowchart TD` per task path, including error + branch paths |
| **Screen Inventory** | Machine-checkable YAML block (parsed by `SpecSheet/Tools/ScreenInventory.ts`) |
| **Screen×State Matrix** | Per-screen: default, empty, loading, error, success, edge states |
| **Microcopy** | Headings, labels, CTAs, empty-state messages, error messages per screen |
| **Acceptance Criteria** | Given/When/Then per screen×state; these become ISC rows downstream |

## Effort Tier Behavior

| Tier | Scope | Depth |
|------|-------|-------|
| **Small** | Only screens touched by the change | Lean — changed-area wireframe + its states + acceptance criteria |
| **Medium** | All screens for the feature under spec | Standard — full screen inventory + flows + acceptance criteria |
| **Large** | All screens + journey maps + personas | Full depth — everything including edge flows, persona variations |

Both UX and UI skills always run on browser/native surfaces — effort tier changes scope and depth, never whether the skills run.

## Templates

- `Templates/screen-inventory.yaml` — Screen Inventory YAML block template (matches `ScreenInventory.ts` contract exactly)
- `Templates/per-screen-section.md` — Per-screen UX section template (states, microcopy, Given/When/Then)
- `Templates/user-flow-guidance.md` — User Flow Mermaid guidance
- `Templates/example-ux-spec.md` — Complete example UX spec (valid per `ScreenInventory.ts`)

## Integration

### Feeds Into
- **UISpec skill** — consumes the Screen Inventory + Screen×State Matrix
- **SpecValidator** — coverage check against the Screen×State Matrix (Slice 5)
- **AutonomousWork ISC** — per-screen acceptance criteria become ISC rows

### Depends On
- `skills/Agents/SpecSheet/Tools/ScreenInventory.ts` — shared parser for the Screen Inventory block
- `skills/Agents/SpecSheet/CONTEXT.md` — canonical vocabulary (UX Spec, Screen Inventory, Screen×State Matrix, etc.)

### Agent
Run by the **UXDesigner** agent (`skills/Agents/UXDesignerContext.md`). The **Designer** agent reviews the output as a separate pass.
