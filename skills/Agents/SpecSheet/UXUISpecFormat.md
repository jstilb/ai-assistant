# Co-located UX/UI Spec Format (CANONICAL)

> Single source of truth for the structure of the co-located UX/UI section.
> `ScreenInventory.coverageGaps`, `SpecValidator.validateUXCompleteness` (`validateUICompleteness`
> was a no-op pass-through, deleted in J4 — do not re-introduce it), the UXDesigner/UIDesigner
> agents (`Tools/UXUIStage.ts`), and the live consumers — the automated `SpecPipelineRunner.ts`
> pipeline and the interactive `Workflows/CurrentWork.md` Step 4d — MUST all conform to this.
> There is no separate UXSpec/UISpec template; the section is co-located directly into the spec
> (see `SKILL.md` "What Survives Here"). `CreateSpec.md` and the other interactive `/specsheet`
> workflows referenced in older docs were retired 2026-07-02 (`SKILL.md`) — they are not live
> consumers. Per ADR 0002, each `## Screen:` section is a self-contained, co-located prompt a
> downstream AI builder can consume in isolation.

## Structure

The UX/UI work is appended to a spec as ONE top-level section, organized per screen:

```
## UX/UI Specification

```yaml screen-inventory
screens:
  - id: item-list
    name: Item List
    purpose: Browse and save items
    entry: ["app launch", "nav: Home"]
    exits: ["opens detail", "logs out"]
    states: [default, loading, empty, error, success]
  - id: login-prompt
    name: Login Prompt
    purpose: Authenticate before saving
    entry: ["save while logged out"]
    exits: ["returns to list"]
    states: [default, loading, error]
```

### User Flows
<optional Mermaid `flowchart TD`, incl. error/branch paths>

## Screen: Item List (`item-list`)

**Purpose / Entry / Exits:** <one line>

**Acceptance Criteria:**
- Given <context>, when <action>, then <observable outcome>
- Given …, when …, then …

### State: default
<annotated HTML+Tailwind wireframe — tokens by NAME, components named in comments, NO lorem>

### State: loading
…
### State: empty
…
### State: error
…
### State: success
…

### Component Inventory
- `shadcn/button` (primary) — …
- `shadcn/skeleton` — …

### Accessibility (WCAG 2.2 AA)
- Focus order: …
- ARIA: `role=…` / `aria-…` on interactive elements
- Contrast: 4.5:1 text / 3:1 UI; touch targets ≥24×24

## Screen: Login Prompt (`login-prompt`)
… (same shape) …
```

## The contract (what is machine-checked)

- **Top-level marker:** the section begins at the `## UX/UI Specification` H2 and runs to end of document. Its absence means "non-UI spec" → validators pass trivially.
- **Screen-inventory:** a fenced ```yaml screen-inventory``` block parseable by `ScreenInventory.parseScreenInventory`.
- **Screen-section delimiter (co-location unit):** `## Screen: <Name> (` + backtick + `<id>` + backtick + `)` — H2, one per screen `id` in the inventory. This is the unit `coverageGaps` splits on and the validators scope to. Each screen's UX **and** UI live inside its own `## Screen:` section.
- **State marker (UI coverage signal):** `### State: <state>` — H3, exactly `State: ` + lowercase state matching the inventory. One per state in that screen's matrix. The 6 states (default/empty/loading/error/success/edge) are the recommended baseline; screens MAY declare additional feature-specific states (e.g. `renaming`, `editing`, `selecting`), and each declared state — baseline or custom — MUST have its own `### State: <state>` wireframe.
- **Acceptance criteria (UX):** ≥1 `Given … when … then …` per `## Screen:` section. Each becomes a behavioral ISC row via `deriveBehavioralISC`.
- **Accessibility (UI):** each `## Screen:` section has a non-empty accessibility subsection mentioning an ARIA role/`aria-`/`role=` and contrast.
- **Tokens by name (UI):** no raw hex (`#abc`/`#aabbcc`) or raw inline `px` sizing; Tailwind bracket utilities (`min-h-[44px]`) are allowed.
- **No lorem ipsum** anywhere in the section.

## The generation flow (who writes what)

1. **UXDesigner** writes `## UX/UI Specification` + the `screen-inventory` yaml + optional `### User Flows`, then one `## Screen: <Name> (`<id>`)` per screen containing **Purpose/Entry/Exits** and **Acceptance Criteria** (UX intent).
2. **UIDesigner** EDITS each existing `## Screen:` section in place, inserting the `### State:` wireframes (one per state), `### Component Inventory`, and `### Accessibility (WCAG 2.2 AA)`. It does NOT create separate `## UI Spec — …` sections — UI is co-located into the screen's own section.
3. **Designer** (Medium+ effort) reviews the co-located result; review notes append below.
