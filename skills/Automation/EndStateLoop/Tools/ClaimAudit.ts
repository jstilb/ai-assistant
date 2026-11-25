#!/usr/bin/env bun
/**
 * ClaimAudit.ts: the claim audit per merge (Workflows/Check.md, "Claim audit (per merge)"), run by a loop driver.
 *
 * Why (Jm, form-doc F-029, 2026-11-24): "how do those orchestrators maintain focus to make meaningful progress (even
 * without you steering them)?" A loop that checks its own work ships false claims, and each one counts as a move.
 * The fix is a reviewer the loop cannot set: after each merge, one fresh headless Claude (sonnet) reads the unit's
 * claims against the product output and the code on the merged commit, writes units/<id>/AUDIT.md, and the verdict
 * goes on the board with `Board.ts unit-audit` (a fail revokes the move; two revoked units in a row make the gate say
 * RE-PLAN). A Gemini (agy) orchestrator cannot start Claude agents, so its driver calls this between steps. A Claude
 * orchestrator can call it too, or run the same brief as an Agent.
 *
 *   next <board> [--since U<n>]                 the oldest closed unit that shipped a live change and has no audit
 *                                               (and no audit attempt in the last 20 min, fewer than 3 attempts); or "none"
 *   run  <board> --unit U<n> --by NAME [--results FILE] [--timeout-min 25] [--no-board] [--dry-run]
 *                                               --no-board: write AUDIT.md only (a trial); --dry-run: print the brief only
 *
 * Exit: 0 audit recorded (or `next` answered); 1 usage or refusal; 3 no verdict (infra, timeout, malformed output):
 * nothing is written to the board, and `next` offers the unit again after 20 min (at most 3 attempts).
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { z } from "zod";
import { parseVerdictBlock, spawnAgentSync } from "../../../../lib/core/AgentSpawner.ts";
import { type Board, localIso, parseBoard, type Unit } from "./Board.ts";

const BOARD_TS = join(import.meta.dir, "Board.ts");
const CHECK_MD = join(import.meta.dir, "..", "Workflows", "Check.md");
const RETRY_AFTER_MS = 20 * 60 * 1000;
const MAX_ATTEMPTS = 3;
const SHIPPED_NONE = "none";

export const VerdictSchema = z.object({
  true: z.number().int().min(0),
  false: z.number().int().min(0),
  unclear: z.number().int().min(0),
  liveChange: z.enum(["verified", "not-verified"]),
  note: z.string().min(1).max(600),
});
export type Verdict = z.infer<typeof VerdictSchema>;

export interface Attempts {
  n: number;
  last: string;
}

export function unitNumber(id: string): number {
  const m = /^U(\d+)$/.exec(id);
  return m ? Number(m[1]) : -1;
}

export function shippedLive(u: Unit): boolean {
  return u.result !== "open" && u.shipped !== null && u.shipped !== SHIPPED_NONE;
}

/** The merged commit of a unit: the first hex run of 7-40 chars in `shipped`. */
export function mergedCommit(u: Unit): string | null {
  const m = /\b[0-9a-f]{7,40}\b/.exec(u.shipped ?? "");
  return m ? m[0] : null;
}

/** Oldest first: closed, shipped live, not audited, id >= since, not tried in the last 20 min, fewer than 3 tries. */
export function pickUnit(board: Board, since: number, attemptsOf: (id: string) => Attempts | null, now: number): Unit | null {
  const due = board.units.filter((u) => {
    if (!shippedLive(u) || u.audit !== undefined || unitNumber(u.id) < since) return false;
    const a = attemptsOf(u.id);
    if (a === null) return true;
    return a.n < MAX_ATTEMPTS && now - Date.parse(a.last) >= RETRY_AFTER_MS;
  });
  due.sort((x, y) => unitNumber(x.id) - unitNumber(y.id));
  return due[0] ?? null;
}

const POST_AFTER_CLOSE_MS = 10 * 60 * 1000;

/**
 * The newest status post whose facts.closed names the unit; else the newest post written while the unit was open
 * (startedAt .. endedAt + 10 min). The fallback is for drivers that close the unit after the step that wrote the post
 * (BOARD-REQUESTS), so the post's facts do not list it yet.
 */
export function findPost(outDir: string, unit: Unit): string | null {
  if (!existsSync(outDir)) return null;
  const files = readdirSync(outDir).filter((f) => /-\d+\.json$/.test(f)).sort().reverse();
  const from = Date.parse(unit.startedAt);
  const to = unit.endedAt === null ? Number.POSITIVE_INFINITY : Date.parse(unit.endedAt) + POST_AFTER_CLOSE_MS;
  let during: string | null = null;
  for (const f of files) {
    try {
      const post = JSON.parse(readFileSync(join(outDir, f), "utf-8")) as { at?: string; facts?: { closed?: { id?: string }[] } };
      if ((post.facts?.closed ?? []).some((c) => c.id === unit.id)) return join(outDir, f);
      const at = Date.parse(post.at ?? "");
      if (during === null && at >= from && at <= to) during = join(outDir, f);
    } catch {
      continue;
    }
  }
  return during;
}

