#!/usr/bin/env bun
/**
 * ProjectStatus.ts — status and gap check for projects on the project standard.
 *
 * Reads each project's AGENTS.md and FEEDBACK.md when it runs (no copy, no sync job) and prints
 * one line per project: status, standard version, age of the current bet, open and decided
 * feedback items, and the size of AGENTS.md. `--check` also lists gaps that a machine can see
 * for certain (no stamped AGENTS.md, an old standard version, no FEEDBACK.md, no CLAUDE.md
 * import) and exits 1 when any exist. It reports; it never blocks work. Ages, counts and the
 * size of AGENTS.md are context for a reader, not verdicts: a size over the budget prints as a
 * NOTE and does not change the exit code (Jm's rule: numbers are context, not gates).
 *
 * Projects: every non-hidden folder in ~/projects (or --projects-dir) that is a git repo or has
 * a stamped AGENTS.md, plus each --root (the folder itself if it has AGENTS.md, else its
 * subfolders), plus every skill folder in ~/.claude/skills/<category>/ with a stamped AGENTS.md
 * (LifeOS is one).
 *
 * "last work" is the newest of: the newest commit in the folder on any branch, and the newest
 * handoff file of the project's chain in ~/.kaya/handoffs (the `Chain: <name>-N` line of
 * AGENTS.md). It is context for the product review, never a gap: an `active` project whose last
 * work is old and whose newest handoff is not PAUSED may have stopped without Jm's word
 * (standard, point 5).
 *
 * Usage: bun ProjectStatus.ts [--check] [--json] [--root <dir>]... [--projects-dir <dir>]
 * Exit:  0 = ok, 1 = --check found gaps, 2 = bad arguments.
 *
 * Standard: ~/.claude/skills/Development/ProjectStandard/SKILL.md
 *
 * @module ProjectStatus
 */

import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { kayaHomePath } from "../../../../lib/core/KayaHome.ts";
import {
  listProjectRefs,
  PROJECT_STANDARD_STAMP_RE,
  type ProjectRef,
  readIfExists,
  resolveProjectRef,
  skillProjectDirs,
  stripComments,
  subfolders,
} from "../../../../lib/core/ProjectRefs.ts";

// Shared with the LifeOS capture Router through lib/ (ADR-006); re-exported so callers keep one import.
export { listProjectRefs, type ProjectRef, resolveProjectRef, skillProjectDirs, stripComments };

const STAMP_RE = PROJECT_STANDARD_STAMP_RE;
const TOKEN_BUDGET = 1500;
const TEMPLATE_AGENTS = join(import.meta.dir, "..", "Templates", "AGENTS.md");
const HANDOFFS_DIR = join(homedir(), ".kaya", "handoffs");
const DAY_MS = 86_400_000;

export interface AgentsInfo {
  version: number | null;
  status: string | null;
  betDate: string | null;
  tokens: number;
  /** Chain prefix from `Chain: <name>-N`, for example "lifeos-loop-"; null if none. */
  chain: string | null;
}

export interface LastWork {
  /** YYYY-MM-DD of the newest commit in the folder (any branch) or chain handoff; null if none found. */
  date: string | null;
  /** True when the newest chain handoff starts with "PAUSED" (a recorded stop, not a silent one). */
  pausedHandoff: boolean;
}

export interface FeedbackItem {
  id: string;
  date: string | null;
  hasOutcome: boolean;
}

export interface FeedbackInfo {
  open: FeedbackItem[];
  decided: FeedbackItem[];
}

export interface ProjectReport {
  name: string;
  dir: string;
  isGitRepo: boolean;
  agents: AgentsInfo | null;
  feedback: FeedbackInfo | null;
  claudeImportsAgents: boolean;
  lastWork: LastWork;
}

/** Text of a `## <name>` section, up to the next `## ` heading (comments removed). */
function section(text: string, name: string): string {
  const visible = stripComments(text);
  const lines = visible.split("\n");
  const start = lines.findIndex((l) => l.trim().toLowerCase() === `## ${name}`.toLowerCase());
  if (start === -1) return "";
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => l.startsWith("## "));
  return (end === -1 ? rest : rest.slice(0, end)).join("\n");
}

