#!/usr/bin/env bun
/**
 * EncounterBalancer.ts - D&D 5e Encounter Builder & Balancer
 *
 * Builds balanced encounters using DMG XP budget math (p81-85).
 * Calculates XP budgets, applies monster count multipliers,
 * rates encounter difficulty, and suggests SRD monsters.
 *
 * @module EncounterBalancer
 * @version 1.0.0
 */

import { join, dirname } from "path";

// ============================================
// TYPES
// ============================================

export interface EncounterBudget {
  easy: number;
  medium: number;
  hard: number;
  deadly: number;
  partyLevel: number;
  partySize: number;
}

export interface MonsterEntry {
  name: string;
  cr: number;
  xp: number;
  count: number;
}

export interface EncounterRating {
  difficulty: "trivial" | "easy" | "medium" | "hard" | "deadly";
  totalXP: number;
  adjustedXP: number;
  budget: EncounterBudget;
  monsters: MonsterEntry[];
}

export interface MonsterSuggestion {
  name: string;
  cr: number;
  xp: number;
  count: number;
  type?: string;
}

// ============================================
// DATA LOADING
// ============================================

let xpData: any = null;
let monsterData: any = null;

function loadXPThresholds(): any {
  if (xpData) return xpData;
  const dataPath = join(dirname(import.meta.dir), "Data", "xp-thresholds.json");
  xpData = JSON.parse(require("fs").readFileSync(dataPath, "utf-8"));
  return xpData;
}

function loadMonsters(): any[] {
  if (monsterData) return monsterData;
  const dataPath = join(dirname(import.meta.dir), "Data", "srd-monsters.json");
  const raw = JSON.parse(require("fs").readFileSync(dataPath, "utf-8"));
  monsterData = raw.monsters;
  return monsterData;
}

// ============================================
// XP BUDGET CALCULATION
// ============================================

/**
 * Calculate XP budget thresholds for a party.
 * Sums the per-character thresholds from DMG p82.
 */
export function calculateXPBudget(partyLevel: number, partySize: number): EncounterBudget {
  const data = loadXPThresholds();
  const levelKey = String(Math.min(Math.max(partyLevel, 1), 20));
  const thresholds = data.thresholdsByLevel[levelKey];

  if (!thresholds) {
    throw new Error(`No XP thresholds for level ${partyLevel}`);
  }

  return {
    easy: thresholds.easy * partySize,
    medium: thresholds.medium * partySize,
    hard: thresholds.hard * partySize,
    deadly: thresholds.deadly * partySize,
    partyLevel,
    partySize,
  };
}

// ============================================
// MONSTER COUNT MULTIPLIER
// ============================================

/**
 * Get the XP multiplier for a given number of monsters.
 * Per DMG p82: adjusts effective XP based on action economy.
 */
export function getMonsterCountMultiplier(monsterCount: number): number {
  const data = loadXPThresholds();
  for (const tier of data.monsterCountMultipliers) {
    if (monsterCount >= tier.monstersMin && monsterCount <= tier.monstersMax) {
      return tier.multiplier;
    }
  }
  return 4.0; // Fallback for 15+
}

// ============================================
// ENCOUNTER DIFFICULTY RATING
// ============================================

/**
 * Rate the difficulty of an encounter given monsters and party composition.
 */
export function rateEncounterDifficulty(
  monsters: MonsterEntry[],
  partyLevel: number,
  partySize: number
): EncounterRating {
  const budget = calculateXPBudget(partyLevel, partySize);

  // Total raw XP
  const totalXP = monsters.reduce((sum, m) => sum + m.xp * m.count, 0);

  // Total monster count for multiplier
  const totalMonsters = monsters.reduce((sum, m) => sum + m.count, 0);
  const multiplier = getMonsterCountMultiplier(totalMonsters);

  // Adjusted XP (for difficulty comparison only -- not for actual XP rewards)
  const adjustedXP = Math.round(totalXP * multiplier);

  // Determine difficulty
  let difficulty: EncounterRating["difficulty"];
  if (adjustedXP >= budget.deadly) {
    difficulty = "deadly";
  } else if (adjustedXP >= budget.hard) {
    difficulty = "hard";
  } else if (adjustedXP >= budget.medium) {
    difficulty = "medium";
  } else if (adjustedXP >= budget.easy) {
    difficulty = "easy";
  } else {
    difficulty = "trivial";
  }

  return {
    difficulty,
    totalXP,
    adjustedXP,
    budget,
    monsters,
  };
}

// ============================================
// MONSTER LIST PARSING
// ============================================

