---
name: ComponentPatterns
description: UISpec-owned shadcn/atomic component patterns for UI Spec wireframe annotations. Maintained independently of UIBuilder.
---
# Component Patterns — UISpec Reference

> **UISpec-owned.** This is a spec-level reference — it describes component structure and variants for wireframe annotation purposes. UIBuilder translates these patterns into working code; UISpec uses them to produce build-ready specs.

---

## Atomic Design Hierarchy

UISpec organizes components in three tiers. Every component in a wireframe must be tagged with its tier in the Component Inventory.

| Tier | Definition | Examples |
|------|------------|---------|
| **Atom** | Single, indivisible shadcn element | Button, Input, Badge, Label, Skeleton, Icon, Separator, Avatar |
| **Molecule** | Composition of 2–4 atoms with a single purpose | ItemCard (Card + Badge + Button), FormField (Label + Input + error text), SearchInput (Input + Button) |
| **Organism** | Full section composing molecules + atoms | ItemList (header + list of ItemCards + empty state), LoginForm (Card + multiple FormFields + Button) |

---

## Core Atoms (shadcn References)

### Button — `shadcn/button`

```html
<!-- <Button variant="default"> — primary action -->
<!-- <Button variant="outline"> — secondary action -->
<!-- <Button variant="ghost"> — tertiary / icon-only -->
<!-- <Button variant="destructive"> — delete, remove -->
<!-- <Button variant="link"> — inline text link style -->
<!-- <Button size="sm"> — compact -->
<!-- <Button size="lg"> — prominent CTA -->
<!-- <Button size="icon"> — icon-only (needs aria-label) -->
<!-- <Button disabled aria-busy="true"> — loading state -->
```

**Spec annotation rule:** Every button must specify `variant` and any non-default `size`. Icon-only buttons must note `aria-label`.

### Input — `shadcn/input`

```html
<!-- <Input type="email" placeholder="[Email address]"> -->
<!-- <Input type="password"> -->
<!-- <Input aria-invalid="true" aria-describedby="[error-id]"> — error state -->
<!-- <Input disabled> — disabled -->
```

Always paired with a `<Label>` in the Component Inventory.

### Label — `shadcn/label`

```html
<!-- <Label htmlFor="[input-id]">[Field Label]</Label> -->
```

Every Input, Select, and Checkbox in a wireframe requires a paired Label.

### Badge — `shadcn/badge`

```html
<!-- <Badge variant="default"> — neutral status -->
<!-- <Badge variant="secondary"> — subdued status -->
<!-- <Badge variant="destructive"> — error / danger status -->
<!-- <Badge variant="outline"> — bordered, no fill -->
```

### Skeleton — `shadcn/skeleton`

```html
<!-- <Skeleton className="h-4 w-full"> — line placeholder -->
<!-- <Skeleton className="h-10 w-full rounded-lg"> — card placeholder -->
<!-- <Skeleton className="h-9 w-9 rounded-full"> — avatar placeholder -->
```

Used in `loading` state wireframes. Mark `aria-hidden="true"` — decorative.

### Separator — `shadcn/separator`

```html
<!-- <Separator /> — horizontal rule between sections -->
```

### Avatar — `shadcn/avatar`

```html
<!-- <Avatar> + <AvatarImage> + <AvatarFallback>[Initials]</AvatarFallback> -->
```

---

## Core Molecules

### FormField (Label + Input + error text)

```html
<!-- FormField molecule: Label + Input + error text -->
<div class="space-y-2">
  <!-- <Label htmlFor="[id]">[Field Label]</Label> -->
  <label class="text-sm font-medium text-foreground" for="[id]">[Field Label]</label>
  <!-- <Input id="[id]" type="[type]"> -->
  <input class="w-full rounded-md border border-input bg-background px-3 py-2 text-sm" />
  <!-- Error text (visible in error state only): -->
  <!-- <p id="[id]-error" role="alert" class="text-sm text-destructive">[Error message]</p> -->
</div>
```

**ARIA:** In error state, Input gets `aria-invalid="true" aria-describedby="[id]-error"`.

### ItemCard (Card + Badge + Button)

```html
<!-- ItemCard molecule: Card + content + save Button -->
<!-- <Card> -->
<div class="rounded-lg border border-border bg-card p-4 flex items-center justify-between gap-4">
  <!-- Item info -->
  <div class="space-y-1">
    <p class="text-sm font-medium text-foreground">[Item Name]</p>
    <!-- <Badge variant="secondary">[Category]</Badge> -->
    <span class="inline-flex rounded-full bg-secondary px-2 py-0.5 text-xs text-secondary-foreground">[Category]</span>
  </div>
  <!-- Save toggle: <Button variant="ghost" size="icon" aria-label="Save [Item Name]"> -->
  <button class="h-9 w-9 rounded-md hover:bg-accent min-h-[44px] min-w-[44px]" aria-label="Save [Item Name]">
    <!-- <BookmarkIcon aria-hidden="true"> -->
    [SaveIcon]
  </button>
</div>
```

In `success` state (item saved): Button `aria-label` updates to `"[Item Name] saved"`.

### SearchInput (Input + Button)

```html
<!-- SearchInput molecule -->
<div class="flex gap-2">
  <!-- <Input placeholder="[Search placeholder]" aria-label="[Search label]"> -->
  <input class="flex-1 rounded-md border border-input bg-background px-3 py-2 text-sm" 
         placeholder="[Search placeholder]" aria-label="[Search label]" />
  <!-- <Button variant="default" size="sm">[Search CTA]</Button> -->
  <button class="rounded-md bg-primary px-4 py-2 text-sm text-primary-foreground">[Search CTA]</button>
</div>
```

