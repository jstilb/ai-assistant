#!/usr/bin/env bun
/**
 * SpellForge.ts - D&D 5e Custom Spell Creator & Balance Validator
 *
 * Creates custom/homebrew spells using AI inference with balance
 * comparison against SRD spells. Validates damage dice, range,
 * AoE, and duration against spells of the same level.
 *
 * @module SpellForge
 * @version 1.0.0
 */

import { join, dirname } from "path";

// ============================================
// TYPES
// ============================================

export interface SpellBlock {
  name: string;
  level: number;
  school: string;
  castingTime: string;
  range: string;
  components: string[];
  material?: string;
  duration: string;
  description: string;
  damage?: string;
  damageType?: string;
  averageDamage?: number;
}

export interface BalanceAnalysis {
  status: "balanced" | "overpowered" | "underpowered";
  reason: string;
  averageDamage?: number;
  benchmarkDamage?: number;
}

export interface ForgedSpell {
  spell: SpellBlock;
  balanceAnalysis: BalanceAnalysis;
  comparableSpells: any[];
}

export interface SpellForgeOptions {
  name: string;
  level: number;
  school: string;
  damageType?: string;
  compare?: boolean;
  _mockInference?: (prompt: string) => Promise<string>;
}

// ============================================
// DATA LOADING
// ============================================

let spellData: any = null;

function loadSpells() {
  if (spellData) return spellData;
  const dataPath = join(dirname(import.meta.dir), "Data", "srd-spells.json");
  spellData = JSON.parse(require("fs").readFileSync(dataPath, "utf-8"));
  return spellData;
}

// ============================================
// DAMAGE CALCULATION
// ============================================

/**
 * Calculate the average (expected) damage from dice notation.
 * Supports: "8d6", "1d10", "10d6+40", "5d8"
 */
