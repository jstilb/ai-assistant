#!/usr/bin/env bun
/**
 * Status.ts — status updates of an end-state loop, and the answers to Jm's feedback.
 *
 * The orchestrator posts when something Jm receives changed (a live change), or after 2 h with none. An update
 * answers five questions in the orchestrator's words (where the loop is, what it finished since the last
 * update, what is left, does it move toward the end state, are the end states still aligned) and carries
 * links: `app` (where Jm opens the product; carried forward) and `try` (where Jm tries each change of this
 * update). The tool adds facts read from the board, so each verdict stands next to evidence: proven count
 * and its change, rows that moved, units closed, live changes, stall, gate, the time of the last exam.
 *
 * Files (next to the board, not in git): `status/STATUS.jsonl` (one update per line: the record),
 * `status/out/` (documents for the page).
 *
 * The page (STATUS_PAGE_URL) is a claude.ai artifact with a `db`. Only a Claude session can write it, with
 * the ArtifactData tool, so each writing command prints the exact ArtifactData call to make next.
 * Collections: `updates` (doc id `<project>-<NNNN>`), `feedback` (written by the page), `receipts`
 * (doc id = the feedback doc id). This tool writes `updates` only. A session reads `feedback` and writes
 * `receipts` itself with ArtifactData (Workflows/Orchestrate.md, "Status page"): the `pull` and `inbox`
 * commands were removed on 2026-11-25 (0 page items in 7 days; a save folder of `pull` held a session 8.5 h).
 *
 * Usage: bun Status.ts <command> <board path> [flags]   (see USAGE)
 * Exit:  0 = ok, 1 = refused (nothing written), 2 = bad arguments.
 *
 * Skill: ~/.claude/skills/Automation/EndStateLoop/SKILL.md (section "Status page")
 *
 * @module Status
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { createAppendLog } from "../../../../lib/core/AppendLog.ts";
import { type Board, checkBoard, gateVerdict, localIso, nextRow, parseBoard, type Status as RowStatus, STATUS_ORDER, stall, statusBefore } from "./Board.ts";

/** Kept here for callers of Status.ts; the one definition is in Board.ts (unit-open uses it too). */


export const STATUS_PAGE_URL = process.env.ENDSTATE_STATUS_URL ?? "https://claude.ai/artifact/HYZQ2KKQxtwphAwRGs8kXb";
const SCHEMA = "endstate-status/v1";
const VERDICTS = ["yes", "partly", "no"] as const;
export type Verdict = (typeof VERDICTS)[number];

/** Caps keep the page scannable: a field that does not fit is a field that says too much. Tightened 2026-11-18 after
 * Jm called the first page "crowded, messy": the first real updates had 5 items of about 200 characters each. */
export const LIMITS = { where: 200, item: 140, items: 4, why: 180, answer: 300, label: 40, target: 400, links: 4, numbers: 8, numberPart: 60 } as const;

const LINK_TIMEOUT_MS = 5000;

// ---------------------------------------------------------------- types

export interface Link {
  label: string;
  /** An http(s) URL, or text that Jm copies (a command, a file path). */
  target: string;
  /** "ok" = answered below 400 (401 and 403 count: sign-in pages); "dead" = no answer or another code. */
  check: "ok" | "dead" | "not-a-url" | "not-checked";
  code: number | null;
}
export interface UnitFact {
  id: string;
  row: string;
  kind: string | null;
  result: string;
  moved: boolean | null;
  shipped: string | null;
  /** From the board's `unit-audit` when the unit has one: the fresh reviewer's verdict. Absent in old records. */
  audit?: { result: string; by: string; note: string };
}
/** One driver number of an update (`post --number`): before -> now against a bar. Absent in old records. */
export interface DriverNumber {
  label: string;
  now: string;
  before: string;
  bar: string;
}
export interface RowMove {
  row: string;
  from: RowStatus;
  to: RowStatus;
  dir: "up" | "down" | "same";
  /** The row's end-state sentence, so the page names the goal in words. */
  sentence: string;
}
/** One end-state goal (a board row) as the page shows it. */
export interface GoalFact {
  id: string;
  status: RowStatus;
  sentence: string;
}
/** One live change of a unit, for the driver it served. `words` = what changed for Jm; `where` = the raw shipped text (commit, place). */
export interface ShippedChange {
  unit: string;
  row: string;
  at: string;
  words: string;
  where: string;
  result: string;
}
/** Images that the orchestrator uploaded for a driver: "/_blob/<id>" or https URLs. */
export interface DriverImages {
  before: string[];
  after: string[];
}
/** One key driver of a project (from the newest KEY-DRIVERS-<n>.md) and the live changes on its rows. */
export interface DriverFact {
  id: string;
  name: string;
  rows: string[];
  /** Live changes, newest first (at most SHIPPED_SHOWN). */
  shipped: ShippedChange[];
  /** Optional: from `post --image`. Old records have none. */
  images?: DriverImages;
  shippedTotal: number;
  lastShippedAt: string | null;
}
/** Key drivers and what reached Jm. Absent in updates posted before 2026-11-18 (the page then shows the old facts only). */
export interface DriverSection {
  /** False when the board folder has no KEY-DRIVERS file, or the newest one has no readable driver table: the page says "not written". */
  written: boolean;
  source: string | null;
  items: DriverFact[];
  /** Live changes on rows that belong to no driver (support rows). */
  supportShipped: number;
}
export interface Facts {
  counts: { proven: number; claimed: number; failed: number; untested: number; total: number };
  provenDelta: number | null;
  since: string;
  sinceKind: "last-update" | "24h";
  rowMoves: RowMove[];
  closed: UnitFact[];
  open: { id: string; row: string; builder: string; startedAt: string }[];
  liveChanges: number;
  stall: number;
  gate: "GO" | "RE-PLAN";
  gateLine: string;
  lastExamAt: string | null;
  top: { id: string; sentence: string } | null;
  /** Every row, in board order (the page's goal map). */
  rows: GoalFact[];
  /** Optional: old records have none. */
  drivers?: DriverSection;
}
export interface Answer {
  /** The page's feedback doc id; null for an item that came by another door (a session, Telegram, the Scratch Pad). */
  feedback: string | null;
  ref: string;
  text: string;
  /** For an item from another door: Jm's verbatim words from FEEDBACK.md (cut), so the page shows what is answered. */
  words: string | null;
}
export interface StatusUpdate {
  schema: typeof SCHEMA;
  id: string;
  project: string;
  n: number;
  at: string;
  by: string;
  where: string;
  done: string[];
  left: string[];
  try: Link[];
  app: Link[];
  progress: { verdict: Verdict; why: string };
  aligned: { verdict: Verdict; why: string };
  answers: Answer[];
  /** Optional: from `post --number`. Old records have none. */
  numbers?: DriverNumber[];
  facts: Facts;
}
class CliError extends Error {
  constructor(
    readonly code: 1 | 2,
    message: string,
  ) {
    super(message);
  }
}

