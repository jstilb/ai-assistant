#!/usr/bin/env bun
/**
 * Board.ts — the scoreboard of an end-state loop (`<project>/SCOREBOARD.json`, schema
 * `endstate-board/v1`).
 *
 * One row per sentence of the end state. A row's status is the status of its last mark. Only an
 * examiner mark with a set id and evidence on disk can make a row `proven`. Units record builder
 * sessions; a unit that closes with no change to any row status did not move the board, and two
 * such units in a row make `gate` exit 5 (re-plan).
 *
 * Every writing command reads the board, changes it, runs the same checks as `validate` on the
 * result, and writes it atomically (temp file in the same folder + rename) only when the result
 * is valid. A refused command leaves the file byte-identical.
 *
 * Two sessions (orchestrator, examiner) write one board, so every writing command holds the lock
 * directory `<board>.lock` around the whole read-change-check-write. It waits up to
 * BOARD_LOCK_TIMEOUT_MS (default 10000) for a held lock; a lock older than 60 s is stale and is
 * taken. Before each write, the old file is copied to `<board>.bak`. Read commands take no lock.
 *
 * Usage: bun Board.ts <command> <board path> [flags]   (commands: see USAGE below)
 * Exit:  0 = ok, 1 = invalid board or refused change, 2 = bad arguments, 5 = gate says re-plan.
 *
 * Skill: ~/.claude/skills/Automation/EndStateLoop/SKILL.md
 *
 * @module Board
 */

import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

// ---------------------------------------------------------------- schema

const SCHEMA = "endstate-board/v1";
const STATUSES = ["proven", "claimed", "failed", "untested"] as const;
const ROLES = ["setup", "examiner"] as const;
const KINDS = ["known-answer", "judged", "none"] as const;
const RESULTS = ["open", "pass", "fail", "too-large"] as const;
const CLOSE_RESULTS = ["pass", "fail", "too-large"] as const;

export type Status = (typeof STATUSES)[number];
export type Role = (typeof ROLES)[number];
export type TestKind = (typeof KINDS)[number];
export type UnitResult = (typeof RESULTS)[number];

export interface Mark {
  at: string;
  by: string;
  role: Role;
  status: Status;
  evidence: string[];
  set: string | null;
  note: string;
}
export interface RowTest {
  name: string;
  kind: TestKind;
  command: string | null;
  passRule: string | null;
  ruleFile: string | null;
  ruleSetAt: string | null;
}
export interface Row {
  id: string;
  sentence: string;
  source: string;
  test: RowTest;
  status: Status;
  gap: string;
  rank: number | null;
  marks: Mark[];
}
export interface Unit {
  id: string;
  row: string;
  contract: string;
  builder: string;
  startedAt: string;
  endedAt: string | null;
  result: UnitResult;
  /** The whole board's status hash at open. Kept for the record; `moved` no longer reads it (2026-11-09). */
  statusHashAtOpen: string;
  /** The unit's own row status at open. Null in units opened before 2026-11-09 23:45 PST: unit-close then reads the row's marks. */
  rowStatusAtOpen: Status | null;
  /** True only when the unit closed "pass" and its own row went up (untested < failed < claimed < proven). */
  moved: boolean | null;
  note: string;
}
export interface FinalCheck {
  what: string;
  value: string;
  readAt: string;
}
export interface Board {
  schema: typeof SCHEMA;
  project: string;
  folder: string;
  endState: { source: string; approvedBy: string; summary: string };
  finalCheck: FinalCheck[];
  rows: Row[];
  units: Unit[];
}

const BOARD_KEYS = ["schema", "project", "folder", "endState", "finalCheck", "rows", "units"] as const satisfies readonly (keyof Board)[];
const END_STATE_KEYS = ["source", "approvedBy", "summary"] as const satisfies readonly (keyof Board["endState"])[];
const FINAL_KEYS = ["what", "value", "readAt"] as const satisfies readonly (keyof FinalCheck)[];
const ROW_KEYS = ["id", "sentence", "source", "test", "status", "gap", "rank", "marks"] as const satisfies readonly (keyof Row)[];
const TEST_KEYS = ["name", "kind", "command", "passRule", "ruleFile", "ruleSetAt"] as const satisfies readonly (keyof RowTest)[];
const MARK_KEYS = ["at", "by", "role", "status", "evidence", "set", "note"] as const satisfies readonly (keyof Mark)[];
const UNIT_KEYS = ["id", "row", "contract", "builder", "startedAt", "endedAt", "result", "statusHashAtOpen", "rowStatusAtOpen", "moved", "note"] as const satisfies readonly (keyof Unit)[];

