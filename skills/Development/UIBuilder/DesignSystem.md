---
name: DesignSystem
description: Default design tokens, CSS variables, and styling conventions for UIBuilder components
---
# Design System

Default design tokens and conventions for all UIBuilder-generated components.

## CSS Custom Properties (shadcn Theme Tokens)

All components use CSS custom properties from shadcn/ui's design system:

```css
:root {
  --background: 0 0% 100%;
  --foreground: 222.2 84% 4.9%;
  --card: 0 0% 100%;
  --card-foreground: 222.2 84% 4.9%;
  --popover: 0 0% 100%;
  --popover-foreground: 222.2 84% 4.9%;
  --primary: 221.2 83.2% 53.3%;
  --primary-foreground: 210 40% 98%;
  --secondary: 210 40% 96.1%;
  --secondary-foreground: 222.2 47.4% 11.2%;
  --muted: 210 40% 96.1%;
  --muted-foreground: 215.4 16.3% 46.9%;
  --accent: 210 40% 96.1%;
  --accent-foreground: 222.2 47.4% 11.2%;
  --destructive: 0 84.2% 60.2%;
  --destructive-foreground: 210 40% 98%;
  --border: 214.3 31.8% 91.4%;
  --input: 214.3 31.8% 91.4%;
  --ring: 221.2 83.2% 53.3%;
  --radius: 0.5rem;
}

.dark {
  --background: 222.2 84% 4.9%;
  --foreground: 210 40% 98%;
  --card: 222.2 84% 4.9%;
  --card-foreground: 210 40% 98%;
  --popover: 222.2 84% 4.9%;
  --popover-foreground: 210 40% 98%;
  --primary: 217.2 91.2% 59.8%;
  --primary-foreground: 222.2 47.4% 11.2%;
  --secondary: 217.2 32.6% 17.5%;
  --secondary-foreground: 210 40% 98%;
  --muted: 217.2 32.6% 17.5%;
  --muted-foreground: 215 20.2% 65.1%;
  --accent: 217.2 32.6% 17.5%;
  --accent-foreground: 210 40% 98%;
  --destructive: 0 62.8% 30.6%;
  --destructive-foreground: 210 40% 98%;
  --border: 217.2 32.6% 17.5%;
  --input: 217.2 32.6% 17.5%;
  --ring: 224.3 76.3% 48%;
}
```

## Color System

### Semantic Colors (Use These)
```typescript
// In Tailwind classes
"bg-background"           // Page background
"bg-card"                 // Card backgrounds
"bg-primary"              // Primary actions (buttons, links)
"bg-secondary"            // Secondary actions
"bg-muted"                // Subtle backgrounds
"bg-accent"               // Accent elements
"bg-destructive"          // Destructive actions (delete, error)

"text-foreground"         // Primary text
"text-muted-foreground"   // Secondary text
"text-primary-foreground" // Text on primary bg
```

### NEVER Use
```typescript
// ❌ FORBIDDEN - hardcoded colors
"bg-blue-500"
"text-red-600"
"border-gray-200"

// ✅ CORRECT - semantic tokens
"bg-primary"
"text-destructive"
"border-border"
```

## Typography Scale

### Font Sizes
```typescript
"text-xs"     // 0.75rem (12px)
"text-sm"     // 0.875rem (14px)
"text-base"   // 1rem (16px)
"text-lg"     // 1.125rem (18px)
"text-xl"     // 1.25rem (20px)
"text-2xl"    // 1.5rem (24px)
"text-3xl"    // 1.875rem (30px)
"text-4xl"    // 2.25rem (36px)
```

### Font Weights
```typescript
"font-normal"    // 400
"font-medium"    // 500
"font-semibold"  // 600
"font-bold"      // 700
```

### Line Heights
```typescript
"leading-none"     // 1
"leading-tight"    // 1.25
"leading-normal"   // 1.5
"leading-relaxed"  // 1.625
```

## Spacing Scale

### Margin & Padding
```typescript
"p-0"    // 0
"p-1"    // 0.25rem (4px)
"p-2"    // 0.5rem (8px)
"p-3"    // 0.75rem (12px)
"p-4"    // 1rem (16px)
"p-6"    // 1.5rem (24px)
"p-8"    // 2rem (32px)
"p-12"   // 3rem (48px)
"p-16"   // 4rem (64px)
```

