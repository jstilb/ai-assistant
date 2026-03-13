---
name: DnD
description: D&D 5e Dungeon Master toolkit with monsters, encounters, loot, spells, homebrew, maps, and VTT export. USE WHEN D&D, dungeon master, DM, encounter, monster, stat block, campaign, session prep, spell lookup, homebrew, VTT.
version: 4.0.0
---

# DnD - D&D 5e Dungeon Master Toolkit

Complete Dungeon Master support for D&D 5th Edition (2014 rules). 12 tools spanning four phases: data foundations, content generation, visual assets, and orchestrated workflows. Calculates challenge ratings (DMG method), generates monsters and spells via AI, balances encounters, validates homebrew, produces art and maps, exports to VTT platforms, and manages persistent campaigns with session logging.

---
---

## Customization

| Field | Default | Description |
|-------|---------|-------------|
| CR range | 1–20 | Default challenge rating range for generated monsters and encounters |
| art style | fantasy illustration | Default art style for MonsterArt and MapPrompt image generation |
| VTT format | foundry | Default VTT export format (foundry or roll20) |
| Campaign save location | `~/.claude/MEMORY/State/` | Where CampaignState persists campaign data |

---

## Voice Notification

Use `notifySync()` from `../lib/core/NotificationService.ts` on major completions:

- Monster generated: `"Frost Wyrm generated at Challenge Rating 12"`
- Encounter designed: `"Hard encounter designed with 4 monsters for 3200 XP"`
- Session prep complete: `"Session 5 prep complete with 2 encounters and 4 NPCs"`
- Homebrew validated: `"Gravity Well spell validated as balanced"`
- Campaign created: `"New campaign Curse of Strahd created"`
- World built: `"Kingdom of Morthaven built with 5 locations and 6 NPCs"`
- Art generated: `"Portrait and token art generated for Dreadlord Veranthos"`

---

## Workflow Routing

| Trigger | Workflow | Mode |
|---------|----------|------|
| "generate a monster", "quick NPC", "random encounter", "I need a creature" | `Workflows/ImprovGenerate.md` | improv |
| "design a monster", "create a boss", "build a creature", "architect monster" | `Workflows/ArchitectMonster.md` | architect |
| "build an encounter", "design a fight", "create a combat", "plan encounter" | `Workflows/ArchitectEncounter.md` | architect |
| "homebrew spell", "custom item", "homebrew monster", "create magic item" | `Workflows/ArchitectHomebrew.md` | architect |
| "plan a session", "session prep", "design session", "session designer" | `Workflows/SessionDesigner.md` | architect |
| "mass combat", "army battle", "war", "siege", "large battle" | `Workflows/WarMechanics.md` | architect |
| "build a world", "create a region", "world builder", "campaign setting" | `Workflows/WorldBuilder.md` | architect |

**Mode distinction:**
- **Improv** = fast, text-only, no art, under 15 seconds. For mid-session use.
- **Architect** = full pipeline with art, validation, export. For session prep.

---

## Tools

### Phase 1: Data Foundations

| Tool | Purpose | Location |
|------|---------|----------|
| **CRCalculator** | DMG p274 CR calculation engine (HP/AC/DPR/attack/save DC averaging) | `Tools/CRCalculator.ts` |
| **StatBlock** | Multi-format stat block renderer (markdown, text, JSON, Foundry VTT, Roll20) | `Tools/StatBlock.ts` |
| **CampaignState** | Persistent campaign management via StateManager (CRUD + session logs) | `Tools/CampaignState.ts` |

### Phase 2: Content Generation

| Tool | Purpose | Location |
|------|---------|----------|
| **MonsterGenerator** | AI-powered monster creation with CR validation and stat adjustment | `Tools/MonsterGenerator.ts` |
| **EncounterBalancer** | DMG XP budget math, difficulty rating, SRD monster suggestions | `Tools/EncounterBalancer.ts` |
| **LootGenerator** | DMG treasure tables (individual + hoard) with magic item rolls | `Tools/LootGenerator.ts` |
| **SpellForge** | Custom spell creation with balance analysis against SRD benchmarks | `Tools/SpellForge.ts` |
| **HomebrewValidator** | Balance validation for homebrew monsters, spells, and items | `Tools/HomebrewValidator.ts` |

### Phase 3: Visual & Export

| Tool | Purpose | Location |
|------|---------|----------|
| **MonsterArt** | AI creature portrait and VTT token generation via Art skill | `Tools/MonsterArt.ts` |
| **MapPrompt** | Battlemap, dungeon, regional, and world map generation via Gemini | `Tools/MapPrompt.ts` |
| **VTTExporter** | Complete encounter export for Foundry VTT and Roll20 | `Tools/VTTExporter.ts` |

