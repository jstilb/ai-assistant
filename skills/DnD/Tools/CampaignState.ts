#!/usr/bin/env bun
/**
 * CampaignState.ts - D&D Campaign Persistence via StateManager
 *
 * Manages persistent campaign state including party members, NPCs,
 * locations, quests, and session logs. All persistence through
 * skills/CORE/Tools/StateManager.ts.
 *
 * @module CampaignState
 * @version 1.0.0
 */

import { z } from "zod";
import { createStateManager, type StateManager } from "../../CORE/Tools/StateManager";
import { existsSync, readdirSync } from "fs";
import { join } from "path";
import { randomUUID } from "crypto";

// ============================================
// CONSTANTS
// ============================================

const KAYA_HOME = process.env.HOME + "/.claude";
export const CAMPAIGNS_DIR = join(KAYA_HOME, "skills", "DnD", "State", "campaigns");

// ============================================
// SCHEMAS
// ============================================

const PartyMemberSchema = z.object({
  name: z.string(),
  class: z.string().optional(),
  level: z.number().optional(),
  race: z.string().optional(),
  playerName: z.string().optional(),
  hp: z.number().optional(),
  maxHp: z.number().optional(),
  notes: z.string().optional(),
});

const NPCSchema = z.object({
  name: z.string(),
  description: z.string().optional(),
  location: z.string().optional(),
  disposition: z.string().optional(),
  notes: z.string().optional(),
});

const LocationSchema = z.object({
  name: z.string(),
  description: z.string().optional(),
  visited: z.boolean().default(true),
  notes: z.string().optional(),
});

const QuestSchema = z.object({
  name: z.string(),
  description: z.string().optional(),
  status: z.enum(["active", "completed", "failed", "abandoned"]).default("active"),
  givenBy: z.string().optional(),
  reward: z.string().optional(),
  notes: z.string().optional(),
});

const SessionLogSchema = z.object({
  number: z.number(),
  date: z.string(),
  summary: z.string(),
  notableEvents: z.array(z.string()).optional(),
  lootFound: z.array(z.string()).optional(),
  xpAwarded: z.number().optional(),
  notes: z.string().optional(),
});

const CampaignSchema = z.object({
  id: z.string(),
  name: z.string(),
  setting: z.string().optional(),
  startingLevel: z.number().optional(),
  maxPlayers: z.number().optional(),
  currentLocation: z.string().optional(),
  partyMembers: z.array(PartyMemberSchema),
  npcs: z.array(NPCSchema),
  locations: z.array(LocationSchema),
  quests: z.array(QuestSchema),
  sessionLogs: z.array(SessionLogSchema),
  createdAt: z.string(),
  lastUpdated: z.string(),
  notes: z.string().optional(),
});

// ============================================
// TYPES (exported for consumers)
// ============================================

export type PartyMember = z.infer<typeof PartyMemberSchema>;
export type NPC = z.infer<typeof NPCSchema>;
export type Location = z.infer<typeof LocationSchema>;
export type Quest = z.infer<typeof QuestSchema>;
export type SessionLog = z.infer<typeof SessionLogSchema>;
export type Campaign = z.infer<typeof CampaignSchema>;

export interface CampaignSettings {
  name: string;
  setting?: string;
  startingLevel?: number;
  maxPlayers?: number;
}

export interface SessionData {
  number: number;
  date: string;
  summary: string;
  notableEvents?: string[];
  lootFound?: string[];
  xpAwarded?: number;
  notes?: string;
}

export interface CampaignSummary {
  id: string;
  name: string;
  createdAt: string;
  setting?: string;
  partySize: number;
  sessionCount: number;
}

// ============================================
// STATE MANAGER CACHE
// ============================================

const managerCache = new Map<string, StateManager<Campaign>>();

function getCampaignManager(campaignId: string, baseDir: string): StateManager<Campaign> {
  const key = `${baseDir}/${campaignId}`;
  if (managerCache.has(key)) {
    return managerCache.get(key)!;
  }

  const manager = createStateManager<Campaign>({
    path: join(baseDir, `${campaignId}.json`),
    schema: CampaignSchema,
    defaults: () => ({
      id: campaignId,
      name: "Untitled Campaign",
      partyMembers: [],
      npcs: [],
      locations: [],
      quests: [],
      sessionLogs: [],
      createdAt: new Date().toISOString(),
      lastUpdated: new Date().toISOString(),
    }),
    backupOnWrite: true,
    version: 1,
  });

  managerCache.set(key, manager);
  return manager;
}

// ============================================
// PUBLIC API
// ============================================

/**
 * Create a new campaign with the given settings.
 */
export async function createCampaign(
  settings: CampaignSettings,
  baseDir: string = CAMPAIGNS_DIR
): Promise<Campaign> {
  const id = randomUUID().slice(0, 8);
  const now = new Date().toISOString();

  const campaign: Campaign = {
    id,
    name: settings.name,
    setting: settings.setting,
    startingLevel: settings.startingLevel,
    maxPlayers: settings.maxPlayers,
    partyMembers: [],
    npcs: [],
    locations: [],
    quests: [],
    sessionLogs: [],
    createdAt: now,
    lastUpdated: now,
  };

  const manager = getCampaignManager(id, baseDir);
  await manager.save(campaign);

  return campaign;
}