/** The "Claim audit (per merge)" section of Check.md, verbatim (the one source of the rules). */
export function checkSection(checkMd: string): string {
  const start = checkMd.indexOf("## Claim audit (per merge)");
  if (start === -1) throw new Error("Check.md has no '## Claim audit (per merge)' section");
  const next = checkMd.indexOf("\n## ", start + 5);
  return checkMd.slice(start, next === -1 ? undefined : next).trim();
}

export function buildBrief(o: { board: Board; boardPath: string; unit: Unit; commit: string; post: string | null; rules: string }): string {
  const row = o.board.rows.find((r) => r.id === o.unit.row);
  const unitDir = join(dirname(o.boardPath), "units", o.unit.id);
  return [
    `You are the claim auditor of unit ${o.unit.id} of the project "${o.board.project}". You did not build or review it.`,
    `Read-only: change no file, no git state, no board; start no agents, servers or long product runs. Budget: about 25 tool calls.`,
    ``,
    `The rules (Kaya EndStateLoop Check.md, verbatim):`,
    o.rules,
    ``,
    `Inputs:`,
    `- Product repo: ${o.board.folder}. Merged commit: ${o.commit} (read code with \`git -C ${o.board.folder} show ${o.commit}:<path>\` or \`git grep <pattern> ${o.commit}\`).`,
    `- Row ${o.unit.row}: "${row?.sentence ?? "(row not found)"}". Source (Jm's words): ${row?.source ?? "(none)"}.`,
    `- Unit contract: ${o.unit.contract}. Unit folder: ${unitDir} (product outputs, pictures, run folders).`,
    o.post === null
      ? `- No status post names this unit. The claims are the "done"/result lines of the unit's RESULT.md or BUILDER-RESULT.md.`
      : `- The status post (the claims Jm will read): ${o.post}. Audit its "where", "done" and "progress" text, claim by claim.`,
    `- Do NOT use the builder's or reviewer's verdict as evidence (REVIEW.md, review/ folders, "Verdict: Pass" lines). A claim is TRUE only by the product output, the picture, or the code on ${o.commit}.`,
    ``,
    `Answer format (nothing after the verdict block):`,
    `<audit>`,
    `- TRUE|FALSE|UNCLEAR: <the claim, short> — <evidence: file:line, command output, or the picture path>`,
    `(one line per claim)`,
    `LIVE CHANGE: verified|not-verified — <what on the merged commit's product output shows the change>`,
    `</audit>`,
    `<verdict>{"true": <n>, "false": <n>, "unclear": <n>, "liveChange": "verified"|"not-verified", "note": "<one line: the FALSE and UNCLEAR claims with their evidence; else 'all claims hold'>"}</verdict>`,
  ].join("\n");
}

export function extractAudit(stdout: string): string | null {
  const s = stdout.indexOf("<audit>");
  const e = stdout.indexOf("</audit>", s + 7);
  if (s === -1 || e === -1) return null;
  const body = stdout.slice(s + 7, e).trim();
  return body.length > 0 ? body : null;
}

/** Check.md: FALSE -> fail; UNCLEAR -> pass only when the live change is verified (a correction post); all TRUE -> pass. */
export function decide(v: Verdict): { result: "pass" | "fail"; correction: boolean } | null {
  if (v.true + v.false + v.unclear === 0) return null;
  if (v.false > 0) return { result: "fail", correction: true };
  if (v.unclear > 0) return v.liveChange === "verified" ? { result: "pass", correction: true } : { result: "fail", correction: true };
  return { result: "pass", correction: false };
}

function readAttempts(file: string): Attempts | null {
  if (!existsSync(file)) return null;
  try {
    const a = JSON.parse(readFileSync(file, "utf-8")) as Attempts;
    return typeof a.n === "number" && typeof a.last === "string" ? a : null;
  } catch {
    return null;
  }
}

function flag(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? undefined : argv[i + 1];
}

function loadBoard(path: string): Board {
  const { board, errors } = parseBoard(JSON.parse(readFileSync(path, "utf-8")));
  if (board === null) throw new Error(`invalid board ${path}: ${errors.slice(0, 3).join("; ")}`);
  return board;
}

