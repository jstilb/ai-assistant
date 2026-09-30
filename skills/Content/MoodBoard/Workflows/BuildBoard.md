# Build Board Workflow

Build a curated mood board from a theme Jm gives ("fall wardrobe", "japandi bedroom",
"desert road trip"). The bar is a board where every pin earns its place — search wide,
then curate by actually looking at the images.

## Steps

1. **Create the board**
   ```bash
   D=~/.claude/skills/Content/MoodBoard/Tools
   bun $D/BoardStore.ts create "<Title>" --theme "<one-line creative direction>" --tags <t1,t2>
   ```
   Note the slug it prints.

2. **Fan out searches** — 4–8 distinct queries covering angles of the theme
   (era references, materials/textures, specific garments/furniture, color palette, mood):
   ```bash
   bun $D/ImageSearch.ts "<query>" --count 8 --json > /tmp/mb-<n>.json
   ```
   Source picks: Met for fashion history/art, Wikimedia for interiors/architecture,
   Openverse for contemporary photography. Empty results on a niche term → broaden it,
   or WebSearch and collect direct image URLs instead. If the board needs styled
   editorial/whole-room shots the free sources don't carry, follow up with
   `PinterestPass.md` (Claude-in-Chrome; interactive sessions only).

3. **Pin the plausible candidates** — flatten each result's `results[].candidates`,
   keep the ones whose title/creator/source plausibly fit, write them to a JSON array file:
   ```bash
   bun $D/BoardStore.ts add-pin <slug> --file /tmp/mb-candidates.json
   ```
   (Duplicates are auto-skipped by image-URL hash.) Pasted URLs from Jm:
   `add-pin <slug> --url <imageUrl> --title "<t>" --note "<why>"`.

4. **Render with download, then LOOK**
   ```bash
   bun $D/BoardRenderer.ts <slug> --download
   ```
   Read each file in `~/.kaya/moodboards/<slug>/images/` with the Read tool. Prune anything
   off-theme, low-quality, or redundant:
   ```bash
   bun $D/BoardStore.ts remove-pin <slug> <pinId>
   ```
   Target ~10–16 keepers. Add `note`s on the standouts (what specifically works).

5. **Final render + deliver**
   ```bash
   bun $D/BoardRenderer.ts <slug> --download --open
   ```
   Report: board slug, pin count, collage path, and 2–3 sentences on the visual direction
   that emerged. `notifySync()` if this ran in the background.

## Troubleshooting

- **All sources empty**: term too niche/modern — decompose the aesthetic into concrete
  nouns ("japandi" → "minimalist wood interior", "shoji screen", "wabi sabi ceramics").
- **A source FAILED**: the other sources still return; exit stays 0 if any succeeded.
- **Download failures**: renderer falls back to hotlinking that pin — collage still works.
- **`.tif` originals from Wikimedia**: display uses `thumbUrl` (rendered JPG), so fine.
