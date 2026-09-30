/**
 * SavedEvents.ts — Jm's "interested" shortlist, persisted to State/saved-events.json.
 *
 * Distinct from the `save` CLI command / Actions.saveToIdeas (which EXPORTS an
 * event to the LifeOS activity_ideas sheet): this store is EventScout-local
 * state backing the UI's star toggle + "Saved" filter and the `saved` CLI
 * subcommands. Entries snapshot the full EventItem so a saved pick survives
 * cache regeneration/pruning; readers prefer the fresh cache copy by id when
 * one still exists.
 *
 * Store file location (in priority order):
 *   1. process.env.EVENTSCOUT_SAVED_PATH  — used in tests to scope to /tmp
 *   2. DEFAULT_SAVED_PATH (State/saved-events.json in this skill dir)
 *
 * Exposed API:
 *   readSaved(): SavedEventEntry[]
 *   saveEvent(event: EventItem): { added: boolean }   — idempotent
 *   unsaveEvent(id: string): { removed: boolean }
 *   savedIdSet(): Set<string>
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname } from "path";
import {
  DEFAULT_SAVED_PATH,
  EventItemSchema,
  SavedEventsStoreSchema,
} from "./types.ts";
import type { EventItem, SavedEventEntry, SavedEventsStore } from "./types.ts";

function getSavedPath(): string {
  return process.env["EVENTSCOUT_SAVED_PATH"] ?? DEFAULT_SAVED_PATH;
}

function loadRaw(savedPath: string): SavedEventsStore {
  if (!existsSync(savedPath)) {
    return { saved: [] };
  }
  const raw = readFileSync(savedPath, "utf-8").trim();
  if (raw === "") {
    return { saved: [] };
  }
  const result = SavedEventsStoreSchema.safeParse(JSON.parse(raw));
  if (!result.success) {
    throw new Error(`Saved-events file corrupt: ${result.error.message}`);
  }
  return result.data;
}

function saveRaw(store: SavedEventsStore, savedPath: string): void {
  const dir = dirname(savedPath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  const validated = SavedEventsStoreSchema.parse(store);
  writeFileSync(savedPath, JSON.stringify(validated, null, 2), "utf-8");
}

/** All saved entries, newest-saved first. */
export function readSaved(): SavedEventEntry[] {
  const store = loadRaw(getSavedPath());
  return [...store.saved].sort((a, b) => (a.savedAt < b.savedAt ? 1 : -1));
}

/**
 * Save an event. Idempotent: re-saving an already-saved id refreshes the
 * snapshot (the cache copy may be richer than the one saved last week) but
 * preserves the original savedAt, and reports { added: false }.
 */
export function saveEvent(event: EventItem): { added: boolean } {
  const validated = EventItemSchema.parse(event);
  const savedPath = getSavedPath();
  const store = loadRaw(savedPath);
  const existing = store.saved.find((s) => s.event.id === validated.id);
  if (existing) {
    existing.event = validated;
    saveRaw(store, savedPath);
    return { added: false };
  }
  store.saved.push({ savedAt: new Date().toISOString(), event: validated });
  saveRaw(store, savedPath);
  return { added: true };
}

/** Remove a saved event by id. { removed: false } when it wasn't saved. */
export function unsaveEvent(id: string): { removed: boolean } {
  const savedPath = getSavedPath();
  const store = loadRaw(savedPath);
  const next = store.saved.filter((s) => s.event.id !== id);
  if (next.length === store.saved.length) {
    return { removed: false };
  }
  saveRaw({ saved: next }, savedPath);
  return { removed: true };
}

/** Ids of all saved events (for star-state lookups). */
export function savedIdSet(): Set<string> {
  return new Set(loadRaw(getSavedPath()).saved.map((s) => s.event.id));
}
