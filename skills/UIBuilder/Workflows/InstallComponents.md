---
name: InstallComponents
description: Install shadcn/ui components via CLI
---
# Install shadcn Components

Install shadcn/ui components using the official CLI.

## Input

- Component name(s) to install (e.g., "card", "button table badge")

## Output

- Installed components in `components/ui/`
- Verification of successful installation

## Workflow

### Step 1: Verify shadcn is Initialized

```bash
# Check if shadcn is initialized
ls components/ui/ 2>/dev/null || echo "Not initialized"
```

If not initialized, direct user to ScaffoldProject workflow.

### Step 2: Check if Component Already Installed

```bash
# List components to install
COMPONENTS="card button table"

# Check each
for component in $COMPONENTS; do
  if [ -f "components/ui/${component}.tsx" ]; then
    echo "✓ $component already installed"
  else
    echo "- $component needs installation"
  fi
done
```

### Step 3: Install Components

```bash
# Install all needed components in one command
npx shadcn@latest add card button table badge

# CLI will:
# 1. Download component files
# 2. Place in components/ui/
# 3. Update dependencies if needed
```

### Step 4: Verify Installation

```bash
# Check files were created
ls -la components/ui/

# Verify each component exists
for component in card button table badge; do
  if [ -f "components/ui/${component}.tsx" ]; then
    echo "✅ $component installed"
  else
    echo "❌ $component FAILED"
  fi
done
```

### Step 5: Report Results

```
Installed shadcn components:

✅ card → components/ui/card.tsx
✅ button → components/ui/button.tsx
✅ table → components/ui/table.tsx
✅ badge → components/ui/badge.tsx

You can now import and use these components:
```typescript
import { Card, CardHeader, CardContent } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
```
```

## Available shadcn Components

**Common Components:**
- accordion, alert, avatar, badge, button, card, checkbox, dialog, dropdown-menu
- form, input, label, select, separator, table, tabs, textarea, toast

**Full List:** https://ui.shadcn.com/docs/components

## Decision Points

**Q: Component name unknown?**
A: List common components or link to shadcn docs.

**Q: Component already installed?**
A: Skip installation, report it's available.

**Q: Installation fails?**
A: Check:
1. Project has shadcn initialized
2. Component name is correct
3. Network connection works
4. Node/npm/npx available

**Q: Multiple components needed?**
A: Install all at once: `npx shadcn@latest add card button table badge`

## Failure Recovery

### If shadcn not initialized:
```
❌ shadcn/ui not initialized in this project.

To set up shadcn:
1. Run: npx shadcn@latest init
2. Follow prompts (accept defaults)
3. Then install components

Or use the ScaffoldProject workflow for complete setup.
```

### If component doesn't exist:
```
❌ Component "xyz" not found in shadcn/ui.

Did you mean one of these?
- card
- button
- badge

See all components: https://ui.shadcn.com/docs/components
```

---

**Last Updated:** 2026-02-13