// ---------------------------------------------------------------- errors

/** An expected failure: message on stderr, then exit with `code`. */
class CliError extends Error {
  constructor(
    readonly code: 1 | 2,
    message: string,
  ) {
    super(message);
  }
}

const USAGE = `usage: bun Board.ts <command> <board path> [flags]
  validate
  show [--json]
  next
  gate
  set-test   --row R --name N --kind known-answer|judged|none [--command C] [--pass-rule P] [--rule-file F]
  mark       --row R --status proven|claimed|failed|untested --by NAME --role setup|examiner [--set ID] [--evidence p1,p2] --note TEXT
  rank       --order R4,R2,R7 --by NAME
  unit-open  --row R --contract PATH --builder NAME
  unit-close --unit U --result pass|fail|too-large --note TEXT
writing commands lock <board>.lock and copy the old file to <board>.bak before the write.
env: BOARD_LOCK_TIMEOUT_MS  ms a writing command waits for a held lock (default 10000); a lock
     older than 60 s is stale and is taken.`;

function usage(problem: string): CliError {
  return new CliError(2, `${problem}\n${USAGE}`);
}

// ---------------------------------------------------------------- parse (structure)

type Obj = Record<string, unknown>;

function isObj(v: unknown): v is Obj {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function oneOf<T extends string>(allowed: readonly T[], v: unknown): v is T {
  return allowed.some((a) => a === v);
}

/** Reads typed fields from one JSON object; each problem adds one error line. */
class Fields {
  constructor(
    private readonly o: Obj,
    private readonly where: string,
    private readonly errors: string[],
    known: readonly string[],
  ) {
    for (const k of Object.keys(o)) {
      if (!known.includes(k)) errors.push(`${where}: unknown field "${k}"`);
    }
  }

  private bad(key: string, want: string): void {
    this.errors.push(`${this.where}.${key}: ${key in this.o ? `expected ${want}, got ${JSON.stringify(this.o[key])}` : "missing"}`);
  }

  str(key: string): string {
    const v = this.o[key];
    if (typeof v === "string") return v;
    this.bad(key, "a string");
    return "";
  }

  strOrNull(key: string): string | null {
    const v = this.o[key];
    if (v === null || typeof v === "string") return v;
    this.bad(key, "a string or null");
    return null;
  }

  rankOrNull(key: string): number | null {
    const v = this.o[key];
    if (v === null || (typeof v === "number" && Number.isInteger(v) && v >= 1)) return v;
    this.bad(key, "an integer >= 1 or null");
    return null;
  }

  boolOrNull(key: string): boolean | null {
    const v = this.o[key];
    if (v === null || typeof v === "boolean") return v;
    this.bad(key, "true, false or null");
    return null;
  }

  strList(key: string): string[] {
    const v = this.o[key];
    if (Array.isArray(v) && v.every((x) => typeof x === "string")) return v.filter((x) => typeof x === "string");
    this.bad(key, "an array of strings");
    return [];
  }

  oneOf<T extends string>(key: string, allowed: readonly T[], fallback: T): T {
    const v = this.o[key];
    if (oneOf(allowed, v)) return v;
    this.bad(key, allowed.map((a) => `"${a}"`).join(" | "));
    return fallback;
  }

  /** A key that older boards do not have: absent or null reads as null. */
  absentOrOneOf<T extends string>(key: string, allowed: readonly T[]): T | null {
    const v = this.o[key];
    if (!(key in this.o) || v === null) return null;
    if (oneOf(allowed, v)) return v;
    this.bad(key, `${allowed.map((a) => `"${a}"`).join(" | ")} or null`);
    return null;
  }

  obj(key: string): Obj {
    const v = this.o[key];
    if (isObj(v)) return v;
    this.bad(key, "an object");
    return {};
  }

  /** Each element that is an object, with its index; a non-object element adds an error. */
  list(key: string): { item: Obj; where: string }[] {
    const v = this.o[key];
    if (!Array.isArray(v)) {
      this.bad(key, "an array");
      return [];
    }
    const out: { item: Obj; where: string }[] = [];
    v.forEach((item: unknown, i) => {
      const where = `${this.where}.${key}[${i}]`;
      if (isObj(item)) out.push({ item, where });
      else this.errors.push(`${where}: expected an object`);
    });
    return out;
  }
}

function parseMark(o: Obj, where: string, errors: string[]): Mark {
  const f = new Fields(o, where, errors, MARK_KEYS);
  return {
    at: f.str("at"),
    by: f.str("by"),
    role: f.oneOf("role", ROLES, "setup"),
    status: f.oneOf("status", STATUSES, "untested"),
    evidence: f.strList("evidence"),
    set: f.strOrNull("set"),
    note: f.str("note"),
  };
}

function parseRow(o: Obj, where: string, errors: string[]): Row {
  const f = new Fields(o, where, errors, ROW_KEYS);
  const t = new Fields(f.obj("test"), `${where}.test`, errors, TEST_KEYS);
  return {
    id: f.str("id"),
    sentence: f.str("sentence"),
    source: f.str("source"),
    test: {
      name: t.str("name"),
      kind: t.oneOf("kind", KINDS, "none"),
      command: t.strOrNull("command"),
      passRule: t.strOrNull("passRule"),
      ruleFile: t.strOrNull("ruleFile"),
      ruleSetAt: t.strOrNull("ruleSetAt"),
    },
    status: f.oneOf("status", STATUSES, "untested"),
    gap: f.str("gap"),
    rank: f.rankOrNull("rank"),
    marks: f.list("marks").map(({ item, where: w }) => parseMark(item, w, errors)),
  };
}

function parseUnit(o: Obj, where: string, errors: string[]): Unit {
  const f = new Fields(o, where, errors, UNIT_KEYS);
  return {
    id: f.str("id"),
    row: f.str("row"),
    contract: f.str("contract"),
    builder: f.str("builder"),
    startedAt: f.str("startedAt"),
    endedAt: f.strOrNull("endedAt"),
    result: f.oneOf("result", RESULTS, "open"),
    statusHashAtOpen: f.str("statusHashAtOpen"),
    rowStatusAtOpen: f.absentOrOneOf("rowStatusAtOpen", STATUSES),
    moved: f.boolOrNull("moved"),
    note: f.str("note"),
  };
}

/** Structure only: types, missing and unknown fields. `board` is null when the top is not an object. */
export function parseBoard(raw: unknown): { board: Board | null; errors: string[] } {
  if (!isObj(raw)) return { board: null, errors: ["board: expected a JSON object"] };
  const errors: string[] = [];
  const f = new Fields(raw, "board", errors, BOARD_KEYS);
  if (raw.schema !== SCHEMA) errors.push(`board.schema: expected "${SCHEMA}", got ${JSON.stringify(raw.schema)}`);
  const e = new Fields(f.obj("endState"), "board.endState", errors, END_STATE_KEYS);
  const board: Board = {
    schema: SCHEMA,
    project: f.str("project"),
    folder: f.str("folder"),
    endState: { source: e.str("source"), approvedBy: e.str("approvedBy"), summary: e.str("summary") },
    finalCheck: f.list("finalCheck").map(({ item, where }) => {
      const c = new Fields(item, where, errors, FINAL_KEYS);
      return { what: c.str("what"), value: c.str("value"), readAt: c.str("readAt") };
    }),
    rows: f.list("rows").map(({ item, where }) => parseRow(item, where, errors)),
    units: f.list("units").map(({ item, where }) => parseUnit(item, where, errors)),
  };
  return { board, errors };
}

// ---------------------------------------------------------------- check (meaning)

function isUrl(e: string): boolean {
  return e.startsWith("http://") || e.startsWith("https://");
}

/** Null when the evidence string is a URL or an absolute path that exists. */
function evidenceProblem(e: string): string | null {
  if (isUrl(e)) return null;
  if (!isAbsolute(e)) return `evidence "${e}" is not an absolute path or an http(s) URL`;
  if (!existsSync(e)) return `evidence "${e}" does not exist`;
  return null;
}

function duplicates(ids: string[]): string[] {
  const seen = new Set<string>();
  const dup = new Set<string>();
  for (const id of ids) (seen.has(id) ? dup : seen).add(id);
  return [...dup];
}

function badTime(t: string): boolean {
  return Number.isNaN(Date.parse(t));
}

/** The rules of `validate`. Errors make a board invalid; warnings do not. */
export function checkBoard(board: Board): { errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];
  if (board.rows.length === 0) errors.push("board.rows: empty (a board needs at least one row)");
  for (const id of duplicates(board.rows.map((r) => r.id))) errors.push(`duplicate row id ${id}`);
  for (const id of duplicates(board.units.map((u) => u.id))) errors.push(`duplicate unit id ${id}`);

  const byRank = new Map<number, string[]>();
  for (const r of board.rows) {
    const last = r.marks.at(-1);
    if (last === undefined) {
      if (r.status !== "untested") errors.push(`${r.id}: status ${r.status} but no marks (a row with no marks must be untested)`);
    } else if (last.status !== r.status) {
      errors.push(`${r.id}: status ${r.status} differs from its last mark status ${last.status}`);
    }
    if (r.status === "proven" && last !== undefined) {
      if (last.role !== "examiner") errors.push(`${r.id}: proven but the last mark has role ${last.role}, not examiner`);
      if (last.set === null) errors.push(`${r.id}: proven but the last mark has set null (an exam needs a set id)`);
      if (last.evidence.length === 0) errors.push(`${r.id}: proven but the last mark has no evidence`);
      for (const e of last.evidence) {
        const p = evidenceProblem(e);
        if (p !== null) errors.push(`${r.id}: proven but ${p}`);
      }
    }
    if (r.test.kind === "none" && (r.status === "proven" || r.status === "claimed")) {
      errors.push(`${r.id}: status ${r.status} but test.kind is none`);
    }
    if (r.status !== "untested" && r.test.passRule === null) {
      errors.push(`${r.id}: status ${r.status} but test.passRule is null (the pass rule goes in the board before the run)`);
    }
    if (r.test.ruleSetAt !== null && badTime(r.test.ruleSetAt)) errors.push(`${r.id}.test.ruleSetAt: not a date "${r.test.ruleSetAt}"`);
    r.marks.forEach((m, i) => {
      if (badTime(m.at)) errors.push(`${r.id}.marks[${i}].at: not a date "${m.at}"`);
    });
    if (r.status !== "proven") {
      for (const m of r.marks) {
        for (const e of m.evidence) {
          const p = evidenceProblem(e);
          if (p !== null) warnings.push(`${r.id}: ${p}`);
        }
      }
      if (r.rank === null) warnings.push(`${r.id}: ${r.status} row has rank null`);
    }
    if (r.rank !== null) byRank.set(r.rank, [...(byRank.get(r.rank) ?? []), r.id]);
  }
  for (const [rank, ids] of byRank) {
    if (ids.length > 1) errors.push(`duplicate rank ${rank}: ${ids.join(", ")}`);
  }

  const rowIds = new Set(board.rows.map((r) => r.id));
  for (const u of board.units) {
    if (!rowIds.has(u.row)) errors.push(`${u.id}: row ${u.row} is not a row id`);
    if (badTime(u.startedAt)) errors.push(`${u.id}.startedAt: not a date "${u.startedAt}"`);
    if (u.result === "open") {
      if (u.endedAt !== null || u.moved !== null) errors.push(`${u.id}: open unit must have endedAt null and moved null`);
    } else if (u.endedAt === null || u.moved === null) {
      errors.push(`${u.id}: closed unit (${u.result}) must have endedAt and moved set`);
    } else if (badTime(u.endedAt)) {
      errors.push(`${u.id}.endedAt: not a date "${u.endedAt}"`);
    }
  }
  return { errors, warnings };
}

