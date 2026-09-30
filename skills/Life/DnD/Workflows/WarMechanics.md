---
name: WarMechanics
description: Large-scale battle handling for 100+ combatants using squad-based abstraction
trigger: "mass combat, army battle, war, siege, large battle, army vs army, war mechanics"
mode: architect
---

# War Mechanics

Squad-based mass combat system for handling battles with 100+ combatants. Abstracts individual creatures into squads, tracks morale and casualties per round, and resolves actions at the squad level.

## When to Use

Standard D&D combat breaks down above 10-15 creatures per side. When the DM needs to run a siege, a battlefield, or an army clash, this workflow handles it without tracking hundreds of individual initiative rolls.

Typical scenarios:
- Castle siege (defenders vs. attackers)
- Army vs. army on an open field
- Village defense against a horde
- Naval battle with multiple ships and crews
- Party leading troops against a monster army

## Core Concepts

### Squad Definition

A **squad** is 10 troops of the same type treated as a single unit.

| Property | Formula |
|----------|---------|
| Squad HP | Sum of 10 individual HPs |
| Squad AC | Individual AC (unchanged) |
| Squad DPR | Sum of 10 individual DPRs x morale modifier |
| Squad Speed | Individual speed |
| Squad CR | Approximately individual CR + 4 (for XP budget purposes) |

Example: 10 Guards (CR 1/8 each)
- Individual: HP 11, AC 16, DPR 4
- Squad: HP 110, AC 16, DPR 40 x morale

### Morale System

Morale is a multiplier (0.0 to 1.2) that modifies squad DPR:

| Condition | Morale | Effect |
|-----------|--------|--------|
| Fresh, well-led | 1.2 | +20% DPR |
| Normal | 1.0 | Standard DPR |
| Under pressure (25% casualties) | 0.8 | -20% DPR |
| Wavering (50% casualties) | 0.5 | -50% DPR |
| Broken (75% casualties) | 0.2 | -80% DPR, may rout |
| Routed | 0.0 | Squad flees, no attacks |

**Morale checks:** At 25%, 50%, and 75% casualties, the squad leader (if any) makes a DC 10/13/15 CHA check. Failure drops morale one step.

### Leaders

Each squad may have a leader (a named NPC or PC). Leaders provide:
- Morale bonus: squad morale cannot drop below 0.5 while leader lives
- Tactical bonus: +2 to the squad's effective attack bonus
- Rally action: On their turn, DC 12 CHA check to restore one morale step

PCs can serve as squad leaders, using their normal turns for either personal actions or squad commands.

## Steps

### Step 1: Define Forces

Work with the DM to define each army's composition.

For each force, gather:
- **Troop types** (guards, knights, goblins, skeletons, etc.)
- **Count per type** (will be grouped into squads of 10)
- **Leaders** (named NPCs or PCs commanding squads)
- **Special units** (siege weapons, spellcasters, flying units, monsters)

Use CRCalculator for custom troop stats if needed:
```bash
echo '{"hp":<n>,"ac":<n>,"attackBonus":<n>,"dpr":<n>,"saveDC":<n>}' | bun Tools/CRCalculator.ts
```

### Step 2: Aggregate into Squads

Convert raw troop counts into squads:

```
Defenders:
  3x Guard Squads (30 guards) - HP 110 ea, AC 16, DPR 40
  1x Knight Squad (10 knights) - HP 520, AC 18, DPR 110
  1x Archer Squad (10 archers) - HP 110, AC 13, DPR 50 (range 150/600)
  Leader: Sir Kaldris (Knight Captain, CHA +3)

Attackers:
  5x Goblin Squads (50 goblins) - HP 70 ea, AC 15, DPR 50
  2x Bugbear Squads (20 bugbears) - HP 270 ea, AC 16, DPR 110
  1x Ogre Squad (10 ogres) - HP 590, AC 11, DPR 130
  Leader: Warchief Grukk (Hobgoblin Captain, CHA +2)
```

### Step 3: Set Battlefield

Generate a battlefield map:
```bash
bun Tools/MapPrompt.ts --type regional --theme "<battlefield>" --features "<terrain>" --json
```

