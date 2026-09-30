#!/usr/bin/env bun
/**
 * DanceMoves.ts — "Moves Learned" section for the hip hop and salsa/bachata decks.
 *
 * Each dance move is a "Kaya Dance Move" note (move name → dance it → breakdown
 * + video link) in `Learning::Hip Hop Dance::Moves Learned` or
 * `Learning::Salsa & Bachata::Moves Learned`.
 *
 * The catalogue (../Data/dance-moves.json) is synced in as SUSPENDED cards, so
 * the section exists with videos attached but costs no review time. `learn`
 * unsuspends a move once Jm has actually learned it in class, stamps where and
 * when, and makes it due tomorrow (the curriculum's ≥24 h retention check).
 * `add` covers moves from class that aren't in the catalogue.
 *
 * Anki desktop must be CLOSED (the collection is locked while it runs), or pass
 * --quit-anki to quit it and reopen it afterwards.
 */

import { join } from "path";
import { readFileSync } from "fs";
import { execFileSync, spawnSync } from "child_process";
import { AnkiClient } from "./AnkiClient.ts";

// ============================================
// TYPES
// ============================================

export type Subject = "Hip Hop Dance" | "Salsa & Bachata";

export interface DanceMove {
  key: string;
  subject: Subject;
  dance: string;
  block: string;
  move: string;
  breakdown: string;
  video?: string;
  videoTitle?: string;
}

interface Catalogue {
  moves: DanceMove[];
}

export interface BridgeResult {
  ok: boolean;
  error?: string;
  [key: string]: unknown;
}

// ============================================
// PURE HELPERS (tested)
// ============================================

export const CATALOGUE_PATH = join(import.meta.dir, "..", "Data", "dance-moves.json");
const BRIDGE_PATH = join(import.meta.dir, "dance_moves_anki.py");

const SUBJECT_ALIASES: Record<string, Subject> = {
  hiphop: "Hip Hop Dance",
  "hip-hop": "Hip Hop Dance",
  hh: "Hip Hop Dance",
  popping: "Hip Hop Dance",
  shuffle: "Hip Hop Dance",
  salsa: "Salsa & Bachata",
  bachata: "Salsa & Bachata",
  sb: "Salsa & Bachata",
};

export function parseSubject(raw: string | undefined): Subject | undefined {
  return raw ? SUBJECT_ALIASES[raw.toLowerCase()] : undefined;
}

export function loadCatalogue(path: string = CATALOGUE_PATH): DanceMove[] {
  const parsed = JSON.parse(readFileSync(path, "utf-8")) as Catalogue;
  validateCatalogue(parsed.moves);
  return parsed.moves;
}

export function validateCatalogue(moves: DanceMove[]): void {
  const seen = new Set<string>();
  for (const m of moves) {
    if (!m.key || !m.move || !m.breakdown) throw new Error(`Catalogue entry missing key/move/breakdown: ${JSON.stringify(m)}`);
    if (seen.has(m.key)) throw new Error(`Duplicate catalogue key: ${m.key}`);
    seen.add(m.key);
    if (m.subject !== "Hip Hop Dance" && m.subject !== "Salsa & Bachata") {
      throw new Error(`${m.key}: subject must be "Hip Hop Dance" or "Salsa & Bachata"`);
    }
    if (m.video && !/^https:\/\//.test(m.video)) throw new Error(`${m.key}: video must be an https URL`);
  }
}

export function slugify(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

/**
 * Resolve a key or a (partial) move name to one catalogue move. An exact key
 * wins; otherwise a case-insensitive match on the name — exact name first,
 * then substring. Keys not in the catalogue (e.g. `custom-…` moves made with
 * `add`) return undefined so the caller can pass them straight through.
 */
export function resolveMove(query: string, moves: DanceMove[]): DanceMove | undefined {
  const byKey = moves.find((m) => m.key === query);
  if (byKey) return byKey;
  const q = query.toLowerCase().trim();
  const exact = moves.filter((m) => m.move.toLowerCase() === q);
  if (exact.length === 1) return exact[0];
  const partial = moves.filter((m) => m.move.toLowerCase().includes(q) || m.key.includes(slugify(q)));
  if (partial.length === 1) return partial[0];
  if (partial.length > 1) {
    throw new Error(`"${query}" matches several moves:\n${partial.map((m) => `  ${m.key}  ${m.move}`).join("\n")}`);
  }
  return undefined;
}

export function localDate(d: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function learnedStamp(date: string, where?: string): string {
  return where ? `${date} · ${where}` : date;
}

export interface ParsedArgs {
  positional: string[];
  flags: Record<string, string | true>;
}

export function parseArgs(argv: string[]): ParsedArgs {
  const positional: string[] = [];
  const flags: Record<string, string | true> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) {
      positional.push(a);
      continue;
    }
    const eq = a.indexOf("=");
    if (eq > 0) {
      flags[a.slice(2, eq)] = a.slice(eq + 1);
    } else if (i + 1 < argv.length && !argv[i + 1].startsWith("--")) {
      flags[a.slice(2)] = argv[++i];
    } else {
      flags[a.slice(2)] = true;
    }
  }
  return { positional, flags };
}

function str(flag: string | true | undefined): string | undefined {
  return typeof flag === "string" ? flag : undefined;
}

// ============================================
// ANKI BRIDGE
// ============================================

function ankiRunning(): boolean {
  // The desktop app is python running aqt.run(); `pgrep -x Anki` misses it.
  return spawnSync("pgrep", ["-f", "aqt"], { encoding: "utf-8" }).status === 0;
}

function quitAnki(): void {
  spawnSync("osascript", ["-e", 'tell application "Anki" to quit'], { encoding: "utf-8", timeout: 15000 });
  for (let i = 0; i < 20 && ankiRunning(); i++) spawnSync("sleep", ["0.5"]);
  if (ankiRunning()) spawnSync("pkill", ["-f", "aqt.run"]);
  for (let i = 0; i < 10 && ankiRunning(); i++) spawnSync("sleep", ["0.5"]);
}

export function runBridge(request: Record<string, unknown>, pythonBin?: string): BridgeResult {
  const python = pythonBin ?? new AnkiClient().resolvePythonBin();
  let stdout: string;
  try {
    stdout = execFileSync(python, [BRIDGE_PATH], {
      input: JSON.stringify(request),
      encoding: "utf-8",
      timeout: 120000,
      env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "" },
    });
  } catch (err) {
    const out = (err as { stdout?: string }).stdout ?? "";
    const last = out.trim().split("\n").pop() ?? "";
    try {
      return JSON.parse(last) as BridgeResult;
    } catch {
      return { ok: false, error: String(err) };
    }
  }
  return JSON.parse(stdout.trim().split("\n").pop() ?? "{}") as BridgeResult;
}

