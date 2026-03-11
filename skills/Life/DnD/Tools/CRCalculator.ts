#!/usr/bin/env bun
/**
 * CRCalculator.ts - D&D 5e Challenge Rating Calculator
 *
 * Implements the DMG p274-281 CR calculation method:
 * 1. Calculate defensive CR from HP (adjusted for resistances/immunities) and AC
 * 2. Calculate offensive CR from DPR and attack bonus/save DC
 * 3. Average offensive and defensive CR for final result
 *
 * @module CRCalculator
 * @version 1.0.0
 */

import { readFileSync } from "fs";
import { join, dirname } from "path";

// ============================================
// TYPES
// ============================================

export interface MonsterStats {
  /** Hit points */
  hp: number;
  /** Armor class */
  ac: number;
  /** Attack bonus (highest) */
  attackBonus: number;
  /** Damage per round (average, across all attacks in a round) */
  dpr: number;
  /** Spell save DC (if applicable) */
  saveDC: number;
  /** Damage resistances */
  resistances?: string[];
  /** Damage immunities */
  immunities?: string[];
  /** Condition immunities */
  conditionImmunities?: string[];
  /** Number of legendary resistances */
  legendaryResistances?: number;
  /** Has Magic Resistance trait */
  magicResistance?: boolean;
  /** Flying speed (if any) */
  flyingSpeed?: number;
  /** Special traits that affect CR */
  specialTraits?: string[];
}

export interface CRResult {
  /** Final calculated CR */
  cr: number;
  /** Offensive CR (from DPR + attack/save DC) */
  offensiveCR: number;
  /** Defensive CR (from HP + AC) */
  defensiveCR: number;
  /** Detailed breakdown */
  details: string;
}

// ============================================
// CR TABLE DATA
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

interface EffectiveHPMultiplier {
  crMin: number;
  crMax: number;
  resistances: number;
  immunities: number;
}

let crTableData: {
  hpByCR: CRTableEntry[];
  statsByCR: StatsByCR[];
  effectiveHPMultipliers: { byExpectedCR: EffectiveHPMultiplier[] };
} | null = null;

function loadCRTables(): typeof crTableData {
  if (crTableData) return crTableData;
  const dataPath = join(dirname(import.meta.dir), "Data", "cr-tables.json");
  crTableData = JSON.parse(readFileSync(dataPath, "utf-8"));
  return crTableData;
}

// ============================================
// VALID CR VALUES
// ============================================

const VALID_CRS: number[] = [
  0, 0.125, 0.25, 0.5,
  1, 2, 3, 4, 5, 6, 7, 8, 9, 10,
  11, 12, 13, 14, 15, 16, 17, 18, 19, 20,
  21, 22, 23, 24, 25, 26, 27, 28, 29, 30,
];

function nearestCR(value: number): number {
  let closest = VALID_CRS[0];
  let closestDiff = Math.abs(value - closest);
  for (const cr of VALID_CRS) {
    const diff = Math.abs(value - cr);
    if (diff < closestDiff) {
      closest = cr;
      closestDiff = diff;
    }
  }
  return closest;
}

/**
 * Shift a CR by a number of table positions (steps).
 * E.g., shiftCR(0.125, +1) = 0.25, shiftCR(1, -1) = 0.5
 */
function shiftCR(baseCR: number, steps: number): number {
  const idx = VALID_CRS.indexOf(nearestCR(baseCR));
  if (idx === -1) return baseCR;
  const newIdx = Math.max(0, Math.min(VALID_CRS.length - 1, idx + steps));
  return VALID_CRS[newIdx];
}

/**
 * Average two CRs using their table index positions, not arithmetic.
 */
function averageCR(cr1: number, cr2: number): number {
  const idx1 = VALID_CRS.indexOf(nearestCR(cr1));
  const idx2 = VALID_CRS.indexOf(nearestCR(cr2));
  const avgIdx = Math.round((idx1 + idx2) / 2);
  return VALID_CRS[Math.max(0, Math.min(VALID_CRS.length - 1, avgIdx))];
}

function crToString(cr: number): string {
  if (cr === 0.125) return "1/8";
  if (cr === 0.25) return "1/4";
  if (cr === 0.5) return "1/2";
  return String(cr);
}

// ============================================
// CR CALCULATION ENGINE
// ============================================

/**
 * Find defensive CR based on HP
 */
function findDefensiveCRFromHP(effectiveHP: number): number {
  const tables = loadCRTables()!;
  for (const entry of tables.hpByCR) {
    if (effectiveHP >= entry.hpMin && effectiveHP <= entry.hpMax) {
      return entry.cr;
    }
  }
  // If HP exceeds table, return CR 30
  if (effectiveHP > 850) return 30;
  // If HP is below minimum, return CR 0
  return 0;
}

/**
 * Find offensive CR based on DPR
 */
