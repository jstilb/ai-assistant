#!/usr/bin/env bun
/**
 * PantryTracker.ts - Track kitchen inventory via StateManager
 *
 * Add/remove items with expiration dates, query what's on hand,
 * find expiring items, and check what recipes are possible.
 * Uses CORE StateManager for type-safe state persistence.
 *
 * Usage:
 *   bun Tools/PantryTracker.ts add "chicken thighs" --expires 2026-02-08
 *   bun Tools/PantryTracker.ts remove "chicken thighs"
 *   bun Tools/PantryTracker.ts list
 *   bun Tools/PantryTracker.ts expiring --days 3
 *
 * @module PantryTracker
 */

import { z } from "zod";
import { createStateManager } from "../../CORE/Tools/StateManager";
import { notifySync } from "../../CORE/Tools/NotificationService";

const KAYA_HOME = process.env.HOME + "/.claude";

const PantryItemSchema = z.object({
  id: z.string(),
  name: z.string(),
  quantity: z.string().optional(),
  unit: z.string().optional(),
  addedAt: z.string(),
  expiresAt: z.string().optional(),
  category: z.enum(["produce", "protein", "dairy", "grain", "pantry-staple", "condiment", "frozen", "other"]).default("other"),
  isStaple: z.boolean().default(false),
});

const PantryStateSchema = z.object({
  items: z.array(PantryItemSchema),
  lastUpdated: z.string(),
});

type PantryItem = z.infer<typeof PantryItemSchema>;
type PantryState = z.infer<typeof PantryStateSchema>;

// StateManager instance for pantry state
const pantryManager = createStateManager<PantryState>({
  path: `${KAYA_HOME}/skills/Cooking/data/pantry-state.json`,
  schema: PantryStateSchema,
  defaults: { items: [], lastUpdated: new Date().toISOString() },
});

export async function addItem(name: string, opts?: { quantity?: string; unit?: string; expires?: string; category?: PantryItem["category"]; isStaple?: boolean }): Promise<PantryItem> {
  const item: PantryItem = {
    id: `pantry-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    name: name.toLowerCase().trim(),
    quantity: opts?.quantity,
    unit: opts?.unit,
    addedAt: new Date().toISOString(),
    expiresAt: opts?.expires,
    category: opts?.category ?? "other",
    isStaple: opts?.isStaple ?? false,
  };

  await pantryManager.update(state => ({
    ...state,
    items: [...state.items, item],
  }));

  return item;
}

export async function removeItem(nameOrId: string): Promise<boolean> {
  const lower = nameOrId.toLowerCase().trim();
  let found = false;

  await pantryManager.update(state => {
    const idx = state.items.findIndex(i => i.id === nameOrId || i.name === lower);
    if (idx === -1) return state;
    found = true;
    return {
      ...state,
      items: [...state.items.slice(0, idx), ...state.items.slice(idx + 1)],
    };
  });

  return found;
}

export async function listItems(): Promise<PantryItem[]> {
  const state = await pantryManager.load();
  return state.items.sort((a, b) => a.name.localeCompare(b.name));
}

export async function getExpiring(withinDays: number): Promise<PantryItem[]> {
  const state = await pantryManager.load();
  const now = Date.now();
  const threshold = now + withinDays * 24 * 60 * 60 * 1000;
  return state.items
    .filter(i => i.expiresAt && new Date(i.expiresAt).getTime() <= threshold)
    .sort((a, b) => new Date(a.expiresAt!).getTime() - new Date(b.expiresAt!).getTime());
}

export async function getExpired(): Promise<PantryItem[]> {
  const state = await pantryManager.load();
  const now = Date.now();
  return state.items
    .filter(i => i.expiresAt && new Date(i.expiresAt).getTime() < now);
}

export async function hasIngredient(name: string): Promise<boolean> {
  const state = await pantryManager.load();
  const lower = name.toLowerCase().trim();
  return state.items.some(i => i.name.includes(lower) || lower.includes(i.name));
}

export async function getNonStapleItems(): Promise<PantryItem[]> {
  const state = await pantryManager.load();
  return state.items.filter(i => !i.isStaple);
}

// CLI entrypoint
if (import.meta.main) {
  const args = process.argv.slice(2);
  const command = args[0];

  switch (command) {
    case "add": {
      const name = args[1];
      if (!name) { console.log("Usage: bun Tools/PantryTracker.ts add <name> [--expires DATE] [--qty AMOUNT] [--category TYPE]"); break; }
      const expires = args.includes("--expires") ? args[args.indexOf("--expires") + 1] : undefined;
      const quantity = args.includes("--qty") ? args[args.indexOf("--qty") + 1] : undefined;
      const category = args.includes("--category") ? args[args.indexOf("--category") + 1] as PantryItem["category"] : undefined;
      const item = await addItem(name, { expires, quantity, category });
      console.log(`Added: ${item.name}${expires ? ` (expires ${expires})` : ""}`);
      notifySync(`Added ${item.name} to pantry`);
      break;
    }
    case "remove": {
      const name = args[1];
      if (!name) { console.log("Usage: bun Tools/PantryTracker.ts remove <name>"); break; }
      const removed = await removeItem(name);
      console.log(removed ? `Removed: ${name}` : `Not found: ${name}`);
      if (removed) notifySync(`Removed ${name} from pantry`);
      break;
    }
    case "list": {
      const items = await listItems();
      if (items.length === 0) { console.log("Pantry is empty."); break; }
      console.log(`\nPantry (${items.length} items):\n`);
      items.forEach(i => {
        const exp = i.expiresAt ? ` (exp: ${i.expiresAt.split("T")[0]})` : "";
        const qty = i.quantity ? ` -- ${i.quantity}${i.unit ? " " + i.unit : ""}` : "";
        console.log(`  ${i.isStaple ? "[staple]" : "-"} ${i.name}${qty}${exp}`);
      });
      break;
    }
    case "expiring": {
      const days = args.includes("--days") ? parseInt(args[args.indexOf("--days") + 1]) : 3;
      const expiring = await getExpiring(days);
      if (expiring.length === 0) { console.log(`No items expiring within ${days} days.`); break; }
      console.log(`\nExpiring within ${days} days:\n`);
      expiring.forEach(i => console.log(`  ${i.name} -- expires ${i.expiresAt!.split("T")[0]}`));
      notifySync(`${expiring.length} items expiring within ${days} days`);
      break;
    }
    default:
      console.log("Commands: add, remove, list, expiring");
      console.log("Usage: bun Tools/PantryTracker.ts <command> [args]");
  }
}
