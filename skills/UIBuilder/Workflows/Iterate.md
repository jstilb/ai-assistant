---
name: Iterate
description: Single-change iteration loop for component refinement
---
# Iterate on Component

Make precisely ONE change at a time with immediate visual verification.

## Principle: One Change at a Time

**CRITICAL:** Apply exactly ONE change per iteration cycle.

**Why:**
- Isolates cause and effect
- Prevents compound errors
- Makes debugging trivial
- Clear feedback loop

**Example:**
```
User: "Make the header sticky and increase spacing and change the color"

❌ WRONG: Apply all three changes
✅ CORRECT:
  1. Make header sticky → preview → approve
  2. Increase spacing → preview → approve
  3. Change color → preview → approve
```

## Input

User feedback (may contain multiple requested changes)

## Output

- Updated component (ONE change applied)
- Browser screenshot showing the change
- Confirmation or next iteration

## Workflow

### Step 1: Parse Feedback

If user provides **multiple** changes:

```
User: "Make the header sticky, increase padding, and use blue instead of gray"

Response:
"I see three changes:
1. Make header sticky
2. Increase padding
3. Change gray to blue

I'll apply them one at a time for clear verification. Starting with: Make header sticky"
```

### Step 2: Apply Single Change

Make ONLY the highest priority change (or ask user which to do first).

**Code Changes:**
- Locate affected component
- Make minimal edit (change one class, one prop, one line)
- Save file

**Example - Making header sticky:**
```typescript
// Before
<header className="w-full border-b">

// After (ONE change)
<header className="sticky top-0 z-50 w-full border-b bg-background">
```

### Step 3: Verify Compilation

```bash
tsc --noEmit
```

If errors: Fix immediately, don't proceed.

### Step 4: Browser Preview

Use Browse.ts CLI to preview the change:

```bash
# Navigate and get full diagnostics (screenshot + console + network)
bun run ~/.claude/skills/Browser/Tools/Browse.ts http://localhost:3000/component
# Check for console errors specifically
bun run ~/.claude/skills/Browser/Tools/Browse.ts errors
```

### Step 5: Present Change

Show user:

```
✅ Change applied: Header is now sticky

Screenshot:
[Display browser screenshot]

Diagnostic:
✅ No console errors
✅ Layout maintained
✅ Scroll behavior working

Next: Would you like me to apply the next change (increase padding)?
```

### Step 6: Wait for Feedback

**User says:** "Looks good, do the next change"
→ Go to Step 2 with next change

**User says:** "Actually, undo that"
→ Revert the change, ask what to do instead

**User says:** "Change the sticky positioning"
→ Iterate on this specific change (don't move to next)

**User says:** "Perfect, all done"
→ Final review, mark complete

## Change Categories & Approach

### Visual/Style Changes
- **Examples:** "Make it blue", "Increase spacing", "Larger text"
- **Approach:** Modify className only
- **Preview:** Single screenshot sufficient

### Layout Changes
- **Examples:** "Make header sticky", "Change to grid", "Center align"
- **Approach:** Modify structural classes or elements
- **Preview:** Screenshots at all 3 breakpoints (layout may differ)

### Behavioral Changes
- **Examples:** "Open on click not hover", "Add validation", "Disable button when loading"
- **Approach:** Modify logic/state
- **Preview:** Screenshots + interaction test

### Content Changes
- **Examples:** "Change button text", "Add description", "Remove section"
- **Approach:** Modify JSX content
- **Preview:** Single screenshot

## Decision Points

**Q: User says "make it better" without specifics?**
A: Ask clarifying questions:
```
"What specifically would you like to improve? For example:
- Colors or styling?
- Layout or spacing?
- Component behavior?
- Content or text?"
```

**Q: Change requires adding new shadcn component?**
A: This is still ONE change. Steps:
1. Install component: `npx shadcn@latest add [component]`
2. Import and use in code
3. Preview
4. Present

**Q: Change breaks responsive design?**
A: Report immediately with screenshots:
```
⚠️ Issue found: Change works on desktop but breaks on mobile

Desktop (1440px): [screenshot - works]
Mobile (375px): [screenshot - text overflow]

Should I:
1. Revert this change
2. Fix the mobile breakpoint (add responsive classes)
3. Try a different approach
```

**Q: User wants to batch changes "for speed"?**
A: Politely decline, explain why:
```
I work best applying one change at a time - it prevents compound errors and makes debugging instant. This actually saves time in the long run.

We can move quickly through changes (each iteration takes 10-20 seconds), but we'll verify each one individually.
```

## Iteration Patterns

### Fast Iteration (Simple Changes)
```
1. Change className
2. Screenshot desktop
3. Present → User approves → Next
(~15 seconds per iteration)
```

### Careful Iteration (Complex Changes)
```
1. Change logic/structure
2. Screenshot all 3 breakpoints
3. Check console/network
4. Present → User reviews → Discuss → Next
(~45 seconds per iteration)
```

### Exploratory Iteration (User unsure)
```
1. Try option A
2. Screenshot → Present
3. User: "Hmm, can you try option B?"
4. Revert → Try option B
5. Screenshot → Present
6. User: "Option A was better"
7. Revert → Apply option A → Done
```

## Failure Recovery

### If change causes error:
```
❌ TypeScript error after change:
[show error]

Reverting change and trying alternative approach...
```

### If change breaks visually:
```
⚠️ Change applied but layout broken:
[screenshot showing issue]

Should I:
1. Revert
2. Fix the issue (adjust responsive classes)
3. Try different approach
```

### If user requests impossible change:
```
I can't [exact request] because [technical limitation].

Instead, I can:
1. [Alternative approach 1]
2. [Alternative approach 2]

Which would you prefer?
```

## Integration Points

- **Called From:** BuildFromText, BuildFromScreenshot, BuildFromUrl (after initial generation)
- **Uses:** Browser skill Browse.ts CLI (preview), TypeScript compiler (verification)
- **Loops:** Continuously until user approves

---

**Last Updated:** 2026-02-13
