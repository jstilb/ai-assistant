---
name: DesignTokens
description: UISpec-owned design token system — color, spacing, typography, radius, shadow — with the tokens-by-name rule. Maintained independently of UIBuilder.
---
# Design Tokens — UISpec Reference

> **UISpec-owned.** This file is maintained independently of UIBuilder's DesignSystem.md. Decisions about token naming and the tokens-by-name rule are made here; UIBuilder's copy may diverge.

## The Tokens-by-Name Rule

**Never use raw hex, rgb(), hsl(), or bare px values in a UISpec wireframe or spec.**

```
# Forbidden
color: #3b82f6
background: rgb(248, 250, 252)
font-size: 16px
border-radius: 6px

# Required — token names or Tailwind classes
bg-primary
text-muted-foreground
text-base
rounded-md
```

The only exception: Tailwind bracket notation for WCAG touch-target enforcement (e.g. `min-h-[44px]`). This is a constraint value, not a design value, and must be annotated as such.

---

## Color Tokens

All color tokens map to the shadcn/ui CSS custom property system. Reference tokens by their Tailwind semantic class.

### Background Colors

| Token Class | Semantic Role | Use When |
|-------------|---------------|----------|
| `bg-background` | Page/app background | Main page backdrop |
| `bg-card` | Card / panel surface | Any elevated surface |
| `bg-popover` | Floating surface (tooltip, dropdown) | Overlays, popovers |
| `bg-primary` | Primary brand / action | Primary buttons, selected states |
| `bg-secondary` | Secondary action / muted surface | Secondary buttons, chips |
| `bg-muted` | Subtle tonal background | Input fills, section dividers |
| `bg-accent` | Accent highlight | Hover states, spotlight areas |
| `bg-destructive` | Destructive / error action | Delete buttons, error banners |

### Text Colors

| Token Class | Semantic Role | Use When |
|-------------|---------------|----------|
| `text-foreground` | Primary body text | All main readable text |
| `text-muted-foreground` | Secondary / subdued text | Captions, placeholders, helper text |
| `text-primary-foreground` | Text on primary bg | Labels inside primary buttons |
| `text-secondary-foreground` | Text on secondary bg | Labels inside secondary buttons |
| `text-destructive` | Error / danger text | Inline validation errors |
| `text-accent-foreground` | Text on accent bg | Active/selected item labels |
| `text-card-foreground` | Text on card surface | Card body content |

### Border and Input Colors

| Token Class | Use When |
|-------------|----------|
| `border-border` | Default borders (cards, dividers, input outlines) |
| `border-input` | Input field borders specifically |
| `ring-ring` | Focus ring (always pair with `ring-2 ring-offset-2`) |

### State-Modifier Colors

Apply these to convey interactive state — do not invent new hex values:

| State | Color approach |
|-------|----------------|
| Disabled | `opacity-50` on the element |
| Hover | `hover:bg-accent hover:text-accent-foreground` |
| Active/pressed | `active:opacity-90` |
| Selected | `bg-primary text-primary-foreground` |
| Error | `border-destructive` + `text-destructive` |
| Success | `text-foreground` + a success `Badge` or `Alert` (no ad-hoc green token) |

---

## Spacing Tokens

Use the Tailwind spacing scale. Never specify padding/margin in raw pixels.

### Padding

| Token | Value | Use When |
|-------|-------|----------|
| `p-0` | 0 | Reset |
| `p-1` | 4px | Micro gaps, icon internal spacing |
| `p-2` | 8px | Tight inline padding |
| `p-3` | 12px | Compact padding (badges, chips) |
| `p-4` | 16px | Standard element padding |
| `p-5` | 20px | Medium section padding |
| `p-6` | 24px | Card padding (default) |
| `p-8` | 32px | Generous section padding |
| `p-12` | 48px | Page-level vertical sections |
| `p-16` | 64px | Hero sections |

Directional variants follow the same scale: `px-4`, `py-6`, `pt-8`, `pb-4`, etc.

### Gap (Flexbox / Grid)