function findOffensiveCRFromDPR(dpr: number): number {
  const tables = loadCRTables()!;
  for (const entry of tables.statsByCR) {
    if (dpr >= entry.dprMin && dpr <= entry.dprMax) {
      return entry.cr;
    }
  }
  // If DPR exceeds table, return CR 30
  if (dpr > 320) return 30;
  return 0;
}

/**
 * Get expected AC for a given CR
 */
function getExpectedAC(cr: number): number {
  const tables = loadCRTables()!;
  const entry = tables.statsByCR.find((e) => e.cr === cr);
  return entry?.ac ?? 13;
}

/**
 * Get expected attack bonus for a given CR
 */
function getExpectedAttackBonus(cr: number): number {
  const tables = loadCRTables()!;
  const entry = tables.statsByCR.find((e) => e.cr === cr);
  return entry?.attackBonus ?? 3;
}

/**
 * Get expected save DC for a given CR
 */
function getExpectedSaveDC(cr: number): number {
  const tables = loadCRTables()!;
  const entry = tables.statsByCR.find((e) => e.cr === cr);
  return entry?.saveDC ?? 13;
}

/**
 * Get effective HP multiplier based on resistances/immunities
 */
function getEffectiveHPMultiplier(
  estimatedCR: number,
  hasResistances: boolean,
  hasImmunities: boolean
): number {
  const tables = loadCRTables()!;
  let multiplier = 1.0;

  for (const tier of tables.effectiveHPMultipliers.byExpectedCR) {
    if (estimatedCR >= tier.crMin && estimatedCR <= tier.crMax) {
      if (hasImmunities) {
        multiplier = tier.immunities;
      } else if (hasResistances) {
        multiplier = tier.resistances;
      }
      break;
    }
  }

  return multiplier;
}

/**
 * Calculate Challenge Rating for a monster using the DMG method.
 *
 * Algorithm (DMG p274):
 * 1. Determine defensive CR from effective HP, then adjust by AC difference
 * 2. Determine offensive CR from DPR, then adjust by attack bonus/save DC difference
 * 3. Average offensive and defensive CR, round to nearest valid CR
 */
export function calculateCR(stats: MonsterStats): CRResult {
  const details: string[] = [];

  // Step 1: Calculate effective HP
  let effectiveHP = stats.hp;
  const hasResistances = (stats.resistances?.length ?? 0) >= 3;
  const hasImmunities = (stats.immunities?.length ?? 0) >= 3;

  // Initial CR estimate for HP multiplier lookup
  const initialDefCR = findDefensiveCRFromHP(stats.hp);

  // Apply HP multipliers for resistances/immunities
  const hpMultiplier = getEffectiveHPMultiplier(
    initialDefCR,
    hasResistances,
    hasImmunities
  );
  effectiveHP = Math.round(stats.hp * hpMultiplier);

  // Additional adjustments per DMG guidelines
  if (stats.legendaryResistances && stats.legendaryResistances > 0) {
    // Each legendary resistance is effectively a free save success.
    // At high CR, these are worth more because each failed save averts high-damage effects.
    // Approximately +30 effective HP per legendary resistance (scales better)
    effectiveHP += stats.legendaryResistances * 30;
  }
  if (stats.magicResistance) {
    // Magic Resistance (advantage on saves vs spells) is significant defensive boost
    effectiveHP = Math.round(effectiveHP * 1.15);
  }
  if (stats.flyingSpeed && stats.flyingSpeed > 0) {
    // Flying creatures are harder to damage in melee. Minor effective HP boost.
    effectiveHP = Math.round(effectiveHP * 1.05);
  }
  if ((stats.conditionImmunities?.length ?? 0) >= 4) {
    // Extensive condition immunities (4+) make the creature significantly harder to control
    effectiveHP = Math.round(effectiveHP * 1.1);
  }

  details.push(`Effective HP: ${effectiveHP} (base ${stats.hp}, multiplier ${hpMultiplier}x)`);

  // Step 2: Defensive CR from effective HP
  let defensiveCR = findDefensiveCRFromHP(effectiveHP);
  details.push(`Defensive CR (from HP): ${crToString(defensiveCR)}`);

  // Adjust defensive CR by AC difference using table index shifting
  const expectedAC = getExpectedAC(defensiveCR);
  const acDiff = stats.ac - expectedAC;
  // Every 2 points of AC above/below expected shifts CR by 1 step in the table
  const acAdjustment = Math.floor(acDiff / 2);
  if (acAdjustment !== 0) {
    details.push(`AC adjustment: ${stats.ac} vs expected ${expectedAC} = ${acAdjustment >= 0 ? "+" : ""}${acAdjustment} steps`);
  }
  defensiveCR = shiftCR(defensiveCR, acAdjustment);
  details.push(`Defensive CR (adjusted): ${crToString(defensiveCR)}`);

  // Step 3: Offensive CR from DPR
  let offensiveCR = findOffensiveCRFromDPR(stats.dpr);
  details.push(`Offensive CR (from DPR ${stats.dpr}): ${crToString(offensiveCR)}`);

  // Use the higher of attack bonus and save DC for offensive adjustment
  const expectedAttack = getExpectedAttackBonus(offensiveCR);
  const expectedSaveDC = getExpectedSaveDC(offensiveCR);

  const attackDiff = stats.attackBonus - expectedAttack;
  const saveDCDiff = stats.saveDC - expectedSaveDC;

  // Use whichever gives the higher adjustment (steps in table)
  const offensiveAdjustment = Math.max(
    Math.floor(attackDiff / 2),
    Math.floor(saveDCDiff / 2)
  );

  if (offensiveAdjustment !== 0) {
    details.push(`Offensive adjustment: attack ${stats.attackBonus} vs expected ${expectedAttack}, save DC ${stats.saveDC} vs expected ${expectedSaveDC} = ${offensiveAdjustment >= 0 ? "+" : ""}${offensiveAdjustment} steps`);
  }
  offensiveCR = shiftCR(offensiveCR, offensiveAdjustment);
  details.push(`Offensive CR (adjusted): ${crToString(offensiveCR)}`);

  // Step 4: Average using table index positions (not arithmetic on CR values)
  let finalCR = averageCR(defensiveCR, offensiveCR);

  // Special trait adjustments
  if (stats.specialTraits?.includes("reflective_carapace")) {
    // Reflective carapace negates and reflects ranged spell attacks -- extremely powerful
    finalCR = shiftCR(finalCR, 2);
    details.push("Reflective Carapace: +2 CR steps");
  }
  if (stats.specialTraits?.includes("siege_monster")) {
    // Minimal combat impact but noted
    details.push("Siege Monster: noted (no CR change)");
  }

  // Ensure we don't exceed bounds
  finalCR = Math.max(0, Math.min(30, finalCR));
  finalCR = nearestCR(finalCR);

  details.push(`Final CR: ${crToString(finalCR)} (average of ${crToString(defensiveCR)} defensive + ${crToString(offensiveCR)} offensive)`);

  return {
    cr: finalCR,
    offensiveCR,
    defensiveCR,
    details: details.join("\n"),
  };
}