const USAGE = `usage: bun Status.ts <command> <board path> [flags]
  facts      print the board facts that a post records now
  post       --by NAME --where TEXT --done TEXT… --left TEXT… --progress yes|partly|no --progress-why TEXT
             --aligned yes|partly|no --aligned-why TEXT [--try "LABEL=URL|command"…] [--app "LABEL=URL|command"…]
             [--answer "F-NNN=TEXT"…] [--number "LABEL|NOW|BEFORE|BAR"…] [--image "D1 before|after=URL"…] [--feedback-file PATH] [--no-check] [--dry-run]
             (--answer takes any ### F-NNN item of FEEDBACK.md or of FEEDBACK-HISTORY.md beside it)
             (repeat --done, --left, --try, --app, --answer, --number once per item; --app is required on a project's
             first update and is carried forward after it)
  show       [--last N] [--json]   the newest updates
caps: where ${LIMITS.where} chars; done/left 1-${LIMITS.items} items of ${LIMITS.item} chars; why ${LIMITS.why}; answer ${LIMITS.answer};
      ${LIMITS.links} links of each kind. env: ENDSTATE_STATUS_URL overrides the page URL.`;

/** What to write in each `post` field (`bun Status.ts post --help`). Moved from Workflows/Orchestrate.md, "Status page". */
const POST_FIELDS = `The fields (the tool refuses longer text: where ${LIMITS.where} characters, 1 to ${LIMITS.items} items of ${LIMITS.item} for done and left, why ${LIMITS.why}, link labels ${LIMITS.label}):
- \`--where\`: the row attacked, the open units, and what waits on what.
- \`--done\`: what changed since the last update: first what Jm receives (a live change and its row), then exams and decisions. Do not repeat the board facts (the page shows them).
- \`--left\`: the next rows in order, and each question to Jm with its default.
- \`--progress\`: \`yes\` only when what Jm receives got better on a key driver since the last update (a live change, seen in before and after images); \`partly\` when work closed but nothing that Jm receives changed; \`no\` when the loop stalled. The why is one sentence with its evidence.
- \`--aligned\`: do the rows still say what Jm's newest words ask? With \`partly\` or \`no\`, name the row, Jm's words and the action (your re-rank or a Setup change; you do not edit rows).
- \`--app\`: where Jm opens the product as a whole, with a short label ("Learn app", "Edition APK"): a URL that he can open, else the exact command or file path. Details such as a build date go in \`--where\`, not in the label. Required in a project's first update; then give it only when it changes (the tool carries it forward).
- \`--try\`: for each live change, where Jm tries it (a deep link to the screen, the lesson or the edition, or the exact command), with a label that says what to look at. If a change has no place to try it, say why in \`--done\`.

- \`--number\`: a driver number that the loop measures, as "LABEL|NOW|BEFORE|BAR" (for example "Cards that pass the read test|18 of 20|11 of 20|18 of 20"). BEFORE and BAR may be empty ("LABEL|NOW||"). Label and now are required. At most ${LIMITS.numbers} numbers; each part at most ${LIMITS.numberPart} characters. The page shows "before -> now (bar X)" under "Moving toward the end state?", so Jm sees measured numbers and not only the loop's words.

Plain words: write no unit, row or exam code and no session name in the text (\`U12\`, \`R4\`, \`E1\`, \`exam-81\`, \`edition-orch-13\`): they mean nothing to Jm. No check does this for you. Commands in \`--try\` and \`--app\` targets may hold them. Name the goal or the change as Jm sees it ("same-story detection", "the coach card").

\`post\` opens each http(s) link once (5 s) and records a dead link, which the page marks red: fix it or say why in the next update. Write about the work only: do not paste Jm's own records (history text, logs, health or money data) into an update.`;

