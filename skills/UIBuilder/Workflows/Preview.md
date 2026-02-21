---
name: Preview
description: Browser preview at multiple breakpoints with diagnostics
---
# Preview Component

Browser preview with screenshots at responsive breakpoints and diagnostic checks.

## Input

- Component route/URL
- Optional: Specific breakpoints to test

## Output

- Screenshots at 3 breakpoints (mobile, tablet, desktop)
- Console error report
- Network request status
- Diagnostic summary

## Workflow

### Step 1: Verify Dev Server Running

```bash
# Check if dev server is running on common ports
lsof -i :3000 || lsof -i :3001 || lsof -i :5173

# If not running, prompt user:
"Development server not running. Please start it with:"
"  npm run dev    (or bun dev, yarn dev)"
```

### Step 2: Preview at Mobile (375px)

```bash
# Using Browse.ts CLI:
bun run ~/.claude/skills/Browser/Tools/Browse.ts eval "await page.setViewportSize({width: 375, height: 812})"
bun run ~/.claude/skills/Browser/Tools/Browse.ts http://localhost:3000/component
# Output includes screenshot + console errors + network stats
```

### Step 3: Preview at Tablet (768px)

```bash
bun run ~/.claude/skills/Browser/Tools/Browse.ts eval "await page.setViewportSize({width: 768, height: 1024})"
bun run ~/.claude/skills/Browser/Tools/Browse.ts http://localhost:3000/component
```

### Step 4: Preview at Desktop (1440px)

```bash
bun run ~/.claude/skills/Browser/Tools/Browse.ts eval "await page.setViewportSize({width: 1440, height: 900})"
bun run ~/.claude/skills/Browser/Tools/Browse.ts http://localhost:3000/component
# Full diagnostics: screenshot + console + network + page status
bun run ~/.claude/skills/Browser/Tools/Browse.ts snapshot
# Saves accessibility tree as YAML for element inspection
```

### Step 5: Analyze Diagnostics

Check for issues:

**Console Errors:**
- JavaScript errors
- React warnings
- Failed prop validations

**Network Issues:**
- 404s (missing assets)
- 500s (API errors)
- Slow requests (> 1s)

**Visual Issues:**
- Text overflow
- Overlapping elements
- Missing images
- Broken layouts

### Step 6: Present Results

**If all clean:**
```
✅ Component Preview

Mobile (375px):
[screenshot]

Tablet (768px):
[screenshot]

Desktop (1440px):
[screenshot]

Diagnostics:
✅ No console errors
✅ All network requests successful
✅ Responsive layout working
✅ Page load time: 1.2s

Component is ready!
```

**If issues found:**
```
⚠️ Component Preview (Issues Found)

Mobile (375px):
[screenshot]
⚠️ Text overflow in card description

Tablet (768px):
[screenshot]
✅ Looks good

Desktop (1440px):
[screenshot]
✅ Looks good

Console Errors (2):
1. Warning: Each child in list should have unique "key" prop
2. Error: Cannot read property 'map' of undefined

Network Issues (1):
- GET /api/users → 404 Not Found

Would you like me to fix these issues?
```

## Breakpoint Presets

### Default (Mobile-First)
- Mobile: 375x812 (iPhone SE)
- Tablet: 768x1024 (iPad)
- Desktop: 1440x900 (MacBook Pro)

### Compact (Quick check)
- Mobile: 375x812
- Desktop: 1440x900

### Comprehensive
- Mobile: 375x812
- Tablet: 768x1024
- Desktop Small: 1024x768
- Desktop: 1440x900
- Desktop Large: 1920x1080

### Custom
User can specify: "Preview at 1024px and 1920px"

## Quick Preview Mode

For rapid iteration, single-breakpoint preview:

```
User: "Quick preview"

→ Take screenshot at desktop (1440px) only
→ Report console errors only
→ Skip network analysis
```

## Integration with Browser Skill

For debugging, use Browser skill's Browse.ts:

```bash
bun ~/.claude/skills/Browser/Tools/Browse.ts http://localhost:3000/component

# Returns:
# - Screenshot
# - Console errors (detailed)
# - Network requests (all)
# - Failed requests (highlighted)
# - Performance metrics
```

## Decision Points

**Q: Dev server not running?**
A: Provide start command, wait for user to start it.

**Q: Component route doesn't exist?**
A: Ask user for correct route or show available routes.

**Q: Preview shows white screen?**
A: Check console errors, likely React error boundary triggered.

**Q: User wants to see specific interaction?**
A: Use Browse.ts CLI interaction commands:
```bash
bun run ~/.claude/skills/Browser/Tools/Browse.ts click "<selector>"
bun run ~/.claude/skills/Browser/Tools/Browse.ts fill "<selector>" "<value>"
bun run ~/.claude/skills/Browser/Tools/Browse.ts screenshot
```

## Failure Recovery

### If page won't load:
```
❌ Page failed to load

Console error:
[error message]

Possible causes:
1. Dev server not running
2. Wrong URL
3. Component has runtime error
4. Missing dependencies

Please verify dev server is running and component exists.
```

### If screenshots fail:
```
❌ Screenshot failed

Falling back to Browser skill:
[Using Browse.ts for debugging]
```

---

**Last Updated:** 2026-02-13
