---
name: WorldBuilder
description: Campaign world creation with regional mapping, locations, NPCs, and factions
trigger: "build a world, create a region, world builder, campaign setting, create a kingdom, design a city"
mode: architect
---

# World Builder

Campaign world creation workflow: define scope, generate maps, create locations, populate with NPCs and factions, and save everything to campaign state.

## When to Use

The DM is starting a new campaign or expanding into a new region. This workflow creates the foundational setting material: geography, key locations, notable NPCs, and faction dynamics. It produces a living document that grows with the campaign.

## Steps

### Step 1: Define Scope

Determine the scale of what the DM wants to build:

| Scope | Description | Map Type | Detail Level |
|-------|-------------|----------|--------------|
| **World** | Entire world/continent | world map | Low (major regions, oceans) |
| **Region** | Kingdom or province | regional map | Medium (cities, roads, landmarks) |
| **City** | Single settlement | battlemap/dungeon | High (districts, buildings, NPCs) |
| **Dungeon** | Adventure site | dungeon map | Very high (rooms, traps, encounters) |

Ask the DM:
- What scale? (world / region / city / dungeon)
- What genre/tone? (high fantasy, dark, gritty, comedic, political)
- Any existing lore to build on?
- Inspiration sources? (Lord of the Rings, Dark Souls, Eberron, etc.)

### Step 2: Generate Map

```bash
bun Tools/MapPrompt.ts --type <world|regional|battlemap|dungeon> --theme "<setting-theme>" --features "<key-features>" --json
```

**World map:**
```bash
bun Tools/MapPrompt.ts --type world --theme "high fantasy continent" --features "mountain range, inland sea, desert, archipelago" --json
```

**Regional map:**
```bash
bun Tools/MapPrompt.ts --type regional --theme "gothic kingdom" --features "dark forest, river delta, walled capital, ruins" --json
```

**City map:**
```bash
bun Tools/MapPrompt.ts --type battlemap --theme "medieval city" --features "castle, market district, harbor, slums, temple quarter" --json
```

Map saved to `~/Downloads/dnd-maps/`. Present to the DM for feedback.

### Step 3: Create Key Locations

For each scope level, generate 3-7 key locations. Each location includes:

```
**Name:** The Thornwood
**Type:** Ancient Forest
**Description:** A vast, primeval forest where the trees grow so thick that
  sunlight never reaches the forest floor. Home to wood elves, fey creatures,
  and something ancient that sleeps beneath the roots.
**Key Feature:** The Heartwood -- a massive tree at the center that is actually
  a sealed portal to the Feywild.
**Hooks:**
  - Loggers from the nearby town are disappearing
  - A druid circle guards the Heartwood and distrusts outsiders
  - Pixies have been stealing from travelers more aggressively than usual
**Connections:** Borders the Kingdom of Valdris, road to Ironhaven passes through
```

Generate location descriptions using AI inference for creativity, then organize them geographically relative to the map.

### Step 4: Generate Notable NPCs

For each key location, create 1-2 notable NPCs:

```
**Name:** Elder Sylvara
**Race/Class:** Wood Elf Druid (CR 5)
**Location:** The Thornwood (Heartwood grove)
**Role:** Guardian of the Heartwood, leader of the Circle of Thorns
**Personality:** Patient and wise, but fiercely protective. Speaks in metaphors.
**Motivation:** Protect the Feywild portal from those who would exploit it.
**Secret:** She has been drawing power from the portal to extend her life,
  and it is weakening the seal.
**Key Quote:** "The forest remembers what you have forgotten."
```

For combat-relevant NPCs, generate stat blocks:
```bash
bun Tools/MonsterGenerator.ts --cr <n> --type humanoid --name "<name>" --json
```

### Step 5: Create Faction Relationships

Define 3-5 factions and their relationships:

```
Factions:
  1. The Crown (Kingdom of Valdris) - Political power, wants expansion
  2. Circle of Thorns (Thornwood druids) - Protect nature, resist civilization
  3. Iron Guild (Ironhaven merchants) - Commerce, want logging rights
  4. The Unseelie Court (Feywild fey) - Chaos, want the portal opened
  5. Order of the Silver Flame (temple knights) - Purge darkness, zealous

Relationships:
  Crown <-> Circle of Thorns: HOSTILE (land dispute)
  Crown <-> Iron Guild: ALLIED (mutual profit)
  Circle of Thorns <-> Unseelie Court: WARY (shared territory, different goals)
  Iron Guild <-> Circle of Thorns: HOSTILE (logging vs preservation)
  Order of Silver Flame <-> everyone: SUSPICIOUS (they answer to a higher power)
```

Present as a relationship web:
```
        Crown ----ALLIED---- Iron Guild
          |                      |
       HOSTILE              HOSTILE
          |                      |
     Circle of Thorns ----WARY---- Unseelie Court
          |
      NEUTRAL
          |
     Silver Flame (suspicious of all)
```

### Step 6: Save to Campaign State

Save all generated content:

```bash
bun Tools/CampaignState.ts create "<campaign-name>" --setting "<world-name>"
```

Then update with locations, NPCs, and factions:
```bash
bun Tools/CampaignState.ts update <campaign-id> --add-location '<location-json>'
bun Tools/CampaignState.ts update <campaign-id> --add-npc '<npc-json>'
```

**Voice notification:**
```
notifySync("World building complete with <n> locations and <n> NPCs")
```

## Example

```
User: "Build me a dark fantasy kingdom for a new campaign"

Kaya: Building a regional setting...

What's the tone?
User: "Gothic horror meets political intrigue, like Curse of Strahd meets Game of Thrones"

[MapPrompt] Generating regional map: "Gothic kingdom with dark forests,
  mountain fortress, cursed swampland, and a capital city on a river"

## The Kingdom of Morthaven

**Tone:** Gothic horror, political intrigue
**Scale:** Regional (1 kingdom, ~200 miles across)

### Key Locations (5):

1. **Duskwall** (Capital)
   Walled city on the River Mor. Seat of the ruling Blackthorne family.
   Population ~15,000. Known for its perpetual fog and clock tower.

2. **The Hollows** (Cursed Swamp)
   Corrupted wetland where the dead don't stay buried. Source of a plague
   that turns the living into ghouls.

3. **Grimspire Keep** (Mountain Fortress)
   Abandoned fortress in the Ironteeth Mountains. Rumored to contain the
   tomb of the first Blackthorne king -- and his curse.

4. **Thornfield** (Agricultural Village)
   Breadbasket of the kingdom, currently suffering crop blight. The villagers
   blame the swamp; the truth is darker.

5. **The Veilwood** (Ancient Forest)
   Home to a reclusive order of witch-hunters who answer to no king.

### Notable NPCs (6):
[Generated NPCs for each location...]

### Factions (4):
  - House Blackthorne (ruling family, hiding a dark secret)
  - The Pallid Order (undead-hunting clerics, possibly corrupt)
  - The Merchant Consortium (want stability for profit)
  - The Hollow Cult (worship the swamp's power)

Saved to campaign "The Kingdom of Morthaven". Ready for session 1 prep?
```

## Notes

- Start small. A DM does not need an entire world on day one. Start with the region the party begins in and expand as needed.
- Factions drive conflict. Every faction should want something that conflicts with at least one other faction. The party gets drawn into these tensions.
- Secrets are fuel. Every NPC should have a secret. Every location should have a hidden truth. These become adventure hooks.
- Leave blank spaces on the map. Not everything needs to be defined up front. Blank spaces are opportunities for future sessions.
- If the DM is running a published setting (Forgotten Realms, Eberron, etc.), adapt rather than replace. Add new locations and NPCs that fit the existing world.
