---
name: SessionDesigner
description: Complete session preparation workflow - the crown jewel of the DnD toolkit
trigger: "plan a session, session prep, design session, session designer, prepare session, next session"
mode: architect
---

# Session Designer

End-to-end session preparation that produces a complete session packet: encounters, stat blocks, NPCs, maps, loot tables, and session notes -- all saved to campaign state.

## When to Use

The DM is preparing for their next game session. This workflow walks through the entire prep process, generating all the content needed to run a 3-4 hour session. It is the most comprehensive workflow in the toolkit and orchestrates most other tools.

## Steps

### Step 1: Load Campaign

```bash
bun Tools/CampaignState.ts list --json
```

If the user has an active campaign, load it:
```bash
bun Tools/CampaignState.ts get <campaign-id> --json
```

Extract:
- Party composition (level, size, classes)
- Previous session notes (last 2-3 sessions)
- Active quests and their states
- Known NPCs and locations
- Outstanding plot threads

If no campaign exists, offer to create one:
```bash
bun Tools/CampaignState.ts create "<name>" --setting "<setting>" --party-level <n> --party-size <n>
```

### Step 2: Review Previous Session

Present a summary of the last session:

```
Last Session (#7):
  - Party cleared the Sunken Temple, defeated the Sahuagin Priestess
  - Found the Trident of Fish Command
  - Cleric hit level 6
  - Open thread: The missing merchant's daughter is still captive in the underwater caves
  - Open thread: Baron Aldric wants the trident returned
```

Ask: "What direction do you want this session to go?"

### Step 3: Define Session Arc

Work with the DM to outline:

1. **Session Objective**: What is the main goal? (rescue, exploration, combat, social, mystery)
2. **Key Locations**: Where will the action take place? (2-3 locations max)
3. **Key NPCs**: Who will the party interact with? (2-4 NPCs)
4. **Encounters**: How many combat encounters? (typically 1-3 per session)
5. **Pacing**: Opening hook > rising action > climax > resolution
6. **Session Duration**: Expected play time (default 3-4 hours)

Structure:
```
Session #8: "Into the Deep"
  Opening: Baron Aldric summons the party, demands the trident
  Rising Action: Party tracks captives to underwater caves
  Climax: Boss fight against Sahuagin Baron in lair
  Resolution: Rescue captives, decide trident's fate

  Locations: Baron's Keep, Coastal Cliffs, Underwater Caves
  NPCs: Baron Aldric (quest giver), Mira (captive), Sahuagin Baron (boss)
  Encounters: 2 combat (cave guards, boss), 1 social (Baron)
```

### Step 4: Generate Encounters

For each planned combat encounter, run the **ArchitectEncounter** workflow:

**Encounter 1 (cave guards):**
```bash
bun Tools/EncounterBalancer.ts --party-level <n> --party-size <n> --difficulty medium --suggest --json
```

**Encounter 2 (boss fight):**
```bash
bun Tools/EncounterBalancer.ts --party-level <n> --party-size <n> --difficulty hard --suggest --json
```

Or design custom monsters:
```bash
bun Tools/MonsterGenerator.ts --cr <n> --type <type> --name <name> --json
```

Validate each encounter's balance. Present the full encounter lineup.

### Step 5: Create NPCs

For each key NPC, generate a stat block if combat-relevant, or a description if social:

**Combat NPCs:**
```bash
bun Tools/MonsterGenerator.ts --cr <n> --type humanoid --name "<name>" --json
```

**Social NPCs:** Generate a brief profile:
- Name, race, class/occupation
- Personality (2-3 traits)
- Motivation (what they want)
- Secret (what they are hiding)
- Key dialogue lines (2-3 memorable quotes)

Use AI inference for NPC personality generation when needed.

### Step 6: Generate Maps

For each key location:

```bash
bun Tools/MapPrompt.ts --type <battlemap|dungeon> --theme "<location-theme>" --features "<terrain>" --json
```

Example locations:
- Baron's Keep: `--type battlemap --theme "castle throne room" --features "throne, pillars, guards"`
- Underwater Caves: `--type dungeon --theme "underwater cave network" --features "water, coral, narrow passages"`

Maps saved to `~/Downloads/dnd-maps/`.

### Step 7: Roll Treasure and Loot

For each encounter, generate appropriate loot:

```bash
bun Tools/LootGenerator.ts --cr <boss-cr> --type hoard --json
```

For non-combat rewards (quest completion, exploration finds):
```bash
bun Tools/LootGenerator.ts --cr <party-level> --type individual --count 3 --json
```

Also consider:
- Quest-specific rewards (the trident, a map, a key)
- Gold/payment from quest givers
- Items that advance the plot

### Step 8: Compile Session Packet

Assemble everything into a structured session document:

```markdown
# Session #8: "Into the Deep"

## Overview
[Session arc summary from Step 3]

## Encounter 1: Cave Guards (Medium)
- Monsters: [list with stat blocks]
- Terrain: [map reference]
- Tactics: [how the monsters fight]
- Treasure: [loot from this encounter]

## Encounter 2: Sahuagin Baron (Hard/Boss)
- Monsters: [list with stat blocks]
- Terrain: [map reference]
- Tactics: [boss strategy, phase changes]
- Treasure: [hoard loot]

## NPCs
- Baron Aldric: [profile]
- Mira: [profile]

## Maps
- [Map 1 path and description]
- [Map 2 path and description]

## Loot Summary
- Total gold: [amount]
- Magic items: [list]
- Special items: [plot items]

## DM Notes
- [Contingencies if party goes off-script]
- [Key plot points to weave in]
- [Cliffhanger for next session]
```

### Step 9: Save to Campaign State

```bash
bun Tools/CampaignState.ts update <campaign-id> --add-session '<session-json>'
```

Save encounters, NPCs, and loot to the campaign state for future reference.

**Voice notification:**
```
notifySync("Session <number> prep complete with <n> encounters and <n> NPCs")
```

## Example

```
User: "Help me prep session 4 of my Curse of Strahd campaign"

Kaya: Loading campaign "Curse of Strahd"...

Last Session (#3):
  - Party arrived in Vallaki, met Ismark and Ireena
  - Discovered the church's bones are missing
  - Rogue spotted Henrik's coffin shop as suspicious

What's the plan for session 4?

User: "They'll investigate the coffin shop and hopefully recover the bones.
There should be vampires."

Kaya: Building session 4: "The Coffin Maker's Shop"

Session Arc:
  Opening: Party investigates Henrik's shop (social/exploration)
  Rising Action: Discover vampire spawn nest upstairs
  Climax: 3-way fight (vampires vs party vs potential guard patrol)
  Resolution: Recover bones or fail (major consequences either way)

Generating...
  [EncounterBalancer] 6x Vampire Spawn (CR 5) = Hard for level 4 party of 4
  [StatBlock] Vampire Spawn stat blocks rendered
  [MonsterGenerator] Henrik van der Voort (CR 1/2, cowardly commoner/spy stats)
  [MapPrompt] Two-story shop interior battlemap generated
  [LootGenerator] Individual treasure x6 + quest item (St. Andral's bones)

Session packet compiled. Want me to adjust anything?
```

## Notes

- Session prep typically takes 5-10 minutes with this workflow. Set expectations with the DM.
- Keep sessions focused: 2-3 encounters max, 1-2 key decision points.
- Always include contingencies for players going off-script.
- The session packet is a living document -- the DM should feel free to improvise around it.
- For published modules (Curse of Strahd, etc.), the session designer adapts to the module's existing content rather than replacing it.
- After the session is played, remind the DM to log the actual events via CampaignState session logging.
