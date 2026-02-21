#!/usr/bin/env bun
/**
 * HomebrewValidator.ts - D&D 5e Homebrew Content Validator
 *
 * Validates homebrew monsters, spells, and items against SRD expectations.
 * Compares stats to CRCalculator targets for monsters, level-appropriate
 * damage for spells, and rarity-appropriate properties for items.
 *
 * @module HomebrewValidator
 * @version 1.0.0
 */

import { join, dirname } from "path";

// ============================================
// TYPES
// ============================================

export interface ValidationFlag {
  field: string;
  actual: number | string;
  expected: number | string;
  deviation: string;
  severity: "warning" | "error";
}

export interface ValidationResult {
  status: "balanced" | "overpowered" | "underpowered";
  flags: ValidationFlag[];
  suggestions: string[];
}

export interface MonsterValidationInput {
  name: string;
  cr: number;
  hp: number;
  ac: number;
  attackBonus: number;
  dpr: number;
  saveDC: number;
  resistances?: string[];
  immunities?: string[];
}

export interface SpellValidationInput {
  name: string;
  level: number;
  school: string;
  damage?: string;
  damageType?: string;
  range?: string;
  area?: string;
  duration?: string;
}

export interface ItemValidationInput {
  name: string;
  type: string;
  rarity: "common" | "uncommon" | "rare" | "very rare" | "legendary" | "artifact";
  properties: string[];
  attunement?: boolean;
}

// ============================================
// DATA LOADING
// ============================================

interface CRTableEntry {
  cr: number;
  hpMin: number;
  hpMax: number;
}

interface StatsByCR {
  cr: number;
  profBonus: number;
  ac: number;
  attackBonus: number;
  saveDC: number;
  dprMin: number;
  dprMax: number;
}

let crTableData: {
  hpByCR: CRTableEntry[];
  statsByCR: StatsByCR[];
} | null = null;

let spellData: any = null;
let itemData: any = null;

function loadCRTables() {
  if (crTableData) return crTableData;
  const dataPath = join(dirname(import.meta.dir), "Data", "cr-tables.json");
  crTableData = JSON.parse(require("fs").readFileSync(dataPath, "utf-8"));
  return crTableData!;
}

function loadSpells() {
  if (spellData) return spellData;
  const dataPath = join(dirname(import.meta.dir), "Data", "srd-spells.json");
  spellData = JSON.parse(require("fs").readFileSync(dataPath, "utf-8"));
  return spellData;
}

function loadItems() {
  if (itemData) return itemData;
  const dataPath = join(dirname(import.meta.dir), "Data", "srd-items.json");
  itemData = JSON.parse(require("fs").readFileSync(dataPath, "utf-8"));
  return itemData;
}

// ============================================
// DAMAGE PARSING
// ============================================

/**
 * Calculate average damage from dice notation like "8d6", "5d8+20"
 */
function averageDamage(notation: string): number {
  if (!notation) return 0;
  const match = notation.match(/^(\d+)d(\d+)(?:([+-])(\d+))?$/);
  if (!match) return 0;
  const count = parseInt(match[1]);
  const sides = parseInt(match[2]);
  const mod = match[3]
    ? (match[3] === "+" ? 1 : -1) * parseInt(match[4])
    : 0;
  return count * ((sides + 1) / 2) + mod;
}

// ============================================
// MONSTER VALIDATION
// ============================================

/**
 * Validate a homebrew monster against DMG CR expectations.
 * Flags deviations > +/- 15% from expected values.
 */
