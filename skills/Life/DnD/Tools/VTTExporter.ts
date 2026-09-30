#!/usr/bin/env bun
/**
 * VTTExporter.ts - VTT Encounter Export Orchestrator
 *
 * Combines monster stat blocks, token art references, and encounter metadata
 * into complete VTT-importable packages for Foundry VTT and Roll20.
 *
 * @module VTTExporter
 * @version 1.0.0
 */

import { join, dirname } from "path";
import { mkdirSync, existsSync, readFileSync, writeFileSync } from "fs";
import { z } from "zod";
import { renderStatBlock, type Monster } from "./StatBlock";

// ============================================
// TYPES
// ============================================

export interface MonsterEntry {
  name: string;
  cr: number;
  xp: number;
  count: number;
}

// EncounterBudget imported from ./shared/DnDData
export type { EncounterBudget } from "./shared/DnDData";

/**
 * Zod schema for validating encounter export JSON inputs.
 * Throws ZodError with field-level messages on invalid input.
 */
export const EncounterExportInputSchema = z.object({
  difficulty: z.string(),
  totalXP: z.number(),
  adjustedXP: z.number(),
  budget: z.object({
    easy: z.number(),
    medium: z.number(),
    hard: z.number(),
    deadly: z.number(),
    partyLevel: z.number(),
    partySize: z.number(),
  }),
  monsters: z.array(z.object({
    name: z.string(),
    cr: z.number(),
    xp: z.number(),
    count: z.number(),
  })),
});

export type EncounterExportInput = z.infer<typeof EncounterExportInputSchema>;

export interface ResolvedMonster {
  name: string;
  count: number;
  cr: number;
  xp: number;
  statBlock: Monster;
}

/**
 * Foundry VTT actor system data (5e system fields).
 * Typed as open record to support arbitrary system extensions.
 */