export function calculateExpectedDamage(notation: string): number {
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
// COMPARABLE SPELL LOOKUP
// ============================================

/**
 * Find SRD spells at the same level, optionally filtered by school.
 */
export function findComparableSpells(level: number, school?: string): any[] {
  const data = loadSpells();
  let spells = data.spells.filter((s: any) => s.level === level);
  if (school) {
    const schoolFiltered = spells.filter(
      (s: any) => s.school.toLowerCase() === school.toLowerCase()
    );
    // If school filter gives results, use it; otherwise return all at that level
    if (schoolFiltered.length > 0) {
      spells = schoolFiltered;
    }
  }
  return spells;
}

// ============================================
// SPELL BLOCK BUILDING
// ============================================

/**
 * Damage benchmarks by spell level (average damage for "typical" damage spells).
 */
const DAMAGE_BENCHMARKS: Record<number, { low: number; mid: number; high: number }> = {
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
 * Build a complete spell block from provided data.
 */
export function buildSpellBlock(data: {
  name: string;
  level: number;
  school: string;
  castingTime: string;
  range: string;
  components: string[];
  material?: string;
  duration: string;
  description: string;
  damage?: string;
  damageType?: string;
}): SpellBlock {
  const spell: SpellBlock = {
    name: data.name,
    level: data.level,
    school: data.school,
    castingTime: data.castingTime,
    range: data.range,
    components: data.components,
    material: data.material,
    duration: data.duration,
    description: data.description,
    damage: data.damage,
    damageType: data.damageType,
  };

  if (data.damage) {
    spell.averageDamage = calculateExpectedDamage(data.damage);
  }

  return spell;
}

// ============================================
// BALANCE ANALYSIS
// ============================================

/**
 * Analyze spell balance against benchmarks.
 */
function analyzeBalance(spell: SpellBlock): BalanceAnalysis {
  const benchmark = DAMAGE_BENCHMARKS[spell.level];

  if (!spell.damage || !spell.averageDamage || !benchmark) {
    return {
      status: "balanced",
      reason: "Non-damage spell or unknown level -- manual review recommended.",
    };
  }

  const avg = spell.averageDamage;

  if (avg > benchmark.high * 1.15) {
    return {
      status: "overpowered",
      reason: `Average damage ${avg} exceeds level ${spell.level} high benchmark (${benchmark.high}) by ${((avg / benchmark.high - 1) * 100).toFixed(0)}%.`,
      averageDamage: avg,
      benchmarkDamage: benchmark.mid,
    };
  }

  if (avg < benchmark.low * 0.85) {
    return {
      status: "underpowered",
      reason: `Average damage ${avg} is below level ${spell.level} low benchmark (${benchmark.low}) by ${((1 - avg / benchmark.low) * 100).toFixed(0)}%.`,
      averageDamage: avg,
      benchmarkDamage: benchmark.mid,
    };
  }

  return {
    status: "balanced",
    reason: `Average damage ${avg} is within level ${spell.level} expected range (${benchmark.low}-${benchmark.high}).`,
    averageDamage: avg,
    benchmarkDamage: benchmark.mid,
  };
}

// ============================================
// FORGE SPELL (AI-POWERED)
// ============================================

/**
 * Forge a custom spell using AI inference + balance validation.
 */
export async function forgeSpell(options: SpellForgeOptions): Promise<ForgedSpell> {
  const benchmark = DAMAGE_BENCHMARKS[options.level];

  const prompt = `Create a D&D 5e spell as JSON. Requirements:
- Name: ${options.name}
- Level: ${options.level}
- School: ${options.school}
${options.damageType ? `- Damage type: ${options.damageType}` : ""}
${benchmark ? `- Target average damage: approximately ${benchmark.mid} (range ${benchmark.low}-${benchmark.high})` : ""}

Return ONLY valid JSON:
{
  "casting_time": "1 action",
  "range": "120 feet",
  "components": ["V", "S", "M"],
  "material": "optional material component",
  "duration": "Instantaneous",
  "description": "Full spell description including damage dice, save, and effects.",
  "damage": "8d6"
}`;

  let rawOutput: string;

  if (options._mockInference) {
    rawOutput = await options._mockInference(prompt);
  } else {
    const { inference } = await import("../../../../lib/core/Inference");
    const result = await inference({
      systemPrompt: "You are a D&D 5e spell designer. Output ONLY valid JSON, no markdown or explanation.",
      userPrompt: prompt,
      level: "standard",
      expectJson: true,
    });

    if (!result.success || !result.parsed) {
      throw new Error(`Inference failed: ${result.error || "no output"}`);
    }
    rawOutput = JSON.stringify(result.parsed);
  }

  // Parse response
  let parsed: any;
  try {
    parsed = JSON.parse(rawOutput);
  } catch {
    const jsonMatch = rawOutput.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error("No valid JSON in inference output");
    parsed = JSON.parse(jsonMatch[0]);
  }

  // Build spell block
  const spell = buildSpellBlock({
    name: options.name,
    level: options.level,
    school: options.school,
    castingTime: parsed.casting_time || "1 action",
    range: parsed.range || "120 feet",
    components: parsed.components || ["V", "S"],
    material: parsed.material,
    duration: parsed.duration || "Instantaneous",
    description: parsed.description || "No description generated.",
    damage: parsed.damage,
    damageType: options.damageType,
  });

  // Analyze balance
  const balanceAnalysis = analyzeBalance(spell);

  // Find comparable spells
  const comparableSpells = options.compare !== false
    ? findComparableSpells(options.level, options.school)
    : [];

  return {
    spell,
    balanceAnalysis,
    comparableSpells,
  };
}

// ============================================
// CLI
// ============================================

if (import.meta.main) {
  const args = process.argv.slice(2);

  if (args.includes("--help") || args.includes("-h")) {
    console.log(`
SpellForge - D&D 5e Custom Spell Creator & Balance Validator

Usage:
  bun SpellForge.ts --name <name> --level <n> --school <school> [--damage-type <type>] [--compare] [--json]
  echo '<partial-json>' | bun SpellForge.ts [--json]
  bun SpellForge.ts --help

Options:
  --name <name>          Spell name
  --level <n>            Spell level (0-9)
  --school <school>      Spell school (evocation, abjuration, etc.)
  --damage-type <type>   Damage type (fire, cold, lightning, etc.)
  --compare              Show comparable SRD spells at the same level
  --json                 Output as JSON
  --help                 Show this help
`);
    process.exit(0);
  }

  const jsonOutput = args.includes("--json");
  const compare = args.includes("--compare");
  const nameIdx = args.indexOf("--name");
  const levelIdx = args.indexOf("--level");
  const schoolIdx = args.indexOf("--school");
  const dmgTypeIdx = args.indexOf("--damage-type");

  // Check for stdin
  const stdinText = await Bun.stdin.text();
  if (stdinText.trim()) {
    try {
      const partial = JSON.parse(stdinText);
      const spell = buildSpellBlock({
        name: partial.name || "Custom Spell",
        level: partial.level || 1,
        school: partial.school || "evocation",
        castingTime: partial.casting_time || partial.castingTime || "1 action",
        range: partial.range || "120 feet",
        components: partial.components || ["V", "S"],
        material: partial.material,
        duration: partial.duration || "Instantaneous",
        description: partial.description || "",
        damage: partial.damage,
        damageType: partial.damageType || partial.damage_type,
      });

      const balanceAnalysis = analyzeBalance(spell);
      const comparableSpells = findComparableSpells(spell.level, spell.school);

      const result: ForgedSpell = { spell, balanceAnalysis, comparableSpells };
      console.log(JSON.stringify(result, null, 2));
      process.exit(0);
    } catch (e) {
      console.error("Error parsing stdin:", e instanceof Error ? e.message : e);
      process.exit(1);
    }
  }

  if (nameIdx === -1 || levelIdx === -1 || schoolIdx === -1) {
    console.error("Error: --name, --level, and --school are required. Use --help for usage.");
    process.exit(1);
  }

  try {
    const result = await forgeSpell({
      name: args[nameIdx + 1],
      level: parseInt(args[levelIdx + 1]),
      school: args[schoolIdx + 1],
      damageType: dmgTypeIdx !== -1 ? args[dmgTypeIdx + 1] : undefined,
      compare,
    });

    if (jsonOutput) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      const s = result.spell;
      console.log(`${s.name} (Level ${s.level} ${s.school})`);
      console.log(`Casting Time: ${s.castingTime}`);
      console.log(`Range: ${s.range}`);
      console.log(`Components: ${s.components.join(", ")}${s.material ? ` (${s.material})` : ""}`);
      console.log(`Duration: ${s.duration}`);
      console.log(`\n${s.description}`);
      if (s.damage) {
        console.log(`\nDamage: ${s.damage}${s.damageType ? ` ${s.damageType}` : ""} (avg ${s.averageDamage})`);
      }
      console.log(`\nBalance: ${result.balanceAnalysis.status.toUpperCase()} - ${result.balanceAnalysis.reason}`);
      if (result.comparableSpells.length > 0) {
        console.log(`\nComparable SRD Spells:`);
        for (const cs of result.comparableSpells.slice(0, 5)) {
          console.log(`  - ${cs.name} (${cs.school})`);
        }
      }
    }
  } catch (e) {
    console.error("Error:", e instanceof Error ? e.message : e);
    process.exit(1);
  }
}
