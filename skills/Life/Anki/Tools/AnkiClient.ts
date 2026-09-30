#!/usr/bin/env bun
/**
 * AnkiClient.ts — Anki Flashcard Management via apy CLI
 *
 * ISC 601: Prerequisite validation — `which apy` check before any operation.
 *          If not found: "apy not installed. Run: pip install apy"
 *
 * apy reads Anki's SQLite collection directly, so the collection must be
 * UNLOCKED — i.e. the Anki app must be CLOSED — for every operation here.
 * (AnkiConnectClient is the complement: it needs the app OPEN.)
 *
 * Features:
 *   - Prerequisite validation: apy binary lookup (launchd-safe), apy info (collection readable)
 *   - Command wrappers: addCard, listDecks, reviewDue, syncAnki, ensureDeck
 *   - Error handling: all apy calls wrapped with typed results
 *   - Audit log to MEMORY/Life/anki-runs.jsonl
 *   - Voice notification on addCard success
 */

import { join } from "path";
import { existsSync, readFileSync } from "fs";
import { execFileSync, execSync } from "child_process";
import { notifySync } from "../../../../lib/core/NotificationService";
import { createAppendLog, type AppendLog } from "../../../../lib/core/AppendLog.ts";
import { getKayaHome } from "../../../../lib/core/KayaHome.ts";

// ============================================
// TYPES
// ============================================

export interface DeckInfo {
  name: string;
  count: number;
}

export interface ReviewDueResult {
  cardCount: number;
  dueCount: number;
  /** Cards never studied (Anki `is:new`) — NOT included in dueCount. */
  newCount: number;
}

/**
 * apy list-cards prints one multi-line block per card ("# Card (cid: N)" +
 * Front/Back sections), so counting output LINES overcounts by ~8x (verified
 * live: a 3-card deck produced 26 non-empty lines). Count card headers.
 */
function countListedCards(output: string): number {
  return (stripAnsi(output).match(/^#\s+Card\s+\(cid:/gim) ?? []).length;
}

export interface AddCardResult {
  success: boolean;
  exitCode?: number;
  stderr?: string;
  suggestion?: string;
  deck?: string;
  /**
   * Always undefined for apy add-single — it prints no note id ("Database was
   * modified." only, verified live). Callers needing nids must post-resolve
   * via `apy list-notes "tag:..."` after adding.
   */
  cardId?: string;
}

export interface PrerequisiteResult {
  prerequisitesMet: boolean;
  apyPath?: string;
  /**
   * True means the collection was READABLE (lock free — Anki app closed or
   * idle), NOT that the Anki app is running. apy fails when Anki is open and
   * holding the collection lock, so this is in practice the inverse of
   * "Anki is running".
   *
   * Renamed from `ankiRunning` on 2026-07-25: that name reported the opposite
   * of what it measured, and `validate` prints this field as JSON, so anyone
   * reading the CLI output got the inverse of reality. No consumer read the
   * old field (all callers branch on `prerequisitesMet`), so this is a clean
   * rename rather than a deprecation.
   */
  collectionReadable?: boolean;
  error?: string;
}

export interface EnsureDeckResult {
  success: boolean;
  /** True when the deck was created by this call; false when it already existed. */
  created?: boolean;
  error?: string;
}

export interface ListedNote {
  /** apy's note id (nid). */
  nid: string;
  /** Front-field text, trimmed. */
  front: string;
}

export interface AnkiClientOptions {
  /** Override the apy binary path for testing */
  apyBin?: string;
  /** Kaya home directory override */
  kayaHome?: string;
}

interface AuditEntry {
  timestamp: string;
  operation: string;
  deck?: string;
  durationMs: number;
  success: boolean;
  cardCount?: number;
  error?: string;
}

// ============================================
// AUDIT LOG
// ============================================

// kayaHome varies per AnkiClient instance (production vs. test overrides), so the
// resolved audit path isn't a single module-level constant — cache one AppendLog
// instance per resolved path (reuse per path, per the AppendLog seam contract).
const auditLogsByPath = new Map<string, AppendLog>();

/**
 * Output cap for the `apy list-*` calls, which are the only ones whose size
 * scales with collection size.
 *
 * execFileSync defaults maxBuffer to 1 MiB and throws ENOBUFS past it. On
 * 2026-07-25 the live collection (2,117 cards) made `apy list-cards ""` emit
 * 1,302,868 bytes, so `reviewDue()` with no deck threw and exited 1 — a real
 * break that went unnoticed because the criterion covering it (ISC 11 of the
 * anki-deck-review spec) was never implemented. `Data Science` alone was
 * already 587,901 bytes, so per-deck calls had thin headroom too.
 *
 * 64 MiB is ~50x the observed collection-wide output; a collection large
 * enough to exceed it has bigger problems than this call.
 */
const APY_LIST_MAX_BUFFER = 64 * 1024 * 1024;

/**
 * Env for every apy subprocess. apy is built on rich, which honors
 * FORCE_COLOR over piped-stdout detection — Claude Code sessions export
 * FORCE_COLOR=3, so apy output captured via execFileSync arrived wrapped in
 * ANSI escapes and every parser here (countListedCards' `^# Card` match,
 * parseDecksFromInfo, listNotes) silently saw 0 matches (verified live
 * 2026-08-24: `deck:Cooking is:due` counted 0 with colors, correct plain).
 * NO_COLOR wins over FORCE_COLOR in rich, and stripping FORCE_COLOR too is
 * belt-and-braces.
 */
function apyEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, NO_COLOR: "1" };
  delete env.FORCE_COLOR;
  delete env.CLICOLOR_FORCE;
  return env;
}

