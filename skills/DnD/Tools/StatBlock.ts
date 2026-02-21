#!/usr/bin/env bun
/**
 * StatBlock.ts - Multi-Format D&D 5e Stat Block Renderer
 *
 * Renders monster stat blocks in multiple formats:
 * - markdown: Clean formatted stat block with headers/tables
 * - text: Plain text stat block
 * - json: Raw JSON of the monster data
 * - foundry-vtt: Valid Foundry VTT actor JSON
 * - roll20: Roll20 NPC JSON format
 *
 * @module StatBlock
 * @version 1.0.0
 */

// ============================================
// TYPES
// ============================================

export type StatBlockFormat = "markdown" | "text" | "json" | "foundry-vtt" | "roll20";

export interface MonsterSpeed {
  walk?: number;
  fly?: number;
  swim?: number;
  burrow?: number;
  climb?: number;
  hover?: boolean;
}

export interface MonsterAbilities {
  str: number;
  dex: number;
  con: number;
  int: number;
  wis: number;
  cha: number;
}

export interface MonsterTrait {
  name: string;
  description: string;
}

export interface MonsterSenses {
  blindsight?: number;
  darkvision?: number;
  tremorsense?: number;
  truesight?: number;
  passivePerception: number;
}

export interface Monster {
  name: string;
  size: "Tiny" | "Small" | "Medium" | "Large" | "Huge" | "Gargantuan";
  type: string;
  subtype?: string;
  alignment: string;
  ac: number;
  acType?: string;
  hp: number;
  hitDice: string;
  speed: MonsterSpeed;
  abilities: MonsterAbilities;
  savingThrows?: Record<string, number>;
  skills?: Record<string, number>;
  damageVulnerabilities?: string[];
  damageResistances?: string[];
  damageImmunities?: string[];
  conditionImmunities?: string[];
  senses?: MonsterSenses;
  languages?: string[];
  cr: number;
  xp: number;
  traits?: MonsterTrait[];
  actions: MonsterTrait[];
  bonusActions?: MonsterTrait[];
  reactions?: MonsterTrait[];
  legendaryActions?: MonsterTrait[];
}

// ============================================
// HELPERS
// ============================================

function crToString(cr: number): string {
  if (cr === 0.125) return "1/8";
  if (cr === 0.25) return "1/4";
  if (cr === 0.5) return "1/2";
  return String(cr);
}

function abilityModifier(score: number): number {
  return Math.floor((score - 10) / 2);
}

function modifierString(score: number): string {
  const mod = abilityModifier(score);
  return mod >= 0 ? `+${mod}` : `${mod}`;
}

function formatSpeed(speed: MonsterSpeed): string {
  const parts: string[] = [];
  if (speed.walk !== undefined) parts.push(`${speed.walk} ft.`);
  if (speed.fly !== undefined) parts.push(`fly ${speed.fly} ft.${speed.hover ? " (hover)" : ""}`);
  if (speed.swim !== undefined) parts.push(`swim ${speed.swim} ft.`);
  if (speed.burrow !== undefined) parts.push(`burrow ${speed.burrow} ft.`);
  if (speed.climb !== undefined) parts.push(`climb ${speed.climb} ft.`);
  return parts.join(", ") || "0 ft.";
}

function formatSenses(senses?: MonsterSenses): string {
  if (!senses) return "passive Perception 10";
  const parts: string[] = [];
  if (senses.blindsight) parts.push(`blindsight ${senses.blindsight} ft.`);
  if (senses.darkvision) parts.push(`darkvision ${senses.darkvision} ft.`);
  if (senses.tremorsense) parts.push(`tremorsense ${senses.tremorsense} ft.`);
  if (senses.truesight) parts.push(`truesight ${senses.truesight} ft.`);
  parts.push(`passive Perception ${senses.passivePerception}`);
  return parts.join(", ");
}

