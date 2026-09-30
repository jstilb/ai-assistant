---
name: AccessibilityGuide
description: UISpec-owned WCAG 2.2 AA accessibility requirements — focus order, ARIA, contrast, touch targets, focus-not-obscured, drag alternatives. Maintained independently of UIBuilder (which references WCAG 2.1).
---
# Accessibility Guide — UISpec Reference (WCAG 2.2 AA)

> **UISpec-owned. WCAG 2.2 AA.** This file is maintained independently of UIBuilder's AccessibilityGuide.md (which references WCAG 2.1). UISpec specs must conform to **WCAG 2.2 Level AA** — the current stable W3C standard (W3C Recommendation, Oct 2023).

---

## WCAG 2.2 AA Requirements Summary

Every UI Spec wireframe and component must satisfy these criteria:

| Criterion | ID | Requirement |
|-----------|-----|-------------|
| Keyboard accessible | 2.1.1 | All functionality available via keyboard |
| No keyboard trap | 2.1.2 | Focus can move away from any component |
| Focus visible | 2.4.7 | Keyboard focus indicator must be visible |
| **Focus not obscured (partial)** | **2.4.11** | **WCAG 2.2 NEW — focused component must not be entirely hidden by sticky content** |
| **Focus not obscured (enhanced)** | **2.4.12** | **WCAG 2.2 NEW (AA) — focused component fully visible when focused** |
| **Focus appearance** | **2.4.13** | **WCAG 2.2 NEW — focus indicator ≥2px outline, area ≥perimeter × 2px** |
| Contrast (text) | 1.4.3 | ≥4.5:1 for normal text; ≥3:1 for large text (≥18pt or ≥14pt bold) |
| Contrast (UI components) | 1.4.11 | ≥3:1 for UI elements, icons, focus indicators |
| Text resize | 1.4.4 | No loss of content or function at 200% zoom |
| Reflow | 1.4.10 | No horizontal scroll at 400% / 320px width (for most content) |
| **Dragging alternatives** | **2.5.7** | **WCAG 2.2 NEW — any drag action must have a single-pointer alternative** |
| **Target size (minimum)** | **2.5.8** | **WCAG 2.2 NEW (AA) — interactive target ≥24×24 CSS pixels** |
| Error identification | 3.3.1 | Errors identified in text, not color alone |
| Labels or instructions | 3.3.2 | Form inputs have labels or instructions |
| Name, role, value | 4.1.2 | UI components have programmatic name, role, and value |
| Status messages | 4.1.3 | Status messages announced to AT without focus |

**Bolded rows** are WCAG 2.2 additions not present in WCAG 2.1.

---

## Color Contrast

### Text Contrast (1.4.3)

| Text type | Minimum ratio |
|-----------|---------------|
| Normal text (< 18pt / < 14pt bold) | **4.5:1** |
| Large text (≥ 18pt or ≥ 14pt bold) | **3:1** |
| Text in disabled components | Exempt |
| Decorative / logo text | Exempt |

shadcn/ui semantic tokens meet AA by default. When speccing custom color combinations, note the pair and assert compliance:

```
<!-- Spec note: text-foreground on bg-background — compliant (AA: ~15:1 light, ~14:1 dark) -->
<!-- Spec note: text-muted-foreground on bg-background — verify; may approach minimum -->
```

### UI Component Contrast (1.4.11)

| Element | Minimum ratio |
|---------|---------------|
| Input borders | **3:1** against adjacent color |
| Icons (informational) | **3:1** |
| Focus indicators | **3:1** against adjacent background |
| Selected / active states | **3:1** |

---

## Focus Management

### Focus Visibility (2.4.7, 2.4.13 — WCAG 2.2)

All focusable elements must have a visible focus indicator meeting WCAG 2.2 2.4.13:

- **Outline area** ≥ perimeter of the element × 2px
- **Minimum contrast** 3:1 between focused and unfocused appearance

**Tailwind pattern (spec annotation):**
```
focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2
```

Use `focus-visible:` (not `focus:`) to suppress focus ring on mouse click while preserving it for keyboard.

### Focus Not Obscured (2.4.11, 2.4.12 — WCAG 2.2 NEW)

When a page has sticky headers, fixed footers, or floating overlays:

- The focused component must **not be entirely hidden** behind any sticky/fixed content (2.4.11 — AA)
- The focused component should be **fully visible** when focused (2.4.12 — AAA, recommended)

**Spec annotation pattern:**
```
<!-- Focus-not-obscured: sticky header height = [token: h-16]; 
     list has scroll-margin-top: 4rem to prevent overlap when focused -->
```

### Focus Order (2.4.3)

Tab order must follow a logical reading sequence (top-to-bottom, left-to-right in LTR):

```
✓  Page header → main content → sidebar → footer
✓  Modal: first focusable element inside modal when opened
✓  Toast/alert: focus moves to action if action is time-sensitive
✗  Using tabindex > 0 (never, unless absolutely necessary)
```

In every wireframe, annotate the intended focus order for non-obvious flows:

```html
<!-- Focus order: [1] Email input → [2] Password input → [3] Sign in button → [4] Not now link -->
```

### Focus Trap (Modals and Dialogs)

