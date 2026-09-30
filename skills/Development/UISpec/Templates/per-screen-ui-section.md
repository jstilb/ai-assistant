# Per-Screen UI Insertion Template

> UIDesigner: this template describes the blocks you INSERT inside each existing
> `## Screen: <Name> (`<id>`)` section — you do NOT create `## UI Spec —` sections.
>
> For each screen from the Screen Inventory, locate the matching `## Screen:` H2 section
> (written by UXDesigner) and append the blocks below after the last UXDesigner content.
>
> Delete states not declared in the Screen Inventory for this screen.
> Keep the `### State: <state>` heading syntax exactly — it is the machine-detectable
> coverage marker checked by SpecValidator.
>
> See `skills/Agents/SpecSheet/UXUISpecFormat.md` for the canonical section contract.

---

<!--
  INSERT point: immediately after the UXDesigner's last state stub in the ## Screen: section.
  The resulting section will look like:

  ## Screen: <SCREEN_NAME> (`<screen-id>`)

    [UXDesigner: Purpose/Entry/Exits + Acceptance Criteria remain untouched above]

    ### State: default
    <wireframe + A11y notes>        ← UIDesigner adds this

    ### State: loading
    <wireframe + A11y notes>        ← UIDesigner adds this

    ... (one per state in inventory)

    ### Component Inventory          ← UIDesigner adds this
    ### Accessibility (WCAG 2.2 AA)  ← UIDesigner adds this
-->

---

### State: default

<!-- Spatial orientation: [describe top-level layout zones in one line] -->

```html
<main class="mx-auto max-w-2xl px-4 sm:px-6 py-8 space-y-6">

  <!-- Page / screen header -->
  <header>
    <h1 class="text-2xl font-bold text-foreground">[Page Heading]</h1>
  </header>

  <!-- Primary content area -->
  <!-- [Describe organism or molecule used here] -->
  <section class="space-y-4">
    <!-- [Placeholder for primary content] -->
  </section>

</main>
```

**A11y notes (default):**
- `<h1>` is the landmark heading; no other `h1` on this route.
- Focus order: [describe expected tab sequence].
- All interactive elements: `focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2` — meets WCAG 2.4.13.
- Touch targets: all interactive elements `min-h-[44px] min-w-[44px]` — meets WCAG 2.2 2.5.8.
- [Add any ARIA notes specific to this state.]

---

### State: loading

<!-- Visual diff from default: list/content replaced with Skeleton atoms; aria-busy on container -->

```html
<main class="mx-auto max-w-2xl px-4 sm:px-6 py-8 space-y-6">
  <header>
    <h1 class="text-2xl font-bold text-foreground">[Page Heading]</h1>
  </header>

  <!-- Loading skeleton — <Skeleton> atoms replacing content -->
  <!-- aria-hidden="true" on each skeleton item (decorative) -->
  <section class="space-y-4" aria-busy="true">
    <!-- repeat skeleton items as needed -->
    <div aria-hidden="true" class="rounded-lg border border-border bg-card p-4 flex items-center gap-4">
      <!-- <Skeleton className="h-4 w-40"> -->
      <div class="h-4 w-40 rounded bg-muted animate-pulse"></div>
    </div>
  </section>

  <!-- Screen-reader announcement -->
  <div class="sr-only" role="status" aria-live="polite">[Accessible loading label — e.g. "Loading..."]</div>
</main>
```

**A11y notes (loading):**
- `aria-busy="true"` on the loading container.
- All skeleton items: `aria-hidden="true"` — decorative.
- Live region: `role="status" aria-live="polite"` announces the loading state to screen readers.
- Interactive elements (if any) are disabled during loading.

---

### State: empty

<!-- Visual diff from default: content replaced with EmptyState molecule; no list rendered -->