export interface FoundryActorSystem {
  attributes?: Record<string, unknown>;
  abilities?: Record<string, unknown>;
  details?: Record<string, unknown>;
  traits?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface FoundryActorItem {
  name: string;
  type: string;
  system?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface FoundryTokenData {
  name?: string;
  displayName?: number;
  actorLink?: boolean;
  width?: number;
  height?: number;
  [key: string]: unknown;
}

export interface FoundryActorExport {
  name: string;
  type: string;
  system: FoundryActorSystem;
  items: FoundryActorItem[];
  prototypeToken: FoundryTokenData;
  tokenCount: number;
  [key: string]: unknown;
}

export interface FoundryEncounterExport {
  actors: FoundryActorExport[];
  encounter: {
    difficulty: string;
    totalXP: number;
    adjustedXP: number;
    partyLevel: number;
    partySize: number;
  };
}

export type Roll20EncounterExport = string;

// ============================================
// SRD DATA LOADING
// ============================================

interface SRDMonster {
  name: string;
  size?: string;
  type?: string;
  subtype?: string;
  alignment?: string;
  ac?: number;
  acType?: string;
  hp?: number;
  hitDice?: string;
  speed?: Monster["speed"];
  abilities?: Monster["abilities"];
  savingThrows?: Record<string, number>;
  skills?: Record<string, number>;
  damageResistances?: string[];
  damageImmunities?: string[];
  conditionImmunities?: string[];
  senses?: Monster["senses"];
  languages?: string[];
  cr: number;
  xp?: number;
  traits?: Monster["traits"];
  actions?: Monster["actions"];
  bonusActions?: Monster["actions"];
  reactions?: Monster["actions"];
  legendaryActions?: Monster["actions"];
}

let srdMonsters: SRDMonster[] | null = null;

function loadSRDMonsters(): SRDMonster[] {
  if (srdMonsters) return srdMonsters;
  const dataPath = join(dirname(import.meta.dir), "Data", "srd-monsters.json");
  const raw = readFileSync(dataPath, "utf-8");
  const parsed = JSON.parse(raw) as { monsters: SRDMonster[] };
  srdMonsters = parsed.monsters;
  return srdMonsters;
}

// ============================================
// MONSTER RESOLUTION
// ============================================

/**
 * Resolve encounter monster names to full stat blocks from SRD data.
 */
export function resolveEncounterMonsters(monsters: MonsterEntry[]): ResolvedMonster[] {
  const srd = loadSRDMonsters();

  return monsters.map((entry) => {
    const found = srd.find(
      (m) => m.name.toLowerCase() === entry.name.toLowerCase()
    );

    if (found) {
      const statBlock: Monster = {
        name: found.name,
        size: found.size || "Medium",
        type: found.type || "monstrosity",
        subtype: found.subtype,
        alignment: found.alignment || "unaligned",
        ac: found.ac || 10,
        acType: found.acType,
        hp: found.hp || 1,
        hitDice: found.hitDice || "1d8",
        speed: found.speed || { walk: 30 },
        abilities: found.abilities || { str: 10, dex: 10, con: 10, int: 10, wis: 10, cha: 10 },
        savingThrows: found.savingThrows,
        skills: found.skills,
        damageResistances: found.damageResistances,
        damageImmunities: found.damageImmunities,
        conditionImmunities: found.conditionImmunities,
        senses: found.senses,
        languages: found.languages,
        cr: found.cr,
        xp: found.xp || entry.xp,
        traits: found.traits,
        actions: found.actions || [],
        bonusActions: found.bonusActions,
        reactions: found.reactions,
        legendaryActions: found.legendaryActions,
      };

      return {
        name: found.name,
        count: entry.count,
        cr: entry.cr,
        xp: entry.xp,
        statBlock,
      };
    }

    // Unknown monster -- create a minimal stat block
    const fallback: Monster = {
      name: entry.name,
      size: "Medium",
      type: "monstrosity",
      alignment: "unaligned",
      ac: 10 + Math.floor(entry.cr / 2),
      hp: Math.max(1, Math.round(entry.cr * 15)),
      hitDice: "1d8",
      speed: { walk: 30 },
      abilities: { str: 10, dex: 10, con: 10, int: 10, wis: 10, cha: 10 },
      cr: entry.cr,
      xp: entry.xp,
      actions: [
        {
          name: "Attack",
          description: `Melee Weapon Attack: +${2 + Math.floor(entry.cr)} to hit, reach 5 ft., one target. Hit: ${Math.max(1, Math.round(entry.cr * 5))} damage.`,
        },
      ],
    };

    return {
      name: entry.name,
      count: entry.count,
      cr: entry.cr,
      xp: entry.xp,
      statBlock: fallback,
    };
  });
}

// ============================================
// FOUNDRY VTT EXPORT
// ============================================

/**
 * Export an encounter as a Foundry VTT importable JSON.
 */
export function exportFoundryEncounter(input: EncounterExportInput): FoundryEncounterExport {
  const resolved = resolveEncounterMonsters(input.monsters);

  const actors: FoundryActorExport[] = resolved.map((monster) => {
    const foundryJson = renderStatBlock(monster.statBlock, "foundry-vtt");
    const actor = JSON.parse(foundryJson);
    actor.tokenCount = monster.count;
    return actor as FoundryActorExport;
  });

  return {
    actors,
    encounter: {
      difficulty: input.difficulty,
      totalXP: input.totalXP,
      adjustedXP: input.adjustedXP,
      partyLevel: input.budget.partyLevel,
      partySize: input.budget.partySize,
    },
  };
}

// ============================================
// ROLL20 EXPORT
// ============================================

/**
 * Export an encounter as a Roll20 formatted text document.
 */
export function exportRoll20Encounter(input: EncounterExportInput): string {
  const resolved = resolveEncounterMonsters(input.monsters);
  const lines: string[] = [];

  // Header
  lines.push("==========================================");
  lines.push(`Encounter: ${input.difficulty.toUpperCase()} difficulty`);
  lines.push(`Total XP: ${input.totalXP} (adjusted: ${input.adjustedXP})`);
  lines.push(`Party: ${input.budget.partySize} characters at level ${input.budget.partyLevel}`);
  lines.push("==========================================");
  lines.push("");

  // Monster list summary
  lines.push("MONSTERS:");
  for (const monster of resolved) {
    lines.push(`  ${monster.count}x ${monster.name} (CR ${monster.cr}, ${monster.xp} XP each)`);
  }
  lines.push("");

  // Full stat blocks
  for (const monster of resolved) {
    lines.push("------------------------------------------");
    lines.push(`${monster.name} (x${monster.count})`);
    lines.push("------------------------------------------");
    const statBlock = renderStatBlock(monster.statBlock, "text");
    lines.push(statBlock);
    lines.push("");
  }

  return lines.join("\n");
}

// ============================================
// CLI
// ============================================

if (import.meta.main) {
  const args = process.argv.slice(2);

  if (args.includes("--help") || args.includes("-h")) {
    console.log(`
VTTExporter - D&D Encounter Export Orchestrator

Usage:
  bun VTTExporter.ts --format <format> --file <encounter.json> [--output <dir>] [--json]
  bun VTTExporter.ts --help

Options:
  --format <format>    Export format: foundry, roll20
  --file <path>        Path to encounter JSON (from EncounterBalancer --json output)
  --output <dir>       Output directory (default: ~/Downloads/dnd-export/)
  --json               Output result metadata as JSON
  --help               Show this help

Encounter JSON Format:
  The input file should be the JSON output from EncounterBalancer, containing:
  - difficulty, totalXP, adjustedXP
  - budget (party level, size, XP thresholds)
  - monsters array (name, cr, xp, count)
`);
    process.exit(0);
  }

  const jsonOutput = args.includes("--json");
  const formatIdx = args.indexOf("--format");
  const fileIdx = args.indexOf("--file");
  const outputIdx = args.indexOf("--output");

  if (formatIdx === -1 || fileIdx === -1) {
    console.error("Error: --format and --file are required. Use --help for usage.");
    process.exit(1);
  }

  const format = args[formatIdx + 1];
  const filePath = args[fileIdx + 1];
  const outputDir = outputIdx !== -1
    ? args[outputIdx + 1]
    : join(process.env.HOME!, "Downloads", "dnd-export");

  if (!existsSync(outputDir)) {
    mkdirSync(outputDir, { recursive: true });
  }

  try {
    const raw = readFileSync(filePath, "utf-8");
    const encounterJson = EncounterExportInputSchema.parse(JSON.parse(raw));
    const timestamp = Date.now();

    if (format === "foundry") {
      const result = exportFoundryEncounter(encounterJson);
      const outputPath = join(outputDir, `encounter-foundry-${timestamp}.json`);
      writeFileSync(outputPath, JSON.stringify(result, null, 2));

      if (jsonOutput) {
        console.log(JSON.stringify({
          success: true,
          format: "foundry",
          outputPath,
          actorCount: result.actors.length,
          difficulty: result.encounter.difficulty,
        }, null, 2));
      } else {
        console.log(`Foundry VTT encounter exported to: ${outputPath}`);
        console.log(`  Actors: ${result.actors.length}`);
        console.log(`  Difficulty: ${result.encounter.difficulty}`);
        console.log(`  Total XP: ${result.encounter.totalXP}`);
      }
    } else if (format === "roll20") {
      const result = exportRoll20Encounter(encounterJson);
      const outputPath = join(outputDir, `encounter-roll20-${timestamp}.txt`);
      writeFileSync(outputPath, result);

      if (jsonOutput) {
        console.log(JSON.stringify({
          success: true,
          format: "roll20",
          outputPath,
          characterCount: result.length,
        }, null, 2));
      } else {
        console.log(`Roll20 encounter exported to: ${outputPath}`);
        console.log(result);
      }
    } else {
      console.error(`Error: Unknown format "${format}". Use "foundry" or "roll20".`);
      process.exit(1);
    }
  } catch (e) {
    if (jsonOutput) {
      console.log(JSON.stringify({
        success: false,
        error: e instanceof Error ? e.message : String(e),
      }, null, 2));
    } else {
      console.error("Error:", e instanceof Error ? e.message : e);
    }
    process.exit(1);
  }
}