### Tool CLI Reference

**CRCalculator.ts**
```bash
echo '{"hp":256,"ac":19,"attackBonus":14,"dpr":73,"saveDC":21}' | bun Tools/CRCalculator.ts
echo '{"hp":256,"ac":19,"attackBonus":14,"dpr":73,"saveDC":21,"resistances":["fire","cold"]}' | bun Tools/CRCalculator.ts
```

**StatBlock.ts**
```bash
echo '<monster-json>' | bun Tools/StatBlock.ts --format markdown
echo '<monster-json>' | bun Tools/StatBlock.ts --format foundry-vtt
echo '<monster-json>' | bun Tools/StatBlock.ts --format roll20
echo '<monster-json>' | bun Tools/StatBlock.ts --format text
echo '<monster-json>' | bun Tools/StatBlock.ts --format json
```

**CampaignState.ts**
```bash
bun Tools/CampaignState.ts create "Campaign Name" --setting "Forgotten Realms"
bun Tools/CampaignState.ts get <campaign-id> --json
bun Tools/CampaignState.ts list --json
bun Tools/CampaignState.ts update <campaign-id> --add-session '<session-json>'
bun Tools/CampaignState.ts update <campaign-id> --add-npc '<npc-json>'
```

**MonsterGenerator.ts**
```bash
bun Tools/MonsterGenerator.ts --cr 8 --type undead --name "Dreadlord" --json
bun Tools/MonsterGenerator.ts --cr 5 --random --json
bun Tools/MonsterGenerator.ts --cr 12 --type dragon --environment mountain --traits "legendary actions" --json
```

**EncounterBalancer.ts**
```bash
bun Tools/EncounterBalancer.ts --party-level 5 --party-size 4 --difficulty hard --json
bun Tools/EncounterBalancer.ts --party-level 5 --party-size 4 --difficulty hard --suggest --json
bun Tools/EncounterBalancer.ts --party-level 5 --party-size 4 --monsters "2 goblins, 1 bugbear" --json
```

**LootGenerator.ts**
```bash
bun Tools/LootGenerator.ts --cr 8 --type hoard --json
bun Tools/LootGenerator.ts --cr 3 --type individual --count 5 --json
bun Tools/LootGenerator.ts --magic-table F --count 3 --json
```

**SpellForge.ts**
```bash
bun Tools/SpellForge.ts --name "Gravity Well" --level 3 --school evocation --damage-type force --compare --json
echo '<spell-json>' | bun Tools/SpellForge.ts --json
```

**HomebrewValidator.ts**
```bash
echo '{"name":"X","cr":5,"hp":136,"ac":15,"attackBonus":6,"dpr":35,"saveDC":15}' | bun Tools/HomebrewValidator.ts --type monster --json
echo '{"name":"X","level":3,"school":"evocation","damage":"8d6"}' | bun Tools/HomebrewValidator.ts --type spell --json
echo '{"name":"X","type":"Weapon","rarity":"rare","properties":["+1 to attack"]}' | bun Tools/HomebrewValidator.ts --type item --json
bun Tools/HomebrewValidator.ts --file monster.json --type monster --json
```

**MonsterArt.ts**
```bash
bun Tools/MonsterArt.ts --name "Frost Wyrm" --type dragon --cr 12 --json
bun Tools/MonsterArt.ts --name "Frost Wyrm" --type dragon --cr 12 --token --json
bun Tools/MonsterArt.ts --name "Frost Wyrm" --type dragon --cr 12 --style watercolor --json
bun Tools/MonsterArt.ts --file monster.json --json
```

**MapPrompt.ts**
```bash
bun Tools/MapPrompt.ts --type battlemap --theme "forest clearing" --json
bun Tools/MapPrompt.ts --type dungeon --theme "ancient ruins" --features "traps, water, collapsed walls" --json
bun Tools/MapPrompt.ts --type regional --theme "gothic kingdom" --json
bun Tools/MapPrompt.ts --type world --theme "high fantasy continent" --json
```

**VTTExporter.ts**
```bash
bun Tools/VTTExporter.ts --format foundry --file encounter.json --json
bun Tools/VTTExporter.ts --format roll20 --file encounter.json --json
bun Tools/VTTExporter.ts --format foundry --file encounter.json --output ~/exports/ --json
```

---

## Data Files