/**
 * Load an existing campaign by ID. Returns null if not found.
 */
export async function loadCampaign(
  campaignId: string,
  baseDir: string = CAMPAIGNS_DIR
): Promise<Campaign | null> {
  const manager = getCampaignManager(campaignId, baseDir);
  const exists = await manager.exists();
  if (!exists) return null;

  try {
    return await manager.load();
  } catch {
    return null;
  }
}

/**
 * Save (update) an existing campaign.
 */
export async function saveCampaign(
  campaign: Campaign,
  baseDir: string = CAMPAIGNS_DIR
): Promise<void> {
  const manager = getCampaignManager(campaign.id, baseDir);
  await manager.save(campaign);
}

/**
 * List all campaigns (summaries).
 */
export async function listCampaigns(
  baseDir: string = CAMPAIGNS_DIR
): Promise<CampaignSummary[]> {
  if (!existsSync(baseDir)) return [];

  const files = readdirSync(baseDir).filter(
    (f) => f.endsWith(".json") && !f.includes(".backup") && !f.includes(".lock")
  );

  const summaries: CampaignSummary[] = [];

  for (const file of files) {
    const campaignId = file.replace(".json", "");
    const campaign = await loadCampaign(campaignId, baseDir);
    if (campaign) {
      summaries.push({
        id: campaign.id,
        name: campaign.name,
        createdAt: campaign.createdAt,
        setting: campaign.setting,
        partySize: campaign.partyMembers.length,
        sessionCount: campaign.sessionLogs.length,
      });
    }
  }

  return summaries;
}

/**
 * Add a session log to a campaign.
 * @throws If campaign not found
 */
export async function addSession(
  campaignId: string,
  sessionData: SessionData,
  baseDir: string = CAMPAIGNS_DIR
): Promise<Campaign> {
  const campaign = await loadCampaign(campaignId, baseDir);
  if (!campaign) {
    throw new Error(`Campaign not found: ${campaignId}`);
  }

  const sessionLog: SessionLog = {
    number: sessionData.number,
    date: sessionData.date,
    summary: sessionData.summary,
    notableEvents: sessionData.notableEvents,
    lootFound: sessionData.lootFound,
    xpAwarded: sessionData.xpAwarded,
    notes: sessionData.notes,
  };

  campaign.sessionLogs.push(sessionLog);
  await saveCampaign(campaign, baseDir);

  return campaign;
}

// ============================================
// CLI
// ============================================

if (import.meta.main) {
  const args = process.argv.slice(2);
  const command = args[0];

  if (!command || command === "--help" || command === "-h") {
    console.log(`
CampaignState - D&D Campaign Persistence Manager

Usage:
  bun CampaignState.ts create <name> [--setting <setting>] [--level <n>]
  bun CampaignState.ts list
  bun CampaignState.ts load <id>
  bun CampaignState.ts add-session <id> --number <n> --date <date> --summary <text>
  bun CampaignState.ts --help

All state persisted via StateManager with backup and validation.
`);
    process.exit(0);
  }

  switch (command) {
    case "create": {
      const name = args[1];
      if (!name) {
        console.error("Error: campaign name required");
        process.exit(1);
      }
      const settingIdx = args.indexOf("--setting");
      const levelIdx = args.indexOf("--level");
      const campaign = await createCampaign({
        name,
        setting: settingIdx !== -1 ? args[settingIdx + 1] : undefined,
        startingLevel: levelIdx !== -1 ? parseInt(args[levelIdx + 1]) : undefined,
      });
      console.log(JSON.stringify(campaign, null, 2));
      break;
    }
    case "list": {
      const campaigns = await listCampaigns();
      console.log(JSON.stringify(campaigns, null, 2));
      break;
    }
    case "load": {
      const id = args[1];
      if (!id) {
        console.error("Error: campaign ID required");
        process.exit(1);
      }
      const campaign = await loadCampaign(id);
      if (campaign) {
        console.log(JSON.stringify(campaign, null, 2));
      } else {
        console.error(`Campaign not found: ${id}`);
        process.exit(1);
      }
      break;
    }
    case "add-session": {
      const campaignId = args[1];
      const numIdx = args.indexOf("--number");
      const dateIdx = args.indexOf("--date");
      const summaryIdx = args.indexOf("--summary");
      if (!campaignId || numIdx === -1 || dateIdx === -1 || summaryIdx === -1) {
        console.error("Error: required --number, --date, --summary");
        process.exit(1);
      }
      const updated = await addSession(campaignId, {
        number: parseInt(args[numIdx + 1]),
        date: args[dateIdx + 1],
        summary: args[summaryIdx + 1],
      });
      console.log(JSON.stringify(updated, null, 2));
      break;
    }
    default:
      console.error(`Unknown command: ${command}`);
      process.exit(1);
  }
}
