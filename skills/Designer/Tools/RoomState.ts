#!/usr/bin/env bun
/**
 * RoomState.ts - Room inventory and design project tracking via StateManager
 *
 * Tracks per-room: dimensions, furniture, planned changes, budget, photos.
 * Uses CORE StateManager for atomic state persistence with validation.
 *
 * Usage:
 *   bun Tools/RoomState.ts add-room "living room" --dimensions "14x18" --budget 2000
 *   bun Tools/RoomState.ts list-rooms
 *   bun Tools/RoomState.ts add-item "living room" "floor lamp" --cost 150 --status purchased
 *   bun Tools/RoomState.ts room-summary "living room"
 *   bun Tools/RoomState.ts list-rooms --json
 *
 * @module RoomState
 */

import { z } from "zod";
import { createStateManager, type StateManager } from "../../CORE/Tools/StateManager.ts";
import { notifySync } from "../../CORE/Tools/NotificationService.ts";
import { join } from "path";

const KAYA_HOME = process.env.HOME + "/.claude";
const STATE_PATH = join(KAYA_HOME, "skills/Designer/data/room-state.json");

const FurnitureItemSchema = z.object({
  id: z.string(),
  name: z.string(),
  cost: z.number().optional(),
  status: z.enum(["wishlist", "planned", "ordered", "purchased", "placed"]).default("wishlist"),
  source: z.string().optional(),
  dimensions: z.string().optional(),
  style: z.string().optional(),
  notes: z.string().optional(),
  addedAt: z.string(),
});