export function validateMonster(input: MonsterValidationInput): ValidationResult {
  const tables = loadCRTables();
  const flags: ValidationFlag[] = [];
  const suggestions: string[] = [];
  const THRESHOLD = 0.15; // 15% deviation threshold

  // Find expected stats for this CR
  const crEntry = tables.hpByCR.find((e) => e.cr === input.cr);
  const statsEntry = tables.statsByCR.find((e) => e.cr === input.cr);

  if (!crEntry || !statsEntry) {
    return {
      status: "balanced",
      flags: [{ field: "cr", actual: input.cr, expected: "0-30", deviation: "CR not found in tables", severity: "error" }],
      suggestions: ["Verify the CR value is between 0 and 30"],
    };
  }

  // Check HP
  const expectedHPMid = (crEntry.hpMin + crEntry.hpMax) / 2;
  const hpDeviation = (input.hp - expectedHPMid) / expectedHPMid;

  if (Math.abs(hpDeviation) > THRESHOLD) {
    flags.push({
      field: "hp",
      actual: input.hp,
      expected: `${crEntry.hpMin}-${crEntry.hpMax}`,
      deviation: `${(hpDeviation * 100).toFixed(0)}%`,
      severity: Math.abs(hpDeviation) > 0.5 ? "error" : "warning",
    });
    if (hpDeviation > 0) {
      suggestions.push(`Reduce HP from ${input.hp} to ${crEntry.hpMin}-${crEntry.hpMax} range for CR ${input.cr}`);
    } else {
      suggestions.push(`Increase HP from ${input.hp} to ${crEntry.hpMin}-${crEntry.hpMax} range for CR ${input.cr}`);
    }
  }

  // Check AC
  const acDeviation = (input.ac - statsEntry.ac) / statsEntry.ac;
  if (Math.abs(acDeviation) > THRESHOLD) {
    flags.push({
      field: "ac",
      actual: input.ac,
      expected: statsEntry.ac,
      deviation: `${(acDeviation * 100).toFixed(0)}%`,
      severity: Math.abs(acDeviation) > 0.3 ? "error" : "warning",
    });
    if (acDeviation > 0) {
      suggestions.push(`Reduce AC from ${input.ac} to approximately ${statsEntry.ac} for CR ${input.cr}`);
    } else {
      suggestions.push(`Increase AC from ${input.ac} to approximately ${statsEntry.ac} for CR ${input.cr}`);
    }
  }

  // Check DPR
  const expectedDPRMid = (statsEntry.dprMin + statsEntry.dprMax) / 2;
  const dprDeviation = expectedDPRMid > 0 ? (input.dpr - expectedDPRMid) / expectedDPRMid : 0;

  if (Math.abs(dprDeviation) > THRESHOLD) {
    flags.push({
      field: "dpr",
      actual: input.dpr,
      expected: `${statsEntry.dprMin}-${statsEntry.dprMax}`,
      deviation: `${(dprDeviation * 100).toFixed(0)}%`,
      severity: Math.abs(dprDeviation) > 0.5 ? "error" : "warning",
    });
    if (dprDeviation > 0) {
      suggestions.push(`Reduce DPR from ${input.dpr} to ${statsEntry.dprMin}-${statsEntry.dprMax} range for CR ${input.cr}`);
    } else {
      suggestions.push(`Increase DPR from ${input.dpr} to ${statsEntry.dprMin}-${statsEntry.dprMax} range for CR ${input.cr}`);
    }
  }

  // Check Attack Bonus
  const atkDeviation = (input.attackBonus - statsEntry.attackBonus) / Math.max(statsEntry.attackBonus, 1);
  if (Math.abs(atkDeviation) > THRESHOLD) {
    flags.push({
      field: "attackBonus",
      actual: input.attackBonus,
      expected: statsEntry.attackBonus,
      deviation: `${(atkDeviation * 100).toFixed(0)}%`,
      severity: Math.abs(atkDeviation) > 0.5 ? "error" : "warning",
    });
  }

  // Check Save DC
  const dcDeviation = (input.saveDC - statsEntry.saveDC) / statsEntry.saveDC;
  if (Math.abs(dcDeviation) > THRESHOLD) {
    flags.push({
      field: "saveDC",
      actual: input.saveDC,
      expected: statsEntry.saveDC,
      deviation: `${(dcDeviation * 100).toFixed(0)}%`,
      severity: Math.abs(dcDeviation) > 0.3 ? "error" : "warning",
    });
  }

  // Determine overall status
  const hasOverpoweredFlags = flags.some((f) => {
    const dev = parseFloat(f.deviation);
    return dev > 0;
  });
  const hasUnderpoweredFlags = flags.some((f) => {
    const dev = parseFloat(f.deviation);
    return dev < 0;
  });

  let status: ValidationResult["status"] = "balanced";
  if (flags.length > 0) {
    // Count error-severity flags in each direction
    const overErrors = flags.filter((f) => parseFloat(f.deviation) > 0 && f.severity === "error").length;
    const underErrors = flags.filter((f) => parseFloat(f.deviation) < 0 && f.severity === "error").length;

    if (overErrors >= underErrors && overErrors > 0) {
      status = "overpowered";
    } else if (underErrors > overErrors) {
      status = "underpowered";
    } else if (hasOverpoweredFlags && !hasUnderpoweredFlags) {
      status = "overpowered";
    } else if (hasUnderpoweredFlags && !hasOverpoweredFlags) {
      status = "underpowered";
    }
  }

  return { status, flags, suggestions };
}

// ============================================
// SPELL VALIDATION
// ============================================