// ---------------------------------------------------------------- queries

export function statusHash(board: Board): string {
  return createHash("sha256")
    .update(JSON.stringify(board.rows.map((r) => [r.id, r.status])))
    .digest("hex");
}

/** Higher is nearer the end state. untested -> failed counts as up: the row now has a test that ran. */
const STATUS_ORDER: Record<Status, number> = { untested: 0, failed: 1, claimed: 2, proven: 3 };

/** A row's status at a time, from its marks (the last mark strictly before `iso`); "untested" with no such mark. */
export function statusBefore(row: Row, iso: string): Status {
  const t = Date.parse(iso);
  let status: Status = "untested";
  for (const m of row.marks) if (Date.parse(m.at) < t) status = m.status;
  return status;
}

/** The end times (ms) of the units in the current stall, newest first. */
export function stallEnds(board: Board): number[] {
  const ends = board.units
    .filter((u) => u.result !== "open" && u.endedAt !== null)
    .map((u) => ({ t: Date.parse(u.endedAt ?? ""), moved: u.moved }))
    .sort((a, b) => b.t - a.t);
  const run: number[] = [];
  for (const e of ends) {
    if (e.moved !== false) break;
    run.push(e.t);
  }
  return run;
}

/** The count of the most recent consecutive closed units (by endedAt) with moved === false. */
export function stall(board: Board): number {
  const closed: { t: number; i: number; moved: boolean | null }[] = [];
  board.units.forEach((u, i) => {
    if (u.result !== "open" && u.endedAt !== null) closed.push({ t: Date.parse(u.endedAt), i, moved: u.moved });
  });
  closed.sort((a, b) => a.t - b.t || a.i - b.i);
  let k = 0;
  for (const c of closed.reverse()) {
    if (c.moved !== false) break;
    k++;
  }
  return k;
}