export function parseAgents(raw: string): AgentsInfo {
  const stamp = raw.match(STAMP_RE);
  const visible = stripComments(raw);
  const status = visible.match(/^Status:\s*([A-Za-z]+)/m);
  const bet = section(raw, "Current bet").match(/Written:\s*(\d{4}-\d{2}-\d{2})/);
  const chain = visible.match(/Chain:\s*`?([A-Za-z0-9][A-Za-z0-9-]*-)N\b/);
  return {
    version: stamp ? Number(stamp[1]) : null,
    status: status ? status[1].toLowerCase() : null,
    betDate: bet ? bet[1] : null,
    tokens: Math.ceil(raw.length / 4),
    chain: chain ? chain[1] : null,
  };
}

function isoDay(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number): string => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Newest commit date (YYYY-MM-DD) that touches `dir`, on any branch; null if git has none. */
function newestCommit(dir: string): string | null {
  const r = Bun.spawnSync(["git", "-C", dir, "log", "--all", "-1", "--format=%cs", "--", "."], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const out = r.stdout.toString().trim();
  return r.exitCode === 0 && /^\d{4}-\d{2}-\d{2}$/.test(out) ? out : null;
}

/** Last work on a project: newest commit in its folder and newest handoff file of its chain. */
export function findLastWork(dir: string, chain: string | null, handoffsDir: string): LastWork {
  const dates: string[] = [];
  const commit = newestCommit(dir);
  if (commit) dates.push(commit);
  let pausedHandoff = false;
  if (chain && existsSync(handoffsDir)) {
    const handoffs = readdirSync(handoffsDir)
      .filter((n) => n.endsWith(".md") && n.includes(chain))
      .map((n) => join(handoffsDir, n))
      .map((p) => ({ p, mtime: statSync(p).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime);
    const newest = handoffs[0];
    if (newest) {
      dates.push(isoDay(newest.mtime));
      const firstLine =
        readFileSync(newest.p, "utf8")
          .split("\n")
          .find((l) => l.trim() !== "") ?? "";
      pausedHandoff = /^\s*#*\s*PAUSED\b/i.test(firstLine);
    }
  }
  dates.sort();
  return { date: dates.length > 0 ? dates[dates.length - 1] : null, pausedHandoff };
}

function parseItems(sectionText: string): FeedbackItem[] {
  const items: FeedbackItem[] = [];
  const blocks = sectionText.split(/^(?=###\s+F-\d+)/m).filter((b) => /^###\s+F-\d+/.test(b));
  for (const block of blocks) {
    const id = block.match(/^###\s+(F-\d+)/);
    if (!id) continue;
    const date = block.split("\n")[0].match(/\d{4}-\d{2}-\d{2}/);
    const outcome = block.match(/\*\*Outcome:\*\*[ \t]*(\S[^\n]*)?/);
    const outcomeText = outcome?.[1]?.trim() ?? "";
    items.push({
      id: id[1],
      date: date ? date[0] : null,
      hasOutcome: outcomeText.length > 0 && !outcomeText.startsWith("<"),
    });
  }
  return items;
}

export function parseFeedback(raw: string): FeedbackInfo {
  return { open: parseItems(section(raw, "Open")), decided: parseItems(section(raw, "Decided")) };
}

function claudeImportsAgents(dir: string): boolean {
  const claudePath = join(dir, "CLAUDE.md");
  const agentsPath = join(dir, "AGENTS.md");
  if (!existsSync(claudePath) || !existsSync(agentsPath)) return false;
  if (realpathSync(claudePath) === realpathSync(agentsPath)) return true;
  return /^@AGENTS\.md\s*$/m.test(readFileSync(claudePath, "utf8"));
}

export function inspectProject(dir: string, handoffsDir: string = HANDOFFS_DIR): ProjectReport {
  const agentsRaw = readIfExists(join(dir, "AGENTS.md"));
  const feedbackRaw = readIfExists(join(dir, "FEEDBACK.md"));
  const parsed = agentsRaw === null ? null : parseAgents(agentsRaw);
  const agents = parsed && parsed.version !== null ? parsed : null;
  // A real repo has a .git folder; a git worktree has a .git file and is not a separate project.
  const isGitRepo = existsSync(join(dir, ".git")) && statSync(join(dir, ".git")).isDirectory();
  return {
    name: basename(dir),
    dir,
    isGitRepo,
    agents,
    feedback: feedbackRaw === null ? null : parseFeedback(feedbackRaw),
    claudeImportsAgents: claudeImportsAgents(dir),
    // Only for folders that are projects: the scan also sees plain folders, and git is slow per call.
    lastWork:
      isGitRepo || agents !== null
        ? findLastWork(dir, agents?.chain ?? null, handoffsDir)
        : { date: null, pausedHandoff: false },
  };
}

export function collectProjects(
  projectsDir: string,
  roots: string[],
  handoffsDir: string = HANDOFFS_DIR,
): ProjectReport[] {
  const dirs = new Set<string>();
  for (const d of subfolders(projectsDir)) dirs.add(resolve(d));
  for (const root of roots) {
    const r = resolve(root);
    if (existsSync(join(r, "AGENTS.md"))) dirs.add(r);
    else for (const d of subfolders(r)) dirs.add(resolve(d));
  }
  return [...dirs]
    .map((d) => inspectProject(d, handoffsDir))
    .filter((p) => p.isGitRepo || p.agents !== null)
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function currentVersion(templatePath: string = TEMPLATE_AGENTS): number {
  const m = readFileSync(templatePath, "utf8").match(STAMP_RE);
  if (!m) throw new Error(`no project-standard stamp in ${templatePath}`);
  return Number(m[1]);
}

export function findGaps(p: ProjectReport, current: number): string[] {
  if (p.agents === null) return ["not on the standard (no AGENTS.md with the project-standard stamp)"];
  if (p.agents.status === "done" || p.agents.status === "cancelled") return [];
  const gaps: string[] = [];
  if (p.agents.version !== null && p.agents.version < current) gaps.push(`behind: v${p.agents.version} < v${current}`);
  if (p.feedback === null) gaps.push("no FEEDBACK.md");
  if (!p.claudeImportsAgents) gaps.push("CLAUDE.md does not import AGENTS.md (Claude Code will not load it)");
  return gaps;
}

/** Context for a reader, never a gap: the size of AGENTS.md against the budget. */
export function findNotes(p: ProjectReport): string[] {
  if (p.agents === null || p.agents.tokens <= TOKEN_BUDGET) return [];
  return [`AGENTS.md is about ${p.agents.tokens} tokens (budget about ${TOKEN_BUDGET}; context, not a gap)`];
}

export function daysSince(date: string, now: Date = new Date()): number {
  return Math.floor((now.getTime() - new Date(`${date}T00:00:00`).getTime()) / DAY_MS);
}

export function formatLine(p: ProjectReport, now: Date = new Date()): string {
  if (p.agents === null) return `${p.name}: not on the standard`;
  const a = p.agents;
  const parts = [`${p.name}: ${a.status ?? "no status"}`, `v${a.version}`];
  parts.push(a.betDate ? `bet ${a.betDate} (${daysSince(a.betDate, now)} d)` : "bet: no date");
  if (p.feedback === null) parts.push("no FEEDBACK.md");
  else {
    const open = p.feedback.open;
    const dated = open
      .map((i) => i.date)
      .filter((d): d is string => d !== null)
      .sort();
    const oldest = dated.length > 0 ? ` (oldest ${daysSince(dated[0], now)} d)` : "";
    const outcomes = p.feedback.decided.filter((i) => i.hasOutcome).length;
    parts.push(`open ${open.length}${oldest}`, `decided ${p.feedback.decided.length} (outcome ${outcomes})`);
  }
  parts.push(`~${a.tokens} tok`);
  const w = p.lastWork;
  parts.push(w.date ? `last work ${w.date} (${daysSince(w.date, now)} d)` : "last work: none found");
  if (w.pausedHandoff) parts.push("newest handoff PAUSED");
  return parts.join(" · ");
}

function main(argv: string[]): number {
  let check = false;
  let json = false;
  let projectsDir = join(homedir(), "projects");
  let skillsDir = kayaHomePath("skills");
  const roots: string[] = [];
  const usage =
    "usage: bun ProjectStatus.ts [--check] [--json] [--root <dir>]... [--projects-dir <dir>] [--skills-dir <dir>]";
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--check") check = true;
    else if (arg === "--json") json = true;
    else if (arg === "--root" || arg === "--projects-dir" || arg === "--skills-dir") {
      const value = argv[++i];
      if (!value) {
        console.error(`${arg} needs a folder`);
        return 2;
      }
      if (arg === "--root") roots.push(value);
      else if (arg === "--projects-dir") projectsDir = value;
      else skillsDir = value;
    } else {
      console.error(`unknown argument: ${arg}\n${usage}`);
      return 2;
    }
  }

  const current = currentVersion();
  const projects = collectProjects(projectsDir, [...roots, ...skillProjectDirs(skillsDir)]);
  const withGaps = projects.map((p) => ({ project: p, gaps: findGaps(p, current), notes: findNotes(p) }));

  if (json) {
    console.log(JSON.stringify({ standardVersion: current, projects: withGaps }, null, 2));
  } else {
    console.log(`Project standard v${current} · ${projects.length} projects`);
    for (const { project, gaps, notes } of withGaps) {
      console.log(`- ${formatLine(project)}`);
      if (check) for (const g of gaps) console.log(`    GAP: ${g}`);
      if (check) for (const n of notes) console.log(`    NOTE: ${n}`);
    }
  }
  const gapCount = withGaps.reduce((n, w) => n + w.gaps.length, 0);
  if (check && !json) console.log(gapCount === 0 ? "No gaps." : `${gapCount} gaps.`);
  return check && gapCount > 0 ? 1 : 0;
}

if (import.meta.main) process.exit(main(process.argv.slice(2)));