const usage = (problem: string): CliError => new CliError(2, `${problem}\n${USAGE}`);

// ---------------------------------------------------------------- files

/** The board, structure and meaning checked (an invalid board is refused, as in Board.ts). */
export function loadBoard(path: string): Board {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    throw new CliError(1, `refused: cannot read board ${path}: ${err instanceof Error ? err.message : String(err)}`);
  }
  const { board, errors } = parseBoard(raw);
  const all = board === null ? errors : [...errors, ...checkBoard(board).errors];
  if (board === null || all.length > 0) throw new CliError(1, [...all.map((e) => `error: ${e}`), `refused: board invalid; run: bun Board.ts validate ${path}`].join("\n"));
  return board;
}

export function statusDir(boardPath: string): string {
  return join(dirname(resolve(boardPath)), "status");
}

function readJsonl<T>(path: string): T[] {
  if (!existsSync(path)) return [];
  const out: T[] = [];
  readFileSync(path, "utf8")
    .split("\n")
    .forEach((line, i) => {
      if (line.trim() === "") return;
      try {
        out.push(JSON.parse(line) as T);
      } catch {
        throw new CliError(1, `refused: ${path} line ${i + 1} is not JSON; fix or move that line first`);
      }
    });
  return out;
}

export function readUpdates(boardPath: string): StatusUpdate[] {
  return readJsonl<StatusUpdate>(join(statusDir(boardPath), "STATUS.jsonl")).sort((a, b) => a.n - b.n);
}

/** STATUS.jsonl is the record, read whole: the 1 GB cap means no rotation in practice
 * (a line is about 3 to 6 KB). A rotation would hide old updates from readUpdates and restart the numbers. */
function appendRecord(path: string, record: object): void {
  createAppendLog(path, { maxSizeMB: 1024, retentionDays: 3650 }).append(record);
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(tmp, path);
}

// ---------------------------------------------------------------- facts

function counts(board: Board): Facts["counts"] {
  const c = { proven: 0, claimed: 0, failed: 0, untested: 0, total: board.rows.length };
  for (const r of board.rows) c[r.status]++;
  return c;
}

/** The facts of the board now, against the previous update (or the last 24 h when there is none). */
export function boardFacts(board: Board, boardPath: string, prev: StatusUpdate | null, now: Date = new Date(), images: ImageArg[] = []): Facts {
  const since = prev?.at ?? localIso(new Date(now.getTime() - 24 * 3600_000));
  const sinceMs = Date.parse(since);
  const c = counts(board);
  const rowMoves: RowMove[] = [];
  for (const r of board.rows) {
    const from = statusBefore(r, since);
    if (from === r.status) continue;
    const d = STATUS_ORDER[r.status] - STATUS_ORDER[from];
    rowMoves.push({ row: r.id, from, to: r.status, dir: d > 0 ? "up" : d < 0 ? "down" : "same", sentence: cut(oneLine(r.sentence), 240) });
  }
  const closed = board.units
    .filter((u) => u.result !== "open" && u.endedAt !== null && Date.parse(u.endedAt) > sinceMs)
    .sort((a, b) => Date.parse(a.endedAt ?? "") - Date.parse(b.endedAt ?? ""))
    .map((u): UnitFact => ({
      id: u.id,
      row: u.row,
      kind: u.kind,
      result: u.result,
      moved: u.moved,
      shipped: u.shipped,
      ...(u.audit === undefined ? {} : { audit: { result: u.audit.result, by: u.audit.by, note: oneLine(u.audit.note).slice(0, 200) } }),
    }));
  let lastExamAt: string | null = null;
  for (const r of board.rows) {
    for (const m of r.marks) if (m.role === "examiner" && (lastExamAt === null || Date.parse(m.at) > Date.parse(lastExamAt))) lastExamAt = m.at;
  }
  const gate = gateVerdict(board, dirname(resolve(boardPath)));
  const top = nextRow(board);
  return {
    counts: c,
    provenDelta: prev === null ? null : c.proven - prev.facts.counts.proven,
    since,
    sinceKind: prev === null ? "24h" : "last-update",
    rowMoves,
    closed,
    open: board.units.filter((u) => u.result === "open").map((u) => ({ id: u.id, row: u.row, builder: u.builder, startedAt: u.startedAt })),
    liveChanges: closed.filter((u) => u.shipped !== null && u.shipped !== "none").length,
    stall: stall(board),
    gate: gate.go ? "GO" : "RE-PLAN",
    gateLine: gate.line,
    lastExamAt,
    top: top === null ? null : { id: top.id, sentence: top.sentence },
    rows: board.rows.map((r) => ({ id: r.id, status: r.status, sentence: cut(oneLine(r.sentence), 240) })),
    drivers: driverSection(board, dirname(resolve(boardPath)), images),
  };
}