/** The non-proven row with the lowest rank; with no ranked one, the first non-proven row. */
export function nextRow(board: Board): Row | null {
  const open = board.rows.filter((r) => r.status !== "proven");
  const ranked = open
    .filter((r): r is Row & { rank: number } => r.rank !== null)
    .sort((a, b) => a.rank - b.rank);
  return ranked[0] ?? open[0] ?? null;
}

function cut(s: string, n: number): string {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length <= n ? one : `${one.slice(0, n - 1)}…`;
}

function byId(a: string, b: string): number {
  return a.localeCompare(b, undefined, { numeric: true });
}

function counts(board: Board): Record<Status | "total", number> {
  const c = { proven: 0, claimed: 0, failed: 0, untested: 0, total: board.rows.length };
  for (const r of board.rows) c[r.status]++;
  return c;
}

function table(rows: string[][]): string {
  const widths: number[] = [];
  for (const row of rows) row.forEach((cell, i) => (widths[i] = Math.max(widths[i] ?? 0, cell.length)));
  return rows.map((row) => row.map((cell, i) => (i === row.length - 1 ? cell : cell.padEnd(widths[i] ?? 0))).join("  ")).join("\n");
}

function showText(board: Board): string {
  const c = counts(board);
  const k = stall(board);
  const sorted = [...board.rows].sort((a, b) => {
    if (a.rank !== b.rank) return a.rank === null ? 1 : b.rank === null ? -1 : a.rank - b.rank;
    return byId(a.id, b.id);
  });
  const lines = [
    `${board.project}: ${c.proven} of ${c.total} proven · ${c.claimed} claimed · ${c.failed} failed · ${c.untested} untested`,
    `stall: ${k} closed unit(s) in a row with no board move`,
    "",
    table([
      ["id", "status", "rank", "test", "sentence", "gap"],
      ...sorted.map((r) => [r.id, r.status, r.rank === null ? "-" : String(r.rank), cut(r.test.name, 50), cut(r.sentence, 70), cut(r.gap, 70)]),
    ]),
    "",
  ];
  if (board.finalCheck.length === 0) lines.push("final check: none");
  for (const f of board.finalCheck) lines.push(`final check: ${f.what} = ${f.value} (read ${f.readAt})`);
  return lines.join("\n");
}

