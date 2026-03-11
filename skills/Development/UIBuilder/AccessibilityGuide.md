---
name: AccessibilityGuide
description: ARIA patterns, keyboard navigation, and WCAG compliance for UIBuilder components
---
# Accessibility Guide

Accessibility requirements and patterns for all UIBuilder-generated components.

## WCAG 2.1 Compliance

All generated components MUST meet **WCAG 2.1 Level AA** standards minimum.

### Color Contrast Requirements

**Normal Text (< 18pt or < 14pt bold):**
- AA: 4.5:1 minimum
- AAA: 7:1 preferred

**Large Text (≥ 18pt or ≥ 14pt bold):**
- AA: 3:1 minimum
- AAA: 4.5:1 preferred

**UI Components & Graphics:**
- AA: 3:1 minimum for borders, icons, focus indicators

### Verifying Contrast

shadcn/ui default tokens meet AA standards. For custom colors:

```typescript
// ✅ CORRECT - semantic tokens (AA compliant)
<p className="text-foreground bg-background">Text</p>

// ⚠️ VERIFY - custom colors
<p className="text-blue-600 bg-blue-50">Verify this contrast</p>
```

**Verification Tools:**
- Chrome DevTools: Lighthouse Accessibility Audit
- Browser DevTools: Accessibility Inspector (shows contrast ratio)
- Online: WebAIM Contrast Checker

## ARIA Patterns

### Button

```typescript
// Standard button (native semantic)
<Button onClick={handleClick}>
  Click Me
</Button>

// Icon-only button
<Button onClick={handleClose} aria-label="Close dialog">
  <X className="h-4 w-4" />
</Button>

// Toggle button
<Button
  onClick={handleToggle}
  aria-pressed={isPressed}
  aria-label="Toggle notifications"
>
  <Bell className="h-4 w-4" />
</Button>

// Disabled button (automatic aria-disabled)
<Button disabled>Cannot Click</Button>
```

### Dialog (Modal)

```typescript
<Dialog open={open} onOpenChange={setOpen}>
  <DialogContent>
    {/* DialogTitle is REQUIRED for screen readers */}
    <DialogHeader>
      <DialogTitle>Confirm Action</DialogTitle>
      <DialogDescription>
        This action cannot be undone.
      </DialogDescription>
    </DialogHeader>
    {/* Content */}
    <DialogFooter>
      <Button onClick={handleCancel}>Cancel</Button>
      <Button onClick={handleConfirm}>Confirm</Button>
    </DialogFooter>
  </DialogContent>
</Dialog>

// Dialog automatically handles:
// - aria-modal="true"
// - Focus trap
// - Escape key to close
// - Focus return to trigger
```

### Form Controls

```typescript
// Input with Label (REQUIRED association)
<div className="space-y-2">
  <Label htmlFor="email">Email Address</Label>
  <Input
    id="email"
    type="email"
    aria-describedby="email-description"
    aria-invalid={hasError}
    aria-required="true"
  />
  <p id="email-description" className="text-sm text-muted-foreground">
    We'll never share your email.
  </p>
  {hasError && (
    <p className="text-sm text-destructive" role="alert">
      Please enter a valid email address.
    </p>
  )}
</div>

// Select with Label
<div className="space-y-2">
  <Label htmlFor="country">Country</Label>
  <Select>
    <SelectTrigger id="country">
      <SelectValue placeholder="Select a country" />
    </SelectTrigger>
    <SelectContent>
      <SelectItem value="us">United States</SelectItem>
      <SelectItem value="uk">United Kingdom</SelectItem>
    </SelectContent>
  </Select>
</div>

// Checkbox with Label
<div className="flex items-center space-x-2">
  <Checkbox id="terms" />
  <Label htmlFor="terms">Accept terms and conditions</Label>
</div>
```

### Navigation

```typescript
<nav aria-label="Main navigation">
  <ul className="flex space-x-4">
    <li><a href="/" aria-current="page">Home</a></li>
    <li><a href="/about">About</a></li>
    <li><a href="/contact">Contact</a></li>
  </ul>
</nav>

// Breadcrumbs
<nav aria-label="Breadcrumb">
  <ol className="flex items-center space-x-2">
    <li><a href="/">Home</a></li>
    <li aria-hidden="true">/</li>
    <li><a href="/products">Products</a></li>
    <li aria-hidden="true">/</li>
    <li aria-current="page">Product Name</li>
  </ol>
</nav>
```

### Tables

```typescript
<Table>
  <caption className="sr-only">User list</caption>
  <TableHeader>
    <TableRow>
      <TableHead scope="col">Name</TableHead>
      <TableHead scope="col">Email</TableHead>
      <TableHead scope="col">Role</TableHead>
    </TableRow>
  </TableHeader>
  <TableBody>
    <TableRow>
      <TableCell>John Doe</TableCell>
      <TableCell>john@example.com</TableCell>
      <TableCell>Admin</TableCell>
    </TableRow>
  </TableBody>
</Table>
```

### Tabs

```typescript
<Tabs defaultValue="account">
  <TabsList aria-label="Account settings">
    <TabsTrigger value="account">Account</TabsTrigger>
    <TabsTrigger value="password">Password</TabsTrigger>
    <TabsTrigger value="notifications">Notifications</TabsTrigger>
  </TabsList>
  <TabsContent value="account">
    {/* Content automatically gets role="tabpanel" */}
  </TabsContent>
</Tabs>

// Tabs automatically handle:
// - Arrow key navigation
// - Home/End keys
// - aria-selected
// - aria-controls
```

### Loading States

