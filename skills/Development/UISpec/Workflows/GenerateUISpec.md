# Workflow: GenerateUISpec

**Agent:** UIDesigner  
**Input:** A UX Spec document (markdown) containing a `screen-inventory` YAML block  
**Output:** UI realization appended per-screen into the same document, or a standalone UI section if producing a separate output file  

---

## Step 0 — Pre-flight

1. Confirm the input is a valid UX Spec by locating the ` ```yaml screen-inventory ``` ` block.
2. Parse the Screen Inventory using `skills/Agents/SpecSheet/Tools/ScreenInventory.ts` (`parseScreenInventory`). If parsing fails, return the errors to the caller — do not proceed.
3. Read the effort tier from the work item context (Small / Medium / Large). Default to Medium if unspecified.
4. Load the UISpec references:
   - `skills/Development/UISpec/References/DesignTokens.md`
   - `skills/Development/UISpec/References/AccessibilityGuide.md`
   - `skills/Development/UISpec/References/ComponentPatterns.md`
   - `skills/Development/UISpec/References/WireframeFormat.md`

---

## Step 1 — Determine Scope

Using the parsed Screen Inventory and the effort tier:

| Effort | Screens | States per screen |
|--------|---------|-------------------|
| **Small** | Only the screens explicitly changed / touched | `default` state only (minimum; add `error` if the change involves a fallible operation) |
| **Medium** | All screens listed in the Screen Inventory | All states declared for that screen in the inventory |
| **Large** | All screens listed in the Screen Inventory | All states, plus edge states; add a full responsive-behavior table and WCAG 2.2 AA per component |

Never invent screens not in the Screen Inventory. A missing screen is a UX Spec gap — flag it and stop.

---

## Step 2 — For Each Screen in Scope

For each screen (in inventory order), **edit the existing `## Screen:` section in place** using
`Templates/per-screen-ui-section.md` as the insertion template. The UIDesigner does NOT create
`## UI Spec — <Screen>` sections — UI is co-located into the UXDesigner's existing screen sections.

Canonical structure (from `skills/Agents/SpecSheet/UXUISpecFormat.md`):
- Screen section starts at: `## Screen: <Name> (`<id>`)` (H2, backtick-quoted id)
- UIDesigner inserts `### State: <state>` wireframe blocks after the UX acceptance criteria
- UIDesigner appends `### Component Inventory` and `### Accessibility (WCAG 2.2 AA)` after the last state

### 2a — Component Inventory

List every UI element appearing on this screen, grouped by atomic tier:

- **Atoms** — single-element shadcn components (Button, Input, Badge, Icon, Label, Skeleton)
- **Molecules** — composed groups (ItemCard = Card + Badge + Button)
- **Organisms** — full screen sections (ItemList = header + Skeleton list + empty state)

For each component:
- Reference its shadcn primitive (`shadcn/button`, `shadcn/card`, etc.)
- Flag `[CUSTOM]` if it has no shadcn equivalent — and briefly describe what it does
- Note key variants/props needed (e.g. `Button variant="ghost"`, `Badge variant="destructive"`)

### 2b — Design Tokens

List all design tokens used on this screen. Always by name, never raw hex/px:

- Colors: e.g. `bg-primary`, `text-muted-foreground`, `border-border`, `bg-destructive`
- Spacing: Tailwind scale classes (e.g. `p-4`, `gap-6`, `space-y-4`)
- Typography: Tailwind text scale + weight (e.g. `text-2xl font-bold`, `text-sm font-medium`)
- Radius: e.g. `rounded-lg`, `rounded-full`
- Shadow: e.g. `shadow-sm`

### 2c — For Each State in Scope

For each state in `statesFor(screen)` (in declaration order), produce a wireframe subsection.

**The subsection MUST start with exactly:**
```
### State: <state>
```
where `<state>` matches the state id from the Screen Inventory (e.g. `default`, `loading`, `empty`, `error`, `success`, `edge`). This marker is machine-detectable by the Slice 5 coverage validator.

Inside the state subsection:
1. **Wireframe** — annotated HTML+Tailwind skeleton following `References/WireframeFormat.md`:
   - Real HTML structure (not ASCII boxes unless used as a spatial orientation comment)
   - Tailwind semantic token classes only — no raw colors
   - Placeholder labels in `[Brackets]` for content (e.g. `[Item Name]`, `[Hero Headline]`)
   - HTML comments naming components (e.g. `<!-- <Button variant="primary"> -->`)
   - No lorem ipsum
2. **State-specific notes** — what changes visually from the default state (e.g. "Button is disabled + `aria-busy=true`"; "Skeleton replaces list items")
3. **Accessibility for this state** — WCAG 2.2 AA notes specific to this state (focus order, live regions, ARIA state changes)

### 2d — Responsive Behavior (Medium / Large only)

| Breakpoint | Behavior |
|------------|----------|
| Mobile (< 640px) | ... |
| Tablet (640–1023px) | ... |
| Desktop (≥ 1024px) | ... |

---

## Step 3 — Assemble Output

The UIDesigner edits each `## Screen:` section in place. The canonical output structure
for each screen (after both UXDesigner and UIDesigner have run) is defined in
`skills/Agents/SpecSheet/UXUISpecFormat.md`:

```markdown
## Screen: <Screen Name> (`<screen-id>`)

**Purpose / Entry / Exits:** <from UXDesigner — do not alter>

**Acceptance Criteria:**
- Given …, when …, then … (from UXDesigner — do not alter)

### State: default

<wireframe + A11y notes>          ← UIDesigner inserts

### State: loading

<wireframe + A11y notes>          ← UIDesigner inserts

### State: <...>

<wireframe + A11y notes>          ← UIDesigner inserts

### Component Inventory           ← UIDesigner appends

<component table>

### Accessibility (WCAG 2.2 AA)   ← UIDesigner appends

- Focus order: …
- ARIA: role=… / aria-… on interactive elements
- Contrast: 4.5:1 text / 3:1 UI; touch targets ≥ min-h-[44px]

### Responsive Behavior  [Medium/Large only]

<breakpoint table>
```

**Do NOT create `## UI Spec — <Screen Name>` sections.** That pattern is deprecated and
will fail the co-located format validator.

---

## Step 4 — Coverage Verification

Before returning output, verify:

1. **State coverage:** Every `screen×state` pair in scope has a `### State: <state>` subsection with a wireframe. No gaps.
2. **Token coverage:** No raw `#hex`, `rgb(...)`, or bare `px` values appear in wireframe styling (Tailwind classes are the allowed form; `min-h-[44px]` bracket notation is allowed for WCAG touch-target enforcement only).
3. **Component coverage:** Every component named in a wireframe comment (`<!-- <ComponentName> -->`) appears in the Component Inventory.
4. **A11y coverage:** Every interactive component (buttons, inputs, links, toggles) has at least one WCAG 2.2 AA note (ARIA role, contrast, focus, or touch target).
5. **No lorem ipsum:** All placeholder text uses `[Label]` bracket notation.

If any check fails, fix before returning.

---

## Step 5 — Effort Scaling Summary

| Effort | Screens | States | Component specs | Responsive table | WCAG per component |
|--------|---------|--------|-----------------|------------------|--------------------|
| Small  | Changed only | default (+ error if applicable) | shadcn refs + flagged custom | No | A11y essentials only |
| Medium | All screens | All declared states | shadcn refs + key variants | Yes | Per state |
| Large  | All screens | All states + edge | Full specs for custom | Yes | Full WCAG 2.2 AA per component |