// ---------------------------------------------------------------- key drivers

const SHIPPED_SHOWN = 3;
const IMAGES_SHOWN = 3;
const IMAGE_EXT = /\.(png|jpe?g|webp|gif)$/i;

/** The newest KEY-DRIVERS-<n>.md of a board folder (highest n), or null. */
export function newestKeyDrivers(boardDir: string): string | null {
  if (!existsSync(boardDir)) return null;
  let best: { n: number; file: string } | null = null;
  for (const f of readdirSync(boardDir)) {
    const m = /^KEY-DRIVERS-(\d+)\.md$/.exec(f);
    if (m?.[1] !== undefined && (best === null || Number(m[1]) > best.n)) best = { n: Number(m[1]), file: f };
  }
  return best === null ? null : join(boardDir, best.file);
}

const tableCells = (line: string): string[] => line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());

/** Drivers from the first table whose header has a "Rows" column; a driver row starts with `D<number>`. A row id counts only if the board has it. Null when no driver is found: never a guess. */
export function parseKeyDrivers(text: string, rowIds: ReadonlySet<string>): { id: string; name: string; rows: string[] }[] | null {
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (!line.trim().startsWith("|")) continue;
    const head = tableCells(line);
    const col = head.findIndex((c) => c.replace(/\*/g, "").trim().toLowerCase() === "rows");
    if (col < 0) continue;
    const out: { id: string; name: string; rows: string[] }[] = [];
    for (let j = i + 1; j < lines.length && (lines[j] ?? "").trim().startsWith("|"); j++) {
      const cells = tableCells(lines[j] ?? "");
      const first = (cells[0] ?? "").replace(/\*/g, "").trim();
      const m = /^(D\d+)\s*[:.\-–—]?\s*(.*)$/.exec(first);
      if (m?.[1] === undefined) continue;
      const rows = [...new Set((cells[col] ?? "").match(/\b[A-Z]{1,2}\d+\b/g) ?? [])].filter((r) => rowIds.has(r));
      out.push({ id: m[1], name: cut(oneLine((m[2] ?? "").replace(/\s*\(.*$/, "").replace(/[:.\s]+$/, "")), 80) || m[1], rows });
    }
    if (out.length > 0) return out;
  }
  return null;
}

export interface ImageArg {
  driver: string;
  kind: "before" | "after";
  url: string;
}

/** "D1 before=/_blob/abc" gives an ImageArg. The URL must be a stored asset ("/_blob/…") or https. */
export function parseImage(raw: string): ImageArg {
  const m = /^(D\d+)\s+(before|after)=(.+)$/.exec(raw.trim());
  if (m?.[1] === undefined || m[2] === undefined || m[3] === undefined) throw usage(`--image needs "<driver id> <before|after>=<url>"; got "${raw}"`);
  const url = m[3].trim();
  if (!(url.startsWith("/_blob/") || url.startsWith("https://")) || /\s/.test(url)) throw usage(`--image url must start with "/_blob/" or "https://" and hold no space; got "${url}"`);
  return { driver: m[1], kind: m[2] === "before" ? "before" : "after", url };
}

function imagesOf(images: ImageArg[], driver: string): { images?: DriverImages } {
  const mine = images.filter((i) => i.driver === driver);
  if (mine.length === 0) return {};
  return { images: { before: mine.filter((i) => i.kind === "before").map((i) => i.url), after: mine.filter((i) => i.kind === "after").map((i) => i.url) } };
}

/** What changed for Jm, in words: the H1 of the unit contract after "Unit Uxx:" (its "(row …)" tail cut), else the first sentence of the unit note, else the row sentence. */
export function unitWords(board: Board, u: Board["units"][number]): string {
  try {
    const h1 = /^#\s+(?:Unit\s+\S+?:\s*)?(.+)$/m.exec(readFileSync(u.contract, "utf8"))?.[1];
    const t = oneLine((h1 ?? "").replace(/\s*\((?:row|rows)\b[^)]*\)\s*$/i, ""));
    if (t !== "") return cut(t, 200);
  } catch {
    // no contract file: fall through to the note
  }
  const note = /^(.+?[.!?])(\s|$)/.exec(oneLine(u.note))?.[1] ?? oneLine(u.note);
  if (note !== "") return cut(note, 200);
  return cut(oneLine(board.rows.find((r) => r.id === u.row)?.sentence ?? u.row), 200);
}

/** Image files under a unit folder (depth 4, no node_modules) whose relative path says before or after. Existing files only. */
export function unitImages(unitDir: string): { before: string[]; after: string[] } {
  const found: string[] = [];
  const walk = (dir: string, depth: number): void => {
    let names: string[];
    try {
      names = readdirSync(dir).sort();
    } catch {
      return;
    }
    for (const n of names) {
      if (n === "node_modules" || n.startsWith(".")) continue;
      const full = join(dir, n);
      let isDir: boolean;
      try {
        isDir = statSync(full).isDirectory();
      } catch {
        continue;
      }
      if (isDir) {
        if (depth < 4) walk(full, depth + 1);
      } else if (IMAGE_EXT.test(n)) found.push(full);
    }
  };
  walk(unitDir, 1);
  const rel = (f: string): string => relative(unitDir, f).toLowerCase();
  return {
    before: found.filter((f) => rel(f).includes("before")).slice(0, IMAGES_SHOWN),
    after: found.filter((f) => rel(f).includes("after") && !rel(f).includes("before")).slice(0, IMAGES_SHOWN),
  };
}

