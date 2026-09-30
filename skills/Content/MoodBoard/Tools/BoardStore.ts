#!/usr/bin/env bun
/**
 * BoardStore.ts - Board + pin persistence via StateManager
 *
 * Boards live in skills/Content/MoodBoard/Data/boards.json (same in-repo
 * pattern as Designer's room-state.json). Pins are deduped by a deterministic
 * hash of imageUrl, so re-adding the same image is a no-op.
 *
 * Usage:
 *   bun Tools/BoardStore.ts create "Fall Fashion 2026" --theme "earth tones, wide silhouettes" --tags fashion,fall
 *   bun Tools/BoardStore.ts list [--json]
 *   bun Tools/BoardStore.ts show <slug> [--json]
 *   bun Tools/BoardStore.ts add-pin <slug> --file /tmp/candidates.json
 *   bun Tools/BoardStore.ts add-pin <slug> --url <imageUrl> [--title t] [--page url] [--creator c] [--license l] [--note n]
 *   bun Tools/BoardStore.ts note <slug> <pinId> "love this collar"
 *   bun Tools/BoardStore.ts remove-pin <slug> <pinId>
 *   bun Tools/BoardStore.ts delete <slug> --confirm
 *
 * All subcommands accept --state <path> to override the state file (tests).
 *
 * @module MoodBoard/BoardStore
 */

import { createHash } from "crypto";
import { join } from "path";
import { z } from "zod";
import { createStateManager, type StateManager } from "../../../../lib/core/StateManager.ts";
import { getKayaHome } from "../../../../lib/core/KayaHome.ts";
import {
  BoardsStateSchema,
  ImageCandidateSchema,
  defaultBoardsState,
  type Board,
  type BoardsState,
  type ImageCandidate,
  type Pin,
} from "./Types.ts";

// ---------------------------------------------------------------------------
// Store construction
// ---------------------------------------------------------------------------

export function boardsStatePath(): string {
  return join(getKayaHome(), "skills/Content/MoodBoard/Data/boards.json");
}

export type BoardStore = StateManager<BoardsState>;