// ---------------------------------------------------------------- time and files

/** Local time, ISO 8601 with a numeric offset (never Z), e.g. 2026-11-09T22:10:00-08:00. */
export function localIso(d: Date = new Date()): string {
  const p = (n: number): string => String(n).padStart(2, "0");
  const off = -d.getTimezoneOffset();
  const abs = Math.abs(off);
  const zone = `${off >= 0 ? "+" : "-"}${p(Math.floor(abs / 60))}:${p(abs % 60)}`;
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}${zone}`;
}

/** Read and parse; a structural error is exit 1. Meaning checks are left to the caller. */
function load(path: string): Board {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    throw new CliError(1, `error: cannot read board ${path}: ${err instanceof Error ? err.message : String(err)}`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new CliError(1, `error: ${path} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  const { board, errors } = parseBoard(raw);
  if (board === null || errors.length > 0) throw new CliError(1, errors.map((e) => `error: ${e}`).join("\n"));
  return board;
}

/** Load a board that must pass every check (for the read-only commands). */
function loadValid(path: string): Board {
  const board = load(path);
  const { errors } = checkBoard(board);
  if (errors.length > 0) throw new CliError(1, [...errors.map((e) => `error: ${e}`), `error: board invalid; run: bun Board.ts validate ${path}`].join("\n"));
  return board;
}

function writeAtomic(path: string, board: Board): void {
  const tmp = join(dirname(path), `.${basename(path)}.${process.pid}.${Date.now()}.tmp`);
  try {
    writeFileSync(tmp, `${JSON.stringify(board, null, 2)}\n`, { flag: "wx" });
    renameSync(tmp, path);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
}

const LOCK_STALE_MS = 60_000;
const LOCK_RETRY_MS = 100;

function errCode(err: unknown): unknown {
  return isObj(err) ? err.code : undefined;
}

function lockTimeoutMs(): number {
  const raw = process.env.BOARD_LOCK_TIMEOUT_MS;
  if (raw === undefined || raw === "") return 10_000;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) throw usage(`BOARD_LOCK_TIMEOUT_MS must be a whole number of ms; got "${raw}"`);
  return n;
}