/** Strip ANSI SGR/escape sequences — second line of defense for any color
 *  output that survives apyEnv() (e.g. a future apy that force-styles). */
function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\u001b\[[0-9;]*[A-Za-z]/g, "");
}

function getAuditLog(auditPath: string): AppendLog {
  let log = auditLogsByPath.get(auditPath);
  if (!log) {
    log = createAppendLog(auditPath);
    auditLogsByPath.set(auditPath, log);
  }
  return log;
}

function appendAuditEntry(kayaHome: string, entry: AuditEntry): void {
  const auditDir = join(kayaHome, "MEMORY", "Life");
  const auditPath = join(auditDir, "anki-runs.jsonl");
  try {
    getAuditLog(auditPath).append(entry);
  } catch {
    // Audit failures must not break operations
  }
}

/**
 * Pure parser for `apy list-notes <query>` output. Block format (verified
 * live):
 *
 *   # Note (nid: 1784221593839)
 *
 *   ## Front
 *   <front text>
 *
 *   ## Back
 *   <back text>
 *
 * apy emits `## Front (markdown)` instead of `## Front` when the note's
 * front field contains Markdown — both headings are recognized. Exported
 * standalone (no apy call inside) so it's unit-testable without a live
 * collection.
 */
export function parseListNotesOutput(output: string): ListedNote[] {
  const notes: ListedNote[] = [];
  const lines = output.split("\n");

  let currentNid: string | null = null;
  let inFront = false;
  let frontLines: string[] = [];

  const flush = () => {
    if (currentNid !== null) {
      const front = frontLines.join("\n").trim();
      if (front.length > 0) notes.push({ nid: currentNid, front });
    }
    frontLines = [];
  };

  for (const line of lines) {
    const noteMatch = line.match(/^#\s+Note\s+\(nid:\s*(\d+)\)/i);
    if (noteMatch) {
      // A new note header always closes out whatever front section (if any)
      // belonged to the PREVIOUS note.
      flush();
      currentNid = noteMatch[1];
      inFront = false;
      continue;
    }

    if (/^##\s+Front(?:\s*\(markdown\))?\s*$/i.test(line)) {
      inFront = true;
      frontLines = [];
      continue;
    }

    // Any other heading (## Back, etc.) ends the front section for this note.
    if (inFront && /^##\s+/.test(line)) {
      inFront = false;
      continue;
    }

    if (inFront) {
      frontLines.push(line);
    }
  }
  flush(); // last note in the output never hits another "# Note" header

  return notes;
}

// ============================================
// ANKI CLIENT
// ============================================

export class AnkiClient {
  private readonly apyBin: string;
  private readonly kayaHome: string;
  private apyValidated = false;
  private readonly ensuredDecks = new Set<string>();

  constructor(options: AnkiClientOptions = {}) {
    this.kayaHome = options.kayaHome ?? getKayaHome();

    if (options.apyBin !== undefined) {
      this.apyBin = options.apyBin;
    } else {
      this.apyBin = this.resolveApyBin();
    }
  }

  private resolveApyBin(): string {
    try {
      const path = execSync("which apy", { encoding: "utf-8", timeout: 5000 }).trim();
      if (path) return path;
    } catch {
      // fall through to known locations
    }

    // launchd/cron PATH omits the install location (e.g. /opt/miniconda3/bin),
    // so a bare `which` failing does not mean apy is absent — this fallback is
    // what lets every scheduled caller work without per-plist PATH edits.
    const home = process.env.HOME ?? "";
    const knownLocations = [
      "/opt/miniconda3/bin/apy",
      join(home, ".local", "bin", "apy"),
      "/opt/homebrew/bin/apy",
      "/usr/local/bin/apy",
    ];
    for (const candidate of knownLocations) {
      if (existsSync(candidate)) return candidate;
    }

    try {
      const path = execSync('bash -lc "command -v apy"', {
        encoding: "utf-8",
        timeout: 10000,
      }).trim();
      if (path) return path;
    } catch {
      // genuinely not installed
    }
    return "";
  }

  /**
   * The interpreter that owns the apyanki package — taken from apy's own
   * shebang so it always matches the installed environment.
   */
  resolvePythonBin(): string {
    try {
      const firstLine = readFileSync(this.apyBin, "utf-8").split("\n", 1)[0] ?? "";
      if (firstLine.startsWith("#!")) {
        const parts = firstLine.slice(2).trim().split(/\s+/);
        const bin = parts[0].endsWith("/env") && parts[1] ? parts[1] : parts[0];
        if (bin) return bin;
      }
    } catch {
      // fall through
    }
    return "python3";
  }

  /**
   * Validate prerequisites before running any apy commands.
   * - Checks that apy binary exists and is executable
   * - Checks the collection is READABLE via `apy info`. apy reads the SQLite
   *   collection directly, which Anki locks while the app is open — so success
   *   means the lock is free (Anki closed), and failure usually means the app
   *   is open, NOT that it needs to be started.
   * @throws Error if apy is not installed (contains "pip install apy" hint)
   */
  async validatePrerequisites(): Promise<PrerequisiteResult> {
    const start = Date.now();

    // Step 1: Check apy is installed
    if (!this.apyBin || !existsSync(this.apyBin)) {
      const error = "apy not installed. Run: pip install apy";
      appendAuditEntry(this.kayaHome, {
        timestamp: new Date().toISOString(),
        operation: "validatePrerequisites",
        durationMs: Date.now() - start,
        success: false,
        error,
      });
      throw new Error(error);
    }

    // Step 2: Check the collection is readable via `apy info` with 5s timeout
    try {
      execFileSync(this.apyBin, ["info"], { encoding: "utf-8", timeout: 5000, env: apyEnv() });
      this.apyValidated = true;
    } catch (err) {
      const errorMsg = String(err);
      const hint = /lock/i.test(errorMsg)
        ? "Anki must be closed for apy to read the collection — quit Anki and try again."
        : "apy could not read the Anki collection. If Anki is open, quit it and try again.";
      appendAuditEntry(this.kayaHome, {
        timestamp: new Date().toISOString(),
        operation: "validatePrerequisites",
        durationMs: Date.now() - start,
        success: false,
        error: hint,
      });
      return {
        prerequisitesMet: false,
        apyPath: this.apyBin,
        collectionReadable: false,
        error: `${hint} (${errorMsg})`,
      };
    }

    return {
      prerequisitesMet: true,
      apyPath: this.apyBin,
      collectionReadable: true,
    };
  }

  private async ensurePrerequisites(): Promise<void> {
    if (!this.apyValidated) {
      await this.validatePrerequisites();
    }
  }

  async listDecks(): Promise<DeckInfo[]> {
    const start = Date.now();
    await this.ensurePrerequisites();

    try {
      const output = execFileSync(this.apyBin, ["info"], { encoding: "utf-8", timeout: 10000, env: apyEnv() });
      const decks = this.parseDecksFromInfo(stripAnsi(output));
      appendAuditEntry(this.kayaHome, {
        timestamp: new Date().toISOString(),
        operation: "listDecks",
        durationMs: Date.now() - start,
        success: true,
        cardCount: decks.reduce((sum, d) => sum + d.count, 0),
      });
      return decks;
    } catch (err) {
      const errorMsg = String(err);
      appendAuditEntry(this.kayaHome, {
        timestamp: new Date().toISOString(),
        operation: "listDecks",
        durationMs: Date.now() - start,
        success: false,
        error: errorMsg,
      });
      throw new Error(`listDecks failed: ${errorMsg}`);
    }
  }

  private parseDecksFromInfo(output: string): DeckInfo[] {
    const decks: DeckInfo[] = [];
    const lines = output.split("\n");
    for (const line of lines) {
      const match = line.match(/^\s*(.+?)[\s:]+(\d+)\s*$/);
      if (match) {
        const name = match[1].trim();
        const count = parseInt(match[2], 10);
        if (name && !isNaN(count) && name !== "Total") {
          decks.push({ name, count });
        }
      }
    }
    return decks;
  }

  /**
   * Create a deck if it doesn't exist. Decks do NOT auto-create — apy's
   * add-single raises KeyError for unknown decks and its CLI has no
   * non-interactive deck creation — so this shells a one-liner through the
   * apyanki library apy itself is built on. Known coupling: relies on
   * apyanki's Anki wrapper + `col.decks.id(name, create=True)` internals.
   * Memoized per-process; requires the collection unlocked (Anki closed).
   */
  async ensureDeck(deck: string): Promise<EnsureDeckResult> {
    if (this.ensuredDecks.has(deck)) {
      return { success: true, created: false };
    }
    const start = Date.now();

    try {
      await this.ensurePrerequisites();
      // Anki(**cfg) mirrors apy's own CLI construction — cfg resolves the
      // collection base path the same way every apy subcommand does.
      const script = [
        "import sys",
        "from apyanki.anki import Anki",
        "from apyanki.config import cfg",
        "deck = sys.argv[1]",
        "with Anki(**cfg) as a:",
        "    if deck in a.deck_name_to_id:",
        "        print('exists')",
        "    else:",
        "        a.col.decks.id(deck, create=True)",
        "        print('created')",
      ].join("\n");
      const output = execFileSync(this.resolvePythonBin(), ["-c", script, deck], {
        encoding: "utf-8",
        timeout: 15000,
      });
      const created = output.includes("created");
      this.ensuredDecks.add(deck);
      appendAuditEntry(this.kayaHome, {
        timestamp: new Date().toISOString(),
        operation: "ensureDeck",
        deck,
        durationMs: Date.now() - start,
        success: true,
      });
      return { success: true, created };
    } catch (err) {
      const error = String(err);
      appendAuditEntry(this.kayaHome, {
        timestamp: new Date().toISOString(),
        operation: "ensureDeck",
        deck,
        durationMs: Date.now() - start,
        success: false,
        error,
      });
      return { success: false, error };
    }
  }

  async addCard(deck: string, front: string, back: string, tags?: string[]): Promise<AddCardResult> {
    const start = Date.now();

    try {
      await this.ensurePrerequisites();
    } catch (err) {
      return {
        success: false,
        suggestion: String(err),
        stderr: String(err),
      };
    }

    const args = ["add-single", "-d", deck];
    if (tags && tags.length > 0) {
      args.push("-t", tags.join(" "));
    }
    args.push(front, back);

    try {
      const output = execFileSync(this.apyBin, args, { encoding: "utf-8", timeout: 15000, env: apyEnv() });
      appendAuditEntry(this.kayaHome, {
        timestamp: new Date().toISOString(),
        operation: "addCard",
        deck,
        durationMs: Date.now() - start,
        success: true,
      });

      this.notifyCardAdded(deck);

      return {
        success: true,
        deck,
        cardId: this.extractCardId(output),
      };
    } catch (err: unknown) {
      const spawnError = err as { status?: number; stderr?: string | Buffer };
      const exitCode = spawnError.status ?? -1;
      const stderr = String(spawnError.stderr ?? err);
      const suggestion = this.suggestForExitCode(exitCode, stderr);

      appendAuditEntry(this.kayaHome, {
        timestamp: new Date().toISOString(),
        operation: "addCard",
        deck,
        durationMs: Date.now() - start,
        success: false,
        error: stderr,
      });

      return {
        success: false,
        exitCode,
        stderr,
        suggestion,
        deck,
      };
    }
  }

  async reviewDue(deck?: string): Promise<ReviewDueResult> {
    const start = Date.now();
    await this.ensurePrerequisites();

    // Deck names with spaces (e.g. Learning::Information Ecosystems) must be
    // inner-quoted or Anki's search parser splits them into separate terms
    // and silently returns nothing (verified live).
    const deckTerm = deck ? `deck:"${deck}"` : "";
    const listCount = (query: string): number => {
      const output = execFileSync(this.apyBin, ["list-cards", query], {
        encoding: "utf-8",
        timeout: 10000,
        maxBuffer: APY_LIST_MAX_BUFFER,
        env: apyEnv(),
      });
      return countListedCards(output);
    };

    try {
      const dueCount = listCount(deck ? `${deckTerm} is:due` : "is:due");
      const newCount = listCount(deck ? `${deckTerm} is:new` : "is:new");
      const cardCount = listCount(deckTerm);

      appendAuditEntry(this.kayaHome, {
        timestamp: new Date().toISOString(),
        operation: "reviewDue",
        deck,
        durationMs: Date.now() - start,
        success: true,
        cardCount,
      });

      return { cardCount, dueCount, newCount };
    } catch (err) {
      appendAuditEntry(this.kayaHome, {
        timestamp: new Date().toISOString(),
        operation: "reviewDue",
        deck,
        durationMs: Date.now() - start,
        success: false,
        error: String(err),
      });
      throw new Error(`reviewDue failed: ${err}`);
    }
  }

  /**
   * Count of cards answered within the last `days` days (Anki search
   * `rated:N`), optionally scoped to a deck. The apy (Anki-closed) leg of the
   * knowledge-track review-activity signal — doing your due cards IS the
   * review (see Aggregation/SkillMastery.ts's sweepReviewDue).
   */
  async reviewedInLastDay(deck?: string, days = 1): Promise<{ count: number }> {
    const start = Date.now();
    await this.ensurePrerequisites();
    const deckTerm = deck ? `deck:"${deck}" ` : "";
    try {
      const output = execFileSync(this.apyBin, ["list-cards", `${deckTerm}rated:${days}`], {
        encoding: "utf-8",
        timeout: 10000,
        maxBuffer: APY_LIST_MAX_BUFFER,
        env: apyEnv(),
      });
      const count = countListedCards(output);
      appendAuditEntry(this.kayaHome, {
        timestamp: new Date().toISOString(),
        operation: "reviewedInLastDay",
        deck,
        durationMs: Date.now() - start,
        success: true,
        cardCount: count,
      });
      return { count };
    } catch (err) {
      appendAuditEntry(this.kayaHome, {
        timestamp: new Date().toISOString(),
        operation: "reviewedInLastDay",
        deck,
        durationMs: Date.now() - start,
        success: false,
        error: String(err),
      });
      throw new Error(`reviewedInLastDay failed: ${err}`);
    }
  }

  /**
   * List notes matching an apy search query (e.g. `tag:kaya-auto`) and
   * parse out {nid, front} pairs. Used to post-resolve note ids after
   * add-single, which prints none (see AddCardResult.cardId's docblock).
   */
  async listNotes(query: string): Promise<ListedNote[]> {
    const start = Date.now();
    await this.ensurePrerequisites();

    try {
      const output = execFileSync(this.apyBin, ["list-notes", query], {
        encoding: "utf-8",
        timeout: 10000,
        maxBuffer: APY_LIST_MAX_BUFFER,
        env: apyEnv(),
      });
      const notes = parseListNotesOutput(stripAnsi(output));
      appendAuditEntry(this.kayaHome, {
        timestamp: new Date().toISOString(),
        operation: "listNotes",
        durationMs: Date.now() - start,
        success: true,
        cardCount: notes.length,
      });
      return notes;
    } catch (err) {
      const errorMsg = String(err);
      appendAuditEntry(this.kayaHome, {
        timestamp: new Date().toISOString(),
        operation: "listNotes",
        durationMs: Date.now() - start,
        success: false,
        error: errorMsg,
      });
      throw new Error(`listNotes failed: ${errorMsg}`);
    }
  }

  async syncAnki(): Promise<{ success: boolean; message: string }> {
    const start = Date.now();
    await this.ensurePrerequisites();

    try {
      execFileSync(this.apyBin, ["sync"], { encoding: "utf-8", timeout: 60000, env: apyEnv() });
      appendAuditEntry(this.kayaHome, {
        timestamp: new Date().toISOString(),
        operation: "syncAnki",
        durationMs: Date.now() - start,
        success: true,
      });
      return { success: true, message: "AnkiWeb sync completed" };
    } catch (err) {
      appendAuditEntry(this.kayaHome, {
        timestamp: new Date().toISOString(),
        operation: "syncAnki",
        durationMs: Date.now() - start,
        success: false,
        error: String(err),
      });
      return {
        success: false,
        message: `Sync failed: ${err}. Try running sync manually from Anki.`,
      };
    }
  }

  private extractCardId(output: string): string | undefined {
    // apy prints "* nid: 1784221593839 (with 1 cards)" after a successful add
    const nidMatch = output.match(/nid:\s*(\d+)/i);
    if (nidMatch) return nidMatch[1];
    const match = output.match(/note\s+(\d+)/i);
    return match ? match[1] : undefined;
  }

  private suggestForExitCode(exitCode: number, stderr: string): string {
    if ((stderr.includes("deck") && stderr.includes("not found")) || stderr.includes("KeyError")) {
      return "Deck not found — decks do NOT auto-create. Call ensureDeck() first or create it in Anki.";
    }
    if (/lock/i.test(stderr)) {
      return "Collection is locked — quit Anki (apy needs the app closed), then try again.";
    }
    if (exitCode === 127) {
      return "apy not found. Install it with: pip install apy";
    }
    return `Command failed with exit code ${exitCode}. Check the deck name, and that Anki is closed (apy needs the collection unlocked).`;
  }

  private notifyCardAdded(deck: string): void {
    // Best-effort voice notification
    try {
      notifySync(`Card added to ${deck}`);
    } catch {
      // Notification failure must not break card addition
    }
  }
}

// ============================================
// CLI INTERFACE
// ============================================

if (import.meta.main) {
  const args = process.argv.slice(2);
  const command = args[0];

  const client = new AnkiClient();

  switch (command) {
    case "validate": {
      const result = await client.validatePrerequisites();
      console.log(JSON.stringify(result, null, 2));
      if (!result.prerequisitesMet) process.exit(1);
      break;
    }
    case "decks": {
      const decks = await client.listDecks();
      console.log(JSON.stringify(decks, null, 2));
      break;
    }
    case "add": {
      const [, deck, front, back, ...tags] = args;
      if (!deck || !front || !back) {
        console.error("Usage: bun AnkiClient.ts add <deck> <front> <back> [tags...]");
        process.exit(1);
      }
      const result = await client.addCard(deck, front, back, tags.length > 0 ? tags : undefined);
      console.log(JSON.stringify(result, null, 2));
      if (!result.success) process.exit(1);
      break;
    }
    case "due": {
      const deck = args[1];
      const result = await client.reviewDue(deck);
      console.log(JSON.stringify(result, null, 2));
      break;
    }
    case "list-notes": {
      const query = args[1];
      if (!query) {
        console.error("Usage: bun AnkiClient.ts list-notes <query>");
        process.exit(1);
      }
      const notes = await client.listNotes(query);
      console.log(JSON.stringify(notes, null, 2));
      break;
    }
    case "sync": {
      const result = await client.syncAnki();
      console.log(result.message);
      if (!result.success) process.exit(1);
      break;
    }
    case "ensure-deck": {
      const deck = args[1];
      if (!deck) {
        console.error("Usage: bun AnkiClient.ts ensure-deck <deck>");
        process.exit(1);
      }
      const result = await client.ensureDeck(deck);
      console.log(JSON.stringify(result, null, 2));
      if (!result.success) process.exit(1);
      break;
    }
    default:
      console.error("Usage: bun AnkiClient.ts <validate|decks|add|due|sync|ensure-deck|list-notes>");
      process.exit(1);
  }
}