function formatSavingThrows(saves?: Record<string, number>): string {
  if (!saves) return "";
  return Object.entries(saves)
    .map(([ability, bonus]) => `${ability.charAt(0).toUpperCase() + ability.slice(1)} +${bonus}`)
    .join(", ");
}

function formatSkills(skills?: Record<string, number>): string {
  if (!skills) return "";
  return Object.entries(skills)
    .map(([skill, bonus]) => `${skill.charAt(0).toUpperCase() + skill.slice(1)} +${bonus}`)
    .join(", ");
}

// ============================================
// RENDERERS
// ============================================

function renderMarkdown(monster: Monster): string {
  const lines: string[] = [];
  const typeStr = monster.subtype
    ? `${monster.size} ${monster.type} (${monster.subtype})`
    : `${monster.size} ${monster.type}`;

  lines.push(`# ${monster.name}`);
  lines.push(`*${typeStr}, ${monster.alignment}*`);
  lines.push("");
  lines.push("---");
  lines.push("");
  lines.push(`**Armor Class** ${monster.ac}${monster.acType ? ` (${monster.acType})` : ""}`);
  lines.push(`**Hit Points** ${monster.hp} (${monster.hitDice})`);
  lines.push(`**Speed** ${formatSpeed(monster.speed)}`);
  lines.push("");
  lines.push("---");
  lines.push("");

  // Ability scores table
  lines.push("| STR | DEX | CON | INT | WIS | CHA |");
  lines.push("|:---:|:---:|:---:|:---:|:---:|:---:|");
  lines.push(
    `| ${monster.abilities.str} (${modifierString(monster.abilities.str)}) ` +
    `| ${monster.abilities.dex} (${modifierString(monster.abilities.dex)}) ` +
    `| ${monster.abilities.con} (${modifierString(monster.abilities.con)}) ` +
    `| ${monster.abilities.int} (${modifierString(monster.abilities.int)}) ` +
    `| ${monster.abilities.wis} (${modifierString(monster.abilities.wis)}) ` +
    `| ${monster.abilities.cha} (${modifierString(monster.abilities.cha)}) |`
  );
  lines.push("");
  lines.push("---");
  lines.push("");

  // Optional sections
  const saves = formatSavingThrows(monster.savingThrows);
  if (saves) lines.push(`**Saving Throws** ${saves}`);

  const skills = formatSkills(monster.skills);
  if (skills) lines.push(`**Skills** ${skills}`);

  if (monster.damageVulnerabilities?.length)
    lines.push(`**Damage Vulnerabilities** ${monster.damageVulnerabilities.join(", ")}`);
  if (monster.damageResistances?.length)
    lines.push(`**Damage Resistances** ${monster.damageResistances.join(", ")}`);
  if (monster.damageImmunities?.length)
    lines.push(`**Damage Immunities** ${monster.damageImmunities.join(", ")}`);
  if (monster.conditionImmunities?.length)
    lines.push(`**Condition Immunities** ${monster.conditionImmunities.join(", ")}`);

  lines.push(`**Senses** ${formatSenses(monster.senses)}`);
  lines.push(`**Languages** ${monster.languages?.join(", ") || "--"}`);
  lines.push(`**Challenge** ${crToString(monster.cr)} (${monster.xp.toLocaleString()} XP)`);
  lines.push("");
  lines.push("---");
  lines.push("");

  // Traits
  if (monster.traits?.length) {
    for (const trait of monster.traits) {
      lines.push(`***${trait.name}.*** ${trait.description}`);
      lines.push("");
    }
  }

  // Actions
  if (monster.actions.length) {
    lines.push("## Actions");
    lines.push("");
    for (const action of monster.actions) {
      lines.push(`***${action.name}.*** ${action.description}`);
      lines.push("");
    }
  }

  // Bonus Actions
  if (monster.bonusActions?.length) {
    lines.push("## Bonus Actions");
    lines.push("");
    for (const action of monster.bonusActions) {
      lines.push(`***${action.name}.*** ${action.description}`);
      lines.push("");
    }
  }

  // Reactions
  if (monster.reactions?.length) {
    lines.push("## Reactions");
    lines.push("");
    for (const reaction of monster.reactions) {
      lines.push(`***${reaction.name}.*** ${reaction.description}`);
      lines.push("");
    }
  }

  // Legendary Actions
  if (monster.legendaryActions?.length) {
    lines.push("## Legendary Actions");
    lines.push("");
    lines.push(
      `The ${monster.name.toLowerCase()} can take 3 legendary actions, choosing from the options below. Only one legendary action option can be used at a time and only at the end of another creature's turn. The ${monster.name.toLowerCase()} regains spent legendary actions at the start of its turn.`
    );
    lines.push("");
    for (const action of monster.legendaryActions) {
      lines.push(`***${action.name}.*** ${action.description}`);
      lines.push("");
    }
  }

  return lines.join("\n");
}