When a modal, dialog, or drawer opens:
- Focus must move to the first focusable element inside (or the dialog `role="dialog"` element)
- Tab/Shift+Tab must cycle only within the modal while it is open
- Escape must close the modal and return focus to the trigger

---

## Touch Targets (2.5.8 — WCAG 2.2 NEW)

**Minimum target size: 24×24 CSS pixels** (WCAG 2.2 AA minimum; 44×44px is the recommended best practice).

| Scenario | Minimum | Recommended |
|----------|---------|-------------|
| Inline text links | 24×24 (spacing allowance) | 44×44 |
| Icon-only buttons | 24×24 | 44×44 |
| Toggle / checkbox | 24×24 | 44×44 |
| List item save icon | 24×24 | 44×44 |

**Tailwind pattern:**
```
min-h-[44px] min-w-[44px]     ← recommended (exceeds WCAG 2.2 minimum)
```

When specifying an icon button that is smaller than 44px, annotate why and confirm it meets the 24px minimum:
```html
<!-- Touch target: 32×32px icon button — exceeds WCAG 2.2 2.5.8 minimum (24px) -->
```

---

## Drag Alternatives (2.5.7 — WCAG 2.2 NEW)

Any drag-and-drop interaction (reordering lists, resizing panels, carousel swipe) must have an equivalent **single-pointer alternative** (tap, click sequence, button pair).

**Spec annotation pattern:**
```
<!-- Drag alternative: list reorder via drag — also exposed as Up/Down buttons per item -->
```

---

## ARIA Patterns

### Required ARIA by Component Type

| Component | Required ARIA |
|-----------|---------------|
| Icon-only button | `aria-label="[Action description]"` |
| Toggle button | `aria-pressed={true|false}` |
| Loading state | `role="status"` or `aria-busy="true"` on button |
| Error message | `role="alert"` (assertive) or `aria-live="polite"` |
| Success / status | `role="status"` + `aria-live="polite"` |
| Modal/Dialog | `role="dialog"` + `aria-labelledby="[title-id]"` + `aria-modal="true"` |
| Form input + error | `aria-describedby="[error-id]"` + `aria-invalid="true"` |
| Progress/loading bar | `role="progressbar"` + `aria-valuenow` + `aria-valuemin` + `aria-valuemax` |
| Disabled interactive element | `aria-disabled="true"` (prefer native `disabled` on `<button>`) |

### Semantic HTML First

Use native semantic elements before reaching for ARIA:

```
✓  <button>  — not  <div role="button">
✓  <a href>  — not  <div role="link">
✓  <nav>     — not  <div role="navigation">
✓  <main>    — not  <div role="main">
✓  <header>  — not  <div role="banner">
✓  <footer>  — not  <div role="contentinfo">
```

### Live Regions

| Scenario | Pattern |
|----------|---------|
| Toast / confirmation after action | `role="status" aria-live="polite"` (does not interrupt speech) |
| Error after form submit | `role="alert" aria-live="assertive"` (interrupts immediately) |
| Save icon state change | `aria-label` update (e.g. "Save Item Name" → "Item Name saved") |
| Loading completion | Announce via `aria-live="polite"` region |

---

## Per-Screen A11y Spec Checklist

For each wireframe state, annotate:

- [ ] **Heading hierarchy** — no skipped levels (h1 → h2 → h3, never h1 → h3)
- [ ] **Focus order** — stated for non-obvious sequences
- [ ] **Focus not obscured** — noted if sticky/fixed chrome exists
- [ ] **Touch targets** — all interactive elements ≥24px (annotate if <44px)
- [ ] **Contrast** — note any near-minimum pairs
- [ ] **ARIA labels** — icon-only elements labeled
- [ ] **Live regions** — dynamic content (loading, errors, toasts) announced
- [ ] **Keyboard trap** — modals trap focus; trap released on Escape
- [ ] **Drag alternatives** — if dragging is present, alternative is specified
- [ ] **Error text** — every error state has a visible text message (not color-only)

---

## State-Specific A11y Requirements

### Loading State
```
- role="status" aria-live="polite" wraps the loading region
- aria-busy="true" on the interactive trigger that caused loading
- Skeleton placeholders: aria-hidden="true" (decorative)
- Screen reader announcement: "[action] in progress" or "[Screen name] loading"
```

### Error State
```
- role="alert" aria-live="assertive" on the error message
- aria-invalid="true" on the relevant input (form errors)
- aria-describedby links input to error message id
- Focus moves to error message or first invalid field after submission
```

### Success State / Toast
```
- role="status" aria-live="polite" on the toast container
- Toast is announced; focus does NOT move to toast (unless action inside)
- Auto-dismiss: announced when dismissed ("Saved. Confirmation dismissed.")
```

### Empty State
```
- Heading announces empty condition ("Nothing here yet")
- No false "No results" announcement if the page is still loading
- Empty state is in the tab order if it contains a CTA
```

---

**Maintained by:** UISpec skill  
**Standard:** WCAG 2.2 Level AA  
**Supersedes:** UIBuilder's AccessibilityGuide.md (WCAG 2.1)  
**Reference:** https://www.w3.org/WAI/WCAG22/quickref/?versions=2.2  
**Last reviewed:** 2026-06-07