/** Per key driver: the units that put a live change on its rows (newest first) and when the last one went live. */
export function driverSection(board: Board, boardDir: string, images: ImageArg[] = []): DriverSection {
  const file = newestKeyDrivers(boardDir);
  const none: DriverSection = { written: false, source: file === null ? null : basename(file), items: [], supportShipped: 0 };
  if (file === null) return none;
  let parsed: ReturnType<typeof parseKeyDrivers>;
  try {
    parsed = parseKeyDrivers(readFileSync(file, "utf8"), new Set(board.rows.map((r) => r.id)));
  } catch {
    return none;
  }
  if (parsed === null) return none;
  const driverOf = new Map<string, string>();
  for (const d of parsed) for (const r of d.rows) if (!driverOf.has(r)) driverOf.set(r, d.id);
  const live = board.units
    // A test-tool unit changes nothing Jm receives: it is not a driver's live change.
    .filter((u) => u.kind !== "test" && u.result !== "open" && u.endedAt !== null && u.shipped !== null && u.shipped !== "none" && u.shipped.trim() !== "")
    .sort((a, b) => Date.parse(b.endedAt ?? "") - Date.parse(a.endedAt ?? ""));
  const items = parsed.map((d): DriverFact => {
    const mine = live.filter((u) => driverOf.get(u.row) === d.id);
    return {
      id: d.id,
      name: d.name,
      rows: d.rows,
      shippedTotal: mine.length,
      lastShippedAt: mine[0]?.endedAt ?? null,
      shipped: mine.slice(0, SHIPPED_SHOWN).map((u): ShippedChange => ({ unit: u.id, row: u.row, at: u.endedAt ?? "", words: unitWords(board, u), where: cut(oneLine(u.shipped ?? ""), 140), result: u.result })),
      ...imagesOf(images, d.id),
    };
  });
  return { written: true, source: basename(file), items, supportShipped: live.filter((u) => !driverOf.has(u.row)).length };
}