// ============================================
// CLI
// ============================================

const USAGE = `Usage: bun DanceMoves.ts <command>

  catalogue [hiphop|salsa]            Moves in the catalogue (no Anki access)
  sync                                Put every catalogue move in Anki (suspended until learned)
  learn <key|name> [--where "Mon CM class"] [--date YYYY-MM-DD] [--clip URL] [--video URL] [--due N | --no-due]
                                      Mark a move learned: unsuspend it, due in N days (default 1)
  add <hiphop|salsa> "<Move name>" --video URL [--dance Bachata] [--breakdown "..."] [--where ...] [--clip URL]
                                      Log a move from class that isn't in the catalogue
  unlearn <key|name>                  Suspend it again
  list [hiphop|salsa] [--learned]     What's in Anki, and what's learned

Common: --collection PATH (default: apy's collection) · --quit-anki (quit Anki, run, reopen)`;

async function main(): Promise<number> {
  const [command, ...rest] = process.argv.slice(2);
  const { positional, flags } = parseArgs(rest);
  const moves = loadCatalogue();

  if (!command || command === "help" || flags.help) {
    console.log(USAGE);
    return command ? 0 : 1;
  }

  if (command === "catalogue") {
    const subject = parseSubject(positional[0]);
    for (const m of moves.filter((x) => !subject || x.subject === subject)) {
      console.log(`${m.key.padEnd(34)} ${m.block.padEnd(4)} ${m.move}${m.video ? "" : "  (no video)"}`);
    }
    return 0;
  }

  const collection = str(flags.collection) ?? null;
  let reopen = false;
  if (!collection && ankiRunning()) {
    if (!flags["quit-anki"]) {
      console.error("Anki is open and holds the collection lock. Quit Anki first, or re-run with --quit-anki.");
      return 2;
    }
    quitAnki();
    reopen = true;
  }

  let result: BridgeResult;
  try {
    switch (command) {
      case "sync":
        result = runBridge({ op: "sync", collection, moves });
        break;

      case "learn":
      case "unlearn": {
        const query = positional.join(" ");
        if (!query) {
          console.error(USAGE);
          return 1;
        }
        const key = resolveMove(query, moves)?.key ?? query;
        if (command === "unlearn") {
          result = runBridge({ op: "unlearn", collection, key });
          break;
        }
        const video = str(flags.video);
        result = runBridge({
          op: "learn",
          collection,
          key,
          learned: learnedStamp(str(flags.date) ?? localDate(), str(flags.where)),
          clip: str(flags.clip),
          video,
          videoTitle: video ? "" : undefined,
          dueDays: flags["no-due"] ? null : Number(str(flags.due) ?? 1),
        });
        break;
      }

      case "add": {
        const subject = parseSubject(positional[0]);
        const name = positional.slice(1).join(" ");
        if (!subject || !name) {
          console.error(USAGE);
          return 1;
        }
        const video = str(flags.video) ?? "";
        const move: DanceMove = {
          key: `custom-${slugify(name)}`,
          subject,
          dance: str(flags.dance) ?? (subject === "Hip Hop Dance" ? "Hip hop" : "Salsa"),
          block: str(flags.block) ?? "",
          move: name,
          breakdown: str(flags.breakdown) ?? "",
          video,
        };
        validateCatalogue([{ ...move, breakdown: move.breakdown || "-" }]);
        result = runBridge({
          op: "add",
          collection,
          move,
          learned: learnedStamp(str(flags.date) ?? localDate(), str(flags.where)),
          clip: str(flags.clip),
          dueDays: flags["no-due"] ? null : Number(str(flags.due) ?? 1),
        });
        break;
      }

      case "list": {
        result = runBridge({ op: "list", collection });
        if (result.ok) {
          const subject = parseSubject(positional[0]);
          const notes = (result.notes as Array<Record<string, string | boolean>>).filter(
            (n) =>
              (!subject || String(n.deck).includes(subject)) && (!flags.learned || Boolean(n.learned)),
          );
          for (const n of notes) {
            const status = n.learned ? `learned ${n.learned}` : "not yet (suspended)";
            console.log(`${String(n.key).padEnd(34)} ${String(n.move).padEnd(40)} ${status}`);
          }
          console.log(`\n${notes.filter((n) => n.learned).length} learned / ${notes.length} shown`);
          return 0;
        }
        break;
      }

      default:
        console.error(USAGE);
        return 1;
    }
  } finally {
    if (reopen) spawnSync("open", ["-a", "Anki"]);
  }

  console.log(JSON.stringify(result, null, 2));
  return result.ok ? 0 : 1;
}

if (import.meta.main) {
  main().then((code) => process.exit(code));
}
