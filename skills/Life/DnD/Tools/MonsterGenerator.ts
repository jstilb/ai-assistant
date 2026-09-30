#!/usr/bin/env bun
/**
 * MonsterGenerator.ts - D&D 5e AI-Powered Monster Generator
 *
 * Generates complete monster stat blocks using AI inference + CR validation.
 * Validates output against CRCalculator and adjusts HP/DPR to fit target CR.
 *
 * @module MonsterGenerator
 * @version 1.0.0
 */

import { join, dirname } from "path";
import { readFileSync } from "fs";
import { calculateCR, deriveHitDice, type MonsterStats } from "./CRCalculator";
import type { Monster } from "./StatBlock";
import { loadCRTables, loadXPData, type CRTableEntry, type StatsByCR, type CRTables, type XPThresholdData as XPData } from "./shared/DnDData";

// ============================================
// TYPES
// ============================================

export interface GeneratedMonsterStats {
  name: string;
  size?: "Tiny" | "Small" | "Medium" | "Large" | "Huge" | "Gargantuan";
  type?: string;
  subtype?: string;
  alignment?: string;
  hp: number;
  ac: number;
  acType?: string;
  attackBonus: number;
  dpr: number;
  saveDC: number;
  speed?: Record<string, number>;
  abilities?: { str: number; dex: number; con: number; int: number; wis: number; cha: number };
  savingThrows?: Record<string, number>;
  skills?: Record<string, number>;
  damageResistances?: string[];
  damageImmunities?: string[];
  conditionImmunities?: string[];
  senses?: { darkvision?: number; blindsight?: number; tremorsense?: number; truesight?: number; passivePerception: number };
  languages?: string[];
  traits?: Array<{ name: string; description: string }>;
  actions?: Array<{ name: string; description: string }>;
  bonusActions?: Array<{ name: string; description: string }>;
  reactions?: Array<{ name: string; description: string }>;
  legendaryActions?: Array<{ name: string; description: string }>;
}

export interface GeneratorOptions {
  cr: number;
  type?: string;
  environment?: string;
  name?: string;
  random?: boolean;
  traits?: string;
}

/** @internal — test-only injection; not part of the public interface */
interface GeneratorOptionsInternal extends GeneratorOptions {
  _mockInference?: (prompt: string) => Promise<string>;
}

// ============================================
// DATA LOADING
// ============================================

// Shared types and loaders imported from ./shared/DnDData

// ============================================
// CR-BASED STAT ADJUSTMENT
// ============================================

/**
 * Adjust generated monster stats to match a target CR.
 * Scales HP and DPR to fit DMG expectations within +/- 10%.
 */
export function adjustStatsToCR(stats: GeneratedMonsterStats, targetCR: number): GeneratedMonsterStats {
  const tables = loadCRTables();
  const crEntry = tables.hpByCR.find((e) => e.cr === targetCR);
  const statsEntry = tables.statsByCR.find((e) => e.cr === targetCR);

  if (!crEntry || !statsEntry) {
    return stats;
  }

  const adjusted = { ...stats };

  // Adjust HP to target range
  const targetHPMid = Math.round((crEntry.hpMin + crEntry.hpMax) / 2);
  const hpRange = crEntry.hpMax - crEntry.hpMin;
  if (adjusted.hp < crEntry.hpMin * 0.85 || adjusted.hp > crEntry.hpMax * 1.15) {
    // Apply some variance (+/- 15% from midpoint)
    const variance = Math.round((Math.random() - 0.5) * hpRange * 0.5);
    adjusted.hp = Math.max(1, targetHPMid + variance);
  }

  // Adjust AC to target
  if (Math.abs(adjusted.ac - statsEntry.ac) > 3) {
    adjusted.ac = statsEntry.ac + Math.round((Math.random() - 0.5) * 2);
  }

  // Adjust attack bonus
  if (Math.abs(adjusted.attackBonus - statsEntry.attackBonus) > 3) {
    adjusted.attackBonus = statsEntry.attackBonus + Math.round((Math.random() - 0.5) * 2);
  }

  // Adjust DPR to target range
  const targetDPRMid = Math.round((statsEntry.dprMin + statsEntry.dprMax) / 2);
  const dprRange = statsEntry.dprMax - statsEntry.dprMin;
  if (adjusted.dpr < statsEntry.dprMin * 0.85 || adjusted.dpr > statsEntry.dprMax * 1.15) {
    const variance = Math.round((Math.random() - 0.5) * dprRange * 0.5);
    adjusted.dpr = Math.max(1, targetDPRMid + variance);
  }

  // Adjust save DC
  if (Math.abs(adjusted.saveDC - statsEntry.saveDC) > 3) {
    adjusted.saveDC = statsEntry.saveDC + Math.round((Math.random() - 0.5) * 2);
  }

  return adjusted;
}

