#!/usr/bin/env bun
/**
 * CampaignState.ts - D&D Campaign Persistence via StateManager
 *
 * Manages persistent campaign state including party members, NPCs,
 * locations, quests, and session logs. All persistence through
 * lib/core/StateManager.ts.
 *
 * @module CampaignState
 * @version 1.0.0
 */

import { z } from "zod";
import { createStateManager, type StateManager } from "../../../../lib/core/StateManager";
import { getKayaHome } from "../../../../lib/core/KayaHome";
import { existsSync, readdirSync, mkdirSync, renameSync } from "fs";
import { join } from "path";
import { randomUUID } from "crypto";

// ============================================
// CONSTANTS
// ============================================

const KAYA_HOME = getKayaHome();
export const CAMPAIGNS_DIR = join(KAYA_HOME, "MEMORY", "State", "dnd-campaigns");

// One-time migration: move campaigns from old skills/ path to MEMORY/ path
(function migrateCampaignsIfNeeded() {
  const oldDir = join(KAYA_HOME, "skills", "Life", "DnD", "State", "campaigns");
  if (existsSync(oldDir) && !existsSync(CAMPAIGNS_DIR)) {
    mkdirSync(CAMPAIGNS_DIR, { recursive: true });
    for (const f of readdirSync(oldDir)) {
      renameSync(join(oldDir, f), join(CAMPAIGNS_DIR, f));
    }
    console.log(`[CampaignState] Migrated campaigns from ${oldDir} to ${CAMPAIGNS_DIR}`);
  }
})();

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
  items: z.array(z.string()).optional(),
  image: z.string().optional(),
  notes: z.string().optional(),
});

const NPCSchema = z.object({
  name: z.string(),
  description: z.string().optional(),
  location: z.string().optional(),
  disposition: z.string().optional(),
  image: z.string().optional(),
  notes: z.string().optional(),
});

