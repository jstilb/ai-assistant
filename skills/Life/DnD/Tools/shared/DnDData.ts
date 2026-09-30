/**
 * DnDData.ts - Shared D&D 5e data interfaces, loaders, and utilities
 *
 * Single source of truth for CR table interfaces, XP data, and utility
 * functions that were previously duplicated across CRCalculator, MonsterGenerator,
 * HomebrewValidator, EncounterBalancer, and VTTExporter.
 *
 * @module DnDData
 */

import { join, dirname } from "path";
import { readFileSync } from "fs";

// ============================================
// INTERFACES
// ============================================

export interface CRTableEntry {
  cr: number;
  hpMin: number;
  hpMax: number;
}

export interface StatsByCR {
  cr: number;
  profBonus: number;
  ac: number;
  attackBonus: number;
  saveDC: number;
  dprMin: number;
  dprMax: number;
}

export interface EffectiveHPMultiplier {
  crMin: number;
  crMax: number;
  resistances: number;
  immunities: number;
}

export interface EncounterBudget {
  easy: number;
  medium: number;
  hard: number;
  deadly: number;
  partyLevel: number;
  partySize: number;
}

// ============================================
// CR TABLE CACHE
// ============================================

export interface CRTables {
  hpByCR: CRTableEntry[];
  statsByCR: StatsByCR[];
  effectiveHPMultipliers: { byExpectedCR: EffectiveHPMultiplier[] };
}

let crTableCache: CRTables | null = null;

/**
 * Load CR tables from disk. Cached after first load.
 * Returns hpByCR, statsByCR, and effectiveHPMultipliers.
 */
// DnDData.ts lives in Tools/shared/, so we need to go up two levels to reach the DnD root
// where the Data/ directory lives: Tools/shared/ -> Tools/ -> DnD/
const DND_ROOT = dirname(dirname(import.meta.dir));

export function loadCRTables(): CRTables {
  if (crTableCache) return crTableCache;
  const dataPath = join(DND_ROOT, "Data", "cr-tables.json");
  const raw = readFileSync(dataPath, "utf-8");
  crTableCache = JSON.parse(raw) as CRTables;
  return crTableCache;
}

// ============================================
// XP DATA CACHE
// ============================================

export interface XPThresholds {
  easy: number;
  medium: number;
  hard: number;
  deadly: number;
}

export interface MonsterCountMultiplier {
  monstersMin: number;
  monstersMax: number;
  multiplier: number;
}

export interface XPThresholdData {
  thresholdsByLevel: Record<string, XPThresholds>;
  monsterCountMultipliers: MonsterCountMultiplier[];
  xpByCR: Record<string, number>;
}

let xpDataCache: XPThresholdData | null = null;

/**
 * Load XP threshold data from disk. Cached after first load.
 */
export function loadXPData(): XPThresholdData {
  if (xpDataCache) return xpDataCache;
  const dataPath = join(DND_ROOT, "Data", "xp-thresholds.json");
  const raw = readFileSync(dataPath, "utf-8");
  xpDataCache = JSON.parse(raw) as XPThresholdData;
  return xpDataCache;
}

// ============================================
// CR UTILITIES
// ============================================

/**
 * Convert a numeric CR to its display string (e.g. 0.125 → "1/8").
 */
export function crToString(cr: number): string {
  if (cr === 0.125) return "1/8";
  if (cr === 0.25) return "1/4";
  if (cr === 0.5) return "1/2";
  return String(cr);
}

/** All valid D&D 5e CR values per DMG. */
export const VALID_CRS: readonly number[] = [
  0, 0.125, 0.25, 0.5,
  1, 2, 3, 4, 5, 6, 7, 8, 9, 10,
  11, 12, 13, 14, 15, 16, 17, 18, 19, 20,
  21, 22, 23, 24, 25, 26, 27, 28, 29, 30,
] as const;

// ============================================
// SRD SPELL DATA
// ============================================

export interface SRDSpell {
  name: string;
  level: number;
  school: string;
  casting_time?: string;
  range?: string;
  components?: string[];
  duration?: string;
  damage?: string;
  damageType?: string;
}

export interface SRDSpellData {
  spells: SRDSpell[];
}

let spellDataCache: SRDSpellData | null = null;

/**
 * Load SRD spell data from disk. Cached after first load.
 */
export function loadSpells(): SRDSpellData {
  if (spellDataCache) return spellDataCache;
  const dataPath = join(DND_ROOT, "Data", "srd-spells.json");
  const raw = readFileSync(dataPath, "utf-8");
  spellDataCache = JSON.parse(raw) as SRDSpellData;
  return spellDataCache;
}

// ============================================
// SRD ITEM DATA
// ============================================

export interface SRDItem {
  name: string;
  type: string;
  rarity?: string;
  attunement?: boolean;
  description?: string;
}

export interface SRDItemData {
  items: SRDItem[];
}

let itemDataCache: SRDItemData | null = null;

/**
 * Load SRD item data from disk. Cached after first load.
 */
export function loadItems(): SRDItemData {
  if (itemDataCache) return itemDataCache;
  const dataPath = join(DND_ROOT, "Data", "srd-items.json");
  const raw = readFileSync(dataPath, "utf-8");
  itemDataCache = JSON.parse(raw) as SRDItemData;
  return itemDataCache;
}

// ============================================
// SRD MONSTER DATA
// ============================================

export interface SRDMonsterEntry {
  name: string;
  cr: number;
  type?: string;
  size?: string;
  subtype?: string;
  alignment?: string;
}

export interface SRDMonsterData {
  monsters: SRDMonsterEntry[];
}

let monsterDataCache: SRDMonsterData | null = null;

/**
 * Load SRD monster data from disk. Cached after first load.
 */
export function loadMonsters(): SRDMonsterData {
  if (monsterDataCache) return monsterDataCache;
  const dataPath = join(DND_ROOT, "Data", "srd-monsters.json");
  const raw = readFileSync(dataPath, "utf-8");
  monsterDataCache = JSON.parse(raw) as SRDMonsterData;
  return monsterDataCache;
}