/**
 * Take the lock directory (mkdir is atomic). A lock older than LOCK_STALE_MS is left by a dead
 * writer: remove it and take it. Known limit: two writers that find the same stale lock at the
 * same moment can both remove it; a stale lock needs a crashed writer first, so this is rare.
 */
function acquireLock(lock: string, timeoutMs: number): void {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      mkdirSync(lock);
      return;
    } catch (err) {
      if (errCode(err) !== "EEXIST") throw err;
    }
    const st = statSync(lock, { throwIfNoEntry: false });
    if (st === undefined) continue; // the holder released it between our mkdir and stat
    const age = Date.now() - st.mtimeMs;
    if (age > LOCK_STALE_MS) {
      try {
        rmdirSync(lock);
      } catch (err) {
        if (errCode(err) !== "ENOENT") throw err; // another writer removed it first
      }
      console.error(`warning: took stale lock ${lock} (age ${Math.round(age / 1000)} s)`);
      continue;
    }
    if (Date.now() >= deadline) {
      throw new CliError(
        1,
        `refused: board is locked by another writer: ${lock} (age ${Math.round(age / 1000)} s); waited ${timeoutMs} ms; board unchanged. ` +
          `If no writer runs, the lock is taken as stale after ${LOCK_STALE_MS / 1000} s.`,
      );
    }
    Bun.sleepSync(LOCK_RETRY_MS);
  }
}

function releaseLock(lock: string): void {
  try {
    rmdirSync(lock);
  } catch (err) {
    if (errCode(err) !== "ENOENT") throw err;
    console.error(`warning: lock ${lock} was already gone at release (held past ${LOCK_STALE_MS / 1000} s?)`);
  }
}

/** Lock, read, change, check, back up, write, unlock. `change` returns the stdout text or throws a CliError. */
function update(path: string, change: (board: Board) => string): void {
  const lock = `${path}.lock`;
  acquireLock(lock, lockTimeoutMs());
  try {
    const board = load(path);
    const out = change(board);
    const { errors, warnings } = checkBoard(board);
    if (errors.length > 0) {
      throw new CliError(1, [`refused: the result would be invalid; ${path} unchanged`, ...errors.map((e) => `error: ${e}`)].join("\n"));
    }
    copyFileSync(path, `${path}.bak`);
    writeAtomic(path, board);
    for (const w of warnings) console.error(`warning: ${w}`);
    console.log(out);
  } finally {
    releaseLock(lock);
  }
}

// ---------------------------------------------------------------- arguments

interface Args {
  flags: Map<string, string>;
  switches: Set<string>;
}

interface CommandSpec {
  required: string[];
  optional: string[];
  switches: string[];
}

const COMMANDS: Record<string, CommandSpec> = {
  validate: { required: [], optional: [], switches: [] },
  show: { required: [], optional: [], switches: ["json"] },
  next: { required: [], optional: [], switches: [] },
  gate: { required: [], optional: [], switches: [] },
  "set-test": { required: ["row", "name", "kind"], optional: ["command", "pass-rule", "rule-file"], switches: [] },
  mark: { required: ["row", "status", "by", "role", "note"], optional: ["set", "evidence"], switches: [] },
  rank: { required: ["order", "by"], optional: [], switches: [] },
  "unit-open": { required: ["row", "contract", "builder"], optional: [], switches: [] },
  "unit-close": { required: ["unit", "result", "note"], optional: [], switches: [] },
};

function parseFlags(tokens: string[], spec: CommandSpec): Args {
  const flags = new Map<string, string>();
  const switches = new Set<string>();
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i] ?? "";
    if (!tok.startsWith("--")) throw usage(`unexpected argument "${tok}"`);
    const name = tok.slice(2);
    if (spec.switches.includes(name)) {
      switches.add(name);
      continue;
    }
    if (!spec.required.includes(name) && !spec.optional.includes(name)) throw usage(`unknown flag --${name}`);
    if (flags.has(name)) throw usage(`flag --${name} given twice`);
    const value = tokens[i + 1];
    if (value === undefined) throw usage(`flag --${name} needs a value`);
    flags.set(name, value);
    i++;
  }
  for (const name of spec.required) if (!flags.has(name)) throw usage(`missing flag --${name}`);
  return { flags, switches };
}