---

## Core Organisms

### ItemList (header + list of ItemCards + empty/loading/error state)

```html
<!-- ItemList organism -->
<main class="mx-auto max-w-2xl px-4 py-8 space-y-4">
  <!-- Page header -->
  <header>
    <h1 class="text-2xl font-bold text-foreground">[Page Heading]</h1>
  </header>

  <!-- [DEFAULT state: list of ItemCard molecules] -->
  <!-- [LOADING state: list of Skeleton atoms] -->
  <!-- [EMPTY state: EmptyState molecule] -->
  <!-- [ERROR state: ErrorBanner molecule + Retry button] -->
</main>
```

### LoginForm (Card + FormFields + Buttons)

```html
<!-- LoginForm organism -->
<!-- <Dialog role="dialog" aria-labelledby="login-title" aria-modal="true"> -->
<div class="rounded-lg border border-border bg-card p-6 max-w-md w-full shadow-lg space-y-4"
     role="dialog" aria-modal="true" aria-labelledby="login-title">
  <h2 class="text-xl font-semibold text-foreground" id="login-title">[Dialog Heading]</h2>
  <p class="text-sm text-muted-foreground">[Dialog Subheading]</p>
  <!-- FormField: email -->
  <!-- FormField: password -->
  <!-- <Button variant="default" type="submit" class="w-full">[Primary CTA]</Button> -->
  <!-- <Button variant="ghost" class="w-full">[Secondary CTA]</Button> -->
</div>
```

### EmptyState

```html
<!-- EmptyState molecule (used in empty state wireframes) -->
<div class="flex flex-col items-center justify-center py-12 text-center space-y-3">
  <!-- Optional icon: <Icon aria-hidden="true" class="h-12 w-12 text-muted-foreground"> -->
  <h2 class="text-lg font-semibold text-foreground">[Empty Heading]</h2>
  <p class="text-sm text-muted-foreground max-w-xs">[Empty Body]</p>
  <!-- Optional CTA: <Button variant="default">[CTA Label]</Button> -->
</div>
```

### ErrorBanner

```html
<!-- ErrorBanner molecule (used in error state wireframes) -->
<!-- <Alert variant="destructive" role="alert" aria-live="assertive"> -->
<div class="rounded-lg border border-destructive bg-destructive/10 p-4 space-y-1"
     role="alert" aria-live="assertive">
  <!-- <AlertCircleIcon aria-hidden="true" class="h-4 w-4 text-destructive"> -->
  <h3 class="text-sm font-semibold text-destructive">[Error Heading]</h3>
  <p class="text-sm text-destructive">[Error Body]</p>
  <!-- <Button variant="outline" size="sm">[Retry CTA]</Button> -->
</div>
```

### Toast (shadcn/sonner or shadcn/toast)

```html
<!-- Toast molecule (used in success state wireframes) -->
<!-- <Toast role="status" aria-live="polite"> — rendered in toast container -->
<div class="rounded-lg border border-border bg-card px-4 py-3 shadow-lg flex items-center gap-3"
     role="status" aria-live="polite">
  <!-- <CheckCircleIcon aria-hidden="true" class="h-4 w-4 text-foreground"> -->
  <p class="text-sm text-foreground">[Success message]</p>
</div>
```

Auto-dismiss: note duration in spec (e.g. "3 seconds, then auto-dismiss"). Announce dismissal via live region.

---

## Component Inventory Format

In a UISpec Component Inventory table:

| Component | Tier | shadcn Ref | Notes |
|-----------|------|------------|-------|
| `Button (save)` | Atom | `shadcn/button` | `variant="ghost" size="icon"` |
| `Skeleton (list)` | Atom | `shadcn/skeleton` | `h-16 w-full rounded-lg` × 5 in loading state |
| `ItemCard` | Molecule | — | Composition: `Card + Badge + Button(save)` |
| `ItemList` | Organism | — | Composition: `h1 + list<ItemCard> + EmptyState \| ErrorBanner` |
| `SaveConfirmToast` | Molecule | `shadcn/sonner` | `role="status"`, 3s auto-dismiss |
| `LoginDialog` | Organism | `shadcn/dialog` | `aria-modal`, focus trap, Escape closes |

Flag custom components clearly: add `[CUSTOM]` in the Notes column with a one-line description of what it does.

---

## Wireframe Comment Conventions

In wireframes, reference components via HTML comments:

```html
<!-- <ComponentName prop="value" prop2="value"> -->
```

Examples:
```html
<!-- <Button variant="default" size="lg">Sign In</Button> -->
<!-- <Input type="email" aria-invalid="true" aria-describedby="email-error"> -->
<!-- <Badge variant="destructive">Error</Badge> -->
<!-- <Skeleton className="h-4 w-32"> -->  <!-- aria-hidden="true" — decorative -->
<!-- [CUSTOM: SaveIcon — bookmark icon, filled = saved, outline = unsaved] -->
```

This convention makes every component in a wireframe cross-referenceable to the Component Inventory, which Slice 5 can check mechanically.

---

**Maintained by:** UISpec skill  
**Component library:** shadcn/ui (https://ui.shadcn.com)  
**Atomic design reference:** Brad Frost — Atomic Design  
**Last reviewed:** 2026-06-07
