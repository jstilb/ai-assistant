---
name: MoodBoard
description: Build Pinterest-style mood boards / visual collages for inspiration — fashion, interior design, travel, tattoos, anything visual. Searches free, keyless image APIs (Openverse, Wikimedia Commons, the Met), pins images to named boards with attribution + notes, and renders a masonry collage HTML you can open in the browser. USE WHEN mood board, moodboard, pinterest board, collage, visual inspiration, inspo board, gather images, fashion inspiration, interior design ideas, style board, aesthetic board, visual references.
---
# MoodBoard

Gather visual inspiration into named **boards** (like Pinterest boards) and render them as
**masonry collages**. Everything is free and keyless: images come from Openverse (CC-licensed,
mostly Flickr), Wikimedia Commons, and the Met Museum open-access collection — plus Pinterest
via **Claude-in-Chrome** (browsing Jm's live logged-in Chrome; see `Workflows/PinterestPass.md`)
or URLs Jm pastes manually. Every pin keeps its provenance (source, creator, license, landing
page), so collages are fully attributed.

The point is **curation, not just search**: Kaya searches broadly, *looks at the images*
(download them, then view with the Read tool), keeps only what fits the board's theme, and
annotates pins with why they earned their spot.

## How it flows

```
"make me a mood board for my fall wardrobe"
   │
   ▼ BoardStore create          — board = slug + title + theme + tags
   ▼ ImageSearch (xN queries)   — Openverse / Wikimedia / Met, keyless, cached 6h
   ▼ BoardStore add-pin         — dedupe by image-URL hash; notes optional
   ▼ BoardRenderer --download   — fetch images locally, LOOK at them (Read tool),
   │                              remove-pin the misses, re-render
   ▼ ~/.kaya/moodboards/<slug>/index.html  — dark masonry collage, --open in browser
```

Board state lives in `skills/Content/MoodBoard/Data/boards.json` (StateManager, auto-backed-up).
Rendered collages + downloaded images live **outside the repo** at `~/.kaya/moodboards/<slug>/`
so image files never get auto-committed.

## Quick reference

```bash
D=~/.claude/skills/Content/MoodBoard/Tools

# Search (free, no keys; sources: openverse,wikimedia,met)
bun $D/ImageSearch.ts "japandi bedroom" --count 8 --json
bun $D/ImageSearch.ts "1970s menswear" --sources met,wikimedia

# Boards
bun $D/BoardStore.ts create "Fall Fashion 2026" --theme "earth tones, wide silhouettes" --tags fashion,fall
bun $D/BoardStore.ts list
bun $D/BoardStore.ts show fall-fashion-2026

# Pins (from a search-results JSON file, or a pasted URL e.g. from Pinterest)
bun $D/BoardStore.ts add-pin fall-fashion-2026 --file /tmp/candidates.json
bun $D/BoardStore.ts add-pin fall-fashion-2026 --url "https://i.pinimg.com/..." --title "camel overcoat" --note "love the drape"
bun $D/BoardStore.ts note fall-fashion-2026 <pinId> "collar shape is the keeper detail"
bun $D/BoardStore.ts remove-pin fall-fashion-2026 <pinId>

# Render the collage
bun $D/BoardRenderer.ts fall-fashion-2026 --download --open
```

## Workflow Routing

| Trigger | Workflow |
|---------|----------|
| "make/build me a mood board for X", "gather inspiration for X" | `Workflows/BuildBoard.md` — the full curated build (search wide → pin → LOOK → prune → render) |
| Free sources came up short on styled/editorial shots; "pull from Pinterest", "pinterest pass" | `Workflows/PinterestPass.md` — Claude-in-Chrome browse of Pinterest search, pin winners with provenance. Interactive Chrome sessions only; falls back to paste flow |
| "add this to my X board", pasted image URL | `BoardStore.ts add-pin <slug> --url ...` directly |
| "show me my boards / my X board" | `BoardStore.ts list` / `BoardRenderer.ts <slug> --open` |

## Curation guidance (the part that makes boards good)

1. **Fan out queries.** One board deserves 4–8 distinct searches, not one. For "fall wardrobe":
   `"autumn menswear street style"`, `"1970s menswear"` (Met Costume Institute is gold),
   `"wool overcoat"`, `"earth tone outfit"`, texture close-ups, era references.
2. **Pick sources per domain.** Met = fashion history / art / objects. Wikimedia = architecture,
   interiors, reference photos. Openverse = contemporary photography (Flickr). Niche modern
   aesthetics ("japandi") can come up empty on all three — broaden the terms
   ("minimalist wood interior"), fall back to WebSearch + `add-pin --url`, or — for styled
   editorial/whole-room shots the free sources rarely have — run `Workflows/PinterestPass.md`.
3. **Actually look.** Render with `--download`, then Read the files in
   `~/.kaya/moodboards/<slug>/images/` and prune with `remove-pin`. Search relevance is noisy;
   vision is the filter. A 12-pin board that's all hits beats a 40-pin dump.
4. **Annotate.** `note` the *why* on standout pins — that's what makes the board useful later
   (e.g. for the Style system or a room redesign).

## Examples

- "Make me a mood board for redecorating my bedroom — japandi, warm minimalism" →
  create board, fan out interior queries, curate to ~12 pins, render `--download --open`.
- "Start a fashion board for fall, earth tones" → BuildBoard workflow with Met + Openverse.
- "Add https://i.pinimg.com/…jpg to my fall board, note: collar detail" → `add-pin --url … --note …`.
- "Show my boards" → `list`, then `--open` the one Jm asks about.

## Components

| Component | Purpose | Location |
|-----------|---------|----------|
| **ImageSearch** | Keyless multi-source image search (Openverse, Wikimedia, Met) | `Tools/ImageSearch.ts` |
| **BoardStore** | Board + pin persistence (StateManager), dedupe, notes | `Tools/BoardStore.ts` |
| **BoardRenderer** | Masonry-collage HTML + local image download | `Tools/BoardRenderer.ts` |
| **Types** | Zod schemas: Board, Pin, ImageCandidate | `Tools/Types.ts` |

## Customization

No config file needed. Per-invocation knobs: `--sources`, `--count` (search); `--out`
(render dir, default `~/.kaya/moodboards/<slug>`); `--state` (alternate boards.json — tests).
To change the collage aesthetic (dark gallery, 4-col masonry), edit the CSS block in
`Tools/BoardRenderer.ts` `renderBoardHTML()`.

## Voice Notification

Use `notifySync()` from `lib/core/NotificationService.ts` after a board build completes,
e.g. `notifySync("Mood board ready", "fall-fashion-2026 — 12 pins")`.

## Integration

- **Style system** (`Style/` + `StyleProfile.json`): fashion boards are evidence for style
  preferences — link renders from Style notes rather than duplicating images.
- **Pinterest**: no usable API (business-app approval, own-boards only) and headless scraping
  is a dead end (robots.txt disallows; BrightData refuses without KYC — verified 2026-08-26).
  The route is **Claude-in-Chrome**: browse Pinterest in Jm's logged-in Chrome, collect
  `i.pinimg.com` image URLs, `add-pin` with `--page`/`--creator` provenance — full procedure,
  engine rule, and read-only/copyright constraints in `Workflows/PinterestPass.md`. Fallback
  when Chrome isn't connected: Jm pastes pin URLs (`add-pin --url`, source recorded as `manual`).
- **Obsidian**: for a research-flavored board, drop a note in the vault linking to
  `~/.kaya/moodboards/<slug>/index.html` and the standout pins.

## Requirements

- Network for search/download (results disk-cached 6h). No API keys, no subscriptions — all
  three sources are free per the FREE-infra constraint.
- Pinterest pass only: an interactive session with `mcp__claude-in-chrome__*` connected
  (in practice the `bin/claude-browser` session). Not required for the keyless sources.