function renderText(monster: Monster): string {
  const lines: string[] = [];
  const typeStr = monster.subtype
    ? `${monster.size} ${monster.type} (${monster.subtype})`
    : `${monster.size} ${monster.type}`;

  lines.push(monster.name);
  lines.push(`${typeStr}, ${monster.alignment}`);
  lines.push("-----------------------------------------------");
  lines.push(`Armor Class ${monster.ac}${monster.acType ? ` (${monster.acType})` : ""}`);
  lines.push(`Hit Points ${monster.hp} (${monster.hitDice})`);
  lines.push(`Speed ${formatSpeed(monster.speed)}`);
  lines.push("-----------------------------------------------");
  lines.push(
    `STR     DEX     CON     INT     WIS     CHA`
  );
  lines.push(
    `${String(monster.abilities.str).padEnd(8)}` +
    `${String(monster.abilities.dex).padEnd(8)}` +
    `${String(monster.abilities.con).padEnd(8)}` +
    `${String(monster.abilities.int).padEnd(8)}` +
    `${String(monster.abilities.wis).padEnd(8)}` +
    `${String(monster.abilities.cha)}`
  );
  lines.push(
    `(${modifierString(monster.abilities.str)})`.padEnd(8) +
    `(${modifierString(monster.abilities.dex)})`.padEnd(8) +
    `(${modifierString(monster.abilities.con)})`.padEnd(8) +
    `(${modifierString(monster.abilities.int)})`.padEnd(8) +
    `(${modifierString(monster.abilities.wis)})`.padEnd(8) +
    `(${modifierString(monster.abilities.cha)})`
  );
  lines.push("-----------------------------------------------");

  const saves = formatSavingThrows(monster.savingThrows);
  if (saves) lines.push(`Saving Throws ${saves}`);

  const skills = formatSkills(monster.skills);
  if (skills) lines.push(`Skills ${skills}`);

  if (monster.damageVulnerabilities?.length)
    lines.push(`Damage Vulnerabilities ${monster.damageVulnerabilities.join(", ")}`);
  if (monster.damageResistances?.length)
    lines.push(`Damage Resistances ${monster.damageResistances.join(", ")}`);
  if (monster.damageImmunities?.length)
    lines.push(`Damage Immunities ${monster.damageImmunities.join(", ")}`);
  if (monster.conditionImmunities?.length)
    lines.push(`Condition Immunities ${monster.conditionImmunities.join(", ")}`);

  lines.push(`Senses ${formatSenses(monster.senses)}`);
  lines.push(`Languages ${monster.languages?.join(", ") || "--"}`);
  lines.push(`Challenge ${crToString(monster.cr)} (${monster.xp.toLocaleString()} XP)`);
  lines.push("-----------------------------------------------");

  if (monster.traits?.length) {
    for (const trait of monster.traits) {
      lines.push(`${trait.name}. ${trait.description}`);
      lines.push("");
    }
  }

  if (monster.actions.length) {
    lines.push("Actions");
    lines.push("-------");
    for (const action of monster.actions) {
      lines.push(`${action.name}. ${action.description}`);
      lines.push("");
    }
  }

  if (monster.reactions?.length) {
    lines.push("Reactions");
    lines.push("---------");
    for (const reaction of monster.reactions) {
      lines.push(`${reaction.name}. ${reaction.description}`);
      lines.push("");
    }
  }

  if (monster.legendaryActions?.length) {
    lines.push("Legendary Actions");
    lines.push("-----------------");
    for (const action of monster.legendaryActions) {
      lines.push(`${action.name}. ${action.description}`);
      lines.push("");
    }
  }

  return lines.join("\n");
}