// ============================================
// CLI
// ============================================

if (import.meta.main) {
  const args = process.argv.slice(2);

  if (args.includes("--help") || args.includes("-h")) {
    console.log(`
CRCalculator - D&D 5e Challenge Rating Calculator

Usage:
  echo '<json>' | bun CRCalculator.ts          Calculate CR from JSON stats
  bun CRCalculator.ts --test                    Run built-in validation
  bun CRCalculator.ts --help                    Show this help

Input JSON format:
  {
    "hp": 256,
    "ac": 19,
    "attackBonus": 14,
    "dpr": 73,
    "saveDC": 21,
    "resistances": ["fire"],
    "immunities": [],
    "legendaryResistances": 3
  }
`);
    process.exit(0);
  }

  if (args.includes("--test")) {
    console.log("Running CRCalculator validation...\n");
    const tests: Array<{ name: string; stats: MonsterStats; expected: number }> = [
      {
        name: "Goblin (CR 1/4)",
        stats: { hp: 7, ac: 15, attackBonus: 4, dpr: 5, saveDC: 10 },
        expected: 0.25,
      },
      {
        name: "Adult Red Dragon (CR 17)",
        stats: {
          hp: 256, ac: 19, attackBonus: 14, dpr: 73, saveDC: 21,
          resistances: ["fire"], legendaryResistances: 3, flyingSpeed: 80,
        },
        expected: 17,
      },
      {
        name: "Tarrasque (CR 30)",
        stats: {
          hp: 676, ac: 25, attackBonus: 19, dpr: 148, saveDC: 24,
          immunities: ["fire", "poison", "bludgeoning", "piercing", "slashing"],
          conditionImmunities: ["charmed", "frightened", "paralyzed", "poisoned"],
          legendaryResistances: 5, magicResistance: true,
          specialTraits: ["reflective_carapace", "siege_monster"],
        },
        expected: 30,
      },
    ];

    let passed = 0;
    for (const test of tests) {
      const result = calculateCR(test.stats);
      const ok = result.cr === test.expected;
      console.log(`${ok ? "PASS" : "FAIL"}: ${test.name} - Got CR ${crToString(result.cr)}, expected CR ${crToString(test.expected)}`);
      if (!ok) {
        console.log(`  Details:\n  ${result.details.split("\n").join("\n  ")}`);
      }
      if (ok) passed++;
    }
    console.log(`\n${passed}/${tests.length} tests passed`);
    process.exit(passed === tests.length ? 0 : 1);
  }

  // Read from stdin
  const input = await Bun.stdin.text();
  if (input.trim()) {
    try {
      const stats: MonsterStats = JSON.parse(input);
      const result = calculateCR(stats);
      console.log(JSON.stringify(result, null, 2));
    } catch (e) {
      console.error("Error:", e instanceof Error ? e.message : e);
      process.exit(1);
    }
  } else {
    console.log("Provide monster stats as JSON via stdin. Use --help for usage.");
  }
}