export function createBoardStore(path: string = boardsStatePath()): BoardStore {
  return createStateManager<BoardsState>({
    path,
    schema: BoardsStateSchema,
    defaults: defaultBoardsState,
    backupOnWrite: true,
    maxBackups: 5,
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function slugify(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || "board";
}

/** Deterministic 12-char pin id from the image URL — the dedupe key. */
export function pinIdFor(imageUrl: string): string {
  return createHash("sha256").update(imageUrl).digest("hex").slice(0, 12);
}

function findBoard(state: BoardsState, slug: string): Board {
  const board = state.boards.find((b) => b.slug === slug);
  if (!board) {
    const known = state.boards.map((b) => b.slug).join(", ") || "(none)";
    throw new Error(`Board "${slug}" not found. Known boards: ${known}`);
  }
  return board;
}

// ---------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------

export async function createBoard(
  store: BoardStore,
  input: { title: string; theme?: string; tags?: string[] }
): Promise<Board> {
  const slug = slugify(input.title);
  const now = new Date().toISOString();
  const board: Board = {
    slug,
    title: input.title,
    theme: input.theme ?? "",
    tags: input.tags ?? [],
    createdAt: now,
    updatedAt: now,
    pins: [],
  };
  await store.update((state) => {
    if (state.boards.some((b) => b.slug === slug)) {
      throw new Error(`Board "${slug}" already exists — use add-pin, or pick a different title.`);
    }
    return { ...state, boards: [...state.boards, board] };
  });
  return board;
}

export async function listBoards(store: BoardStore): Promise<Board[]> {
  return (await store.load()).boards;
}

export async function getBoard(store: BoardStore, slug: string): Promise<Board> {
  return findBoard(await store.load(), slug);
}

export interface AddPinsResult {
  added: Pin[];
  skippedDuplicates: number;
}

export async function addPins(
  store: BoardStore,
  slug: string,
  candidates: ImageCandidate[],
  note?: string
): Promise<AddPinsResult> {
  const parsed = z.array(ImageCandidateSchema).parse(candidates);
  const result: AddPinsResult = { added: [], skippedDuplicates: 0 };
  await store.update((state) => {
    const board = findBoard(state, slug);
    const existing = new Set(board.pins.map((p) => p.id));
    const now = new Date().toISOString();
    for (const c of parsed) {
      const id = pinIdFor(c.imageUrl);
      if (existing.has(id)) {
        result.skippedDuplicates++;
        continue;
      }
      existing.add(id);
      result.added.push({ ...c, id, note, addedAt: now });
    }
    const updated: Board = {
      ...board,
      pins: [...board.pins, ...result.added],
      updatedAt: now,
    };
    return { ...state, boards: state.boards.map((b) => (b.slug === slug ? updated : b)) };
  });
  return result;
}

export async function setPinNote(
  store: BoardStore,
  slug: string,
  pinId: string,
  note: string
): Promise<Pin> {
  let updatedPin: Pin | undefined;
  await store.update((state) => {
    const board = findBoard(state, slug);
    const pin = board.pins.find((p) => p.id === pinId);
    if (!pin) throw new Error(`Pin "${pinId}" not found on board "${slug}".`);
    updatedPin = { ...pin, note };
    const updated: Board = {
      ...board,
      pins: board.pins.map((p) => (p.id === pinId ? updatedPin! : p)),
      updatedAt: new Date().toISOString(),
    };
    return { ...state, boards: state.boards.map((b) => (b.slug === slug ? updated : b)) };
  });
  return updatedPin!;
}

export async function removePin(store: BoardStore, slug: string, pinId: string): Promise<boolean> {
  let removed = false;
  await store.update((state) => {
    const board = findBoard(state, slug);
    const pins = board.pins.filter((p) => p.id !== pinId);
    removed = pins.length !== board.pins.length;
    if (!removed) return state;
    const updated: Board = { ...board, pins, updatedAt: new Date().toISOString() };
    return { ...state, boards: state.boards.map((b) => (b.slug === slug ? updated : b)) };
  });
  return removed;
}

export async function deleteBoard(store: BoardStore, slug: string): Promise<void> {
  await store.update((state) => {
    findBoard(state, slug); // throws if missing
    return { ...state, boards: state.boards.filter((b) => b.slug !== slug) };
  });
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function getFlag(args: string[], name: string): string | undefined {
  const idx = args.indexOf(name);
  return idx >= 0 ? args[idx + 1] : undefined;
}

function summarizeBoard(b: Board): string {
  return `${b.slug} — "${b.title}" · ${b.pins.length} pins · updated ${b.updatedAt.slice(0, 10)}${b.theme ? ` · theme: ${b.theme}` : ""}`;
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const [command] = args;
  const jsonOutput = args.includes("--json");
  const store = createBoardStore(getFlag(args, "--state") ?? boardsStatePath());

  const usage =
    "Usage: bun Tools/BoardStore.ts <create|list|show|add-pin|note|remove-pin|delete> ... (--help for details)";

  try {
    switch (command) {
      case "create": {
        const title = args[1];
        if (!title || title.startsWith("--")) throw new Error('create requires a title: create "Fall Fashion"');
        const tags = getFlag(args, "--tags")?.split(",").map((t) => t.trim()).filter(Boolean);
        const board = await createBoard(store, { title, theme: getFlag(args, "--theme"), tags });
        console.log(jsonOutput ? JSON.stringify(board, null, 2) : `Created board: ${summarizeBoard(board)}`);
        break;
      }
      case "list": {
        const boards = await listBoards(store);
        if (jsonOutput) console.log(JSON.stringify(boards, null, 2));
        else if (boards.length === 0) console.log("No boards yet. Create one with: create \"<title>\"");
        else boards.forEach((b) => console.log(summarizeBoard(b)));
        break;
      }
      case "show": {
        const slug = args[1];
        if (!slug) throw new Error("show requires a board slug");
        const board = await getBoard(store, slug);
        if (jsonOutput) {
          console.log(JSON.stringify(board, null, 2));
        } else {
          console.log(summarizeBoard(board));
          for (const p of board.pins) {
            const meta = [p.source, p.creator, p.license].filter(Boolean).join(" · ");
            console.log(`  [${p.id}] ${p.title || "(untitled)"} — ${meta}${p.note ? `\n         note: ${p.note}` : ""}`);
          }
        }
        break;
      }
      case "add-pin": {
        const slug = args[1];
        if (!slug) throw new Error("add-pin requires a board slug");
        let candidates: ImageCandidate[];
        const file = getFlag(args, "--file");
        const url = getFlag(args, "--url");
        if (file) {
          candidates = z.array(ImageCandidateSchema).parse(JSON.parse(await Bun.file(file).text()));
        } else if (url) {
          candidates = [
            ImageCandidateSchema.parse({
              imageUrl: url,
              pageUrl: getFlag(args, "--page"),
              title: getFlag(args, "--title") ?? "",
              source: "manual",
              creator: getFlag(args, "--creator"),
              license: getFlag(args, "--license"),
            }),
          ];
        } else {
          throw new Error("add-pin requires --file <candidates.json> or --url <imageUrl>");
        }
        const result = await addPins(store, slug, candidates, getFlag(args, "--note"));
        console.log(
          jsonOutput
            ? JSON.stringify(result, null, 2)
            : `Added ${result.added.length} pin(s) to "${slug}" (${result.skippedDuplicates} duplicate(s) skipped)`
        );
        break;
      }
      case "note": {
        const [, slug, pinId, ...rest] = args;
        const note = rest.filter((a, i) => !a.startsWith("--") && rest[i - 1] !== "--state")[0];
        if (!slug || !pinId || !note) throw new Error('note requires: note <slug> <pinId> "<note text>"');
        const pin = await setPinNote(store, slug, pinId, note);
        console.log(`Noted [${pin.id}]: ${note}`);
        break;
      }
      case "remove-pin": {
        const [, slug, pinId] = args;
        if (!slug || !pinId) throw new Error("remove-pin requires: remove-pin <slug> <pinId>");
        const removed = await removePin(store, slug, pinId);
        if (!removed) throw new Error(`Pin "${pinId}" not found on board "${slug}".`);
        console.log(`Removed pin ${pinId} from "${slug}"`);
        break;
      }
      case "delete": {
        const slug = args[1];
        if (!slug) throw new Error("delete requires a board slug");
        if (!args.includes("--confirm")) {
          throw new Error(`Deleting a board is destructive. Re-run with --confirm to delete "${slug}".`);
        }
        await deleteBoard(store, slug);
        console.log(`Deleted board "${slug}"`);
        break;
      }
      default:
        console.log(usage);
        process.exit(command ? 1 : 0);
    }
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}