function renderJSON(monster: Monster): string {
  return JSON.stringify(monster, null, 2);
}

function getTokenSize(size: string): number {
  switch (size.toLowerCase()) {
    case "tiny": return 0.5;
    case "small":
    case "medium": return 1;
    case "large": return 2;
    case "huge": return 3;
    case "gargantuan": return 4;
    default: return 1;
  }
}

function parseActionType(action: MonsterTrait): string {
  const desc = action.description.toLowerCase();
  if (desc.includes("melee weapon attack")) return "weapon";
  if (desc.includes("ranged weapon attack")) return "weapon";
  if (desc.includes("spell")) return "spell";
  return "feat";
}

function parseActionDamage(action: MonsterTrait): Array<[string, string]> {
  const desc = action.description;
  const damageMatch = desc.match(/(\d+d\d+(?:\s*[+-]\s*\d+)?)\s*(\w+)\s*damage/i);
  if (damageMatch) {
    return [[damageMatch[1].replace(/\s/g, ""), damageMatch[2].toLowerCase()]];
  }
  return [];
}

function parseAttackBonus(action: MonsterTrait): number | null {
  const match = action.description.match(/[+-](\d+) to hit/);
  return match ? parseInt(match[1]) : null;
}

function buildFoundryItems(monster: Monster): any[] {
  const items: any[] = [];

  // Build items from traits
  if (monster.traits) {
    for (const trait of monster.traits) {
      items.push({
        name: trait.name,
        type: "feat",
        system: {
          description: { value: trait.description },
          activation: { type: "none" },
        },
      });
    }
  }

  // Build items from actions
  for (const action of monster.actions) {
    const actionType = parseActionType(action);
    const damage = parseActionDamage(action);
    const attackBonus = parseAttackBonus(action);

    const item: any = {
      name: action.name,
      type: actionType,
      system: {
        description: { value: action.description },
        activation: { type: "action", cost: 1 },
      },
    };

    if (actionType === "weapon") {
      item.system.damage = { parts: damage };
      if (attackBonus !== null) {
        item.system.attackBonus = attackBonus;
      }
    }

    items.push(item);
  }

  // Bonus actions
  if (monster.bonusActions) {
    for (const action of monster.bonusActions) {
      items.push({
        name: action.name,
        type: "feat",
        system: {
          description: { value: action.description },
          activation: { type: "bonus" },
        },
      });
    }
  }

  // Reactions
  if (monster.reactions) {
    for (const reaction of monster.reactions) {
      items.push({
        name: reaction.name,
        type: "feat",
        system: {
          description: { value: reaction.description },
          activation: { type: "reaction" },
        },
      });
    }
  }

  // Legendary actions
  if (monster.legendaryActions) {
    for (const action of monster.legendaryActions) {
      items.push({
        name: action.name,
        type: "feat",
        system: {
          description: { value: action.description },
          activation: { type: "legendary", cost: 1 },
        },
      });
    }
  }

  return items;
}