// ============================================
// MONSTER BUILDING
// ============================================

/**
 * Build a complete monster object with XP and hit dice from generated stats.
 */
export function buildMonsterFromStats(stats: GeneratedMonsterStats, cr: number): Monster {
  const xp = loadXPData();
  const monsterXP = xp.xpByCR[String(cr)] || 0;

  // Calculate hit dice from HP, size, and CON via CRCalculator
  const conScore = stats.abilities?.con ?? 14; // default CON 14 if no abilities provided
  const { hitDiceStr } = deriveHitDice(stats.hp, stats.size ?? "Medium", conScore);

  return {
    name: stats.name,
    size: stats.size || "Medium",
    type: stats.type || "monstrosity",
    subtype: stats.subtype,
    alignment: stats.alignment || "unaligned",
    ac: stats.ac,
    acType: stats.acType,
    hp: stats.hp,
    hitDice: hitDiceStr,
    speed: stats.speed || { walk: 30 },
    abilities: stats.abilities || { str: 10, dex: 10, con: 10, int: 10, wis: 10, cha: 10 },
    savingThrows: stats.savingThrows,
    skills: stats.skills,
    damageResistances: stats.damageResistances,
    damageImmunities: stats.damageImmunities,
    conditionImmunities: stats.conditionImmunities,
    senses: stats.senses || { passivePerception: 10 },
    languages: stats.languages || [],
    cr,
    xp: monsterXP,
    traits: stats.traits || [],
    actions: stats.actions || [
      {
        name: "Attack",
        description: `Melee Weapon Attack: +${stats.attackBonus} to hit, reach 5 ft., one target. Hit: ${stats.dpr} damage.`,
      },
    ],
    bonusActions: stats.bonusActions,
    reactions: stats.reactions,
    legendaryActions: stats.legendaryActions,
  };
}

// ============================================
// AI-POWERED GENERATION
// ============================================

/**
 * Generate monster stats using AI inference (or mock for testing).
 */
export async function generateMonsterStats(options: GeneratorOptions | GeneratorOptionsInternal): Promise<GeneratedMonsterStats> {
  const opts = options as GeneratorOptionsInternal;
  const tables = loadCRTables();
  const crEntry = tables.hpByCR.find((e) => e.cr === options.cr);
  const statsEntry = tables.statsByCR.find((e) => e.cr === options.cr);

  const hpMid = crEntry ? Math.round((crEntry.hpMin + crEntry.hpMax) / 2) : 50;
  const dprMid = statsEntry ? Math.round((statsEntry.dprMin + statsEntry.dprMax) / 2) : 10;

  const prompt = `Generate a D&D 5e monster stat block as JSON. Requirements:
- Name: ${options.name || "generate a creative name"}
- Challenge Rating: ${options.cr}
- Type: ${options.type || "any"}
- Environment: ${options.environment || "any"}
${options.traits ? `- Must have these traits: ${options.traits}` : ""}
- Target HP: approximately ${hpMid} (range ${crEntry?.hpMin}-${crEntry?.hpMax})
- Target DPR: approximately ${dprMid} (range ${statsEntry?.dprMin}-${statsEntry?.dprMax})
- Target AC: ${statsEntry?.ac || 13}
- Target Attack Bonus: +${statsEntry?.attackBonus || 3}
- Target Save DC: ${statsEntry?.saveDC || 13}

Return ONLY valid JSON with these fields:
{
  "name": "string",
  "size": "Medium|Large|etc",
  "type": "beast|monstrosity|etc",
  "alignment": "string",
  "hp": number,
  "ac": number,
  "attackBonus": number,
  "dpr": number,
  "saveDC": number,
  "speed": { "walk": 30 },
  "abilities": { "str": 10, "dex": 10, "con": 10, "int": 10, "wis": 10, "cha": 10 },
  "traits": [{ "name": "string", "description": "string" }],
  "actions": [{ "name": "string", "description": "string" }]
}`;

  let rawOutput: string;

  if (opts._mockInference) {
    rawOutput = await opts._mockInference(prompt);
  } else {
    // Real inference via CORE Inference tool
    const { inference } = await import("../../../../lib/core/Inference");
    const result = await inference({
      systemPrompt: "You are a D&D 5e monster designer. Output ONLY valid JSON, no markdown or explanation.",
      userPrompt: prompt,
      level: "standard",
      expectJson: true,
    });

    if (!result.success || !result.parsed) {
      throw new Error(`Inference failed: ${result.error || "no output"}`);
    }
    rawOutput = JSON.stringify(result.parsed);
  }

  // Parse and validate
  let parsed: GeneratedMonsterStats;
  try {
    parsed = JSON.parse(rawOutput);
  } catch {
    // Try to extract JSON from the output
    const jsonMatch = rawOutput.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error("No valid JSON in inference output");
    parsed = JSON.parse(jsonMatch[0]);
  }

  // Ensure required fields
  if (!parsed.name) parsed.name = options.name || "Unknown Monster";
  if (!parsed.hp) parsed.hp = hpMid;
  if (!parsed.ac) parsed.ac = statsEntry?.ac || 13;
  if (!parsed.attackBonus) parsed.attackBonus = statsEntry?.attackBonus || 3;
  if (!parsed.dpr) parsed.dpr = dprMid;
  if (!parsed.saveDC) parsed.saveDC = statsEntry?.saveDC || 13;

  // Adjust to match target CR
  return adjustStatsToCR(parsed, options.cr);
}