/** A required flag's value (parseFlags already proved it is present). */
function need(a: Args, name: string): string {
  const v = a.flags.get(name);
  if (v === undefined) throw usage(`missing flag --${name}`);
  return v;
}

function enumFlag<T extends string>(a: Args, name: string, allowed: readonly T[]): T {
  const v = need(a, name);
  if (oneOf(allowed, v)) return v;
  throw usage(`--${name} must be one of ${allowed.join(", ")}; got "${v}"`);
}

function listFlag(v: string): string[] {
  return v
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s !== "");
}

function findRow(board: Board, id: string): Row {
  const row = board.rows.find((r) => r.id === id);
  if (row === undefined) throw new CliError(1, `refused: unknown row ${id}`);
  return row;
}

// ---------------------------------------------------------------- commands

function cmdValidate(path: string): number {
  const board = load(path);
  const { errors, warnings } = checkBoard(board);
  for (const e of errors) console.error(`error: ${e}`);
  for (const w of warnings) console.error(`warning: ${w}`);
  if (errors.length > 0) return 1;
  console.log(`OK: ${board.rows.length} rows, ${board.units.length} units`);
  return 0;
}

function cmdShow(path: string, a: Args): number {
  const board = loadValid(path);
  if (!a.switches.has("json")) {
    console.log(showText(board));
    return 0;
  }
  const next = nextRow(board);
  console.log(JSON.stringify({ project: board.project, counts: counts(board), stall: stall(board), next: next === null ? null : next.id }, null, 2));
  return 0;
}

function cmdNext(path: string): number {
  const row = nextRow(loadValid(path));
  console.log(row === null ? JSON.stringify({ done: true }) : JSON.stringify(row, null, 2));
  return 0;
}

function cmdGate(path: string): number {
  const board = loadValid(path);
  const k = stall(board);
  if (k < 2) {
    console.log(`GO: stall ${k}`);
    return 0;
  }
  const top = nextRow(board);
  // A re-plan of the top row that is newer than the stall's start answers the gate: it fires again only
  // after 2 more units with no move (2026-11-10: the edition's gate said RE-PLAN at every handoff after REPLAN-R2.md).
  const replan = top === null ? undefined : statSync(join(dirname(path), `REPLAN-${top.id}.md`), { throwIfNoEntry: false });
  if (top !== null && replan !== undefined) {
    const since = stallEnds(board).filter((t) => t > replan.mtimeMs).length;
    const written = `REPLAN-${top.id}.md written ${localIso(replan.mtime)}`;
    if (since < 2 && since < k) {
      console.log(`GO: stall ${k}; ${written}; ${since} unit(s) with no move since then`);
      return 0;
    }
    if (since < k) {
      console.log(`RE-PLAN: ${since} units with no board move since ${written}; top red row ${top.id}: ${cut(top.sentence, 100)}`);
      return 5;
    }
  }
  const red = top === null ? "none (every row is proven)" : `${top.id}: ${cut(top.sentence, 100)}`;
  console.log(`RE-PLAN: ${k} units in a row with no board move; top red row ${red}`);
  return 5;
}

function cmdSetTest(path: string, a: Args): void {
  const kind = enumFlag(a, "kind", KINDS);
  update(path, (board) => {
    const row = findRow(board, need(a, "row"));
    const passRule = a.flags.get("pass-rule");
    row.test = {
      name: need(a, "name"),
      kind,
      command: a.flags.get("command") ?? row.test.command,
      passRule: passRule ?? row.test.passRule,
      ruleFile: a.flags.get("rule-file") ?? row.test.ruleFile,
      ruleSetAt: passRule === undefined ? row.test.ruleSetAt : localIso(),
    };
    return `${row.id}: test set (${row.test.name}, ${row.test.kind})`;
  });
}

function cmdMark(path: string, a: Args): void {
  const status = enumFlag(a, "status", STATUSES);
  const role = enumFlag(a, "role", ROLES);
  const evidence = listFlag(a.flags.get("evidence") ?? "").map((e) => (isUrl(e) ? e : resolve(e)));
  update(path, (board) => {
    const row = findRow(board, need(a, "row"));
    if (status === "proven" && role === "setup") throw new CliError(1, `refused: role setup cannot mark proven; only an examiner can`);
    if (status === "proven" && a.flags.get("set") === undefined) throw new CliError(1, `refused: proven needs --set <set id>`);
    if (status === "proven" && evidence.length === 0) throw new CliError(1, `refused: proven needs --evidence`);
    row.marks.push({
      at: localIso(),
      by: need(a, "by"),
      role,
      status,
      evidence,
      set: a.flags.get("set") ?? null,
      note: need(a, "note"),
    });
    const from = row.status;
    row.status = status;
    if (status === "proven") row.rank = null;
    return `${row.id}: ${from} -> ${status}`;
  });
}