// Common irregular plurals for D&D monsters
const IRREGULAR_PLURALS: Record<string, string> = {
  wolves: "wolf",
  goblins: "goblin",
  zombies: "zombie",
  skeletons: "skeleton",
  kobolds: "kobold",
  ogres: "ogre",
  trolls: "troll",
  mages: "mage",
  bandits: "bandit",
  guards: "guard",
  nobles: "noble",
  commoners: "commoner",
  bugbears: "bugbear",
  minotaurs: "minotaur",
  beholders: "beholder",
  liches: "lich",
  owlbears: "owlbear",
};

/**
 * Parse a natural language monster list like "2 goblins, 1 bugbear"
 */
export function parseMonsterList(input: string): Array<{ name: string; count: number }> {
  const parts = input.split(",").map((s) => s.trim()).filter(Boolean);
  const result: Array<{ name: string; count: number }> = [];

  for (const part of parts) {
    const match = part.match(/^(\d+)\s+(.+)$/);
    if (match) {
      const count = parseInt(match[1]);
      let name = match[2].toLowerCase().trim();
      // Handle plurals
      if (IRREGULAR_PLURALS[name]) {
        name = IRREGULAR_PLURALS[name];
      } else if (name.endsWith("s") && !name.endsWith("ss")) {
        // Try removing trailing 's'
        const singular = name.slice(0, -1);
        name = singular;
      }
      result.push({ name, count });
    } else {
      // Single monster without count
      let name = part.toLowerCase().trim();
      if (IRREGULAR_PLURALS[name]) {
        name = IRREGULAR_PLURALS[name];
      }
      result.push({ name, count: 1 });
    }
  }

  return result;
}

// ============================================
// MONSTER SUGGESTION
// ============================================

/**
 * Suggest monsters from the SRD list that fit a target difficulty.
 */
export function suggestMonsters(
  partyLevel: number,
  partySize: number,
  difficulty: "easy" | "medium" | "hard" | "deadly"
): MonsterSuggestion[] {
  const budget = calculateXPBudget(partyLevel, partySize);
  const targetXP = budget[difficulty];
  const monsters = loadMonsters();
  const xpData = loadXPThresholds();

  // Find suitable CR range -- monsters whose individual XP is plausible
  const suitableMonsters = monsters.filter((m: any) => {
    const monsterXP = xpData.xpByCR[String(m.cr)] || 0;
    // A single monster should be at most the full budget, at least 1/8 of it
    return monsterXP > 0 && monsterXP <= targetXP && monsterXP >= targetXP / 10;
  });

  if (suitableMonsters.length === 0) {
    // Fallback: just find any monster with XP <= budget
    const fallback = monsters.filter((m: any) => {
      const monsterXP = xpData.xpByCR[String(m.cr)] || 0;
      return monsterXP > 0 && monsterXP <= targetXP;
    });
    if (fallback.length === 0) return [];
    // Pick one
    const pick = fallback[Math.floor(Math.random() * fallback.length)];
    const pickXP = xpData.xpByCR[String(pick.cr)] || 0;
    return [{ name: pick.name, cr: pick.cr, xp: pickXP, count: 1, type: pick.type }];
  }

  // Strategy: pick 1-3 different monsters that together fit the budget
  // For variety: try to pick different types (tank, striker, controller)
  const suggestions: MonsterSuggestion[] = [];
  let remainingXP = targetXP;

  // Shuffle for variety
  const shuffled = [...suitableMonsters].sort(() => Math.random() - 0.5);

  for (const monster of shuffled) {
    if (remainingXP <= 0) break;
    if (suggestions.length >= 3) break;

    const monsterXP = xpData.xpByCR[String(monster.cr)] || 0;
    if (monsterXP <= 0) continue;

    // How many of this monster can we fit?
    // Need to account for the multiplier increasing as we add more total monsters
    const currentTotalMonsters = suggestions.reduce((sum, s) => sum + s.count, 0);
    let count = Math.max(1, Math.floor(remainingXP / monsterXP));

    // Limit individual monster count to keep encounters manageable
    count = Math.min(count, 6);

    // Check the adjusted XP with multiplier doesn't exceed budget
    const tentativeTotal = suggestions.reduce((sum, s) => sum + s.xp * s.count, 0) + monsterXP * count;
    const tentativeTotalMonsters = currentTotalMonsters + count;
    const multiplier = getMonsterCountMultiplier(tentativeTotalMonsters);
    const adjustedTotal = Math.round(tentativeTotal * multiplier);

    // If adjusted would exceed 1.5x target (allow some flexibility), reduce count
    while (count > 0 && Math.round((suggestions.reduce((sum, s) => sum + s.xp * s.count, 0) + monsterXP * count) * getMonsterCountMultiplier(currentTotalMonsters + count)) > targetXP * 1.5) {
      count--;
    }

    if (count > 0) {
      suggestions.push({
        name: monster.name,
        cr: monster.cr,
        xp: monsterXP,
        count,
        type: monster.type,
      });
      remainingXP -= monsterXP * count;
    }
  }

  return suggestions;
}

