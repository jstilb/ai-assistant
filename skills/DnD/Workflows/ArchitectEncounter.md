---
name: ArchitectEncounter
description: Balanced encounter design with terrain, monsters, loot, and VTT export
trigger: "build an encounter, design a fight, create a combat, plan encounter, encounter for my party"
mode: architect
---

# Architect Encounter

Complete encounter design pipeline: party analysis, XP budgeting, monster selection, stat blocks, loot, battlemap, and VTT export.

## When to Use

The DM wants a balanced, fully prepped combat encounter for an upcoming session. This produces everything needed to run the fight: monsters with stat blocks, a difficulty rating, treasure rewards, a battlemap prompt, and optionally a VTT-ready export package.

## Steps

### Step 1: Get Party Information

Check CampaignState first:
```bash
bun Tools/CampaignState.ts list --json
```

If a campaign is loaded, pull party level and size from it. Otherwise ask:

- **Party level** (1-20)
- **Party size** (number of characters)
- **Desired difficulty** (easy, medium, hard, deadly)

Also gather optional context:
- Environment/terrain (forest, dungeon, urban, etc.)
- Narrative context (ambush, boss fight, random encounter, etc.)
- Any specific monsters the DM wants included

### Step 2: Calculate XP Budget

```bash
bun Tools/EncounterBalancer.ts --party-level <n> --party-size <n> --difficulty <level> --json
```

This returns the XP budget thresholds for all difficulty tiers. Present the budget:

```
Party: 4 characters at level 5
XP Budget: Easy=1000, Medium=2000, Hard=3000, Deadly=4400
Target: Hard (3000 XP)
```

### Step 3: Select Monster Composition

**Option A: Auto-suggest from SRD**
```bash
bun Tools/EncounterBalancer.ts --party-level <n> --party-size <n> --difficulty <level> --suggest --json
```

**Option B: User specifies monsters**
```bash
bun Tools/EncounterBalancer.ts --party-level <n> --party-size <n> --monsters "2 goblins, 1 bugbear" --json
```

**Option C: Generate custom monsters**
Use MonsterGenerator for each creature, then validate the full encounter balance.

Present the monster list with XP math:
```
Suggested Encounter (Hard):
  1x Owlbear (CR 3, 700 XP)
  2x Dire Wolf (CR 1, 200 XP each)
  Total: 1100 XP (adjusted: 1650 XP with multiplier)
  Rating: HARD
```

Ask user to confirm or adjust.

### Step 4: Generate Stat Blocks

For each unique monster in the encounter:

**SRD monsters:**
```bash
echo '{"name":"<monster>"}' | bun Tools/StatBlock.ts --format markdown
```

**Custom monsters:**
```bash
bun Tools/MonsterGenerator.ts --cr <n> --type <type> --name <name> --json
```
Then render:
```bash
echo '<monster-json>' | bun Tools/StatBlock.ts --format markdown
```

Present all stat blocks in a compact format.

### Step 5: Generate Loot

```bash
bun Tools/LootGenerator.ts --cr <highest-monster-cr> --type hoard --json
```

For multi-monster encounters without a clear "boss", use individual treasure per monster:
```bash
bun Tools/LootGenerator.ts --cr <avg-cr> --type individual --count <monster-count> --json
```

Present loot summary:
```
Treasure:
  Coins: 450 gp, 120 sp
  Gems: 2x 50 gp gems
  Magic Items: Potion of Healing, +1 Dagger
```

### Step 6: Generate Battlemap

```bash
bun Tools/MapPrompt.ts --type battlemap --theme <environment> [--features <terrain>] --json
```

The map is saved to `~/Downloads/dnd-maps/`. Present the image path and a brief description of the terrain layout.

### Step 7: Export VTT Package

Save the encounter data to a temp file, then export:

```bash
bun Tools/VTTExporter.ts --format <foundry|roll20> --file <encounter.json> --json
```

The export includes all monster stat blocks formatted for the target VTT system.

### Step 8: Save to Campaign

If a campaign is active:
```bash
bun Tools/CampaignState.ts update <campaign-id> --add-encounter '<encounter-json>'
```

**Voice notification:**
```
notifySync("Encounter designed: <difficulty> with <n> monsters and <total-xp> XP")
```

## Example

```
User: "Build a hard encounter for my level 7 party of 5, set in a swamp"

Kaya: Pulling party info from campaign... Level 7, 5 players.

XP Budget:
  Easy=1750, Medium=3500, Hard=5250, Deadly=8000
  Target: Hard (5250 XP)

Suggested Encounter:
  1x Young Black Dragon (CR 7, 2900 XP)
  3x Giant Constrictor Snake (CR 2, 450 XP each)
  Total: 4250 XP (adjusted: 6375 XP)
  Rating: HARD

[StatBlock] Young Black Dragon rendered
[StatBlock] Giant Constrictor Snake rendered
[LootGenerator] Hoard treasure: 1200 gp, 3x 100 gp art objects, Cloak of Elvenkind
[MapPrompt] Swamp battlemap with murky water, fallen trees, and a dragon lair cave
[VTTExporter] Foundry package saved

Encounter ready! Want me to adjust the difficulty or swap any monsters?
```

## Notes

- The encounter multiplier (DMG p82) increases adjusted XP as monster count grows. 1 monster = x1, 2 = x1.5, 3-6 = x2, 7-10 = x2.5.
- For boss fights (single high-CR monster), suggest adding lair actions or minions to keep the action economy balanced.
- Always present the difficulty rating AFTER applying the encounter multiplier.
- If the encounter feels too swingy (high CR monster + low CR fodder), warn the DM about potential one-shot risk on squishier PCs.