/**
 * Expected damage benchmarks by spell level (approximate DMG guidelines).
 * Level 0 is cantrip. Values are average damage for a "damage focused" spell.
 */
const SPELL_DAMAGE_BENCHMARKS: Record<number, { low: number; mid: number; high: number }> = {
  0: { low: 3, mid: 5.5, high: 10 },
  1: { low: 5, mid: 10, high: 18 },
  2: { low: 10, mid: 16, high: 24 },
  3: { low: 18, mid: 28, high: 40 },
  4: { low: 22, mid: 32, high: 45 },
  5: { low: 28, mid: 36, high: 50 },
  6: { low: 35, mid: 55, high: 75 },
  7: { low: 40, mid: 60, high: 85 },
  8: { low: 45, mid: 65, high: 90 },
  9: { low: 50, mid: 75, high: 110 },
};

/**
 * Validate a homebrew spell against SRD expectations.
 */
export function validateSpell(input: SpellValidationInput): ValidationResult & { comparableSpells: any[] } {
  const spells = loadSpells();
  const flags: ValidationFlag[] = [];
  const suggestions: string[] = [];

  // Find comparable SRD spells at the same level
  const comparableSpells = spells.spells.filter((s: any) => s.level === input.level);

  // Check damage if applicable
  if (input.damage) {
    const avgDmg = averageDamage(input.damage);
    const benchmark = SPELL_DAMAGE_BENCHMARKS[input.level];

    if (benchmark) {
      if (avgDmg > benchmark.high * 1.15) {
        flags.push({
          field: "damage",
          actual: `${input.damage} (avg ${avgDmg})`,
          expected: `${benchmark.low}-${benchmark.high} avg`,
          deviation: `${(((avgDmg - benchmark.mid) / benchmark.mid) * 100).toFixed(0)}%`,
          severity: "error",
        });
        suggestions.push(`Damage ${input.damage} (avg ${avgDmg}) exceeds level ${input.level} benchmark. Consider reducing to ~${benchmark.mid} avg.`);
      } else if (avgDmg < benchmark.low * 0.85) {
        flags.push({
          field: "damage",
          actual: `${input.damage} (avg ${avgDmg})`,
          expected: `${benchmark.low}-${benchmark.high} avg`,
          deviation: `${(((avgDmg - benchmark.mid) / benchmark.mid) * 100).toFixed(0)}%`,
          severity: "warning",
        });
        suggestions.push(`Damage ${input.damage} (avg ${avgDmg}) is below level ${input.level} benchmark. Consider increasing to ~${benchmark.mid} avg.`);
      }
    }
  }

  // Determine status
  let status: ValidationResult["status"] = "balanced";
  if (flags.length > 0) {
    const deviation = parseFloat(flags[0].deviation);
    status = deviation > 0 ? "overpowered" : "underpowered";
  }

  return { status, flags, suggestions, comparableSpells };
}

// ============================================
// ITEM VALIDATION
// ============================================

/**
 * Expected property power levels by rarity.
 */
const RARITY_POWER: Record<string, number> = {
  common: 1,
  uncommon: 2,
  rare: 3,
  "very rare": 4,
  legendary: 5,
  artifact: 6,
};

/**
 * Estimate the power level of item properties.
 */
function estimatePropertyPower(properties: string[]): number {
  let power = 0;
  for (const prop of properties) {
    const lower = prop.toLowerCase();
    // +X bonuses
    if (lower.includes("+1")) power += 2;
    else if (lower.includes("+2")) power += 3;
    else if (lower.includes("+3")) power += 5;

    // Powerful keywords
    if (lower.includes("truesight")) power += 4;
    if (lower.includes("invisibility")) power += 3;
    if (lower.includes("fly") || lower.includes("flying")) power += 3;
    if (lower.includes("teleport")) power += 4;
    if (lower.includes("resistance")) power += 2;
    if (lower.includes("immunity")) power += 4;
    if (lower.includes("wish")) power += 6;
    if (lower.includes("legendary")) power += 4;
    if (lower.includes("extra damage") || lower.includes("extra attack")) power += 2;
  }
  return power;
}

/**
 * Validate a homebrew item against rarity expectations.
 */
