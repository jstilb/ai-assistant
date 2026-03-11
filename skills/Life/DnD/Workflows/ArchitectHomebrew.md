---
name: ArchitectHomebrew
description: Homebrew creation with iterative balance validation
trigger: "homebrew spell, custom item, homebrew monster, create magic item, custom spell, homebrew content"
mode: architect
---

# Architect Homebrew

Create and validate homebrew content (monsters, spells, items) with iterative balance checking against SRD benchmarks.

## When to Use

The DM or player wants to create custom content that fits within the 5e balance framework. This workflow generates the content, validates it against DMG benchmarks, and iterates until the result is balanced (or the user deliberately accepts a deviation).

## Steps

### Step 1: Determine Content Type

| Request Pattern | Type | Generator | Validator |
|-----------------|------|-----------|-----------|
| "monster", "creature", "enemy" | Monster | MonsterGenerator | HomebrewValidator --type monster |
| "spell", "cantrip", "magic" | Spell | SpellForge | HomebrewValidator --type spell |
| "item", "weapon", "armor", "magic item" | Item | (manual/AI) | HomebrewValidator --type item |

### Step 2: Gather Concept

**For Monsters:**
- What CR should it be?
- What type? (beast, fiend, undead, aberration, etc.)
- What makes it unique? (abilities, theme, narrative role)
- Any specific mechanics? (legendary actions, lair actions, pack tactics)

**For Spells:**
- What level? (0-9)
- What school? (evocation, abjuration, conjuration, etc.)
- What does it do? (damage, control, utility, healing)
- Damage type? (fire, cold, necrotic, etc.)
- Single target or area?

**For Items:**
- What type? (weapon, armor, wondrous, potion, ring, etc.)
- What rarity? (common, uncommon, rare, very rare, legendary)
- What properties? (+1 bonus, resistance, special ability)
- Attunement required?

### Step 3: Generate Content

**Monster:**
```bash
bun Tools/MonsterGenerator.ts --cr <n> --type <type> [--name <name>] [--traits <traits>] --json
```

**Spell:**
```bash
bun Tools/SpellForge.ts --name <name> --level <n> --school <school> [--damage-type <type>] --compare --json
```

**Item:**
Items do not have a dedicated generator. Build the item JSON manually from the user's concept:
```json
{
  "name": "Frostbrand Gauntlet",
  "type": "Weapon",
  "rarity": "rare",
  "properties": ["+1 to attack and damage", "extra cold damage on hit", "resistance to fire"]
}
```

### Step 4: Validate Balance

```bash
echo '<content-json>' | bun Tools/HomebrewValidator.ts --type <monster|spell|item> --json
```

Present results clearly:

```
Balance Check: BALANCED
No flags. Your homebrew fits within CR 5 expectations.
```

or:

```
Balance Check: OVERPOWERED
Flags:
  !!! damage: 12d6 (avg 42) exceeds level 3 benchmark (18-40 avg) by 17%
Suggestions:
  -> Reduce damage from 12d6 to 8d6 for level 3 balance

Fix automatically, keep as-is, or adjust manually?
```

### Step 5: Iterate Until Balanced

If overpowered or underpowered:
1. Present the specific flags and suggestions
2. Offer three options:
   - **Auto-fix**: Apply the validator's suggestions automatically
   - **Manual adjust**: Let the user specify changes
   - **Accept as-is**: User acknowledges the imbalance (document it)
3. Re-validate after changes
4. Repeat until balanced or accepted

### Step 6: Save and Present

**Monster:** Full stat block via StatBlock, optionally art via MonsterArt
```bash
echo '<monster-json>' | bun Tools/StatBlock.ts --format markdown
```

**Spell:** Formatted spell description with balance comparison
```
Present the spell with its comparable SRD spells for context.
```

**Item:** Formatted item card
```
Present item with properties, attunement, and rarity tag.
```

If campaign is loaded:
```bash
bun Tools/CampaignState.ts update <campaign-id> --add-homebrew '<content-json>'
```

**Voice notification:**
```
notifySync("Homebrew <type> <name> validated and ready")
```

## Example

```
User: "I want to create a homebrew spell called 'Gravity Well' - 3rd level,
evocation, pulls enemies in and does force damage"

Kaya: Creating Gravity Well...

[SpellForge] Generated:
  **Gravity Well** (Level 3 Evocation)
  Casting Time: 1 action | Range: 120 feet
  Components: V, S, M (a small iron sphere)
  Duration: Concentration, up to 1 minute

  You create a 20-foot-radius sphere of crushing gravitational force centered
  on a point you can see. Each creature in the area must make a STR save (DC =
  spell save DC). On a fail, they take 4d8 force damage and are pulled 15 feet
  toward the center. On success, half damage and not pulled. Creatures starting
  their turn in the area take 2d8 force damage.

  Damage: 4d8 (avg 18) initial + 2d8 (avg 9) per round

[HomebrewValidator] Status: BALANCED
  Average damage 18 is within level 3 range (18-40).
  Comparable: Fireball (8d6 avg 28), Lightning Bolt (8d6 avg 28).
  Note: Lower single-hit damage is offset by the pull + sustained damage + control.

Save to campaign?
```

## Notes

- Spells with control effects (restrained, pulled, stunned) should deal less damage than pure damage spells at the same level. The control IS part of the power budget.
- Items with multiple properties may individually seem fine but be overpowered in combination. The validator checks aggregate power level.
- Always show comparable SRD content so the user can make informed decisions.
- If a user insists on keeping something overpowered, note it as "intentionally above curve" in the campaign state.