const RoomSchema = z.object({
  id: z.string(),
  name: z.string(),
  dimensions: z.string().optional(),
  budget: z.number().optional(),
  spent: z.number().default(0),
  style: z.string().optional(),
  items: z.array(FurnitureItemSchema).default([]),
  photos: z.array(z.object({
    path: z.string(),
    label: z.string().optional(),
    date: z.string(),
  })).default([]),
  notes: z.string().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

const RoomStateSchema = z.object({
  rooms: z.array(RoomSchema),
  lastUpdated: z.string(),
});

type Room = z.infer<typeof RoomSchema>;
type FurnitureItem = z.infer<typeof FurnitureItemSchema>;
type RoomState = z.infer<typeof RoomStateSchema>;

// Initialize StateManager with schema validation and backup
const stateManager: StateManager<RoomState> = createStateManager({
  path: STATE_PATH,
  schema: RoomStateSchema,
  defaults: { rooms: [], lastUpdated: new Date().toISOString() },
  backupOnWrite: true,
});

export async function addRoom(name: string, opts?: { dimensions?: string; budget?: number; style?: string }): Promise<Room> {
  const now = new Date().toISOString();
  const room: Room = {
    id: `room-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    name: name.toLowerCase().trim(),
    dimensions: opts?.dimensions,
    budget: opts?.budget,
    spent: 0,
    style: opts?.style,
    items: [],
    photos: [],
    createdAt: now,
    updatedAt: now,
  };

  await stateManager.update(state => ({
    ...state,
    rooms: [...state.rooms, room],
    lastUpdated: now,
  }));

  return room;
}

export async function getRoom(name: string): Promise<Room | null> {
  const lower = name.toLowerCase().trim();
  const state = await stateManager.load();
  return state.rooms.find(r => r.name === lower) ?? null;
}

export async function listRooms(): Promise<Room[]> {
  const state = await stateManager.load();
  return state.rooms;
}

export async function addItem(roomName: string, itemName: string, opts?: {
  cost?: number; status?: FurnitureItem["status"]; source?: string; dimensions?: string; style?: string; notes?: string;
}): Promise<FurnitureItem | null> {
  const lower = roomName.toLowerCase().trim();
  const now = new Date().toISOString();

  const item: FurnitureItem = {
    id: `item-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    name: itemName,
    cost: opts?.cost,
    status: opts?.status ?? "wishlist",
    source: opts?.source,
    dimensions: opts?.dimensions,
    style: opts?.style,
    notes: opts?.notes,
    addedAt: now,
  };

  const newState = await stateManager.update(state => {
    const room = state.rooms.find(r => r.name === lower);
    if (!room) return state; // No room found, return unchanged

    room.items.push(item);
    if (opts?.cost && (opts?.status === "purchased" || opts?.status === "placed")) {
      room.spent += opts.cost;
    }
    room.updatedAt = now;
    state.lastUpdated = now;
    return state;
  });

  // Check if room was found
  const room = newState.rooms.find(r => r.name === lower);
  if (!room) return null;
  return item;
}

export async function removeItem(roomName: string, itemNameOrId: string): Promise<boolean> {
  const lower = roomName.toLowerCase().trim();
  let found = false;

  await stateManager.update(state => {
    const room = state.rooms.find(r => r.name === lower);
    if (!room) return state;

    const idx = room.items.findIndex(i => i.id === itemNameOrId || i.name.toLowerCase() === itemNameOrId.toLowerCase());
    if (idx === -1) return state;

    const item = room.items[idx];
    if (item.cost && (item.status === "purchased" || item.status === "placed")) {
      room.spent -= item.cost;
    }
    room.items.splice(idx, 1);
    room.updatedAt = new Date().toISOString();
    state.lastUpdated = room.updatedAt;
    found = true;
    return state;
  });

  return found;
}

export async function getRoomSummary(roomName: string): Promise<string | null> {
  const room = await getRoom(roomName);
  if (!room) return null;

  const lines: string[] = [
    `${room.name.charAt(0).toUpperCase() + room.name.slice(1)}`,
    room.dimensions ? `Dimensions: ${room.dimensions}` : "",
    room.style ? `Style: ${room.style}` : "",
    room.budget ? `Budget: $${room.spent}/$${room.budget} (${((room.spent / room.budget) * 100).toFixed(0)}% used)` : "",
    "",
    `Items (${room.items.length}):`,
  ].filter(Boolean);

  const grouped = { wishlist: [] as FurnitureItem[], planned: [] as FurnitureItem[], ordered: [] as FurnitureItem[], purchased: [] as FurnitureItem[], placed: [] as FurnitureItem[] };
  room.items.forEach(i => grouped[i.status].push(i));

  for (const [status, items] of Object.entries(grouped)) {
    if (items.length === 0) continue;
    lines.push(`  ${status.charAt(0).toUpperCase() + status.slice(1)} (${items.length}):`);
    items.forEach(i => {
      lines.push(`    - ${i.name}${i.cost ? ` -- $${i.cost}` : ""}${i.source ? ` (${i.source})` : ""}`);
    });
  }

  return lines.join("\n");
}

// CLI entrypoint
if (import.meta.main) {
  const args = process.argv.slice(2);
  const command = args[0];
  const jsonOutput = args.includes("--json");

  switch (command) {
    case "add-room": {
      const name = args[1];
      if (!name) { console.log("Usage: bun Tools/RoomState.ts add-room <name> [--dimensions WxL] [--budget N] [--style S]"); break; }
      const dimensions = args.includes("--dimensions") ? args[args.indexOf("--dimensions") + 1] : undefined;
      const budget = args.includes("--budget") ? parseInt(args[args.indexOf("--budget") + 1]) : undefined;
      const style = args.includes("--style") ? args[args.indexOf("--style") + 1] : undefined;
      const room = await addRoom(name, { dimensions, budget, style });
      if (jsonOutput) {
        console.log(JSON.stringify(room, null, 2));
      } else {
        console.log(`Added room: ${room.name}`);
        notifySync(`Added room ${room.name} to design tracker`);
      }
      break;
    }
    case "list-rooms": {
      const rooms = await listRooms();
      if (jsonOutput) {
        console.log(JSON.stringify(rooms, null, 2));
        break;
      }
      if (rooms.length === 0) { console.log("No rooms tracked yet."); break; }
      console.log(`\nRooms (${rooms.length}):\n`);
      rooms.forEach(r => {
        console.log(`  ${r.name}${r.dimensions ? ` (${r.dimensions})` : ""} -- ${r.items.length} items${r.budget ? `, $${r.spent}/$${r.budget}` : ""}`);
      });
      break;
    }
    case "add-item": {
      const roomName = args[1];
      const itemName = args[2];
      if (!roomName || !itemName) { console.log("Usage: bun Tools/RoomState.ts add-item <room> <item> [--cost N] [--status S]"); break; }
      const cost = args.includes("--cost") ? parseInt(args[args.indexOf("--cost") + 1]) : undefined;
      const status = args.includes("--status") ? args[args.indexOf("--status") + 1] as FurnitureItem["status"] : undefined;
      const item = await addItem(roomName, itemName, { cost, status });
      if (!item) { console.log(`Room "${roomName}" not found.`); break; }
      if (jsonOutput) {
        console.log(JSON.stringify(item, null, 2));
      } else {
        console.log(`Added "${itemName}" to ${roomName}`);
        notifySync(`Added ${itemName} to ${roomName} inventory`);
      }
      break;
    }
    case "room-summary": {
      const name = args[1];
      if (!name) { console.log("Usage: bun Tools/RoomState.ts room-summary <room>"); break; }
      if (jsonOutput) {
        const room = await getRoom(name);
        if (!room) { console.log(`Room "${name}" not found.`); break; }
        console.log(JSON.stringify(room, null, 2));
      } else {
        const summary = await getRoomSummary(name);
        if (!summary) { console.log(`Room "${name}" not found.`); break; }
        console.log(summary);
      }
      break;
    }
    default:
      console.log("Commands: add-room, list-rooms, add-item, room-summary");
      console.log("Flags: --json (structured JSON output)");
  }
}
