---
name: ImprovGenerate
description: Quick single-command generation for mid-session improvisation
trigger: "generate a monster, quick NPC, random encounter, I need a creature, quick monster, generate enemy"
mode: improv
---

# Improv Generate

Fast, text-only generation for when the DM needs something NOW. Target: under 15 seconds, no art generation.

## When to Use

The players just kicked down a door you did not prep. They wandered into a tavern and want to talk to the barkeep. They triggered a random encounter on the road. You need a stat block, an encounter, loot, or a spell RIGHT NOW.

Key constraint: **No art generation** (too slow for improv). Text output only.

## Steps

### Step 1: Determine What to Generate

Parse the user's request to identify the generation type:

| Request Pattern | Type | Tool |
|-----------------|------|------|
| "monster", "creature", "enemy", "NPC" | Monster | MonsterGenerator |
| "encounter", "fight", "combat" | Encounter | EncounterBalancer |
| "loot", "treasure", "reward" | Loot | LootGenerator |
| "spell", "magic" | Spell | SpellForge |

If unclear, ask: "What do you need? A **monster**, an **encounter**, some **loot**, or a **spell**?"

### Step 2: Gather Minimum Context

Only ask what is strictly necessary. Default aggressively:

**Monster defaults:**
- CR: Match party level (check CampaignState if loaded, otherwise ask)
- Type: random
- Name: AI-generated

**Encounter defaults:**
- Difficulty: medium
- Party: from CampaignState (or ask level + size)

**Loot defaults:**
- CR: party level
- Type: individual

**Spell defaults:**
- Level: half party level (round down)
- School: evocation

### Step 3: Generate

**Monster:**
```bash
bun Tools/MonsterGenerator.ts --cr <n> --random --json
```
**Output:** Name, HP, AC, key abilities, 1-2 actions. Skip full stat block unless asked.

**Encounter:**
```bash
bun Tools/EncounterBalancer.ts --party-level <n> --party-size <n> --difficulty <level> --suggest --json
```
**Output:** Monster list with counts, total XP, difficulty rating.

**Loot:**
```bash
bun Tools/LootGenerator.ts --cr <n> --type <individual|hoard> --json
```
**Output:** Coins, gems/art, magic items (if any).

**Spell:**
```bash
bun Tools/SpellForge.ts --name <name> --level <n> --school <school> --json
```
**Output:** Spell name, level, casting time, range, description, damage.

### Step 4: Format for Chat

Present the result in a compact, readable format. No JSON dumps. Example:

```
**Gritfang Hyena** (CR 3)
HP 45 | AC 14 | Speed 50 ft
STR 16 (+3) DEX 15 (+2) CON 14 (+2)
**Bite.** +5 to hit, 2d6+3 piercing + 1d6 necrotic
**Pack Tactics.** Advantage when ally is within 5 ft
```

### Step 5: Offer to Save

If a campaign is loaded, offer: "Save to campaign state?"

**Tool:** `bun Tools/CampaignState.ts update <campaign-id> --add-npc '<json>'`

## Example

```
User: "I need a CR 5 monster, something fiery"

Kaya: Generating a CR 5 fire creature...

**Emberclaw Salamander** (CR 5)
HP 90 | AC 15 (natural armor) | Speed 30 ft, climb 30 ft
STR 18 (+4) DEX 12 (+1) CON 16 (+3) INT 8 (-1) WIS 11 (+0) CHA 14 (+2)
Damage Immunities: fire
**Multiattack.** Two claw attacks.
**Claw.** +7 to hit, 1d8+4 slashing + 1d6 fire
**Fire Breath (Recharge 5-6).** 30 ft cone, 5d8 fire, DEX DC 14 half

Save to your campaign?
```

## Notes

- Speed is everything. Do not ask unnecessary questions.
- If the user says "random", generate with all defaults. Zero questions.
- If MonsterGenerator inference is slow, fall back to pulling a similar CR monster from srd-monsters.json and reskinning it.
- Never generate art in improv mode. The user can always upgrade to ArchitectMonster later.