| Token | Value | Use When |
|-------|-------|----------|
| `gap-1` | 4px | Tightest spacing (icon + label) |
| `gap-2` | 8px | Close groupings |
| `gap-3` | 12px | Related items |
| `gap-4` | 16px | Standard row/column gap |
| `gap-6` | 24px | Section-level gap |
| `gap-8` | 32px | Wide grid gap |

### Vertical Stack Spacing

| Token | Use When |
|-------|----------|
| `space-y-1` | Tightest list items |
| `space-y-2` | Form field + label pairs |
| `space-y-4` | Standard stacked components |
| `space-y-6` | Section-level stacking |
| `space-y-8` | Major page sections |

---

## Typography Tokens

### Font Size Scale

| Token | Value | Use When |
|-------|-------|----------|
| `text-xs` | 12px | Captions, legal, timestamps |
| `text-sm` | 14px | Helper text, secondary labels, table cells |
| `text-base` | 16px | Body text (default) |
| `text-lg` | 18px | Lead text, card titles |
| `text-xl` | 20px | Section headings (h3 level) |
| `text-2xl` | 24px | Section headings (h2 level) |
| `text-3xl` | 30px | Page headings (h1 on sub-pages) |
| `text-4xl` | 36px | Hero headings |

### Font Weight

| Token | Value | Use When |
|-------|-------|----------|
| `font-normal` | 400 | Body text |
| `font-medium` | 500 | Labels, navigation items |
| `font-semibold` | 600 | Card titles, section headings |
| `font-bold` | 700 | Page headings, strong emphasis |

### Line Height

| Token | Value | Use When |
|-------|-------|----------|
| `leading-none` | 1 | Headlines with tight stacking |
| `leading-tight` | 1.25 | Headings |
| `leading-normal` | 1.5 | Body text |
| `leading-relaxed` | 1.625 | Long-form / readable body copy |

---

## Border Radius Tokens

| Token | Value | Use When |
|-------|-------|----------|
| `rounded-none` | 0 | Sharp-edge elements (tables, ruled lines) |
| `rounded-sm` | 2px | Subtle rounding (badges, chips) |
| `rounded` | 4px | Small elements |
| `rounded-md` | 6px | Inputs, select triggers |
| `rounded-lg` | 8px | Cards, modals, popovers (shadcn default via `--radius`) |
| `rounded-xl` | 12px | Large surfaces, image containers |
| `rounded-2xl` | 16px | Hero cards, featured sections |
| `rounded-full` | 9999px | Pill buttons, avatars, badges |

---

## Shadow Tokens

| Token | Use When |
|-------|----------|
| `shadow-none` | Flush elements (inline components) |
| `shadow-sm` | Subtle elevation (cards on bg-background) |
| `shadow` | Default elevation (dropdowns, tooltips) |
| `shadow-md` | Medium elevation (modals, popovers) |
| `shadow-lg` | High elevation (dialogs, command palettes) |

---

## Breakpoint Tokens (Responsive)

Mobile-first. Breakpoints are modifiers, not standalone tokens:

| Prefix | Min-width | Use For |
|--------|-----------|---------|
| _(none)_ | 0 | Mobile-first base styles |
| `sm:` | 640px | Tablet portrait |
| `md:` | 768px | Tablet landscape |
| `lg:` | 1024px | Desktop |
| `xl:` | 1280px | Large desktop |
| `2xl:` | 1536px | Extra large |

Standard testing viewports: **320px** (mobile min), **375px** (iPhone SE), **768px** (iPad), **1440px** (MacBook Pro).

---

## Quick Reference — What to Never Do

| Forbidden | Use Instead |
|-----------|-------------|
| `color: #3b82f6` | `text-primary` |
| `background: #f8fafc` | `bg-muted` |
| `border: 1px solid #e2e8f0` | `border border-border` |
| `font-size: 14px` | `text-sm` |
| `padding: 16px` | `p-4` |
| `border-radius: 8px` | `rounded-lg` |
| `box-shadow: 0 1px 2px ...` | `shadow-sm` |

---

**Maintained by:** UISpec skill  
**WCAG alignment:** WCAG 2.2 AA (shadcn default tokens meet AA contrast; verify custom themes)  
**Last reviewed:** 2026-06-07