function cut(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n - 1)}…`;
}

function driversText(s: DriverSection | undefined, now: Date = new Date()): string[] {
  if (s === undefined) return [];
  if (!s.written) return ["key drivers: not written"];
  return s.items.map((d) => {
    const h = d.lastShippedAt === null ? null : Math.round((now.getTime() - Date.parse(d.lastShippedAt)) / 3600_000);
    const imgs = (d.images?.before.length ?? 0) + (d.images?.after.length ?? 0);
    return `driver ${d.id} ${d.name}: ${d.shippedTotal} live change(s), ${h === null ? "none ever" : `last ${h} h ago`}${imgs > 0 ? `, ${imgs} before/after image(s)` : ""}`;
  });
}

function factsText(f: Facts): string {
  const d = f.provenDelta === null ? "" : ` (${f.provenDelta >= 0 ? "+" : ""}${f.provenDelta} since the last update)`;
  const lines = [
    ...driversText(f.drivers),
    `support count: ${f.counts.proven} of ${f.counts.total} rows proven${d} · ${f.counts.claimed} claimed · ${f.counts.failed} failed · ${f.counts.untested} untested`,
    `since ${f.since} (${f.sinceKind}):`,
    `  rows moved: ${f.rowMoves.length === 0 ? "none" : f.rowMoves.map((m) => `${m.row} ${m.from}->${m.to}`).join(", ")}`,
    `  units closed: ${f.closed.length === 0 ? "none" : f.closed.map((u) => `${u.id} ${u.row} ${u.result}${u.moved === true ? " moved" : ""} shipped=${cut(u.shipped ?? "?", 60)}`).join("; ")}`,
    `  live changes: ${f.liveChanges}`,
    `open units: ${f.open.length === 0 ? "none" : f.open.map((u) => `${u.id} ${u.row} (${u.builder})`).join(", ")}`,
    `stall ${f.stall} · ${f.gateLine}`,
    `last examiner mark: ${f.lastExamAt ?? "none"} · top red row: ${f.top === null ? "none" : `${f.top.id}: ${f.top.sentence}`}`,
  ];
  return lines.join("\n");
}

// ---------------------------------------------------------------- arguments

interface Spec {
  single: string[];
  multi: string[];
  switches: string[];
  required: string[];
}
interface Args {
  one: Map<string, string>;
  many: Map<string, string[]>;
  on: Set<string>;
}

const SPECS: Record<string, Spec> = {
  facts: { single: [], multi: [], switches: [], required: [] },
  post: {
    single: ["by", "where", "progress", "progress-why", "aligned", "aligned-why", "feedback-file"],
    multi: ["done", "left", "try", "app", "answer", "image", "number"],
    switches: ["no-check", "dry-run"],
    required: ["by", "where", "progress", "progress-why", "aligned", "aligned-why", "done", "left"],
  },
  show: { single: ["last"], multi: [], switches: ["json"], required: [] },
};

function parseArgs(tokens: string[], spec: Spec): Args {
  const a: Args = { one: new Map(), many: new Map(), on: new Set() };
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i] ?? "";
    if (!tok.startsWith("--")) throw usage(`unexpected argument "${tok}"`);
    const name = tok.slice(2);
    if (spec.switches.includes(name)) {
      a.on.add(name);
      continue;
    }
    const value = tokens[i + 1];
    if (!spec.single.includes(name) && !spec.multi.includes(name)) throw usage(`unknown flag --${name}`);
    if (value === undefined) throw usage(`flag --${name} needs a value`);
    i++;
    if (spec.multi.includes(name)) {
      a.many.set(name, [...(a.many.get(name) ?? []), value]);
    } else {
      if (a.one.has(name)) throw usage(`flag --${name} given twice`);
      a.one.set(name, value);
    }
  }
  for (const r of spec.required) if (!a.one.has(r) && !a.many.has(r)) throw usage(`missing flag --${r}`);
  return a;
}

function need(a: Args, name: string): string {
  const v = a.one.get(name);
  if (v === undefined) throw usage(`missing flag --${name}`);
  return v;
}

function oneLine(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

/** One line of text for Jm: not empty, at most `max` characters (the page's field sizes). */
function capped(what: string, raw: string, max: number): string {
  const s = oneLine(raw);
  if (s === "") throw new CliError(1, `refused: ${what} is empty`);
  if (s.length > max) throw new CliError(1, `refused: ${what} has ${s.length} chars; the cap is ${max}. Say less: Jm reads this on a phone.`);
  return s;
}

function items(what: string, raw: string[]): string[] {
  if (raw.length === 0) throw new CliError(1, `refused: --${what} needs at least one item`);
  if (raw.length > LIMITS.items) throw new CliError(1, `refused: ${raw.length} --${what} items; the cap is ${LIMITS.items}. Keep the ones that matter to Jm.`);
  return raw.map((x, i) => capped(`--${what} item ${i + 1}`, x, LIMITS.item));
}

function verdict(name: string, raw: string): Verdict {
  const v = VERDICTS.find((x) => x === raw);
  if (v === undefined) throw usage(`--${name} must be one of ${VERDICTS.join(", ")}; got "${raw}"`);
  return v;
}

/** "LABEL=TARGET", split at the first "=" (a URL may hold more). */
export function parseLink(flag: string, raw: string): Link {
  const at = raw.indexOf("=");
  if (at <= 0) throw usage(`--${flag} needs "LABEL=URL or command"; got "${raw}"`);
  const label = capped(`--${flag} label`, raw.slice(0, at), LIMITS.label);
  const target = capped(`--${flag} target`, raw.slice(at + 1), LIMITS.target);
  return { label, target, check: /^https?:\/\//.test(target) ? "not-checked" : "not-a-url", code: null };
}

/** "LABEL|NOW|BEFORE|BAR": before and bar may be empty. */
export function parseNumber(raw: string): DriverNumber {
  const parts = raw.split("|");
  if (parts.length > 4) throw usage(`--number takes at most 4 parts "LABEL|NOW|BEFORE|BAR"; got ${parts.length} in "${raw}"`);
  const [label = "", now = "", before = "", bar = ""] = parts;
  const part = (what: string, v: string, required: boolean): string => (required || oneLine(v) !== "" ? capped(`--number ${what}`, v, LIMITS.numberPart) : "");
  return { label: part("label", label, true), now: part("now", now, true), before: part("before", before, false), bar: part("bar", bar, false) };
}

/** One GET per http(s) link (5 s). The result is recorded, not enforced: a dead app is news for Jm. */
export async function checkLinks(links: Link[]): Promise<Link[]> {
  return Promise.all(
    links.map(async (l): Promise<Link> => {
      if (!/^https?:\/\//.test(l.target)) return { ...l, check: "not-a-url", code: null };
      try {
        const res = await fetch(l.target, { method: "GET", redirect: "follow", signal: AbortSignal.timeout(LINK_TIMEOUT_MS) });
        await res.body?.cancel();
        const ok = res.status < 400 || res.status === 401 || res.status === 403;
        return { ...l, check: ok ? "ok" : "dead", code: res.status };
      } catch {
        return { ...l, check: "dead", code: null };
      }
    }),
  );
}

function slug(project: string): string {
  return project.replace(/[^A-Za-z0-9_.~:@+-]/g, "-").replace(/^\.+/, "p");
}

// ---------------------------------------------------------------- commands

function cmdFacts(path: string): void {
  const board = loadBoard(path);
  const prev = readUpdates(path).at(-1) ?? null;
  console.log(factsText(boardFacts(board, path, prev)));
}

async function cmdPost(path: string, a: Args): Promise<void> {
  const board = loadBoard(path);
  const updates = readUpdates(path);
  const prev = updates.at(-1) ?? null;

  const where = capped("--where", need(a, "where"), LIMITS.where);
  const done = items("done", a.many.get("done") ?? []);
  const left = items("left", a.many.get("left") ?? []);
  const progress = { verdict: verdict("progress", need(a, "progress")), why: capped("--progress-why", need(a, "progress-why"), LIMITS.why) };
  const aligned = { verdict: verdict("aligned", need(a, "aligned")), why: capped("--aligned-why", need(a, "aligned-why"), LIMITS.why) };

  const tryRaw = a.many.get("try") ?? [];
  const appRaw = a.many.get("app") ?? [];
  if (tryRaw.length > LIMITS.links || appRaw.length > LIMITS.links) throw new CliError(1, `refused: at most ${LIMITS.links} --try and ${LIMITS.links} --app links`);
  let app = appRaw.map((x) => parseLink("app", x));
  if (app.length === 0) {
    if (prev === null || prev.app.length === 0) {
      throw new CliError(1, `refused: the first update of ${board.project} needs --app "LABEL=URL or command": where Jm opens the product as a whole`);
    }
    app = prev.app.map((l) => ({ label: l.label, target: l.target, check: "not-checked", code: null }));
  }
  let tries = tryRaw.map((x) => parseLink("try", x));
  const images = (a.many.get("image") ?? []).map(parseImage);
  const numbers = (a.many.get("number") ?? []).map(parseNumber);
  if (numbers.length > LIMITS.numbers) throw new CliError(1, `refused: ${numbers.length} --number items; the cap is ${LIMITS.numbers}. Keep the key drivers.`);

  const fbFile = resolve(a.one.get("feedback-file") ?? join(board.folder, "FEEDBACK.md"));
  const answers: Answer[] = (a.many.get("answer") ?? []).map((raw) => {
    const at = raw.indexOf("=");
    if (at <= 0) throw usage(`--answer needs "F-NNN=TEXT"; got "${raw}"`);
    const key = raw.slice(0, at).trim();
    const text = capped(`--answer ${key}`, raw.slice(at + 1), LIMITS.answer);
    // The item is in FEEDBACK.md (it waits) or in FEEDBACK-HISTORY.md beside it (decided). An item that came through
    // the page carries the line `- **Page item:** <doc id>`, so the page shows the answer under Jm's message.
    for (const file of feedbackFiles(fbFile)) {
      const item = findFeedbackItem(readFileSync(file, "utf8"), key);
      if (item !== null) return { feedback: item.pageDoc, ref: key, text, words: item.pageDoc === null ? item.words : null };
    }
    throw new CliError(1, `refused: --answer ${key}: no ### ${key} in ${fbFile} or in FEEDBACK-HISTORY.md beside it (give --feedback-file when FEEDBACK.md is outside the project folder)`);
  });

  if (!a.on.has("no-check")) {
    app = await checkLinks(app);
    tries = await checkLinks(tries);
  }

  const n = (prev?.n ?? 0) + 1;
  const id = `${slug(board.project)}-${String(n).padStart(4, "0")}`;
  const update: StatusUpdate = {
    schema: SCHEMA,
    id,
    project: board.project,
    n,
    at: localIso(),
    by: oneLine(need(a, "by")),
    where,
    done,
    left,
    try: tries,
    app,
    progress,
    aligned,
    answers,
    ...(numbers.length === 0 ? {} : { numbers }),
    facts: boardFacts(board, path, prev, new Date(), images),
  };
  const known = new Set(update.facts.drivers?.items.map((d) => d.id) ?? []);
  for (const i of images) if (!known.has(i.driver)) throw new CliError(1, `refused: --image names driver ${i.driver}, which the key-drivers file of this board does not list (${[...known].join(", ") || "none written"})`);

  if (a.on.has("dry-run")) {
    console.log(JSON.stringify(update, null, 2));
    console.log("dry run: nothing written");
    return;
  }
  const dir = statusDir(path);
  const out = join(dir, "out", `${id}.json`);
  writeJson(out, update);
  appendRecord(join(dir, "STATUS.jsonl"), update);

  console.log(`${id} recorded in ${join(dir, "STATUS.jsonl")}`);
  console.log(factsText(update.facts));
  for (const l of [...app, ...tries]) {
    if (l.check === "dead") console.error(`warning: link "${l.label}" did not answer (${l.code ?? "no answer"}): ${l.target}. The page shows it as dead; fix it or say why in the next update.`);
  }
  for (const line of imageReminders(update, path, images)) console.error(line);
  console.log(`\nPush it to the page (one ArtifactData call):`);
  console.log(JSON.stringify({ action: "set", url: STATUS_PAGE_URL, collection: "updates", doc_id: id, file_path: out }));
}

