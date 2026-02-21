#!/usr/bin/env bun
/**
 * LootGenerator.ts - D&D 5e Treasure Generator
 *
 * Rolls treasure from DMG tables (p133-139) for individual and hoard treasure.
 * Supports dice rolling with multiplier notation, magic item table lookups,
 * and multiple roll counts.
 *
 * @module LootGenerator
 * @version 1.0.0
 */

import { join, dirname } from "path";

// ============================================
// TYPES
// ============================================

export interface DiceNotation {
  count: number;
  sides: number;
  modifier: number;
  multiplier: number;
}

export interface CoinResult {
  cp: number;
  sp: number;
  ep: number;
  gp: number;
  pp: number;
  [key: string]: number;
}

export interface TreasureResult {
  coins: CoinResult;
  gems?: { count: number; valueEach: number; totalValue: number };
  artObjects?: { count: number; valueEach: number; totalValue: number };
  magicItems?: string[];
  crTier: string;
  type: "individual" | "hoard";
}

// ============================================
// DATA LOADING
// ============================================

let treasureData: any = null;

function loadTreasureTables(): any {
  if (treasureData) return treasureData;
  const dataPath = join(dirname(import.meta.dir), "Data", "treasure-tables.json");
  treasureData = JSON.parse(require("fs").readFileSync(dataPath, "utf-8"));
  return treasureData;
}

// ============================================
// DICE ROLLING
// ============================================

/**
 * Parse dice notation string into components.
 * Supports: "2d6", "3d8+5", "1d8-1", "4d6x100", "1" (constant)
 */
export function parseDiceNotation(notation: string): DiceNotation {
  // Handle multiplier notation: "4d6x100"
  const multMatch = notation.match(/^(\d+)d(\d+)x(\d+)$/);
  if (multMatch) {
    return {
      count: parseInt(multMatch[1]),
      sides: parseInt(multMatch[2]),
      modifier: 0,
      multiplier: parseInt(multMatch[3]),
    };
  }

  // Handle standard notation: "2d6", "3d8+5", "1d8-1"
  const diceMatch = notation.match(/^(\d+)d(\d+)(?:([+-])(\d+))?$/);
  if (diceMatch) {
    const mod = diceMatch[3]
      ? (diceMatch[3] === "+" ? 1 : -1) * parseInt(diceMatch[4])
      : 0;
    return {
      count: parseInt(diceMatch[1]),
      sides: parseInt(diceMatch[2]),
      modifier: mod,
      multiplier: 1,
    };
  }

  // Handle constant: "1", "3"
  const constMatch = notation.match(/^(\d+)$/);
  if (constMatch) {
    return {
      count: 0,
      sides: 0,
      modifier: parseInt(constMatch[1]),
      multiplier: 1,
    };
  }

  throw new Error(`Invalid dice notation: ${notation}`);
}

/**
 * Roll dice from a notation string.
 * Returns the total result.
 */
export function rollDice(notation: string): number {
  const parsed = parseDiceNotation(notation);

  if (parsed.count === 0 && parsed.sides === 0) {
    return parsed.modifier * parsed.multiplier;
  }

  let total = 0;
  for (let i = 0; i < parsed.count; i++) {
    total += Math.floor(Math.random() * parsed.sides) + 1;
  }
  total += parsed.modifier;
  total *= parsed.multiplier;

  return Math.max(0, total);
}

// ============================================
// CR TIER MAPPING
// ============================================

/**
 * Map a CR value to the treasure table tier key.
 */
export function getCRTier(cr: number): string {
  if (cr <= 4) return "cr0_4";
  if (cr <= 10) return "cr5_10";
  if (cr <= 16) return "cr11_16";
  return "cr17_plus";
}

// ============================================
// MAGIC ITEM TABLES
// ============================================

/**
 * Roll on a magic item table, returning a random item name.
 */
export function rollOnMagicItemTable(table: string): string {
  const data = loadTreasureTables();
  const items = data.magicItemTables[table];
  if (!items || items.length === 0) {
    return `Unknown magic item (table ${table})`;
  }
  const idx = Math.floor(Math.random() * items.length);
  return items[idx];
}

// ============================================
// INDIVIDUAL TREASURE
// ============================================

/**
 * Generate individual treasure for a given CR.
 */
export function generateIndividualTreasure(cr: number): TreasureResult {
  const data = loadTreasureTables();
  const tier = getCRTier(cr);
  const table = data.individualTreasure[tier];

  if (!table) {
    return {
      coins: { cp: 0, sp: 0, ep: 0, gp: 0, pp: 0 },
      crTier: tier,
      type: "individual",
    };
  }

  // Roll d100 to determine which row
  const d100 = Math.floor(Math.random() * 100) + 1;

  let selectedRow = table.rolls[0];
  for (const row of table.rolls) {
    if (d100 >= row.d100Min && d100 <= row.d100Max) {
      selectedRow = row;
      break;
    }
  }

  // Roll coins
  const coins: CoinResult = { cp: 0, sp: 0, ep: 0, gp: 0, pp: 0 };
  if (selectedRow.coins) {
    for (const [coinType, diceNotation] of Object.entries(selectedRow.coins)) {
      coins[coinType] = rollDice(diceNotation as string);
    }
  }

  return {
    coins,
    crTier: tier,
    type: "individual",
  };
}

// ============================================
// HOARD TREASURE
// ============================================

/**
 * Generate hoard treasure for a given CR.
 */
