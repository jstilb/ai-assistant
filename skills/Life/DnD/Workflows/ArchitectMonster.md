---
name: ArchitectMonster
description: Deep monster creation with full art, balance validation, and VTT export
trigger: "design a monster, create a boss, build a creature, architect monster, custom monster, design a villain"
mode: architect
---

# Architect Monster

Full-pipeline monster creation: concept to VTT-ready. Includes AI generation, balance validation, iteration, art (portrait + token), stat block rendering, and export.

## When to Use

The DM wants to create a polished, unique creature for a planned session. This is not for improvisation -- use ImprovGenerate for that. This workflow produces a publication-quality monster with art and VTT-ready export files.

## Steps

### Step 1: Gather Requirements

Collect the following from the user. Bold items are required:

| Field | Required | Default | Example |
|-------|----------|---------|---------|
| **CR** | Yes | -- | 8 |
| **Type** | Yes | -- | monstrosity, undead, fiend |
| Theme/concept | No | AI decides | "corrupted treant", "psychic parasite" |
| Name | No | AI-generated | "Mindflayer Sovereign" |
| Special abilities | No | AI decides | "pack tactics", "legendary actions" |
| Environment | No | any | forest, underdark, coastal |
| Art style | No | dark fantasy | watercolor, anime, realistic |
| VTT format | No | foundry | foundry, roll20 |

### Step 2: Generate Monster

```bash
bun Tools/MonsterGenerator.ts --cr <n> --type <type> [--name <name>] [--environment <env>] [--traits <traits>] --json
```

Parse the JSON output. Store the full monster object for subsequent steps.

### Step 3: Validate Balance

Pipe the generated monster through HomebrewValidator:

```bash
echo '<monster-json>' | bun Tools/HomebrewValidator.ts --type monster --json
```

Check the result:
- **balanced**: Proceed to Step 5.
- **overpowered/underpowered**: Go to Step 4.

### Step 4: Iterate (If Needed)

Present the validation flags to the user:

```
Balance Check: OVERPOWERED
- HP 180 exceeds CR 8 range (106-120)
- DPR 55 exceeds CR 8 range (39-44)
Suggestion: Reduce HP to ~113, reduce DPR to ~42

Adjust automatically, or would you prefer to keep it powerful?
```

If user wants adjustment:
- Modify the stats and re-run HomebrewValidator
- Repeat until balanced or user accepts

### Step 5: Generate Art

**Portrait:**
```bash
bun Tools/MonsterArt.ts --name <name> --type <type> --cr <n> [--style <style>] --json
```

**Token:**
```bash
bun Tools/MonsterArt.ts --name <name> --type <type> --cr <n> --token --json
```

Present both images to the user. Art paths will be in `~/Downloads/dnd-art/`.

### Step 6: Render Stat Block

```bash
echo '<monster-json>' | bun Tools/StatBlock.ts --format markdown
```

Display the full stat block in chat in a clean markdown format.

### Step 7: Export for VTT

```bash
echo '<encounter-json>' | bun Tools/VTTExporter.ts --format <foundry|roll20> --json
```

Note: VTTExporter expects encounter-format JSON. Wrap the single monster:
```json
{
  "difficulty": "custom",
  "totalXP": <xp>,
  "adjustedXP": <xp>,
  "budget": { "easy": 0, "medium": 0, "hard": 0, "deadly": 0, "partyLevel": 1, "partySize": 4 },
  "monsters": [{ "name": "<name>", "cr": <cr>, "xp": <xp>, "count": 1 }]
}
```

Export file saved to `~/Downloads/dnd-export/`.

### Step 8: Save to Campaign

If a campaign is loaded:
```bash
bun Tools/CampaignState.ts update <campaign-id> --add-npc '<monster-summary-json>'
```

**Voice notification:**
```
notifySync("Monster <name> at CR <n> is ready with art and VTT export")
```

## Example

```
User: "Design a CR 12 undead boss for a necropolis dungeon, something with legendary actions"

Kaya: Building your undead boss...

[MonsterGenerator] Generated "Dreadlord Veranthos" (CR 12)
[HomebrewValidator] Status: balanced (HP 187, AC 17, DPR 62)
[MonsterArt] Portrait saved to ~/Downloads/dnd-art/dreadlord-veranthos-*.png
[MonsterArt] Token saved to ~/Downloads/dnd-art/dreadlord-veranthos-token-*.png

## Dreadlord Veranthos
*Large undead, lawful evil*

**Armor Class** 17 (plate)
**Hit Points** 187 (22d10 + 66)
**Speed** 30 ft.

| STR | DEX | CON | INT | WIS | CHA |
|-----|-----|-----|-----|-----|-----|
| 20 (+5) | 10 (+0) | 16 (+3) | 14 (+2) | 13 (+1) | 18 (+4) |

**Saving Throws** STR +10, CON +8, CHA +9
**Damage Immunities** necrotic, poison
**Condition Immunities** charmed, exhaustion, frightened, poisoned
**Senses** darkvision 120 ft., passive Perception 11
**Languages** Common, Abyssal

**Undead Fortitude.** If reduced to 0 HP, DC 5 + damage CON save to drop to 1 HP instead.

### Actions
**Multiattack.** Three attacks with Soulreaver.
**Soulreaver.** +10 to hit, reach 10 ft. Hit: 2d8+5 slashing + 2d6 necrotic.
**Necrotic Blast (Recharge 5-6).** 60 ft cone, 10d8 necrotic, CON DC 17 half.

### Legendary Actions (3/round)
**Attack.** One Soulreaver attack.
**Dark Command (2 actions).** One undead within 60 ft makes an attack.
**Drain Life (3 actions).** One creature within 30 ft, CON DC 17, 4d8 necrotic + Dreadlord heals half.

[VTTExporter] Foundry VTT file saved to ~/Downloads/dnd-export/encounter-foundry-*.json

Saved to campaign. Ready for your session!
```

## Notes

- The full pipeline takes 30-60 seconds due to art generation. Set expectations.
- If art generation fails (MCP unavailable), continue without art and note it.
- Always validate with HomebrewValidator before presenting as final.
- Legendary actions are appropriate for CR 10+. Below that, suggest lair actions instead.