| File | Contents | Location |
|------|----------|----------|
| **cr-tables.json** | DMG p274-281: HP-to-CR mapping, expected AC/attack/DPR/save DC by CR, effective HP multipliers | `Data/cr-tables.json` |
| **xp-thresholds.json** | DMG p82: XP thresholds by level (Easy/Medium/Hard/Deadly), encounter multipliers, XP by CR | `Data/xp-thresholds.json` |
| **treasure-tables.json** | DMG p133-139: Individual/hoard treasure by CR tier, magic item tables A-I | `Data/treasure-tables.json` |
| **srd-monsters.json** | 20 SRD monsters with full stat blocks (Goblin through Tarrasque) | `Data/srd-monsters.json` |
| **srd-spells.json** | 34 SRD spells, cantrips through 9th level | `Data/srd-spells.json` |
| **srd-items.json** | 23 SRD magic items across all rarity tiers | `Data/srd-items.json` |
| **map-templates.json** | 10 grid-based map templates (dungeon, wilderness, urban) with terrain and entry/exit points | `Data/map-templates.json` |

---

## Examples

### Improv Examples

**Quick monster generation:**
```
User: "I need a CR 3 beast, something fast"

-> MonsterGenerator --cr 3 --type beast --random --json
-> Quick stat summary (no art, no export)
-> "Razorclaw Panther, CR 3, HP 52, AC 14, Speed 50 ft. Pounce + multiattack."
```

**Random encounter:**
```
User: "Random hard encounter for my party"

-> Load party from CampaignState (level 5, 4 players)
-> EncounterBalancer --party-level 5 --party-size 4 --difficulty hard --suggest --json
-> "Hard encounter: 1 Owlbear + 2 Dire Wolves. Adjusted XP: 1650."
```

**Quick loot roll:**
```
User: "Roll treasure for CR 8"

-> LootGenerator --cr 8 --type individual --json
-> "450 gp, 30 sp, 2x 50 gp gems."
```

### Architect Examples

**Full boss monster design:**
```
User: "Design a CR 15 lich for the final dungeon"

-> Gather: undead, legendary actions, necrotic theme
-> MonsterGenerator --cr 15 --type undead --name "Archlich Vorynn" --traits "legendary actions, lair actions" --json
-> HomebrewValidator validates balanced
-> MonsterArt generates portrait + token
-> StatBlock renders full block
-> VTTExporter exports Foundry package
-> CampaignState saves to campaign
```

**Complete session prep:**
```
User: "Help me prep session 6 -- the party enters the Underdark"

-> SessionDesigner workflow:
  1. Load campaign, review session 5 notes
  2. Define arc: Underdark descent, drow patrol encounter, mushroom forest exploration
  3. EncounterBalancer: medium (drow patrol) + hard (drider ambush)
  4. MonsterGenerator for custom drider variant
  5. MapPrompt: underground cavern battlemap + mushroom forest
  6. LootGenerator: hoard from drider + drow equipment
  7. Full session packet compiled and saved
```

**World building:**
```
User: "Build me a pirate archipelago campaign setting"

-> WorldBuilder workflow:
  1. Scope: regional (island chain)
  2. MapPrompt --type regional --theme "tropical archipelago"
  3. 5 key islands with unique features
  4. 8 NPCs across pirate crews, merchants, and navy
  5. 4 factions (Crimson Fleet, Trade Company, Royal Navy, Sea Witch Coven)
  6. Faction relationship web generated
  7. All saved to new campaign
```

---

## Integration

### Uses
- **Art skill** (`skills/Content/Art/Tools/Generate.ts`) -- Image generation for MonsterArt and MapPrompt
- **CORE/Tools/Inference.ts** -- AI content generation for MonsterGenerator and SpellForge
- **CORE/Tools/StateManager** -- All campaign persistence via CampaignState
- **CORE/Tools/NotificationService.ts** -- Voice notifications on workflow completions
- **Data/*.json** -- SRD reference data for lookups, calculations, and validation

### Feeds Into
- **DigitalMaestro** -- D&D rules learning via spaced repetition
- **Obsidian** -- Campaign notes and session summaries
- **Art** -- Battle map generation, character portraits, tokens

### MCPs Used
- **Gemini** -- Image generation for MonsterArt (creature portraits, tokens) and MapPrompt (battle maps, dungeon maps, regional maps, world maps) via `gemini-generate-image`

---

## Success Criteria

- CRCalculator matches known SRD monsters within 1 CR
- StatBlock renders valid JSON for Foundry VTT and Roll20 import
- MonsterGenerator produces balanced monsters validated by HomebrewValidator
- EncounterBalancer applies correct DMG encounter multipliers
- LootGenerator rolls from accurate DMG treasure tables
- SpellForge produces spells within SRD damage benchmarks
- HomebrewValidator catches overpowered/underpowered content
- MonsterArt and MapPrompt produce usable prompts for image generation
- VTTExporter outputs valid import packages for Foundry and Roll20
- CampaignState persists and recovers campaign data across sessions
- All 7 workflows are executable end-to-end
- All tests pass with zero failures