export function generateHoardTreasure(cr: number): TreasureResult {
  const data = loadTreasureTables();
  const tier = getCRTier(cr);
  const table = data.hoardTreasure[tier];

  if (!table) {
    return {
      coins: { cp: 0, sp: 0, ep: 0, gp: 0, pp: 0 },
      crTier: tier,
      type: "hoard",
    };
  }

  // Roll base coins
  const coins: CoinResult = { cp: 0, sp: 0, ep: 0, gp: 0, pp: 0 };
  if (table.coins) {
    for (const [coinType, diceNotation] of Object.entries(table.coins)) {
      coins[coinType] = rollDice(diceNotation as string);
    }
  }

  const result: TreasureResult = {
    coins,
    crTier: tier,
    type: "hoard",
  };

  // Roll d100 for additional treasure (gems/art/magic)
  if (table.additionalTreasure) {
    const d100 = Math.floor(Math.random() * 100) + 1;

    let selectedRow: any = null;
    for (const row of table.additionalTreasure) {
      if (d100 >= row.d100Min && d100 <= row.d100Max) {
        selectedRow = row;
        break;
      }
    }

    if (selectedRow) {
      // Gems
      if (selectedRow.gems) {
        const count = typeof selectedRow.gems.count === "string"
          ? rollDice(selectedRow.gems.count)
          : selectedRow.gems.count;
        result.gems = {
          count,
          valueEach: selectedRow.gems.value,
          totalValue: count * selectedRow.gems.value,
        };
      }

      // Art objects
      if (selectedRow.art) {
        const count = typeof selectedRow.art.count === "string"
          ? rollDice(selectedRow.art.count)
          : selectedRow.art.count;
        result.artObjects = {
          count,
          valueEach: selectedRow.art.value,
          totalValue: count * selectedRow.art.value,
        };
      }

      // Magic items
      if (selectedRow.magicItems) {
        const itemCount = typeof selectedRow.magicItems.count === "string"
          ? rollDice(selectedRow.magicItems.count)
          : selectedRow.magicItems.count;
        const items: string[] = [];
        for (let i = 0; i < itemCount; i++) {
          items.push(rollOnMagicItemTable(selectedRow.magicItems.table));
        }
        result.magicItems = items;
      }
    }
  }

  return result;
}

// ============================================
// CLI
// ============================================

if (import.meta.main) {
  const args = process.argv.slice(2);

  if (args.includes("--help") || args.includes("-h")) {
    console.log(`
LootGenerator - D&D 5e Treasure Generator

Usage:
  bun LootGenerator.ts --cr <n> --type <individual|hoard> [--count <n>] [--json]
  bun LootGenerator.ts --magic-table <A|B|C|F|G|I> [--count <n>] [--json]
  bun LootGenerator.ts --help

Options:
  --cr <n>           Monster/encounter CR (0-30)
  --type <type>      Treasure type: individual or hoard (default: individual)
  --count <n>        Number of times to roll (default: 1)
  --magic-table <t>  Roll directly on a magic item table (A, B, C, F, G, I)
  --json             Output as JSON
  --help             Show this help
`);
    process.exit(0);
  }

  const jsonOutput = args.includes("--json");
  const crIdx = args.indexOf("--cr");
  const typeIdx = args.indexOf("--type");
  const countIdx = args.indexOf("--count");
  const magicIdx = args.indexOf("--magic-table");

  const count = countIdx !== -1 ? parseInt(args[countIdx + 1]) : 1;

  // Magic item table direct roll
  if (magicIdx !== -1) {
    const table = args[magicIdx + 1];
    const items: string[] = [];
    for (let i = 0; i < count; i++) {
      items.push(rollOnMagicItemTable(table));
    }
    if (jsonOutput) {
      console.log(JSON.stringify({ table, items }, null, 2));
    } else {
      console.log(`Magic Item Table ${table}:`);
      items.forEach((item, idx) => console.log(`  ${idx + 1}. ${item}`));
    }
    process.exit(0);
  }

  // Treasure generation
  if (crIdx === -1) {
    console.error("Error: --cr is required. Use --help for usage.");
    process.exit(1);
  }

  const cr = parseInt(args[crIdx + 1]);
  const treasureType = typeIdx !== -1 ? args[typeIdx + 1] : "individual";

  const results: TreasureResult[] = [];
  for (let i = 0; i < count; i++) {
    if (treasureType === "hoard") {
      results.push(generateHoardTreasure(cr));
    } else {
      results.push(generateIndividualTreasure(cr));
    }
  }

  if (jsonOutput) {
    console.log(JSON.stringify(count === 1 ? results[0] : results, null, 2));
  } else {
    for (let i = 0; i < results.length; i++) {
      const r = results[i];
      if (count > 1) console.log(`\n--- Roll ${i + 1} ---`);
      console.log(`${r.type.charAt(0).toUpperCase() + r.type.slice(1)} Treasure (CR ${cr}, tier ${r.crTier}):`);

      // Coins
      const coinParts: string[] = [];
      if (r.coins.cp > 0) coinParts.push(`${r.coins.cp} cp`);
      if (r.coins.sp > 0) coinParts.push(`${r.coins.sp} sp`);
      if (r.coins.ep > 0) coinParts.push(`${r.coins.ep} ep`);
      if (r.coins.gp > 0) coinParts.push(`${r.coins.gp} gp`);
      if (r.coins.pp > 0) coinParts.push(`${r.coins.pp} pp`);
      console.log(`  Coins: ${coinParts.join(", ") || "none"}`);

      if (r.gems) {
        console.log(`  Gems: ${r.gems.count}x ${r.gems.valueEach} gp gems (total ${r.gems.totalValue} gp)`);
      }
      if (r.artObjects) {
        console.log(`  Art: ${r.artObjects.count}x ${r.artObjects.valueEach} gp art objects (total ${r.artObjects.totalValue} gp)`);
      }
      if (r.magicItems && r.magicItems.length > 0) {
        console.log(`  Magic Items:`);
        r.magicItems.forEach((item) => console.log(`    - ${item}`));
      }
    }
  }
}