function renderFoundryVTT(monster: Monster): string {
  const tokenSize = getTokenSize(monster.size);

  const actor = {
    name: monster.name,
    type: "npc",
    img: "",
    system: {
      abilities: {
        str: { value: monster.abilities.str, mod: abilityModifier(monster.abilities.str) },
        dex: { value: monster.abilities.dex, mod: abilityModifier(monster.abilities.dex) },
        con: { value: monster.abilities.con, mod: abilityModifier(monster.abilities.con) },
        int: { value: monster.abilities.int, mod: abilityModifier(monster.abilities.int) },
        wis: { value: monster.abilities.wis, mod: abilityModifier(monster.abilities.wis) },
        cha: { value: monster.abilities.cha, mod: abilityModifier(monster.abilities.cha) },
      },
      attributes: {
        ac: {
          flat: monster.ac,
          calc: monster.acType ? "custom" : "default",
          formula: monster.acType || "",
        },
        hp: {
          value: monster.hp,
          max: monster.hp,
          formula: monster.hitDice,
        },
        movement: {
          walk: monster.speed.walk ?? 0,
          fly: monster.speed.fly ?? 0,
          swim: monster.speed.swim ?? 0,
          burrow: monster.speed.burrow ?? 0,
          climb: monster.speed.climb ?? 0,
          hover: monster.speed.hover ?? false,
          units: "ft",
        },
        senses: {
          blindsight: monster.senses?.blindsight ?? 0,
          darkvision: monster.senses?.darkvision ?? 0,
          tremorsense: monster.senses?.tremorsense ?? 0,
          truesight: monster.senses?.truesight ?? 0,
          units: "ft",
        },
      },
      details: {
        cr: monster.cr,
        xp: { value: monster.xp },
        type: {
          value: monster.type,
          subtype: monster.subtype || "",
        },
        alignment: monster.alignment,
        source: "SRD 5.1",
      },
      traits: {
        size: monster.size.toLowerCase().slice(0, 3) as string,
        di: {
          value: monster.damageImmunities ?? [],
        },
        dr: {
          value: monster.damageResistances ?? [],
        },
        dv: {
          value: monster.damageVulnerabilities ?? [],
        },
        ci: {
          value: monster.conditionImmunities ?? [],
        },
        languages: {
          value: monster.languages ?? [],
        },
      },
    },
    items: buildFoundryItems(monster),
    prototypeToken: {
      width: tokenSize,
      height: tokenSize,
      texture: {
        src: "",
      },
    },
  };
  return JSON.stringify(actor, null, 2);
}