function main(argv: string[]): number {
  const [cmd, boardPath, ...rest] = argv;
  if ((cmd !== "next" && cmd !== "run") || boardPath === undefined) {
    console.error("usage: ClaimAudit.ts next <board> [--since U<n>] | run <board> --unit U<n> --by NAME [--results FILE] [--timeout-min N] [--no-board] [--dry-run]");
    return 1;
  }
  const board = loadBoard(boardPath);
  const unitsDir = join(dirname(boardPath), "units");
  const attemptsFile = (id: string) => join(unitsDir, id, "AUDIT.attempts.json");
  if (cmd === "next") {
    const since = flag(rest, "since");
    const u = pickUnit(board, since === undefined ? 0 : unitNumber(since), (id) => readAttempts(attemptsFile(id)), Date.now());
    console.log(u === null ? "none" : u.id);
    return 0;
  }
  const id = flag(rest, "unit");
  const by = flag(rest, "by");
  if (id === undefined || by === undefined) {
    console.error("run needs --unit and --by");
    return 1;
  }
  const unit = board.units.find((u) => u.id === id);
  if (unit === undefined || !shippedLive(unit)) {
    console.error(`refused: ${id} is not a closed unit with a live change`);
    return 1;
  }
  const commit = mergedCommit(unit);
  if (commit === null) {
    console.error(`refused: ${id} names no commit in shipped (${unit.shipped})`);
    return 1;
  }
  const post = findPost(join(dirname(boardPath), "status", "out"), unit);
  const brief = buildBrief({ board, boardPath, unit, commit, post, rules: checkSection(readFileSync(CHECK_MD, "utf-8")) });
  if (rest.includes("--dry-run")) {
    console.log(brief);
    return 0;
  }
  const unitDir = join(unitsDir, id);
  mkdirSync(unitDir, { recursive: true });
  const prev = readAttempts(attemptsFile(id));
  writeFileSync(attemptsFile(id), JSON.stringify({ n: (prev?.n ?? 0) + 1, last: localIso() }));
  const minutes = Number(flag(rest, "timeout-min") ?? "25");
  const res = spawnAgentSync({
    prompt: brief,
    model: "sonnet",
    effort: "medium",
    allowedTools: "Read,Grep,Glob,Bash",
    enforceTools: true,
    guardHooks: true,
    settings: "readonly", // --permission-mode plan, never skip-permissions: the claims were written by another model
    cwd: board.folder,
    timeoutMs: minutes * 60 * 1000,
  });
  const verdict = parseVerdictBlock(res.stdout, { start: "<verdict>", end: "</verdict>" }, VerdictSchema);
  const audit = extractAudit(res.stdout);
  const decision = verdict === null ? null : decide(verdict);
  if (verdict === null || audit === null || decision === null) {
    const why = res.preSpawnGated ? "rate-limit gate" : res.timedOut ? "timeout" : res.infraReason ?? (res.success ? "malformed answer" : `exit ${res.exitCode}`);
    writeFileSync(join(unitDir, "AUDIT.failed-run.txt"), `${localIso()} ${why}\n--- stdout (tail) ---\n${res.stdout.slice(-4000)}\n--- stderr (tail) ---\n${res.stderr.slice(-2000)}\n`);
    console.log(`claim audit ${id}: NO VERDICT (${why}); nothing on the board; retry after 20 min (attempt ${(prev?.n ?? 0) + 1} of ${MAX_ATTEMPTS})`);
    return 3;
  }
  const auditPath = join(unitDir, "AUDIT.md");
  writeFileSync(
    auditPath,
    `# Claim audit ${id} (${localIso()}, by ${by}: fresh headless sonnet, ClaimAudit.ts)\n\nCommit ${commit}. Post: ${post ?? "none"}. Result: ${decision.result}${decision.correction ? " (correction post needed)" : ""}.\n\n${audit}\n\nVerdict: ${JSON.stringify(verdict)}\n`,
  );
  const note = `${decision.result === "fail" ? "FAIL" : decision.correction ? "UNCLEAR, live change verified" : "all TRUE"}: ${verdict.note}`;
  if (!rest.includes("--no-board")) {
    const w = spawnSync("bun", [BOARD_TS, "unit-audit", boardPath, "--unit", id, "--result", decision.result, "--by", by, "--note", note, "--evidence", auditPath], { encoding: "utf-8" });
    if (w.status !== 0) {
      console.error(`claim audit ${id}: board write failed: ${(w.stderr || w.stdout).trim()}`);
      return 1;
    }
  }
  const line = `claim audit ${id}: ${decision.result.toUpperCase()}${decision.correction ? " + correction post" : ""} (${verdict.true} true, ${verdict.false} false, ${verdict.unclear} unclear; live change ${verdict.liveChange}) -> ${auditPath}`;
  console.log(line);
  const results = flag(rest, "results");
  if (results !== undefined) {
    const todo = decision.correction
      ? `Do next: write a correction post${post ? ` for ${post.split("/").pop()}` : ""} that removes or narrows each FALSE/UNCLEAR claim in ${auditPath}${decision.result === "fail" ? "; the unit's move is revoked; mark its row failed if the row's claim rests on it" : ""}.`
      : "No action.";
    // A small Markdown file that the next orch step reads (not a log): read and rewrite, no rotation.
    writeFileSync(results, `${existsSync(results) ? readFileSync(results, "utf-8") : ""}\n## ${line}\n${note}\n${todo}\n`);
  }
  return 0;
}

if (import.meta.main) {
  try {
    process.exit(main(process.argv.slice(2)));
  } catch (e) {
    console.error(`ClaimAudit: ${(e as Error).message}`);
    process.exit(1);
  }
}