Define terrain zones:
- **Open ground**: Normal movement, no cover
- **Difficult terrain**: Half movement (marsh, rubble, forest)
- **Fortifications**: Three-quarters cover (+5 AC) for defenders
- **Chokepoints**: Only 1 squad can engage at a time

### Step 4: Resolve Rounds

Each round represents approximately 1 minute of battle time (10 standard D&D rounds abstracted).

**Round sequence:**
1. **Command phase**: Each leader chooses orders (advance, hold, retreat, flank, rally)
2. **Movement phase**: Squads move according to orders
3. **Combat phase**: Engaged squads deal damage simultaneously
4. **Morale phase**: Check morale for squads that took heavy casualties
5. **Special phase**: Resolve siege weapons, spells, PC heroics

**Combat resolution:**
- Attacker squad rolls 1d20 + squad attack bonus vs target AC
- On hit: deal squad DPR x morale modifier
- Subtract from target squad HP
- Each 10% HP lost = approximately 1 troop killed

**PC actions during war rounds:**
PCs act normally during the 1-minute round. They can:
- Lead their squad (rally, tactical commands)
- Target enemy leaders (duel mechanics)
- Cast battlefield spells (Fireball = ~squad-level DPR against one squad)
- Perform heroic actions (break a gate, challenge a champion)

### Step 5: Report Casualties and Morale

After each round, report:

```
=== Round 3 ===
Defenders:
  Guard Squad 1: 80/110 HP (2 casualties), Morale: Normal
  Guard Squad 2: 45/110 HP (6 casualties), Morale: Under Pressure
  Guard Squad 3: 110/110 HP, Morale: Normal
  Knight Squad: 450/520 HP, Morale: Normal
  Archer Squad: 90/110 HP, Morale: Normal

Attackers:
  Goblin Squad 1: ROUTED (fled the field)
  Goblin Squad 2: 30/70 HP (5 casualties), Morale: Wavering
  Bugbear Squad 1: 200/270 HP, Morale: Normal
  Ogre Squad: 400/590 HP, Morale: Under Pressure

Key Events:
  - Goblin Squad 1 broke after taking 60% casualties
  - Sir Kaldris rallied Guard Squad 2 (morale restored to Normal)
  - Party Wizard's Fireball dealt 8d6 to Bugbear Squad 1
```

### Step 6: Determine Victory

The battle ends when:
- One side is entirely routed or destroyed
- A strategic objective is achieved (gate breached, leader killed, reinforcements arrive)
- A parley or surrender occurs
- The DM decides the outcome

Calculate final casualties for both sides and narrative consequences.

## Example

```
User: "The party is defending a village with 40 militia against 80 goblins and
a hill giant. How do we run this?"

Kaya: Setting up mass combat...

Defenders:
  4x Militia Squads (40 militia = Guard stats)
    HP 110 each, AC 16, DPR 40, Morale: Normal
  Party (4 PCs at level 5) - acting as leaders + individual combatants

Attackers:
  8x Goblin Squads (80 goblins)
    HP 70 each, AC 15, DPR 50, Morale: Fresh (1.2)
  1x Hill Giant (solo, not squadded - CR 5, HP 105, DPR 36)
  Leader: Goblin Boss (CHA +1)

Battlefield: Village with barricades (3/4 cover for defenders),
  two approach roads (chokepoints), open market square.

Round 1: Goblins advance. 4 squads engage at barricades, 4 held in reserve.
  [Combat rolls and results...]

The hill giant is a solo threat - the party can engage it directly while
their militia holds the line.

Continue to Round 2?
```

## Notes

- This system is intentionally abstract. It is not meant to be as precise as individual combat.
- DMs should feel free to narrate dramatically between rounds. The numbers provide structure; the story provides meaning.
- PCs should always feel impactful. Their individual actions (killing a leader, casting a key spell, opening a gate) should swing the battle.
- Siege weapons deal squad-level DPR: ballista ~40, catapult ~80, trebuchet ~120.
- Flying units (dragon, griffon riders) can engage any squad without being engaged by melee squads.
- If the battle is narrative-only (outcome predetermined), skip the mechanics and just narrate it with the DM.
