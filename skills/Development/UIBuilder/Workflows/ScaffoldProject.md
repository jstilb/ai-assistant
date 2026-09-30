---
name: ScaffoldProject
description: Set up new Next.js project with shadcn/ui
---
# Scaffold UI Project

Create a new Next.js project with shadcn/ui, Tailwind CSS, and TypeScript.

## Input

- Project name/directory
- Optional: Configuration preferences

## Output

- Complete Next.js 15+ project
- shadcn/ui initialized
- TypeScript strict mode
- Tailwind CSS configured
- Ready for UIBuilder workflows

## Workflow

### Step 1: Create Next.js Project

```bash
# Interactive creation
npx create-next-app@latest

# Prompts and recommended answers:
# What is your project named? → [user's project name]
# Would you like to use TypeScript? → Yes
# Would you like to use ESLint? → Yes
# Would you like to use Tailwind CSS? → Yes
# Would you like to use `src/` directory? → No
# Would you like to use App Router? → Yes
# Would you like to customize the default import alias (@/*)? → No
```

### Step 2: Navigate to Project

```bash
cd [project-name]
```

### Step 3: Initialize shadcn/ui

```bash
npx shadcn@latest init

# Prompts and recommended answers:
# Which style would you like to use? → Default
# Which color would you like to use as base color? → Slate
# Would you like to use CSS variables for colors? → Yes
```

This creates:
- `components/ui/` directory
- `lib/utils.ts` with `cn()` helper
- Tailwind config with shadcn theme
- CSS variables in `app/globals.css`

### Step 4: Verify Setup

```bash
# Check directory structure
ls -la

# Expected structure:
# app/
# ├── layout.tsx
# ├── page.tsx
# └── globals.css
# components/
# └── ui/           # shadcn components (empty initially)
# lib/
# └── utils.ts      # cn() utility
# node_modules/
# package.json
# tailwind.config.ts
# tsconfig.json
```

### Step 5: Configure TypeScript Strict Mode

Edit `tsconfig.json`:

```json
{
  "compilerOptions": {
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "noImplicitReturns": true,
    "noFallthroughCasesInSwitch": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    // ... other options
  }
}
```

### Step 6: Install Common shadcn Components

```bash
# Install frequently used components
npx shadcn@latest add button card input label
```

### Step 7: Create Component Directory Structure

```bash
# Create custom components directory
mkdir -p components/custom
```

Final structure:
```
app/
├── layout.tsx
├── page.tsx
└── globals.css
components/
├── ui/              # shadcn components
│   ├── button.tsx
│   ├── card.tsx
│   ├── input.tsx
│   └── label.tsx
└── custom/          # UIBuilder-generated components
lib/
└── utils.ts
```

### Step 8: Verify Installation

```bash
# Start dev server
npm run dev

# Open browser to http://localhost:3000
# Should see Next.js welcome page
```

### Step 9: Report Success

```
✅ Project scaffolded successfully!

**Project:** [project-name]
**Location:** [full-path]

**Installed:**
✅ Next.js 15+ (App Router)
✅ TypeScript (strict mode)
✅ Tailwind CSS
✅ shadcn/ui
✅ Initial components: button, card, input, label

**Directory Structure:**
- app/ → Next.js pages and layouts
- components/ui/ → shadcn/ui components
- components/custom/ → Your custom components (UIBuilder generates here)
- lib/ → Utilities (cn() helper)

**Next Steps:**
1. Start dev server: `npm run dev`
2. Use UIBuilder to generate components
3. Components will be created in `components/custom/`

**Ready for UIBuilder workflows:**
- BuildFromText
- BuildFromScreenshot
- BuildFromUrl
```

## Configuration Options

### Minimal Setup (Fast)
- Accept all defaults
- Install no components initially
- Let workflows install components as needed

### Standard Setup (Recommended)
- Accept defaults
- Install common components: button, card, input, label, table, badge
- Create custom components directory

### Complete Setup (Comprehensive)
- Accept defaults
- Install many components: button, card, input, label, table, badge, dialog, dropdown-menu, tabs, alert, checkbox, select, separator
- Create additional directories (layouts, hooks, types)

## Common Modifications

### Add Prettier

```bash
npm install -D prettier prettier-plugin-tailwindcss

# Create .prettierrc
echo '{
  "semi": false,
  "singleQuote": false,
  "tabWidth": 2,
  "trailingComma": "es5",
  "plugins": ["prettier-plugin-tailwindcss"]
}' > .prettierrc
```

### Add Custom Fonts

Update `app/layout.tsx`:

```typescript
import { Inter } from 'next/font/google'

const inter = Inter({ subsets: ['latin'] })

export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <html lang="en">
      <body className={inter.className}>{children}</body>
    </html>
  )
}
```

### Add Dark Mode

shadcn/ui includes dark mode by default via CSS variables.

To add toggle:
```bash
npx shadcn@latest add dropdown-menu

# Then create theme toggle component (UIBuilder can generate this)
```

## Decision Points

**Q: User wants different framework?**
A: UIBuilder is optimized for Next.js + shadcn/ui. For other frameworks:
- Vite + React: Use `npm create vite@latest`, then add shadcn manually
- Remix: Explain shadcn setup is different
- Other: Recommend Next.js or decline

**Q: User wants Vite instead of Next.js?**
A: Possible but requires manual shadcn setup:
```bash
npm create vite@latest my-app -- --template react-ts
cd my-app
npx shadcn@latest init
```

**Q: User wants to add to existing project?**
A: Skip create-next-app, just run:
```bash
npx shadcn@latest init
```

## Failure Recovery

### If create-next-app fails:
- Check Node.js version (need 18+)
- Check internet connection
- Try: `npx create-next-app@latest --use-npm`

### If shadcn init fails:
- Verify Tailwind is installed
- Check `tailwind.config.ts` exists
- Manually create `lib/utils.ts` with cn() if needed

### If dev server won't start:
- Delete node_modules, reinstall: `rm -rf node_modules && npm install`
- Check port 3000 is free: `lsof -i :3000`
- Try different port: `npm run dev -- -p 3001`

---

**Last Updated:** 2026-02-13
