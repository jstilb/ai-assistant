---
name: WireframeFormat
description: UISpec wireframe format convention — annotated HTML+Tailwind skeleton structure, placeholder labeling rules, component comment syntax, and per-state section structure for machine-detectable coverage checks.
---
# Wireframe Format — UISpec Reference

A UISpec wireframe is a **lo-fi annotated HTML + Tailwind skeleton** — not a prototype, not a mockup, not ASCII art. It shows real HTML structure with semantic token classes, placeholder labels, and HTML comment annotations naming the components. It is directly consumable by v0, Cursor, Bolt, and AutonomousWork as a build prompt.

---

## Core Rules

1. **Real HTML structure.** Use real HTML elements (`<main>`, `<header>`, `<section>`, `<button>`, `<input>`, `<ul>`, `<li>`, etc.), not boxes or ASCII art (ASCII is only allowed as a one-line spatial orientation comment, never as the wireframe itself).

2. **Semantic token classes only.** All Tailwind classes must use semantic token names (`bg-primary`, `text-muted-foreground`, `border-border`) — no raw color classes (`bg-blue-500`, `text-red-600`). Exception: Tailwind bracket notation for WCAG touch-target enforcement (`min-h-[44px]`) is allowed and must be annotated.

3. **Placeholder labels in `[Brackets]`.** All content placeholders use `[Label]` notation. Never use lorem ipsum. Use realistic min/max/typical content descriptions in the label when useful:
   - `[Item Name — typical: 1–4 words]`
   - `[Category Badge — e.g. "Electronics"]`
   - `[Error message — e.g. "Couldn't load items"]`

4. **Component annotations via HTML comments.** Every place a shadcn component or custom component is used, add an HTML comment immediately above it:
   ```html
   <!-- <Button variant="primary"> -->
   <!-- <Input type="email" aria-invalid="true"> -->
   <!-- [CUSTOM: SaveIcon — bookmark, filled=saved, outline=unsaved] -->
   ```

5. **No inline styles.** No `style=""` attributes. No CSS. Tailwind only.

6. **No lorem ipsum.** Zero tolerance. Use brackets.

7. **One wireframe per state.** Each state is a separate subsection with its own complete HTML skeleton.

---

## Co-located Per-Screen UI Section Structure

The UIDesigner **edits each existing `## Screen:` section in place** — it does NOT create
separate `## UI Spec — …` sections. UI is co-located into the UXDesigner's screen sections.

The canonical section shape after both UXDesigner and UIDesigner have run:

```markdown
## Screen: <Screen Name> (`<screen-id>`)

**Purpose / Entry / Exits:** <one line from UXDesigner>

**Acceptance Criteria:**
- Given …, when …, then … (from UXDesigner — do not alter)

### State: default

<wireframe + A11y notes>

### State: loading

<wireframe + A11y notes>

### State: empty

<wireframe + A11y notes>

### State: error

<wireframe + A11y notes>

### State: success

<wireframe + A11y notes>

### Component Inventory

| Component | Tier | shadcn Ref | Notes |
|-----------|------|------------|-------|
| ...       |      |            |       |

### Accessibility (WCAG 2.2 AA)

- Focus order: …
- ARIA: `role=…` / `aria-…` on interactive elements
- Contrast: 4.5:1 text / 3:1 UI; touch targets ≥ min-h-[44px]
```

**Key rules:**
- The `## Screen: <Name> (`<id>`)` H2 delimiter is the **co-location unit** — one per screen in the inventory. UXDesigner writes it; UIDesigner edits it.
- `### State: <state>` (H3) is the machine-detectable **coverage marker** — one per state declared in that screen's inventory entry.
- Every `## Screen:` section must contain `### Component Inventory` and `### Accessibility (WCAG 2.2 AA)` after the last state block.

### The Machine-Detectable Coverage Marker

Slice 5's SpecValidator detects wireframe coverage by searching for the exact pattern:

```
### State: <state>
```

Where `<state>` matches a state declared in that screen's inventory entry. The 6 states (default/empty/loading/error/success/edge) are the recommended baseline; screens MAY declare additional feature-specific states (e.g. `renaming`, `editing`, `selecting`), and each declared state — baseline or custom — MUST have its own `### State: <state>` wireframe.

Rules for the marker:
- Exactly three `#` characters — not two, not four
- Exactly `State: ` (capital S, colon, space) before the state name
- State name in lowercase, matching the Screen Inventory exactly
- No surrounding backticks in the heading itself (the state name is plain text in the heading)

**Correct:**
```markdown
### State: default
### State: loading
### State: error
```

**Incorrect (will not be detected):**
```markdown
#### State: default        ← wrong heading level
### state: default         ← lowercase s
### Default State          ← wrong order
### State: `default`       ← backticks in heading
### loading state          ← wrong format
```

---

## Wireframe Anatomy

A complete wireframe state section looks like this:

```markdown
### State: default

<!-- Spatial orientation: [PageHeader] / [ListContainer: 1..N ItemCards] -->

```html
<main class="mx-auto max-w-2xl px-4 sm:px-6 py-8 space-y-6">

  <!-- Page header -->
  <header>
    <!-- Heading: text-2xl font-bold text-foreground -->
    <h1 class="text-2xl font-bold text-foreground">[Page Heading]</h1>
  </header>

  <!-- Item list container -->
  <ul class="space-y-3" aria-label="[List label]">

    <!-- ItemCard molecule (repeat for each item) -->
    <!-- <Card> -->
    <li class="rounded-lg border border-border bg-card p-4
               flex items-center justify-between gap-4">

      <!-- Item info -->
      <div class="space-y-1">
        <p class="text-sm font-medium text-foreground">[Item Name]</p>
        <!-- <Badge variant="secondary">[Category]</Badge> -->
        <span class="inline-flex items-center rounded-full bg-secondary
                     px-2.5 py-0.5 text-xs font-medium text-secondary-foreground">
          [Category]
        </span>
      </div>

      <!-- Save icon button: <Button variant="ghost" size="icon" aria-label="Save [Item Name]"> -->
      <!-- Touch target: min-h-[44px] min-w-[44px] — WCAG 2.2 2.5.8 -->
      <button
        class="rounded-md hover:bg-accent min-h-[44px] min-w-[44px]
               flex items-center justify-center
               focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
        aria-label="Save [Item Name]"
      >
        <!-- [CUSTOM: BookmarkIcon — outline variant when unsaved] -->
        <!-- aria-hidden="true" on icon; label on button -->
        <span aria-hidden="true">[BookmarkIcon]</span>
      </button>
    </li>

  </ul>

</main>
```

**A11y notes (default state):**
- `<h1>` is the page landmark heading; no other `h1` on this route.
- Focus order: header → list items (top to bottom) → each item's save button.
- Save button: `aria-label="Save [Item Name]"` (icon-only button, WCAG 4.1.2).
- Touch target: `min-h-[44px] min-w-[44px]` on save button — exceeds WCAG 2.2 2.5.8 minimum (24px).
- Focus ring: `focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2` — meets WCAG 2.4.13.
```

---

## Loading State Wireframe Pattern

In a `loading` state, replace interactive content with Skeleton atoms:

```html
<ul class="space-y-3" aria-label="[List label]" aria-busy="true">
  <!-- 5× skeleton placeholders -->
  <!-- <Skeleton> — aria-hidden="true" — decorative -->
  <li aria-hidden="true" class="rounded-lg border border-border bg-card p-4
                                 flex items-center justify-between gap-4">
    <!-- <Skeleton className="h-4 w-40"> -->
    <div class="space-y-2">
      <div class="h-4 w-40 rounded bg-muted animate-pulse"></div>
      <div class="h-3 w-20 rounded bg-muted animate-pulse"></div>
    </div>
    <!-- <Skeleton className="h-9 w-9 rounded-md"> -->
    <div class="h-9 w-9 rounded-md bg-muted animate-pulse"></div>
  </li>
  <!-- repeat 4 more times -->
</ul>
<!-- role="status" aria-live="polite" wrapper announces loading -->
<div class="sr-only" role="status" aria-live="polite">[Accessible loading label]</div>
```

---

## Empty State Wireframe Pattern

```html
<main class="mx-auto max-w-2xl px-4 py-8">
  <header>
    <h1 class="text-2xl font-bold text-foreground">[Page Heading]</h1>
  </header>
  <!-- EmptyState molecule -->
  <div class="flex flex-col items-center justify-center py-16 text-center space-y-3">
    <!-- Optional icon (decorative): <Icon aria-hidden="true"> -->
    <span aria-hidden="true" class="text-muted-foreground">[EmptyIcon]</span>
    <h2 class="text-lg font-semibold text-foreground">[Empty Heading]</h2>
    <p class="text-sm text-muted-foreground max-w-xs">[Empty Body]</p>
    <!-- Optional CTA: <Button variant="default">[CTA Label]</Button> -->
  </div>
</main>
```

---

## Error State Wireframe Pattern

```html
<main class="mx-auto max-w-2xl px-4 py-8 space-y-4">
  <header>
    <h1 class="text-2xl font-bold text-foreground">[Page Heading]</h1>
  </header>
  <!-- ErrorBanner molecule: <Alert variant="destructive" role="alert" aria-live="assertive"> -->
  <div class="rounded-lg border border-destructive bg-destructive/10 p-4 space-y-2"
       role="alert" aria-live="assertive">
    <!-- <AlertCircleIcon aria-hidden="true"> -->
    <span aria-hidden="true" class="text-destructive">[AlertIcon]</span>
    <h2 class="text-sm font-semibold text-destructive">[Error Heading]</h2>
    <p class="text-sm text-destructive">[Error Body]</p>
    <!-- <Button variant="outline" size="sm">[Retry CTA]</Button> -->
    <button class="rounded-md border border-border px-3 py-1.5 text-sm
                   text-foreground hover:bg-accent min-h-[44px]
                   focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2">
      [Retry CTA]
    </button>
  </div>
</main>
```

---

## Success State Wireframe Pattern (Toast)

The list remains visible in its `default` appearance. The toast is rendered in a portal/container above the list:

```html
<!-- Toast container (portal, fixed position) -->
<!-- <Toast role="status" aria-live="polite"> — Sonner or Radix Toast -->
<div class="fixed bottom-4 right-4 z-50
            rounded-lg border border-border bg-card px-4 py-3 shadow-lg
            flex items-center gap-3"
     role="status" aria-live="polite">
  <!-- <CheckCircleIcon aria-hidden="true" class="text-foreground"> -->
  <span aria-hidden="true">[CheckIcon]</span>
  <p class="text-sm font-medium text-foreground">[Success message]</p>
</div>
<!-- List content: identical to `default` state, save icon updated to saved/filled -->
```

---

**Maintained by:** UISpec skill  
**Coverage marker:** `### State: <state>` (exact, h3 level, lowercase state name)  
**Slice 5 dependency:** SpecValidator detects this marker to check screen×state coverage  
**Last reviewed:** 2026-06-07
