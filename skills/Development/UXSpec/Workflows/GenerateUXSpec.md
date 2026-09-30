# GenerateUXSpec — Workflow

Produces a UX Spec for a feature on a `browser` or `native` surface. Follows TDD-style vertical slicing: spec the screens first, then flow per screen, then states, then microcopy, then acceptance criteria — iterating per screen rather than layer-by-layer.

## Inputs

| Input | Required | Description |
|-------|----------|-------------|
| Feature description | Yes | One-paragraph description of the feature and its user goal |
| Effort tier | Yes | `Small` / `Medium` / `Large` — controls scope and depth (see SKILL.md table) |
| Surface | Yes | Must be `browser` or `native`; skip this workflow for `cli`/`api`/`library` |
| Existing screens | No | List of screens already in the product (for context) |
| Personas | No | (Large tier only) Primary user personas to consider |

## Step 1 — Understand the Feature

1. Read the feature description carefully. Identify: the user goal, the entry trigger, the happy path, error paths, and any edge cases.
2. Identify which screens the feature touches (for Small) or requires end-to-end (for Medium/Large).
3. For Large tier: identify the primary personas and any journey-level context.

## Step 2 — Draft the Screen Inventory

Produce the Screen Inventory as a fenced YAML block tagged `yaml screen-inventory`. Use the template in `Templates/screen-inventory.yaml` exactly — it matches the `ScreenInventory.ts` contract.

Constraints:
- Every screen must include `default` in its states array.
- Use only valid states: `default`, `empty`, `loading`, `error`, `success`, `edge`.
- Screen `id` values must be lowercase kebab-case and unique.
- For Small tier: include only the screens the change touches.
- For Medium/Large tier: include all screens the feature requires.

After drafting, mentally verify: "Can a developer enumerate every screen and state from this block alone?"

## Step 3 — User Flows (Mermaid)

For each primary task path through the feature, produce a Mermaid `flowchart TD`. Guidelines from `Templates/user-flow-guidance.md`:

- Every flow must include the error/branch paths — happy-path-only is incomplete.
- Use screen `id` values as node identifiers in the diagram.
- Annotate decision nodes with the condition (e.g., `{Auth token valid?}`).
- For Small tier: one flow covering the touched screens. For Medium/Large: one flow per major task path.

## Step 4 — Per-Screen Spec Sections

For each screen in the Screen Inventory, produce a **co-located** `## Screen:` section using
the template in `Templates/per-screen-section.md` and the canonical structure in
`skills/Agents/SpecSheet/UXUISpecFormat.md`.

The UXDesigner writes these H2 sections; the UIDesigner will later **edit them in place** to
insert wireframes. This means the format must be correct from the start:

- Use **`## Screen: <Name> (`<id>`)`** (H2, backtick-quoted id). This is the co-location unit
  and the machine-detectable delimiter — the exact format is required.
- Do NOT use `## Screen Specs` → `### Name` → `#### States` nesting. That old layout is
  incompatible with the validator.

Each `## Screen:` section must contain:

1. **Purpose / Entry / Exits** — one-sentence line with the screen's role, entry points, and exits.
2. **Acceptance Criteria** — ≥1 `Given … when … then …` bullet per screen. Use inline bullet
   form (not fenced code blocks) so `deriveBehavioralISC` can extract them:
   ```
   - Given [precondition], when [action or system event], then [observable outcome].
   ```
3. **`### State: <state>`** stubs — H3, one per state in the inventory. The UXDesigner may
   stub them with microcopy + description; the UIDesigner fills in the wireframes. The exact
   marker `### State: <state>` (capital S, lowercase state name) is required.

For Small tier: spec only the screens and states in the touched area.
For Medium tier: spec all screens in the inventory at standard depth.
For Large tier: add persona-specific notes, edge-case flows, and journey-level criteria.

## Step 5 — Review and Self-Check

Before finalizing, verify:

- [ ] Screen Inventory YAML block is present and tagged `yaml screen-inventory`.
- [ ] Every screen has `default` in its states.
- [ ] No duplicate screen ids.
- [ ] Every screen in the inventory has a corresponding spec section in the document.
- [ ] Every state in a screen's states array has at least one Given/When/Then criterion.
- [ ] Every user flow references only screens from the inventory (no orphan screens).
- [ ] Microcopy is specific enough to write — no "[placeholder]" labels.
- [ ] Error messages are actionable, not just "An error occurred."

If the spec is Machine-checkable by `ScreenInventory.ts`, it will be parseable. Run the parser to confirm if tooling is available.

## Output Format

Produce a single markdown document following the co-located structure defined in
`skills/Agents/SpecSheet/UXUISpecFormat.md`. The UX/UI content lives under a single
`## UX/UI Specification` H2 section:

```markdown
# [Feature Name] — UX Spec

**Effort:** [Small | Medium | Large]
**Surface:** [browser | native]
**Generated:** [ISO date]

## Overview

[One paragraph: user goal, entry trigger, key flows]

## UX/UI Specification

> Generated by UXDesigner ([Model]). Surface: [surface]. Effort: [effort].
> UIDesigner will add wireframes into each ## Screen: section below.

` ` `yaml screen-inventory
screens:
  - id: [screen-id]
    name: [Screen Name]
    purpose: [purpose]
    route: /[route]
    entry:
      - [entry point]
    exits:
      - [exit point]
    states:
      - default
      - [other states]
` ` `

### User Flows

[Mermaid flowchart(s)]

## Screen: [Screen Name] (`[screen-id]`)

**Purpose / Entry / Exits:** [one line]

**Acceptance Criteria:**
- Given [precondition], when [action], then [outcome].
- Given [precondition], when [action], then [outcome].

### State: default

[UXDesigner microcopy stub — UIDesigner will replace with wireframe]

### State: [other-state]

[UXDesigner microcopy stub]

... (one ### State: per state in inventory — UIDesigner inserts wireframes)

## Screen: [Next Screen Name] (`[next-screen-id]`)

... (repeat for each screen)
```

For Large tier, add `## Personas` and `## Journey Map` before the `## UX/UI Specification`
section.

**Critical format rules (enforced by SpecValidator):**
- The `## Screen:` H2 delimiter is `## Screen: <Name> (`<id>`)` — exact syntax required.
- Each screen section must contain ≥1 `Given … when … then …` criterion.
- State stubs use `### State: <state>` (H3, capital S, lowercase state name).
- There is NO `## Screen Specs` umbrella section. Screens are direct H2 sections.
- The Screen Inventory yaml block is inside `## UX/UI Specification`, not a separate section.