/** For each driver that has a live change in this update but no --image: the exact Artifact upload call for the newest such unit's before/after files, when they exist. */
export function imageReminders(update: StatusUpdate, boardPath: string, images: ImageArg[]): string[] {
  const out: string[] = [];
  const since = Date.parse(update.facts.since);
  for (const d of update.facts.drivers?.items ?? []) {
    if (images.some((i) => i.driver === d.id)) continue;
    const fresh = d.shipped.find((c) => Date.parse(c.at) > since);
    if (fresh === undefined) continue;
    const files = unitImages(join(dirname(resolve(boardPath)), "units", fresh.unit));
    const picks = [...files.before.slice(0, 1), ...files.after.slice(0, 1)];
    if (picks.length === 0) continue;
    out.push(`reminder: driver ${d.id} has a live change (${fresh.unit}) and no --image. Upload its before/after with the Artifact tool: ${JSON.stringify({ action: "publish", url: STATUS_PAGE_URL, asset: true, file_paths: picks })} then re-post with --image "${d.id} before=<url>" --image "${d.id} after=<url>" (the page shows them under the driver).`);
  }
  return out;
}

/** The marked fields of a feedback item: Jm's words (cut) and, for an item that came through the page, its doc id. */
export interface FeedbackItemRef {
  words: string | null;
  /** From the item's line `- **Page item:** <doc id>`; null for an item from another door. */
  pageDoc: string | null;
}