export function validateItem(input: ItemValidationInput): ValidationResult {
  const flags: ValidationFlag[] = [];
  const suggestions: string[] = [];

  const rarityPower = RARITY_POWER[input.rarity] ?? 2;
  const propertyPower = estimatePropertyPower(input.properties);

  // Power threshold: rarity * 1.5 is the acceptable max
  const powerThreshold = rarityPower * 1.5;

  if (propertyPower > powerThreshold + 1) {
    flags.push({
      field: "properties",
      actual: `power level ${propertyPower}`,
      expected: `power level ${rarityPower}-${Math.round(powerThreshold)}`,
      deviation: `${(((propertyPower - rarityPower) / rarityPower) * 100).toFixed(0)}%`,
      severity: "error",
    });
    suggestions.push(`Properties are too powerful for ${input.rarity} rarity. Consider upgrading rarity to ${Object.entries(RARITY_POWER).find(([_, v]) => v >= Math.ceil(propertyPower / 1.5))?.[0] || "legendary"} or reducing properties.`);
  } else if (propertyPower < rarityPower * 0.5 && propertyPower > 0) {
    flags.push({
      field: "properties",
      actual: `power level ${propertyPower}`,
      expected: `power level ${rarityPower}-${Math.round(powerThreshold)}`,
      deviation: `${(((propertyPower - rarityPower) / rarityPower) * 100).toFixed(0)}%`,
      severity: "warning",
    });
    suggestions.push(`Properties seem weak for ${input.rarity} rarity. Consider downgrading rarity or adding effects.`);
  }

  let status: ValidationResult["status"] = "balanced";
  if (flags.length > 0) {
    const deviation = parseFloat(flags[0].deviation);
    status = deviation > 0 ? "overpowered" : "underpowered";
  }

  return { status, flags, suggestions };
}

// ============================================
// CLI
// ============================================

if (import.meta.main) {
  const args = process.argv.slice(2);

  if (args.includes("--help") || args.includes("-h")) {
    console.log(`
HomebrewValidator - D&D 5e Homebrew Content Validator

Usage:
  bun HomebrewValidator.ts --file <path> --type <monster|spell|item> [--json]
  echo '<json>' | bun HomebrewValidator.ts --type <monster|spell|item> [--json]
  bun HomebrewValidator.ts --help

Options:
  --file <path>   Path to JSON file to validate
  --type <type>   Content type: monster, spell, or item
  --json          Output as JSON
  --help          Show this help

Monster JSON format:
  { "name": "...", "cr": 5, "hp": 136, "ac": 15, "attackBonus": 6, "dpr": 35, "saveDC": 15 }

Spell JSON format:
  { "name": "...", "level": 3, "school": "evocation", "damage": "8d6", "damageType": "fire" }

Item JSON format:
  { "name": "...", "type": "Weapon", "rarity": "uncommon", "properties": ["+1 to attack and damage"] }
`);
    process.exit(0);
  }

  const jsonOutput = args.includes("--json");
  const fileIdx = args.indexOf("--file");
  const typeIdx = args.indexOf("--type");

  const contentType = typeIdx !== -1 ? args[typeIdx + 1] : null;

  // Load input from file or stdin
  let inputStr = "";
  if (fileIdx !== -1) {
    const filePath = args[fileIdx + 1];
    inputStr = require("fs").readFileSync(filePath, "utf-8");
  } else {
    inputStr = await Bun.stdin.text();
  }

  if (!inputStr.trim()) {
    console.error("Error: no input provided. Use --file or pipe JSON via stdin.");
    process.exit(1);
  }

  if (!contentType) {
    console.error("Error: --type is required (monster, spell, or item).");
    process.exit(1);
  }

  try {
    const input = JSON.parse(inputStr);
    let result: any;

    switch (contentType) {
      case "monster":
        result = validateMonster(input);
        break;
      case "spell":
        result = validateSpell(input);
        break;
      case "item":
        result = validateItem(input);
        break;
      default:
        console.error(`Unknown type: ${contentType}`);
        process.exit(1);
    }

    if (jsonOutput) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      const icon = result.status === "balanced" ? "PASS" : result.status === "overpowered" ? "OVER" : "UNDER";
      console.log(`[${icon}] ${input.name || "Unknown"}: ${result.status}`);
      if (result.flags.length > 0) {
        console.log("Flags:");
        for (const f of result.flags) {
          console.log(`  ${f.severity === "error" ? "!!!" : " ! "} ${f.field}: ${f.actual} (expected ${f.expected}, ${f.deviation})`);
        }
      }
      if (result.suggestions.length > 0) {
        console.log("Suggestions:");
        for (const s of result.suggestions) {
          console.log(`  -> ${s}`);
        }
      }
    }
  } catch (e) {
    console.error("Error:", e instanceof Error ? e.message : e);
    process.exit(1);
  }
}