function cmdRank(path: string, a: Args): void {
  const order = listFlag(need(a, "order"));
  if (order.length === 0) throw usage("--order needs at least one row id");
  const by = need(a, "by");
  update(path, (board) => {
    const twice = duplicates(order)[0];
    if (twice !== undefined) throw new CliError(1, `refused: row ${twice} listed twice in --order`);
    for (const id of order) {
      if (findRow(board, id).status === "proven") throw new CliError(1, `refused: row ${id} is proven; proven rows take no rank`);
    }
    const rest = board.rows
      .map((r, i) => ({ r, i }))
      .filter(({ r }) => !order.includes(r.id) && r.status !== "proven" && r.rank !== null)
      .sort((x, y) => (x.r.rank ?? 0) - (y.r.rank ?? 0) || x.i - y.i)
      .map(({ r }) => r.id);
    const ranks = new Map<string, number>([...order, ...rest].map((id, i) => [id, i + 1]));
    for (const r of board.rows) r.rank = ranks.get(r.id) ?? null;
    return `ranked by ${by}: ${[...ranks].map(([id, n]) => `${id}=${n}`).join(", ")}`;
  });
}

function cmdUnitOpen(path: string, a: Args): void {
  update(path, (board) => {
    const row = findRow(board, need(a, "row"));
    const max = Math.max(0, ...board.units.map((u) => /^U(\d+)$/.exec(u.id)).map((m) => (m?.[1] === undefined ? 0 : Number(m[1]))));
    const id = `U${max + 1}`;
    board.units.push({
      id,
      row: row.id,
      contract: need(a, "contract"),
      builder: need(a, "builder"),
      startedAt: localIso(),
      endedAt: null,
      result: "open",
      statusHashAtOpen: statusHash(board),
      rowStatusAtOpen: row.status,
      moved: null,
      note: "",
    });
    return id;
  });
}

function cmdUnitClose(path: string, a: Args): void {
  const result = enumFlag(a, "result", CLOSE_RESULTS);
  const id = need(a, "unit");
  update(path, (board) => {
    const unit = board.units.find((u) => u.id === id);
    if (unit === undefined) throw new CliError(1, `refused: unknown unit ${id}`);
    if (unit.result !== "open") throw new CliError(1, `refused: unit ${id} is not open (result ${unit.result})`);
    unit.endedAt = localIso();
    unit.result = result;
    unit.note = need(a, "note");
    // A move is this unit's own row going up, and the unit passed. A mark on another row (a parallel
    // exam) or a row that went up without this unit's change (result fail) is not a move (edition U2, 2026-11-09).
    const row = findRow(board, unit.row);
    const before = unit.rowStatusAtOpen ?? statusBefore(row, unit.startedAt);
    unit.moved = result === "pass" && STATUS_ORDER[row.status] > STATUS_ORDER[before];
    return `${id}: ${result}, moved ${unit.moved} (${unit.row} ${before} -> ${row.status})`;
  });
}

function run(argv: string[]): number {
  const [command, path, ...rest] = argv;
  if (command === undefined) throw usage("missing command");
  const spec = COMMANDS[command];
  if (spec === undefined) throw usage(`unknown command "${command}"`);
  if (path === undefined || path.startsWith("--")) throw usage("missing board path");
  const a = parseFlags(rest, spec);
  switch (command) {
    case "validate":
      return cmdValidate(path);
    case "show":
      return cmdShow(path, a);
    case "next":
      return cmdNext(path);
    case "gate":
      return cmdGate(path);
    case "set-test":
      cmdSetTest(path, a);
      return 0;
    case "mark":
      cmdMark(path, a);
      return 0;
    case "rank":
      cmdRank(path, a);
      return 0;
    case "unit-open":
      cmdUnitOpen(path, a);
      return 0;
    case "unit-close":
      cmdUnitClose(path, a);
      return 0;
    default:
      throw usage(`unknown command "${command}"`);
  }
}

if (import.meta.main) {
  try {
    process.exit(run(process.argv.slice(2)));
  } catch (err) {
    if (!(err instanceof CliError)) throw err;
    console.error(err.message);
    process.exit(err.code);
  }
}
