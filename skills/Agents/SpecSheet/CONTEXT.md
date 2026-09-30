# SpecSheet — UX/UI Spec Generation

How SpecSheet produces development-ready UX/UI specifications by composing a UX skill and a UI skill, each run by a dedicated generator agent. This document fixes the vocabulary so the two skills and their handoff mean one thing each.

## Language

### Artifacts

**UX Spec**:
The tech-agnostic experience specification — user flows, information architecture, screen inventory, screen×state matrix, microcopy, acceptance criteria. The "how it works / why / where."
_Avoid_: design doc, mockup.

**UI Spec**:
The build-ready visual specification — wireframes, component specs, design tokens, responsive + accessibility specs. The "how it looks / how it's built."
_Avoid_: mockup, design.

**User Flow**:
A Mermaid flowchart of one task's paths through screens, including error and branch paths.
_Avoid_: journey (a journey map is broader and narrative), wireflow.

**Information Architecture**:
The navigable map of all screens and their hierarchy.
_Avoid_: nav tree (sitemap is an acceptable alias).

**Screen Inventory**:
The enumerated set of screens, each with purpose, entry points, and exit states, expressed as a machine-checkable table or YAML block. The contract the UX Spec hands to the UI Spec.
_Avoid_: page list, screen list.

**Screen×State Matrix**:
For each screen, the required set of states (default, empty, loading, error, success, edge). The completeness contract.
_Avoid_: state list.

**Wireframe**:
A lo-fi layout skeleton expressed as annotated HTML + Tailwind (ASCII only for inline sketches).
_Avoid_: mockup (implies hi-fi), prototype.

**Component**:
A UI element (atom / molecule / organism, usually a shadcn element). In this context "component" is a UI element, NOT the architecture-vocabulary term — for code structure say **Module** (see `LANGUAGE.md`).
_Avoid_: using "component" to mean a code module.

**Design Token**:
A named design value (color / spacing / type) referenced by name, never as raw hex or px.
_Avoid_: variable, style.

**Effort tier**:
Small / Medium / Large — controls UX/UI artifact scope and depth (not *which* skills run; both always run on UI surfaces), mirroring how CurrentWork scales ISC rows.
_Avoid_: size, t-shirt.

**Surface**:
The kind of thing a work item targets — `browser`, `native`, `cli`, `api`, or `library` — declared once by the classifier and carried on the work item. UX/UI generation fires only for `browser` / `native`.
_Avoid_: platform, target, channel.

**Stage**:
One persisted step the spec pipeline advances an item through (e.g. `researching`, `generating-spec`, `awaiting-approval`). UX/UI generation runs within spec generation; `ux-ui` is not a persisted stage. A build **Slice** is realized as a vertical **Phase** block in AutonomousWork; only horizontal phase chunking is deprecated.
_Avoid_: phase, slice (those belong to the build-execution context).

### Agents

**UXDesigner**:
The generator agent that runs the UX skill (`UXSpec`, in `Development/`) and produces the **UX Spec**.
_Avoid_: designer (that name is the reviewer).

**UIDesigner**:
The generator agent that runs the UI skill (`UISpec`, in `Development/`) and produces the **UI Spec**.
_Avoid_: builder (UIBuilder builds code, not specs).

**Designer**:
The existing review-only agent; runs as a critique pass over a generated UX/UI Spec. Never generates one.
_Avoid_: using Designer to generate.

## Relationships

- A **UX Spec** produces the **Screen Inventory** + **Screen×State Matrix**, which the **UI Spec** consumes.
- The spec is organized **per screen**: each screen's section co-locates its UX intent (states, acceptance criteria) and its UI realization (wireframe, components, tokens, a11y).
- A **UXDesigner** generates the **UX Spec**; a **UIDesigner** generates the **UI Spec**; the **Designer** reviews both.
- Each screen in the **Screen Inventory** must have a **Wireframe** and a spec for every state in its **Screen×State Matrix**.
- **SpecSheet** orchestrates: when **Surface** is `browser`/`native` it spawns **UXDesigner** then **UIDesigner**, then optionally **Designer**.
- A **UI Spec** references **Component**s and **Design Token**s; it never contains code (that is **UIBuilder**).
- UX/UI generation runs after base-spec generation and before ISC derivation; per-screen acceptance criteria become behavioral **ISC Row**s, while **Screen×State Matrix** coverage, accessibility, and token usage are enforced by the validator (not as ISC rows).

## Example dialogue

> **Dev:** "The UIDesigner can just decide what screens exist, right?"
> **Domain expert:** "No — screens are fixed by the **UX Spec**'s **Screen Inventory**. The **UIDesigner** renders those screens; it doesn't invent them. A missing screen is a UX-Spec gap, not a UI-Spec one."
> **Dev:** "And a screen's done once it has a wireframe?"
> **Domain expert:** "Only when it has a **Wireframe** for every state in its **Screen×State Matrix** — the empty and error states count, not just the happy path."

## Flagged ambiguities

- "component" meant both a UI element and an architecture module. **Resolved:** here **Component** = UI element; code structure is a **Module** (`LANGUAGE.md`).
- "designer" meant both the generator and the reviewer. **Resolved:** generators are **UXDesigner** / **UIDesigner**; **Designer** is review-only.
- "stage" vs "phase" vs "slice" for the orchestration step. **Resolved:** persisted pipeline states are **Stage**s (e.g. `researching`, `generating-spec`); UX/UI generation is a step within spec generation. A **Slice** is the build-loop unit represented by a vertical **Phase** block.