function renderRoll20(monster: Monster): string {
  const attribs: Array<{ name: string; current: string; max?: string }> = [];

  attribs.push({ name: "npc_name", current: monster.name });
  attribs.push({
    name: "npc_type",
    current: monster.subtype
      ? `${monster.size} ${monster.type} (${monster.subtype}), ${monster.alignment}`
      : `${monster.size} ${monster.type}, ${monster.alignment}`,
  });
  attribs.push({ name: "npc_ac", current: String(monster.ac) });
  attribs.push({ name: "hp", current: String(monster.hp), max: String(monster.hp) });
  attribs.push({ name: "npc_hpformula", current: monster.hitDice });
  attribs.push({ name: "npc_speed", current: formatSpeed(monster.speed) });

  // Ability scores
  attribs.push({ name: "strength", current: String(monster.abilities.str) });
  attribs.push({ name: "dexterity", current: String(monster.abilities.dex) });
  attribs.push({ name: "constitution", current: String(monster.abilities.con) });
  attribs.push({ name: "intelligence", current: String(monster.abilities.int) });
  attribs.push({ name: "wisdom", current: String(monster.abilities.wis) });
  attribs.push({ name: "charisma", current: String(monster.abilities.cha) });

  // CR
  attribs.push({ name: "npc_challenge", current: crToString(monster.cr) });
  attribs.push({ name: "npc_xp", current: String(monster.xp) });

  // Saves
  if (monster.savingThrows) {
    attribs.push({
      name: "npc_saving_flag",
      current: formatSavingThrows(monster.savingThrows),
    });
  }

  // Senses
  attribs.push({ name: "npc_senses", current: formatSenses(monster.senses) });

  // Languages
  attribs.push({
    name: "npc_languages",
    current: monster.languages?.join(", ") || "--",
  });

  // Damage resistances/immunities
  if (monster.damageResistances?.length) {
    attribs.push({
      name: "npc_resistances",
      current: monster.damageResistances.join(", "),
    });
  }
  if (monster.damageImmunities?.length) {
    attribs.push({
      name: "npc_immunities",
      current: monster.damageImmunities.join(", "),
    });
  }
  if (monster.damageVulnerabilities?.length) {
    attribs.push({
      name: "npc_vulnerabilities",
      current: monster.damageVulnerabilities.join(", "),
    });
  }
  if (monster.conditionImmunities?.length) {
    attribs.push({
      name: "npc_condition_immunities",
      current: monster.conditionImmunities.join(", "),
    });
  }

  // NPC Actions as repeating attributes
  for (let i = 0; i < monster.actions.length; i++) {
    const action = monster.actions[i];
    const rowId = `npcaction_${i}`;
    attribs.push({
      name: `repeating_npcaction_-${rowId}_name`,
      current: action.name,
    });
    attribs.push({
      name: `repeating_npcaction_-${rowId}_description`,
      current: action.description,
    });

    // Parse attack bonus and damage from description
    const attackMatch = action.description.match(/[+-](\d+) to hit/);
    if (attackMatch) {
      attribs.push({
        name: `repeating_npcaction_-${rowId}_attack_tohit`,
        current: attackMatch[1],
      });
    }
    const damageMatch = action.description.match(/(\d+d\d+(?:\s*[+-]\s*\d+)?)\s*(\w+)\s*damage/i);
    if (damageMatch) {
      attribs.push({
        name: `repeating_npcaction_-${rowId}_attack_damage`,
        current: damageMatch[1].replace(/\s/g, ""),
      });
      attribs.push({
        name: `repeating_npcaction_-${rowId}_attack_damagetype`,
        current: damageMatch[2].toLowerCase(),
      });
    }
  }

  // Build bio from traits + actions
  const bioParts: string[] = [];
  if (monster.traits?.length) {
    for (const t of monster.traits) {
      bioParts.push(`<b>${t.name}.</b> ${t.description}`);
    }
  }

  const npc = {
    name: monster.name,
    bio: bioParts.join("<br><br>"),
    attribs,
  };

  return JSON.stringify(npc, null, 2);
}

// ============================================
// PUBLIC API
// ============================================

/**
 * Render a monster stat block in the specified format.
 */
export function renderStatBlock(monster: Monster, format: StatBlockFormat): string {
  switch (format) {
    case "markdown":
      return renderMarkdown(monster);
    case "text":
      return renderText(monster);
    case "json":
      return renderJSON(monster);
    case "foundry-vtt":
      return renderFoundryVTT(monster);
    case "roll20":
      return renderRoll20(monster);
    default:
      throw new Error(`Unknown format: ${format}`);
  }
}

// ============================================
// CLI
// ============================================

if (import.meta.main) {
  const args = process.argv.slice(2);

  if (args.includes("--help") || args.includes("-h")) {
    console.log(`
StatBlock - D&D 5e Multi-Format Stat Block Renderer

Usage:
  echo '<json>' | bun StatBlock.ts [--format <fmt>]   Render stat block from JSON
  bun StatBlock.ts --help                              Show this help

Formats: markdown (default), text, json, foundry-vtt, roll20
`);
    process.exit(0);
  }

  const formatIdx = args.indexOf("--format");
  const format = (formatIdx !== -1 ? args[formatIdx + 1] : "markdown") as StatBlockFormat;

  const input = await Bun.stdin.text();
  if (input.trim()) {
    try {
      const monster: Monster = JSON.parse(input);
      console.log(renderStatBlock(monster, format));
    } catch (e) {
      console.error("Error:", e instanceof Error ? e.message : e);
      process.exit(1);
    }
  } else {
    console.log("Provide monster data as JSON via stdin. Use --help for usage.");
  }
}