// ============================================
// CLI
// ============================================

if (import.meta.main) {
  const args = process.argv.slice(2);

  if (args.includes("--help") || args.includes("-h")) {
    console.log(`
MonsterGenerator - D&D 5e AI-Powered Monster Generator

Usage:
  bun MonsterGenerator.ts --cr <n> [--type <type>] [--environment <env>] [--name <name>] [--json]
  bun MonsterGenerator.ts --cr <n> --random [--json]
  bun MonsterGenerator.ts --cr <n> --traits "pack tactics, keen smell" [--json]
  echo '<partial-json>' | bun MonsterGenerator.ts --cr <n> [--json]
  bun MonsterGenerator.ts --help

Options:
  --cr <n>             Target Challenge Rating (0-30)
  --type <type>        Monster type (beast, monstrosity, undead, etc.)
  --environment <env>  Environment (forest, mountain, swamp, etc.)
  --name <name>        Monster name
  --random             Generate a random monster
  --traits <traits>    Custom traits (comma-separated)
  --json               Output as JSON
  --help               Show this help
`);
    process.exit(0);
  }

  const jsonOutput = args.includes("--json");
  const crIdx = args.indexOf("--cr");
  const typeIdx = args.indexOf("--type");
  const envIdx = args.indexOf("--environment");
  const nameIdx = args.indexOf("--name");
  const traitsIdx = args.indexOf("--traits");
  const random = args.includes("--random");

  if (crIdx === -1) {
    // Check stdin
    const input = await Bun.stdin.text();
    if (input.trim()) {
      try {
        const partial = JSON.parse(input);
        const cr = partial.cr || 1;
        const stats = adjustStatsToCR(partial, cr);
        const monster = buildMonsterFromStats(stats, cr);
        console.log(JSON.stringify(monster, null, 2));
      } catch (e) {
        console.error("Error:", e instanceof Error ? e.message : e);
        process.exit(1);
      }
    } else {
      console.error("Error: --cr is required. Use --help for usage.");
      process.exit(1);
    }
    process.exit(0);
  }

  const cr = parseFloat(args[crIdx + 1]);

  try {
    const stats = await generateMonsterStats({
      cr,
      type: typeIdx !== -1 ? args[typeIdx + 1] : undefined,
      environment: envIdx !== -1 ? args[envIdx + 1] : undefined,
      name: nameIdx !== -1 ? args[nameIdx + 1] : undefined,
      random,
      traits: traitsIdx !== -1 ? args[traitsIdx + 1] : undefined,
    });

    const monster = buildMonsterFromStats(stats, cr);

    // Validate against CRCalculator
    const crResult = calculateCR({
      hp: monster.hp,
      ac: monster.ac,
      attackBonus: stats.attackBonus,
      dpr: stats.dpr,
      saveDC: stats.saveDC,
    });

    if (jsonOutput) {
      console.log(JSON.stringify({
        monster,
        crValidation: {
          targetCR: cr,
          calculatedCR: crResult.cr,
          match: crResult.cr === cr,
          details: crResult.details,
        },
      }, null, 2));
    } else {
      console.log(`${monster.name} (CR ${cr})`);
      console.log(`HP: ${monster.hp}, AC: ${monster.ac}, DPR: ${stats.dpr}`);
      console.log(`Attack: +${stats.attackBonus}, Save DC: ${stats.saveDC}`);
      console.log(`CR Validation: ${crResult.cr === cr ? "MATCH" : `MISMATCH (calculated CR ${crResult.cr})`}`);
      console.log(`\nFull stat block:`);
      console.log(JSON.stringify(monster, null, 2));
    }
  } catch (e) {
    console.error("Error:", e instanceof Error ? e.message : e);
    process.exit(1);
  }
}
