---
name: Art
description: Complete visual content system. USE WHEN user wants to create visual content, illustrations, diagrams, OR mentions art, header images, visualizations, mermaid, flowchart, technical diagram, infographic, Kaya icon, pack icon, or Kaya pack icon.
---

# Art Skill

Complete visual content system for creating illustrations, diagrams, and visual content.
## 🚨🚨🚨 MANDATORY: Output to Downloads First 🚨🚨🚨

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
⚠️  ALL GENERATED IMAGES GO TO ~/Downloads/ FIRST                   ⚠️
⚠️  NEVER output directly to project directories                    ⚠️
⚠️  User MUST preview in Finder/Preview before use                  ⚠️
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

**This applies to ALL workflows in this skill.**

## Voice Notification

-> Use `notifySync()` from `skills/CORE/Tools/NotificationService.ts`

---

## Workflow Routing

Route to the appropriate workflow based on the request.

  - Blog header or editorial illustration → `Workflows/Essay.md`
  - D3.js interactive chart or dashboard → `Workflows/D3Dashboards.md`
  - Visualization or unsure which format → `Workflows/Visualize.md`
  - Mermaid flowchart or sequence diagram → `Workflows/Mermaid.md`
  - Technical or architecture diagram → `Workflows/TechnicalDiagrams.md`
  - Taxonomy or classification grid → `Workflows/Taxonomies.md`
  - Timeline or chronological progression → `Workflows/Timelines.md`
  - Framework or 2x2 matrix → `Workflows/Frameworks.md`
  - Comparison or X vs Y → `Workflows/Comparisons.md`
  - Annotated screenshot → `Workflows/AnnotatedScreenshots.md`
  - Recipe card or step-by-step → `Workflows/RecipeCards.md`
  - Aphorism or quote card → `Workflows/Aphorisms.md`
  - Conceptual map or territory → `Workflows/Maps.md`
  - Stat card or big number visual → `Workflows/Stats.md`
  - Comic or sequential panels → `Workflows/Comics.md`
  - YouTube thumbnail (generate from content) → `Workflows/AdHocYouTubeThumbnail.md`
  - Kaya pack icon → `Workflows/CreateKayaPackIcon.md`

---

## Core Aesthetic

**Default:** Production-quality concept art style appropriate for editorial and technical content.

**User customization** defines specific aesthetic preferences including:
- Visual style and influences
- Line treatment and rendering approach
- Color palette and wash technique
- Character design specifications
- Scene composition rules

**Configured in:** Art skill defaults and `settings.json` preferences

---

## Reference Images

**User customization** may include reference images for consistent style.

Art skill defaults include:
- Reference image locations
- Style examples by use case
- Character and scene reference guidance

**Usage:** Before generating images, load relevant user-provided references to match their preferred style.

---

## Image Generation

**Default model:** nano-banana-pro (Gemini 3 Pro)
**Fallback:** nano-banana-pro (Gemini 3 Pro)

### 🚨 CRITICAL: Always Output to Downloads First

**ALL generated images MUST go to `~/Downloads/` first for preview and selection.**

Never output directly to a project's `public/images/` directory. User needs to review images in Preview before they're used.

**Workflow:**
1. Generate to `~/Downloads/[descriptive-name].png`
2. User reviews in Preview
3. If approved, THEN copy to final destination (e.g., `cms/public/images/`)
4. Create WebP and thumbnail versions at final destination

```bash
# CORRECT - Output to Downloads for preview
bun run ~/.claude/skills/Art/Tools/Generate.ts \
  --model nano-banana-pro \
  --prompt "[PROMPT]" \
  --size 2K \
  --aspect-ratio 1:1 \
  --thumbnail \
  --output ~/Downloads/blog-header-concept.png

# After approval, copy to final location
cp ~/Downloads/blog-header-concept.png ~/Projects/Website/cms/public/images/
cp ~/Downloads/blog-header-concept-thumb.png ~/Projects/Website/cms/public/images/
```

### Multiple Reference Images (Character/Style Consistency)

For improved character or style consistency, use multiple `--reference-image` flags:

```bash
# Multiple reference images for better likeness
bun run ~/.claude/skills/Art/Tools/Generate.ts \
  --model nano-banana-pro \
  --prompt "Person from references at a party..." \
  --reference-image face1.jpg \
  --reference-image face2.jpg \
  --reference-image face3.jpg \
  --size 2K \
  --aspect-ratio 16:9 \
  --output ~/Downloads/character-scene.png
```

**API Limits (Gemini):**
- Up to 5 human reference images
- Up to 6 object reference images
- Maximum 14 total reference images per request

**API keys in:** `${KAYA_DIR}/.env`

## Examples

**Example 1: Blog header image**
```
User: "create a header for my AI agents post"
→ Invokes ESSAY workflow
→ Generates charcoal sketch prompt
→ Creates image with architectural aesthetic
→ Saves to ~/Downloads/ for preview
→ After approval, copies to public/images/
```

**Example 2: Technical architecture diagram**
```
User: "make a diagram showing the SPQA pattern"
→ Invokes TECHNICALDIAGRAMS workflow
→ Creates structured architecture visual
→ Outputs PNG with consistent styling
```

**Example 3: Comparison visualization**
```
User: "visualize humans vs AI decision-making"
→ Invokes COMPARISONS workflow
→ Creates side-by-side visual
→ Charcoal sketch with labeled elements
```

**Example 4: Kaya pack icon**
```
User: "create icon for the skill system pack"
→ Invokes CREATEKAYAPACKICON workflow
→ Reads workflow from Workflows/CreateKayaPackIcon.md
→ Generates 1K image with --remove-bg for transparency
→ Resizes to 256x256 RGBA PNG
→ Outputs to ~/Downloads/ for preview
→ After approval, copies to ~/Projects/Kaya/Packs/icons/
```

---

## Integration

### Uses
- **Image Generation APIs** - Gemini/Flux via Generate.ts tool
- **Skill defaults** - Aesthetic, model, and output preferences
- **Filesystem** - Output to Downloads, then final destinations

### Feeds Into
- **Blogging** - Header images for blog posts
- **Kaya** - Pack icons for public repository
- **Website projects** - Visual content for web properties

### MCPs Used
- None (direct API calls via Tools/Generate.ts)