const LocationSchema = z.object({
  name: z.string(),
  description: z.string().optional(),
  visited: z.boolean().default(true),
  image: z.string().optional(),
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
  assetLibrary: z.string().optional(),
  homebrewRef: z.string().optional(),
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
  id?: string;
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
  const requestedId = settings.id?.trim();
  if (requestedId && !/^[a-z0-9][a-z0-9-]*$/.test(requestedId)) {
    throw new Error(
      `Invalid campaign id "${requestedId}": use lowercase letters, digits, and hyphens only`
    );
  }
  const id = requestedId || randomUUID().slice(0, 8);
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
  } catch (e) {
    // File exists but failed to parse/validate - distinct from "never created".
    // Loud on purpose: a missing campaign is normal, a corrupted one is not.
    console.error(
      `[CampaignState] Campaign file for "${campaignId}" exists but failed to load (corrupted or invalid): ${
        e instanceof Error ? e.message : e
      }`
    );
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

async function requireCampaign(
  campaignId: string,
  baseDir: string
): Promise<Campaign> {
  const campaign = await loadCampaign(campaignId, baseDir);
  if (!campaign) {
    throw new Error(`Campaign not found: ${campaignId}`);
  }
  return campaign;
}

/**
 * Merge `patch` over `base`, ignoring keys whose value is `undefined` so that
 * unset CLI flags never erase existing data. Explicit values (including empty
 * strings) still overwrite.
 */
function mergeDefined<T extends object>(base: T, patch: T): T {
  const result = { ...base };
  for (const [k, v] of Object.entries(patch)) {
    if (v !== undefined) (result as Record<string, unknown>)[k] = v;
  }
  return result;
}

/**
 * Add (or replace, by name) a party member. Re-adding an existing name merges
 * the new fields over the old entry so edits are idempotent.
 */
export async function addPartyMember(
  campaignId: string,
  member: PartyMember,
  baseDir: string = CAMPAIGNS_DIR
): Promise<Campaign> {
  const campaign = await requireCampaign(campaignId, baseDir);
  const idx = campaign.partyMembers.findIndex((m) => m.name === member.name);
  if (idx !== -1) {
    campaign.partyMembers[idx] = mergeDefined(campaign.partyMembers[idx], member);
  } else {
    campaign.partyMembers.push(member);
  }
  await saveCampaign(campaign, baseDir);
  return campaign;
}

/**
 * Add (or replace, by name) an NPC.
 */
export async function addNPC(
  campaignId: string,
  npc: NPC,
  baseDir: string = CAMPAIGNS_DIR
): Promise<Campaign> {
  const campaign = await requireCampaign(campaignId, baseDir);
  const idx = campaign.npcs.findIndex((n) => n.name === npc.name);
  if (idx !== -1) {
    campaign.npcs[idx] = mergeDefined(campaign.npcs[idx], npc);
  } else {
    campaign.npcs.push(npc);
  }
  await saveCampaign(campaign, baseDir);
  return campaign;
}

/**
 * Add (or replace, by name) a location.
 */
export async function addLocation(
  campaignId: string,
  location: Location,
  baseDir: string = CAMPAIGNS_DIR
): Promise<Campaign> {
  const campaign = await requireCampaign(campaignId, baseDir);
  const idx = campaign.locations.findIndex((l) => l.name === location.name);
  if (idx !== -1) {
    campaign.locations[idx] = mergeDefined(campaign.locations[idx], location);
  } else {
    campaign.locations.push(location);
  }
  await saveCampaign(campaign, baseDir);
  return campaign;
}

/**
 * Add (or replace, by name) a quest.
 */
export async function addQuest(
  campaignId: string,
  quest: Quest,
  baseDir: string = CAMPAIGNS_DIR
): Promise<Campaign> {
  const campaign = await requireCampaign(campaignId, baseDir);
  const idx = campaign.quests.findIndex((q) => q.name === quest.name);
  if (idx !== -1) {
    campaign.quests[idx] = mergeDefined(campaign.quests[idx], quest);
  } else {
    campaign.quests.push(quest);
  }
  await saveCampaign(campaign, baseDir);
  return campaign;
}

/**
 * Set the party's current location.
 */
export async function setCurrentLocation(
  campaignId: string,
  location: string,
  baseDir: string = CAMPAIGNS_DIR
): Promise<Campaign> {
  const campaign = await requireCampaign(campaignId, baseDir);
  campaign.currentLocation = location;
  await saveCampaign(campaign, baseDir);
  return campaign;
}

/**
 * Import a full campaign from a plain object (e.g. parsed seed JSON).
 * Validates against the schema, fills timestamps, and persists under its id.
 */
export async function importCampaign(
  data: unknown,
  baseDir: string = CAMPAIGNS_DIR
): Promise<Campaign> {
  const now = new Date().toISOString();
  const raw = (typeof data === "object" && data !== null ? data : {}) as Record<
    string,
    unknown
  >;
  const withDefaults = {
    partyMembers: [],
    npcs: [],
    locations: [],
    quests: [],
    sessionLogs: [],
    createdAt: now,
    lastUpdated: now,
    ...raw,
  };
  const campaign = CampaignSchema.parse(withDefaults);
  await saveCampaign(campaign, baseDir);
  return campaign;
}

/**
 * Render a human-readable markdown "campaign sheet" for at-the-table use.
 */
export function renderCampaignSheet(campaign: Campaign): string {
  const lines: string[] = [];
  lines.push(`# ${campaign.name}`);
  const meta: string[] = [];
  if (campaign.setting) meta.push(`**Setting:** ${campaign.setting}`);
  if (campaign.currentLocation)
    meta.push(`**Current location:** ${campaign.currentLocation}`);
  if (campaign.startingLevel != null)
    meta.push(`**Starting level:** ${campaign.startingLevel}`);
  meta.push(`**ID:** \`${campaign.id}\``);
  if (meta.length) lines.push("", meta.join("  •  "));
  if (campaign.notes) lines.push("", campaign.notes);

  const party = campaign.partyMembers;
  if (party.length) {
    lines.push("", "## Party");
    for (const m of party) {
      const bits = [m.class, m.level != null ? `lvl ${m.level}` : "", m.race]
        .filter(Boolean)
        .join(", ");
      const player = m.playerName ? ` _(${m.playerName})_` : "";
      lines.push(`- **${m.name}**${player}${bits ? ` — ${bits}` : ""}`);
      if (m.items?.length) lines.push(`  - Items: ${m.items.join(", ")}`);
      if (m.notes) lines.push(`  - ${m.notes}`);
    }
  }

  const activeQuests = campaign.quests.filter((q) => q.status === "active");
  const otherQuests = campaign.quests.filter((q) => q.status !== "active");
  if (activeQuests.length) {
    lines.push("", "## Active Quests");
    for (const q of activeQuests) {
      lines.push(
        `- **${q.name}**${q.givenBy ? ` (from ${q.givenBy})` : ""}${
          q.description ? ` — ${q.description}` : ""
        }`
      );
    }
  }
  if (otherQuests.length) {
    lines.push("", "## Other Quests");
    for (const q of otherQuests) {
      lines.push(`- ~~${q.name}~~ (${q.status})`);
    }
  }

  if (campaign.npcs.length) {
    lines.push("", "## NPCs");
    for (const n of campaign.npcs) {
      const tags = [n.location, n.disposition].filter(Boolean).join(", ");
      lines.push(
        `- **${n.name}**${tags ? ` (${tags})` : ""}${
          n.description ? ` — ${n.description}` : ""
        }`
      );
    }
  }

  if (campaign.locations.length) {
    lines.push("", "## Locations");
    for (const l of campaign.locations) {
      const mark = l.visited ? "" : " _(unvisited)_";
      lines.push(
        `- **${l.name}**${mark}${l.description ? ` — ${l.description}` : ""}`
      );
    }
  }

  const logs = [...campaign.sessionLogs].sort((a, b) => a.number - b.number);
  if (logs.length) {
    lines.push("", "## Session Log");
    for (const s of logs) {
      lines.push(`- **Session ${s.number}** (${s.date}) — ${s.summary}`);
    }
  }

  if (campaign.assetLibrary || campaign.homebrewRef) {
    lines.push("", "## References");
    if (campaign.assetLibrary)
      lines.push(`- Asset library: ${campaign.assetLibrary}`);
    if (campaign.homebrewRef)
      lines.push(`- Homebrew items: ${campaign.homebrewRef}`);
  }

  return lines.join("\n") + "\n";
}

// ============================================
// CLI
// ============================================

if (import.meta.main) {
  const args = process.argv.slice(2);
  const command = args[0];

  /** Read the value after a `--flag`, or undefined if absent. */
  const flag = (name: string): string | undefined => {
    const i = args.indexOf(name);
    return i !== -1 ? args[i + 1] : undefined;
  };
  const num = (name: string): number | undefined => {
    const v = flag(name);
    return v !== undefined ? parseInt(v, 10) : undefined;
  };
  const has = (name: string): boolean => args.includes(name);
  const die = (msg: string): never => {
    console.error(`Error: ${msg}`);
    process.exit(1);
  };

  if (!command || command === "--help" || command === "-h") {
    console.log(`
CampaignState - D&D Campaign Persistence Manager

Usage:
  bun CampaignState.ts create <name> [--id <slug>] [--setting <s>] [--level <n>] [--max-players <n>]
  bun CampaignState.ts list [--json]
  bun CampaignState.ts load <id> [--json]         # --json prints raw JSON (default: readable sheet)
  bun CampaignState.ts sheet <id>                 # readable markdown campaign sheet
  bun CampaignState.ts import <file.json>         # import/overwrite a full campaign from a seed file
  bun CampaignState.ts add-party <id> --name <n> [--class <c>] [--level <n>] [--race <r>] [--player <p>] [--items "a, b"] [--image <path>] [--notes <t>]
  bun CampaignState.ts add-npc <id> --name <n> [--description <d>] [--location <l>] [--disposition <x>] [--image <path>] [--notes <t>]
  bun CampaignState.ts add-location <id> --name <n> [--description <d>] [--unvisited] [--image <path>] [--notes <t>]
  bun CampaignState.ts add-quest <id> --name <n> [--description <d>] [--status active|completed|failed|abandoned] [--given-by <g>] [--reward <r>] [--notes <t>]
  bun CampaignState.ts set-location <id> --location <name>
  bun CampaignState.ts add-session <id> --number <n> --date <date> --summary <text>

All state persisted via StateManager with backup and validation.
`);
    process.exit(0);
  }

  switch (command) {
    case "create": {
      const name = args[1];
      if (!name || name.startsWith("--")) die("campaign name required");
      const campaign = await createCampaign({
        name,
        id: flag("--id"),
        setting: flag("--setting"),
        startingLevel: num("--level"),
        maxPlayers: num("--max-players"),
      });
      console.log(JSON.stringify(campaign, null, 2));
      break;
    }
    case "list": {
      const campaigns = await listCampaigns();
      if (has("--json")) {
        console.log(JSON.stringify(campaigns, null, 2));
      } else if (campaigns.length === 0) {
        console.log("No campaigns yet. Create one with: create <name> --id <slug>");
      } else {
        for (const c of campaigns) {
          console.log(
            `${c.id.padEnd(12)} ${c.name}  (party ${c.partySize}, ${c.sessionCount} sessions)`
          );
        }
      }
      break;
    }
    case "load": {
      const id = args[1];
      if (!id) die("campaign ID required");
      const campaign = await loadCampaign(id);
      if (!campaign) die(`Campaign not found: ${id}`);
      console.log(
        has("--json")
          ? JSON.stringify(campaign, null, 2)
          : renderCampaignSheet(campaign!)
      );
      break;
    }
    case "sheet": {
      const id = args[1];
      if (!id) die("campaign ID required");
      const campaign = await loadCampaign(id);
      if (!campaign) die(`Campaign not found: ${id}`);
      console.log(renderCampaignSheet(campaign!));
      break;
    }
    case "import": {
      const file = args[1];
      if (!file) die("path to a campaign JSON file required");
      if (!existsSync(file)) die(`File not found: ${file}`);
      let parsed: unknown;
      try {
        parsed = JSON.parse(await Bun.file(file).text());
      } catch (e) {
        die(`Could not parse JSON: ${(e as Error).message}`);
      }
      const campaign = await importCampaign(parsed);
      console.log(
        `Imported campaign "${campaign.name}" as id "${campaign.id}" ` +
          `(${campaign.partyMembers.length} party, ${campaign.npcs.length} NPCs, ` +
          `${campaign.locations.length} locations, ${campaign.quests.length} quests).`
      );
      break;
    }
    case "add-party": {
      const id = args[1];
      const name = flag("--name");
      if (!id || !name) die("required <id> and --name");
      const itemsRaw = flag("--items");
      const updated = await addPartyMember(id!, {
        name: name!,
        class: flag("--class"),
        level: num("--level"),
        race: flag("--race"),
        playerName: flag("--player"),
        items: itemsRaw
          ? itemsRaw.split(",").map((s) => s.trim()).filter(Boolean)
          : undefined,
        image: flag("--image"),
        notes: flag("--notes"),
      });
      console.log(`Party member "${name}" saved (${updated.partyMembers.length} total).`);
      break;
    }
    case "add-npc": {
      const id = args[1];
      const name = flag("--name");
      if (!id || !name) die("required <id> and --name");
      const updated = await addNPC(id!, {
        name: name!,
        description: flag("--description"),
        location: flag("--location"),
        disposition: flag("--disposition"),
        image: flag("--image"),
        notes: flag("--notes"),
      });
      console.log(`NPC "${name}" saved (${updated.npcs.length} total).`);
      break;
    }
    case "add-location": {
      const id = args[1];
      const name = flag("--name");
      if (!id || !name) die("required <id> and --name");
      const updated = await addLocation(id!, {
        name: name!,
        description: flag("--description"),
        visited: !has("--unvisited"),
        image: flag("--image"),
        notes: flag("--notes"),
      });
      console.log(`Location "${name}" saved (${updated.locations.length} total).`);
      break;
    }
    case "add-quest": {
      const id = args[1];
      const name = flag("--name");
      if (!id || !name) die("required <id> and --name");
      const statusRaw = flag("--status") ?? "active";
      const status = QuestSchema.shape.status.safeParse(statusRaw);
      if (!status.success) die(`invalid --status "${statusRaw}"`);
      const updated = await addQuest(id!, {
        name: name!,
        description: flag("--description"),
        status: status.data!,
        givenBy: flag("--given-by"),
        reward: flag("--reward"),
        notes: flag("--notes"),
      });
      console.log(`Quest "${name}" saved (${updated.quests.length} total).`);
      break;
    }
    case "set-location": {
      const id = args[1];
      const location = flag("--location");
      if (!id || !location) die("required <id> and --location");
      await setCurrentLocation(id!, location!);
      console.log(`Current location set to "${location}".`);
      break;
    }
    case "add-session": {
      const campaignId = args[1];
      const number = num("--number");
      const date = flag("--date");
      const summary = flag("--summary");
      if (!campaignId || number === undefined || !date || !summary) {
        die("required <id>, --number, --date, --summary");
      }
      const updated = await addSession(campaignId!, {
        number: number!,
        date: date!,
        summary: summary!,
      });
      console.log(
        `Session ${number} logged (${updated.sessionLogs.length} sessions total).`
      );
      break;
    }
    default:
      console.error(`Unknown command: ${command}`);
      process.exit(1);
  }
}
