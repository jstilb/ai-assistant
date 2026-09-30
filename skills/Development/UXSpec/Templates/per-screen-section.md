# Per-Screen UX Section Template
#
# UXDesigner: use one `## Screen:` section per screen from the Screen Inventory.
# The H2 heading uses the screen's `name` and `id` from the inventory — exact format required
# for the machine-detectable co-location unit (see UXUISpecFormat.md).
#
# UIDesigner: insert `### State:` wireframes + `### Component Inventory` +
# `### Accessibility (WCAG 2.2 AA)` inside these same sections — do NOT create
# separate `## UI Spec —` sections.

---

## Screen: [Screen Name] (`[screen-id]`)

**Purpose / Entry / Exits:** [One sentence: what this screen does, how a user arrives (entry points from the inventory), and where they can go (exits from the inventory).]

**Acceptance Criteria:**
- Given [precondition — e.g., the user has navigated from the home screen], when [action or system event — e.g., the screen loads], then [observable outcome — e.g., the item list is visible with at least one item].
- Given [another precondition], when [action], then [outcome].

<!-- UXDesigner: add one bullet per state or per meaningful user action above.
     At minimum one criterion per state listed in the Screen Inventory.
     UIDesigner: do not alter the acceptance criteria above — add ### State: sections below. -->

---

<!-- UIDesigner inserts the following blocks for each state in this screen's inventory entry.
     States listed in the screen-inventory MUST all have a matching `### State:` subsection.
     The `### State: <state>` heading is the machine-detectable coverage marker — exact syntax required. -->

### State: `default`

<!-- UXDesigner may stub this heading with a one-line description; UIDesigner fills in the wireframe. -->

**Description:** The normal, data-loaded view of this screen.

**Microcopy:**
- Heading: "[Screen heading text]"
- Subheading: "[Optional — describe the context or next step]" _(omit if none)_
- Primary CTA: "[Button or link label]"
- Secondary CTA: "[Optional secondary action]" _(omit if none)_

<!-- UIDesigner: replace the Description + Microcopy above with a full annotated HTML+Tailwind wireframe,
     then add **A11y notes** below. -->

---

### State: `loading`

**Description:** Async data fetch is in progress; content is not yet available.

**Microcopy:**
- Loading indicator label: "[Optional accessible label for screen readers, e.g., 'Loading items…']"
- _(No primary CTA while loading; actions should be disabled or hidden)_

---

### State: `empty`

**Description:** The fetch succeeded but returned no items or content.

**Microcopy:**
- Heading: "[Empty-state headline — affirm, don't apologize, e.g., 'No items yet']"
- Body: "[One sentence explaining what to do next.]"
- Primary CTA: "[Action to move out of empty state]" _(omit if no creation action from this screen)_

---

### State: `error`

**Description:** The request failed or a validation error occurred.

**Microcopy:**
- Heading: "[Error headline — specific, e.g., 'Couldn't load items']"
- Body: "[Actionable explanation, e.g., 'Check your connection and try again.']"
- Primary CTA: "[Recovery action, e.g., 'Retry']"

**Error Sub-cases:**

| Sub-case | Heading | Body | CTA |
|----------|---------|------|-----|
| Network unavailable | "No internet connection" | "Connect to Wi-Fi or mobile data to continue." | Retry |
| Server error (5xx) | "Something went wrong" | "We're working on it. Try again in a moment." | Retry |

---

### State: `success`

**Description:** A user action (e.g., form submission, item creation) completed successfully.

**Microcopy:**
- Confirmation message: "[Brief, specific confirmation, e.g., 'Item saved.']"
- _(Specify duration or dismissal trigger if transient)_

---

### State: `edge`

**Description:** [Boundary or unusual condition — e.g., maximum item count, degraded mode.]

**Microcopy:**
- [Appropriate copy for the edge condition]

---

<!-- UIDesigner adds after the last ### State: block: -->

### Component Inventory

| Component | Tier | shadcn Ref | Notes |
|-----------|------|------------|-------|
| `[ComponentName]` | Atom | `shadcn/[component]` | variant, size, or key props |
| `[MoleculeName]` | Molecule | — | Composition: `[Atom] + [Atom]` |
| `[CustomComponent]` | Atom | — | `[CUSTOM]` — one-line description |

### Accessibility (WCAG 2.2 AA)

- Focus order: [describe expected tab sequence across all states]
- ARIA: `role=[role]` / `aria-[attr]` on interactive elements; [list screen-specific roles]
- Contrast: 4.5:1 text on background; 3:1 UI components; touch targets ≥ `min-h-[44px]`