```typescript
// Loading spinner
<div role="status" aria-live="polite">
  <Spinner className="h-4 w-4" />
  <span className="sr-only">Loading...</span>
</div>

// Loading button
<Button disabled aria-busy="true">
  <Spinner className="mr-2 h-4 w-4" />
  Loading...
</Button>
```

### Alerts & Notifications

```typescript
// Success alert
<Alert role="status" aria-live="polite">
  <CheckCircle className="h-4 w-4" />
  <AlertTitle>Success</AlertTitle>
  <AlertDescription>Your changes have been saved.</AlertDescription>
</Alert>

// Error alert (assertive for immediate attention)
<Alert variant="destructive" role="alert" aria-live="assertive">
  <AlertCircle className="h-4 w-4" />
  <AlertTitle>Error</AlertTitle>
  <AlertDescription>Something went wrong. Please try again.</AlertDescription>
</Alert>
```

## Keyboard Navigation

### Interactive Elements

All interactive elements MUST be keyboard accessible:

```typescript
// ✅ CORRECT - native button
<Button onClick={handleClick}>Click</Button>

// ✅ CORRECT - custom element with keyboard support
<div
  role="button"
  tabIndex={0}
  onClick={handleClick}
  onKeyDown={(e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault()
      handleClick()
    }
  }}
>
  Custom Button
</div>

// ❌ WRONG - div without keyboard support
<div onClick={handleClick}>Not accessible</div>
```

### Focus Management

```typescript
// Focus visible indicator (REQUIRED)
<Button className="focus:ring-2 focus:ring-ring focus:ring-offset-2">
  Visible Focus
</Button>

// Skip to content link (for long nav)
<a
  href="#main-content"
  className="sr-only focus:not-sr-only focus:absolute focus:top-0 focus:left-0"
>
  Skip to main content
</a>

<main id="main-content">
  {/* Main content */}
</main>
```

### Tab Order

Maintain logical tab order (left-to-right, top-to-bottom):

```typescript
// ✅ CORRECT - logical order
<form>
  <Input placeholder="First Name" />      {/* tabindex 0 */}
  <Input placeholder="Last Name" />       {/* tabindex 0 */}
  <Input placeholder="Email" />           {/* tabindex 0 */}
  <Button type="submit">Submit</Button>   {/* tabindex 0 */}
</form>

// ❌ WRONG - explicit tabindex (avoid unless necessary)
<Input tabIndex={3} />
<Input tabIndex={1} />
<Input tabIndex={2} />
```

## Screen Reader Support

### Hidden Content

```typescript
// Visually hidden but available to screen readers
<span className="sr-only">Additional context for screen readers</span>

// Hidden from everyone (decorative only)
<Icon aria-hidden="true" className="h-4 w-4" />

// Conditional visibility
<div className={cn(
  "text-sm",
  isImportant ? "block" : "sr-only"
)}>
  Important message
</div>
```

### Semantic HTML

Use semantic HTML for better screen reader navigation:

```typescript
// ✅ CORRECT - semantic structure
<header>
  <h1>Page Title</h1>
  <nav aria-label="Main navigation">...</nav>
</header>

<main>
  <article>
    <h2>Article Title</h2>
    <p>Content...</p>
  </article>
</main>

<footer>
  <p>Footer content</p>
</footer>

// ❌ WRONG - div soup
<div className="header">
  <div className="title">Page Title</div>
  <div className="nav">...</div>
</div>
```

### Heading Hierarchy

Maintain proper heading levels (no skipping):

```typescript
// ✅ CORRECT - logical hierarchy
<h1>Page Title</h1>
<h2>Section 1</h2>
<h3>Subsection 1.1</h3>
<h3>Subsection 1.2</h3>
<h2>Section 2</h2>

// ❌ WRONG - skipped level
<h1>Page Title</h1>
<h3>Subsection</h3>  {/* Skipped h2 */}
```

## Touch Targets

Minimum size for touch targets: **44x44px**

```typescript
// ✅ CORRECT - adequate touch target
<Button className="min-h-[44px] min-w-[44px]">
  Click
</Button>

// ✅ CORRECT - icon button with adequate target
<Button size="icon" className="h-11 w-11">
  <Icon className="h-4 w-4" />
</Button>

// ❌ WRONG - too small
<button className="h-6 w-6">
  <Icon />
</button>
```

## Testing Checklist

Before marking a component as complete, verify:

- [ ] All interactive elements are keyboard accessible
- [ ] Focus indicators are visible
- [ ] Color contrast meets AA standards (4.5:1 minimum)
- [ ] All images have alt text (or aria-hidden if decorative)
- [ ] All form inputs have associated labels
- [ ] Headings follow logical hierarchy
- [ ] ARIA attributes are correct (not redundant with semantic HTML)
- [ ] Screen reader announces content correctly
- [ ] Touch targets are minimum 44x44px
- [ ] Tab order is logical
- [ ] No keyboard traps

### Testing Tools

**Automated:**
- Chrome DevTools Lighthouse Accessibility Audit
- axe DevTools browser extension

**Manual:**
- Keyboard-only navigation (unplug mouse)
- Screen reader testing (NVDA on Windows, VoiceOver on Mac)
- Color contrast checker in DevTools

**Playwright Accessibility Tests:**
```typescript
// Include in generated test files
import { test, expect } from '@playwright/test'
import { injectAxe, checkA11y } from 'axe-playwright'

test('component is accessible', async ({ page }) => {
  await page.goto('/component')
  await injectAxe(page)
  await checkA11y(page)
})
```

---

**Reference:** https://www.w3.org/WAI/WCAG21/quickref/
**Last Updated:** 2026-02-13
