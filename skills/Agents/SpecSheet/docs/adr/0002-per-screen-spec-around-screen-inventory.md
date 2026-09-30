# UX/UI spec is organized per-screen around a machine-checkable Screen Inventory

The UX/UI spec is a single document organized by screen, anchored on a structured **Screen Inventory** (table or YAML) authored by the **UXDesigner** as the contract. Each screen's section co-locates its UX intent (states, acceptance criteria) and its UI realization (wireframe, components, design tokens, accessibility). We chose this over two separate linked specs (ux-spec.md + ui-spec.md), which drift apart, and over a flat "UX block then UI block" document, which can't be coverage-checked and isn't organized for a builder.

## Consequences

- The validator can enforce that every screen × every state in the **Screen×State Matrix** has both intent and realization — coverage becomes a hard check, not a hope.
- Each screen section is a self-contained prompt a downstream AI builder (v0 / Cursor / AutonomousWork) can consume in isolation.
- The **UIDesigner** is constrained to the screens the **UX Spec** declares; it renders, it does not invent screens.