// ============================================
// CLI
// ============================================

if (import.meta.main) {
  const args = process.argv.slice(2);

  if (args.includes("--help") || args.includes("-h")) {
    console.log(`
EncounterBalancer - D&D 5e Encounter Builder

Usage:
  bun EncounterBalancer.ts --party-level <n> --party-size <n> --difficulty <level> [--suggest] [--json]
  bun EncounterBalancer.ts --party-level <n> --party-size <n> --monsters "2 goblins, 1 bugbear" [--json]
  bun EncounterBalancer.ts --help

Options:
  --party-level <n>      Party level (1-20)
  --party-size <n>       Number of party members
  --difficulty <level>   Target difficulty: easy, medium, hard, deadly
  --monsters <list>      Check balance of specific monsters (e.g. "2 goblins, 1 bugbear")
  --suggest              Auto-suggest monsters from SRD for the XP budget
  --json                 Output as JSON
  --help                 Show this help
`);
    process.exit(0);
  }

  const jsonOutput = args.includes("--json");
  const suggest = args.includes("--suggest");
  const levelIdx = args.indexOf("--party-level");
  const sizeIdx = args.indexOf("--party-size");
  const diffIdx = args.indexOf("--difficulty");
  const monstersIdx = args.indexOf("--monsters");

  if (levelIdx === -1 || sizeIdx === -1) {
    console.error("Error: --party-level and --party-size are required. Use --help for usage.");
    process.exit(1);
  }

  const partyLevel = parseInt(args[levelIdx + 1]);
  const partySize = parseInt(args[sizeIdx + 1]);
  const budget = calculateXPBudget(partyLevel, partySize);

  // Mode 1: Check existing encounter balance
  if (monstersIdx !== -1) {
    const monsterList = args[monstersIdx + 1];
    const parsed = parseMonsterList(monsterList);
    const xpThresholds = loadXPThresholds();
    const srdMonsters = loadMonsters();

    // Resolve each parsed monster to SRD data
    const resolvedMonsters: MonsterEntry[] = parsed.map((p) => {
      const found = srdMonsters.find(
        (m: any) => m.name.toLowerCase() === p.name
      );
      if (found) {
        return {
          name: found.name,
          cr: found.cr,
          xp: xpThresholds.xpByCR[String(found.cr)] || 0,
          count: p.count,
        };
      }
      return { name: p.name, cr: 0, xp: 0, count: p.count };
    });

    const rating = rateEncounterDifficulty(resolvedMonsters, partyLevel, partySize);

    if (jsonOutput) {
      console.log(JSON.stringify(rating, null, 2));
    } else {
      console.log(`Encounter Rating: ${rating.difficulty.toUpperCase()}`);
      console.log(`Total XP: ${rating.totalXP} (adjusted: ${rating.adjustedXP})`);
      console.log(`Budget: Easy=${budget.easy}, Medium=${budget.medium}, Hard=${budget.hard}, Deadly=${budget.deadly}`);
      console.log(`Monsters:`);
      for (const m of resolvedMonsters) {
        console.log(`  ${m.count}x ${m.name} (CR ${m.cr}, ${m.xp} XP each)`);
      }
    }
    process.exit(0);
  }

  // Mode 2: Calculate budget and optionally suggest monsters
  const difficulty = diffIdx !== -1
    ? args[diffIdx + 1] as "easy" | "medium" | "hard" | "deadly"
    : "medium";

  const output: any = {
    budget,
    targetDifficulty: difficulty,
    targetXP: budget[difficulty],
  };

  if (suggest) {
    output.suggestedMonsters = suggestMonsters(partyLevel, partySize, difficulty);
    // Rate the suggestion
    if (output.suggestedMonsters.length > 0) {
      output.suggestedRating = rateEncounterDifficulty(
        output.suggestedMonsters,
        partyLevel,
        partySize
      );
    }
  }

  if (jsonOutput) {
    console.log(JSON.stringify(output, null, 2));
  } else {
    console.log(`Party: ${partySize} characters at level ${partyLevel}`);
    console.log(`XP Budget: Easy=${budget.easy}, Medium=${budget.medium}, Hard=${budget.hard}, Deadly=${budget.deadly}`);
    console.log(`Target: ${difficulty} (${budget[difficulty]} XP)`);
    if (output.suggestedMonsters) {
      console.log(`\nSuggested Encounter:`);
      for (const s of output.suggestedMonsters) {
        console.log(`  ${s.count}x ${s.name} (CR ${s.cr}, ${s.xp} XP each)`);
      }
      if (output.suggestedRating) {
        console.log(`  -> Rated: ${output.suggestedRating.difficulty} (${output.suggestedRating.adjustedXP} adjusted XP)`);
      }
    }
  }
}
