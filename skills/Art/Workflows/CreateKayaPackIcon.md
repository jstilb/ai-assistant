# Kaya Pack Icon Workflow

**Generate 256x256 transparent PNG icons for Kaya packs.**

---

## Purpose

Create consistent, professional icons for Kaya packs following the established visual identity.

**Use for:** New pack icons, icon refreshes, icon regeneration.

---

## Visual Specifications

### Required Specs

| Spec | Value |
|------|-------|
| **Dimensions** | 256x256 pixels |
| **Format** | PNG with transparency |
| **Background** | ACTUAL transparent (not checkerboard) |
| **Primary Color** | Electric blue #4a90d9 |
| **Accent Color** | Purple #8b5cf6 (10-15% max) |
| **Style** | Simple, flat, readable at 64x64 |

### Color Palette

```
Background:     Transparent (actual transparency, not pattern)
Primary:        Electric Blue #4a90d9 (dominant color)
Accent:         Purple #8b5cf6 (sparingly, 10-15% of design)
Optional Dark:  Dark #0a0a0f (for contrast elements if needed)
```

### Design Rules

1. **Simple geometry** - Icon must be readable at 64x64 pixels
2. **Conceptual** - Represent the pack's core function visually
3. **Consistent style** - Match existing Kaya pack icons
4. **No text** - Icons should work without labels
5. **Centered** - Icon should be centered in the 256x256 canvas

---

## Workflow Steps

### Step 1: Understand Pack Purpose

Before generating, understand:
- What does this pack do?
- What visual metaphor represents it?
- How should it relate to other pack icons?

**Good icon concepts:**
- `kaya-hook-system` → Hook shape, event trigger
- `kaya-core-install` → Download/install arrow
- `kaya-skill-system` → Brain/routing/capability
- `kaya-agent-system` → Robot/assistant figure
- `kaya-voice-system` → Sound wave/speaker

### Step 2: Construct Prompt

Build a prompt that specifies:
1. The visual concept
2. The style (simple flat icon)
3. The color palette
4. The size requirements

**Prompt template:**
```
[VISUAL CONCEPT representing {pack function}], simple flat icon design, 256x256 pixels.
COLOR PALETTE: Primary electric blue (#4a90d9), Accent purple (#8b5cf6) sparingly.
STYLE: Modern flat icon, simple enough to read at 64x64, no text, centered.
BACKGROUND: Dark (#0a0a0f) - will be removed for transparency.
```

### Step 3: Generate Icon

**Command:**
```bash
bun run ~/.claude/skills/Art/Tools/Generate.ts \
  --model nano-banana-pro \
  --prompt "[YOUR_PROMPT]" \
  --size 1K \
  --aspect-ratio 1:1 \
  --remove-bg \
  --output ~/Projects/Kaya/Packs/icons/[PACK_NAME].png
```

**Flags explained:**
- `--model nano-banana-pro` - Best quality for icons
- `--size 1K` - Small file, fast generation
- `--aspect-ratio 1:1` - Square for icons
- `--remove-bg` - Creates actual transparency

### Step 4: Verify Output

Check the generated icon:
```bash
# Verify file exists and size
ls -la ~/Projects/Kaya/Packs/icons/[PACK_NAME].png

# Check dimensions (requires imagemagick)
file ~/Projects/Kaya/Packs/icons/[PACK_NAME].png
```

**Verification checklist:**
- [ ] File exists at correct location
- [ ] PNG format
- [ ] Approximately 256x256 dimensions
- [ ] Has transparency (no solid background)
- [ ] Uses blue/purple palette
- [ ] Readable at small size

---

## Examples

### Example 1: Hook System Pack

```bash
bun run ~/.claude/skills/Art/Tools/Generate.ts \
  --model nano-banana-pro \
  --prompt "A stylized hook or fishing hook shape representing event hooks in software, simple flat icon design, 256x256 pixels. COLOR PALETTE: Primary electric blue (#4a90d9), Accent purple (#8b5cf6) sparingly. STYLE: Modern flat icon, simple enough to read at 64x64, no text, centered. BACKGROUND: Dark (#0a0a0f)." \
  --size 1K \
  --aspect-ratio 1:1 \
  --remove-bg \
  --output ~/Projects/Kaya/Packs/icons/kaya-hook-system.png
```

### Example 2: Core Install Pack

```bash
bun run ~/.claude/skills/Art/Tools/Generate.ts \
  --model nano-banana-pro \
  --prompt "A download arrow pointing into a foundation/base structure representing core installation, simple flat icon design, 256x256 pixels. COLOR PALETTE: Primary electric blue (#4a90d9), Accent purple (#8b5cf6) sparingly. STYLE: Modern flat icon, simple enough to read at 64x64, no text, centered. BACKGROUND: Dark (#0a0a0f)." \
  --size 1K \
  --aspect-ratio 1:1 \
  --remove-bg \
  --output ~/Projects/Kaya/Packs/icons/kaya-core-install.png
```

### Example 3: Memory System Pack

```bash
bun run ~/.claude/skills/Art/Tools/Generate.ts \
  --model nano-banana-pro \
  --prompt "A brain with memory/data flowing in and out representing an AI memory system, simple flat icon design, 256x256 pixels. COLOR PALETTE: Primary electric blue (#4a90d9), Accent purple (#8b5cf6) sparingly. STYLE: Modern flat icon, simple enough to read at 64x64, no text, centered. BACKGROUND: Dark (#0a0a0f)." \
  --size 1K \
  --aspect-ratio 1:1 \
  --remove-bg \
  --output ~/Projects/Kaya/Packs/icons/kaya-memory-system.png
```

---

## Output Location

All Kaya pack icons go to:
```
~/Projects/Kaya/Packs/icons/[PACK_NAME].png
```

**Naming convention:** Match the pack directory name exactly.
- Pack: `Packs/kaya-hook-system/`
- Icon: `Packs/icons/kaya-hook-system.png`

---

## Regeneration

If an icon needs to be regenerated:

1. Delete the old icon
2. Run the generate command with updated prompt
3. Verify the new icon
4. Update README if icon changed significantly

---

## Validation Checklist

Before marking icon complete:

- [ ] **Exists** at `~/Projects/Kaya/Packs/icons/[PACK_NAME].png`
- [ ] **Format** is PNG with transparency
- [ ] **Size** approximately 256x256
- [ ] **Colors** use blue primary, purple accent
- [ ] **Readable** at 64x64 size
- [ ] **Conceptual** - represents pack function
- [ ] **Consistent** - matches other Kaya icons in style

---

## Related Workflows

- `~/.claude/skills/Kaya/Workflows/CreatePack.md` - Uses this for icon generation
- `~/.claude/skills/Kaya/Workflows/ValidatePack.md` - Validates icon exists
- `~/.claude/skills/Kaya/Workflows/KayaIntegrityCheck.md` - Checks all icons

---

**Last Updated:** 2026-01-10