### Gap (Flexbox/Grid)
```typescript
"gap-1"   // 0.25rem (4px)
"gap-2"   // 0.5rem (8px)
"gap-4"   // 1rem (16px)
"gap-6"   // 1.5rem (24px)
"gap-8"   // 2rem (32px)
```

## Border Radius

```typescript
"rounded-none"   // 0
"rounded-sm"     // 0.125rem (2px)
"rounded"        // 0.25rem (4px)
"rounded-md"     // 0.375rem (6px)
"rounded-lg"     // 0.5rem (8px) - shadcn default
"rounded-xl"     // 0.75rem (12px)
"rounded-full"   // 9999px
```

## Responsive Breakpoints

Mobile-first approach (min-width):

```typescript
// Base (mobile): < 640px - no prefix
"p-4"

// Tablet: >= 640px
"sm:p-6"

// Desktop: >= 768px
"md:p-8"

// Large Desktop: >= 1024px
"lg:p-12"

// Extra Large: >= 1280px
"xl:p-16"

// 2XL: >= 1536px
"2xl:p-20"
```

### Standard Testing Viewports
- **Mobile:** 375px (iPhone SE)
- **Tablet:** 768px (iPad)
- **Desktop:** 1440px (MacBook Pro)

## Component Structure Conventions

### Always Include
```typescript
interface ComponentProps {
  className?: string  // ✅ REQUIRED - allows composition
  // ... other props
}

export function Component({ className, ...props }: ComponentProps) {
  return (
    <div className={cn(
      "base-classes",  // Component's default styles
      className        // Allow override
    )}>
      {/* ... */}
    </div>
  )
}
```

### cn() Utility
Import from shadcn/ui utils:
```typescript
import { cn } from "@/lib/utils"

// Merges classes intelligently, right-side wins
cn("p-4", "p-8")  // → "p-8"
cn("bg-primary", undefined)  // → "bg-primary"
cn("text-sm", className)  // → composition
```

## Dark Mode

All components support dark mode via CSS custom properties:

```typescript
// ✅ AUTOMATIC - uses semantic tokens
<Card className="bg-card text-card-foreground" />

// ❌ MANUAL - requires dark: prefix
<Card className="bg-white dark:bg-gray-900" />
```

Use semantic tokens for automatic dark mode support.

## Accessibility Requirements

### Color Contrast
- **AA Standard (minimum):** 4.5:1 for normal text, 3:1 for large text
- **AAA Standard (preferred):** 7:1 for normal text, 4.5:1 for large text

shadcn tokens meet AA by default. Verify custom colors with:
```bash
# Use browser DevTools Accessibility Inspector
```

### Focus Indicators
All interactive elements MUST have visible focus:
```typescript
"focus:ring-2 focus:ring-ring focus:ring-offset-2"
```

### Touch Targets
Minimum 44x44px for interactive elements:
```typescript
"min-h-[44px] min-w-[44px]"
```

## File Structure

Generated components should be organized:

```
app/
├── components/
│   ├── ui/              # shadcn components (auto-installed)
│   │   ├── button.tsx
│   │   ├── card.tsx
│   │   └── ...
│   └── custom/          # UIBuilder-generated components
│       ├── Dashboard.tsx
│       ├── UserCard.tsx
│       └── ...
├── lib/
│   └── utils.ts         # cn() utility
└── app/
    ├── layout.tsx
    └── page.tsx
```

## Common Patterns

### Container Widths
```typescript
"max-w-sm"    // 24rem (384px)
"max-w-md"    // 28rem (448px)
"max-w-lg"    // 32rem (512px)
"max-w-xl"    // 36rem (576px)
"max-w-2xl"   // 42rem (672px)
"max-w-4xl"   // 56rem (896px)
"max-w-6xl"   // 72rem (1152px)
"max-w-7xl"   // 80rem (1280px)
```

### Centered Layouts
```typescript
"mx-auto max-w-7xl px-4 sm:px-6 lg:px-8"
```

### Card Spacing
```typescript
"p-6 md:p-8"  // Responsive padding
"space-y-4"   // Vertical stack spacing
```

---

**Reference:** https://ui.shadcn.com/docs/theming
**Last Updated:** 2026-02-13