```html
<main class="mx-auto max-w-2xl px-4 sm:px-6 py-8 space-y-6">
  <header>
    <h1 class="text-2xl font-bold text-foreground">[Page Heading]</h1>
  </header>

  <!-- EmptyState molecule -->
  <div class="flex flex-col items-center justify-center py-16 text-center space-y-3">
    <!-- Optional icon (decorative): <Icon aria-hidden="true"> -->
    <span aria-hidden="true" class="text-muted-foreground">[EmptyIcon — optional]</span>
    <h2 class="text-lg font-semibold text-foreground">[Empty Heading]</h2>
    <p class="text-sm text-muted-foreground max-w-xs leading-normal">[Empty Body]</p>
    <!-- Optional CTA (only if there is a relevant action): -->
    <!-- <Button variant="default" class="min-h-[44px]">[CTA Label]</Button> -->
  </div>
</main>
```

**A11y notes (empty):**
- `<h2>` announces the empty state; heading hierarchy: `h1` (page) → `h2` (empty state heading).
- Empty state icon (if present): `aria-hidden="true"` — decorative.
- CTA (if present): fully focusable, `min-h-[44px]`, `aria-label` if icon-only.

---

### State: error

<!-- Visual diff from default: ErrorBanner replaces content; Retry CTA is primary action -->

```html
<main class="mx-auto max-w-2xl px-4 sm:px-6 py-8 space-y-4">
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
    <!-- <Button variant="outline" size="sm"> Retry </Button> -->
    <button class="mt-2 rounded-md border border-border px-4 py-2 text-sm font-medium
                   text-foreground hover:bg-accent min-h-[44px]
                   focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2">
      [Retry CTA]
    </button>
  </div>
</main>
```

**A11y notes (error):**
- `role="alert" aria-live="assertive"` on ErrorBanner — announced immediately to screen readers.
- Retry button: `min-h-[44px]`, focus ring, descriptive label.
- No list content rendered in error state (error replaces content, does not overlay it).

---

### State: success

<!-- Visual diff from default: toast overlay appears; list content identical to default -->

```html
<!-- Toast portal (fixed, overlays everything) -->
<!-- <Toast role="status" aria-live="polite"> — Sonner or shadcn/toast -->
<div class="fixed bottom-4 right-4 z-50 max-w-sm
            rounded-lg border border-border bg-card px-4 py-3 shadow-lg
            flex items-center gap-3"
     role="status" aria-live="polite">
  <!-- <CheckCircleIcon aria-hidden="true" class="text-foreground h-4 w-4"> -->
  <span aria-hidden="true">[CheckIcon]</span>
  <p class="text-sm font-medium text-foreground">[Success message — e.g. "Saved to your collection"]</p>
</div>
<!-- Main content: identical to default state -->
```

**A11y notes (success):**
- `role="status" aria-live="polite"` on toast — announces without interrupting speech.
- Focus does NOT move to the toast (focus stays on the element that triggered the action).
- Toast auto-dismiss: announce dismissal via live region on close.

---

### State: edge

<!-- Edge/overflow state: e.g. very long content, maximum items, offline banner, restricted access. -->
<!-- Only include if declared in the Screen Inventory for this screen. -->

```html
<!-- [Describe the edge condition and its visual treatment] -->
```

**A11y notes (edge):**
- [Edge-specific a11y notes.]

---

### Component Inventory

| Component | Tier | shadcn Ref | Notes |
|-----------|------|------------|-------|
| `[ComponentName]` | Atom | `shadcn/[component]` | variant, size, or key props |
| `[MoleculeName]` | Molecule | — | Composition: `[Atom] + [Atom]` |
| `[OrganismName]` | Organism | — | Composition: `[Molecule] + [Molecule]` |
| `[CustomComponent]` | Atom | — | `[CUSTOM]` — one-line description |

### Accessibility (WCAG 2.2 AA)

- Focus order: [describe expected tab sequence across all states for this screen]
- ARIA: `role=[role]` / `aria-[attr]` on interactive elements; [list key ARIA usage]
- Contrast: 4.5:1 text on background tokens; 3:1 UI components; touch targets `min-h-[44px]`

---

### Responsive Behavior

> Include for Medium and Large effort. Delete for Small.

| Breakpoint | Layout |
|------------|--------|
| Mobile (< 640px) | Single column, full-width cards, `px-4` |
| Tablet (640–1023px) | Single column, `px-6`, slightly wider max-width |
| Desktop (≥ 1024px) | Single column centered, `max-w-2xl`, `px-8` |