/** The `### F-NNN` item of a feedback file (comments ignored): null when absent. */
export function findFeedbackItem(content: string, ref: string): FeedbackItemRef | null {
  if (!/^F-\d+$/.test(ref)) return null;
  const lines = content.replace(/<!--[\s\S]*?-->/g, "").split("\n");
  const head = new RegExp(`^###\\s+${ref}(?!\\d)`);
  const start = lines.findIndex((l) => head.test(l));
  if (start < 0) return null;
  const item: FeedbackItemRef = { words: null, pageDoc: null };
  for (let i = start + 1; i < lines.length && !/^#{2,3}\s/.test(lines[i] ?? ""); i++) {
    const line = lines[i] ?? "";
    const w = /\*\*Jm \(verbatim\):\*\*\s*"?(.*?)"?\s*$/.exec(line);
    if (item.words === null && w?.[1] !== undefined && w[1] !== "") item.words = cut(w[1], 200);
    const p = /\*\*Page item:\*\*\s*`?([A-Za-z0-9_.~:@+-]+)`?/.exec(line);
    if (item.pageDoc === null && p?.[1] !== undefined) item.pageDoc = p[1];
  }
  return item;
}

/** The file of open items and, beside it, the history of decided items (ProjectStandard v3): those that exist. */
export function feedbackFiles(openFile: string): string[] {
  return [openFile, join(dirname(openFile), "FEEDBACK-HISTORY.md")].filter((f) => existsSync(f));
}

function cmdShow(path: string, a: Args): void {
  const updates = readUpdates(path);
  const lastRaw = a.one.get("last") ?? "1";
  const last = Number(lastRaw);
  if (!Number.isInteger(last) || last < 1) throw usage(`--last must be a whole number >= 1; got "${lastRaw}"`);
  const shown = updates.slice(-last).reverse();
  if (a.on.has("json")) {
    console.log(JSON.stringify({ page: STATUS_PAGE_URL, updates: shown }, null, 2));
    return;
  }
  if (updates.length === 0) console.log(`no status updates yet (${join(statusDir(path), "STATUS.jsonl")}); page: ${STATUS_PAGE_URL}`);
  for (const u of shown) {
    console.log(`${u.id} · ${u.at} · ${u.by}`);
    console.log(`  where: ${u.where}`);
    for (const d of u.done) console.log(`  done: ${d}`);
    for (const l of u.left) console.log(`  left: ${l}`);
    for (const t of u.try) console.log(`  try: ${t.label} = ${t.target} [${t.check}]`);
    console.log(`  progress: ${u.progress.verdict} · ${u.progress.why}`);
    console.log(`  aligned: ${u.aligned.verdict} · ${u.aligned.why}`);
    console.log(`  app: ${u.app.map((l) => `${l.label} = ${l.target} [${l.check}]`).join("; ")}`);
    console.log(`  ${factsText(u.facts).split("\n").join("\n  ")}`);
  }
  console.log(`page: ${STATUS_PAGE_URL}`);
}

async function run(argv: string[]): Promise<number> {
  const [command, path, ...rest] = argv;
  if (argv.includes("--help")) {
    console.log(command === "post" ? `${USAGE}\n\n${POST_FIELDS}` : USAGE);
    return 0;
  }
  if (command === undefined) throw usage("missing command");
  if (command === "pull" || command === "inbox") {
    // A session that still follows the old workflow text gets the new steps, not an error.
    console.log(`${command} is removed (2026-11-25). Read Jm's page feedback yourself: ArtifactData ${JSON.stringify({ action: "query", url: STATUS_PAGE_URL, collection: "feedback", query: { where: [["project", "==", "<your project>"]] } })} (no out_dir). No documents: nothing is new. Else follow ~/.claude/skills/Automation/EndStateLoop/Workflows/Orchestrate.md, section "Status page".`);
    return 0;
  }
  const spec = SPECS[command];
  if (spec === undefined) throw usage(`unknown command "${command}"`);
  if (path === undefined || path.startsWith("--")) throw usage("missing board path");
  const a = parseArgs(rest, spec);
  switch (command) {
    case "facts":
      cmdFacts(path);
      break;
    case "post":
      await cmdPost(path, a);
      break;
    case "show":
      cmdShow(path, a);
      break;
    default:
      throw usage(`unknown command "${command}"`);
  }
  return 0;
}

if (import.meta.main) {
  try {
    process.exit(await run(process.argv.slice(2)));
  } catch (err) {
    if (!(err instanceof CliError)) throw err;
    console.error(err.message);
    process.exit(err.code);
  }
}
