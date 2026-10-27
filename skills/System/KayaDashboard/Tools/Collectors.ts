/**
 * Collectors.ts — read-only data collectors for the Kaya dashboard.
 *
 * Every collector reads LIVE Kaya state (KAYA_HOME, ~/.kaya) and returns plain JSON.
 * Each is wrapped by the server in its own try/catch, so one broken source renders as an
 * error card instead of blanking the page — loud, not silent.
 *
 * Sources (see ../PRD.md §Inventory for the full map):
 *   sessions   ~/.claude/projects/<slug>/<sessionId>.jsonl  (+ history.jsonl = interactive)
 *   usage      history.jsonl, MEMORY/LEARNING/SIGNALS/ratings.jsonl, cron run-ledger
 *   skills     skills/<Category>/<Sub>/SKILL.md frontmatter
 *   hooks      settings.json "hooks"
 *   context    CLAUDE.md, CONTEXT-ROUTING.md, USER/*, TELOS, ~/.kaya/memory index
 *   telegram   MEMORY/TELEGRAM/outbound.jsonl + Telegram-delivering cron manifests
 *   projects   USER/TELOS/PROJECTS.md, LucidTasks projects table
 *   work       LucidTasks tasks, autonomous-executor log, git log
 *   systems    QUEUES/state.json, tech-debt.jsonl, MONITORING failure log
 *   diagrams   SystemFlowchart Output/*.md + docs/architecture.md mermaid, graph meta.json
 */

import { existsSync, readFileSync, readdirSync, statSync } from "fs";
import { join, relative, resolve, basename } from "path";
import { homedir } from "os";
import { spawnSync } from "child_process";
import { Database } from "bun:sqlite";
import { getKayaHome } from "../../../../lib/core/KayaHome.ts";
import { tailFile, listJobs, type Job } from "./Jobs.ts";

export function kayaHome(): string {
  return getKayaHome();
}
const kayaShared = () => join(homedir(), ".kaya");
/** Claude Code's own data dir (projects/ transcripts, history.jsonl) — the same dir as KAYA_HOME on this install. */
const claudeDataDir = () => process.env.CLAUDE_CONFIG_DIR ?? getKayaHome();

function readJsonl<T = Record<string, unknown>>(path: string, maxBytes = 1024 * 1024): T[] {
  const out: T[] = [];
  for (const line of tailFile(path, maxBytes).split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      // tail-boundary partial line
    }
  }
  return out;
}

function readText(path: string): string {
  return existsSync(path) ? readFileSync(path, "utf8") : "";
}

function localDate(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** Parse `---\nkey: value\n---` frontmatter (single-line values only). */
export function parseFrontmatter(md: string): Record<string, string> {
  const m = md.match(/^---\n([\s\S]*?)\n---/);
  const out: Record<string, string> = {};
  if (!m) return out;
  for (const line of m[1].split("\n")) {
    const kv = line.match(/^([A-Za-z_][\w-]*):\s*(.*)$/);
    if (kv) out[kv[1]] = kv[2].replace(/^["']|["']$/g, "");
  }
  return out;
}

// ── Sessions ────────────────────────────────────────────────────────────────

export interface SessionSummary {
  sessionId: string;
  title: string;
  firstPrompt: string;
  cwd: string;
  project: string;
  updatedAt: string;
  sizeKB: number;
  interactive: boolean;
  transcriptPath: string;
}

/** Pull title / first user prompt / cwd out of a transcript's head+tail without reading it all. */
export function summarizeTranscript(head: string, tail: string): { title: string; firstPrompt: string; cwd: string } {
  let title = "";
  let firstPrompt = "";
  let cwd = "";
  for (const line of tail.split("\n").reverse()) {
    if (!title && line.includes('"ai-title"')) {
      try {
        title = JSON.parse(line).aiTitle ?? "";
      } catch {}
    }
    if (title) break;
  }
  for (const line of head.split("\n")) {
    if (!line.includes('"type":"user"')) continue;
    try {
      const r = JSON.parse(line);
      cwd ||= r.cwd ?? "";
      const c = r.message?.content;
      const text = typeof c === "string" ? c : Array.isArray(c) ? (c.find((p: { type: string }) => p.type === "text")?.text ?? "") : "";
      if (text && !text.startsWith("<")) {
        firstPrompt = text;
        break;
      }
    } catch {}
  }
  return { title, firstPrompt: firstPrompt.replace(/\s+/g, " ").slice(0, 220), cwd };
}

function readHead(path: string, bytes: number): string {
  const fd = Bun.file(path);
  return fd.size === 0 ? "" : readFileSync(path).subarray(0, bytes).toString("utf8");
}

let sessionCache: { at: number; data: SessionSummary[] } | null = null;

export function recentSessions(limit = 40, opts: { recentDays?: number } = {}): SessionSummary[] {
  if (sessionCache && Date.now() - sessionCache.at < 60_000) return sessionCache.data.slice(0, limit);
  const root = join(claudeDataDir(), "projects");
  const cutoff = Date.now() - (opts.recentDays ?? 14) * 86400_000;
  const interactive = new Set(readJsonl<{ sessionId: string }>(join(claudeDataDir(), "history.jsonl"), 4 * 1024 * 1024).map((h) => h.sessionId));
  const files: { path: string; mtime: number; size: number; slug: string }[] = [];
  for (const slug of existsSync(root) ? readdirSync(root) : []) {
    const dir = join(root, slug);
    let st;
    try {
      st = statSync(dir);
    } catch {
      continue;
    }
    // A session file's creation bumps its dir mtime — skip dirs untouched in the window.
    if (!st.isDirectory() || st.mtimeMs < cutoff) continue;
    for (const f of readdirSync(dir)) {
      if (!f.endsWith(".jsonl")) continue;
      const p = join(dir, f);
      const s = statSync(p);
      if (s.mtimeMs >= cutoff) files.push({ path: p, mtime: s.mtimeMs, size: s.size, slug });
    }
  }
  files.sort((a, b) => b.mtime - a.mtime);
  const data = files.slice(0, 120).map((f) => {
    const sessionId = basename(f.path, ".jsonl");
    const s = summarizeTranscript(readHead(f.path, 96 * 1024), tailFile(f.path, 128 * 1024));
    return {
      sessionId,
      title: s.title || s.firstPrompt.slice(0, 80) || "(untitled)",
      firstPrompt: s.firstPrompt,
      cwd: s.cwd,
      project: s.cwd ? basename(s.cwd) : f.slug,
      updatedAt: new Date(f.mtime).toISOString(),
      sizeKB: Math.round(f.size / 1024),
      interactive: interactive.has(sessionId),
      transcriptPath: f.path,
    };
  });
  sessionCache = { at: Date.now(), data };
  return data.slice(0, limit);
}

/** Readable transcript: user + assistant text turns only (tool noise stripped). */
export function sessionTranscript(sessionId: string, maxTurns = 400): { sessionId: string; path: string; turns: { role: string; ts: string; text: string }[] } {
  if (!/^[0-9a-f-]{36}$/.test(sessionId)) throw new Error("bad session id");
  const root = join(claudeDataDir(), "projects");
  let path = "";
  for (const slug of readdirSync(root)) {
    const p = join(root, slug, `${sessionId}.jsonl`);
    if (existsSync(p)) {
      path = p;
      break;
    }
  }
  if (!path) throw new Error("transcript not found");
  const turns: { role: string; ts: string; text: string }[] = [];
  for (const line of tailFile(path, 8 * 1024 * 1024).split("\n")) {
    if (!line.includes('"type":"user"') && !line.includes('"type":"assistant"')) continue;
    try {
      const r = JSON.parse(line);
      if (r.type !== "user" && r.type !== "assistant") continue;
      if (r.isSidechain) continue;
      const c = r.message?.content;
      const text =
        typeof c === "string"
          ? c
          : Array.isArray(c)
            ? c.filter((p: { type: string }) => p.type === "text").map((p: { text: string }) => p.text).join("\n")
            : "";
      if (text.trim()) turns.push({ role: r.type, ts: r.timestamp ?? "", text: text.slice(0, 6000) });
    } catch {}
  }
  return { sessionId, path, turns: turns.slice(-maxTurns) };
}

// ── Usage patterns ──────────────────────────────────────────────────────────

export interface Usage {
  days: { date: string; prompts: number; sessions: number; cronOk: number; cronFail: number; avgRating: number | null }[];
  hourOfDay: number[];
  topProjects: { project: string; prompts: number }[];
  ratings: { count: number; avg: number | null; recent: { timestamp: string; rating: number; summary: string }[] };
  cronFailures: { jobId: string; failures: number; lastFailureClass?: string }[];
}

export function usagePatterns(days = 30): Usage {
  const home = kayaHome();
  const since = Date.now() - days * 86400_000;
  const history = readJsonl<{ timestamp: number; project: string; sessionId: string }>(join(claudeDataDir(), "history.jsonl"), 8 * 1024 * 1024).filter((h) => h.timestamp >= since);
  const ratings = readJsonl<{ timestamp: string; rating: number; sentiment_summary?: string }>(join(home, "MEMORY", "LEARNING", "SIGNALS", "ratings.jsonl"), 2 * 1024 * 1024).filter((r) => Date.parse(r.timestamp) >= since && typeof r.rating === "number");
  const ledger = readJsonl<{ jobId: string; startedAt: string; outcome: string; failureClass?: string }>(join(home, "MEMORY", "daemon", "cron", "run-ledger.jsonl"), 6 * 1024 * 1024).filter((r) => Date.parse(r.startedAt) >= since);

  const byDay = new Map<string, { prompts: number; sessions: Set<string>; cronOk: number; cronFail: number; ratings: number[] }>();
  for (let i = days - 1; i >= 0; i--) byDay.set(localDate(Date.now() - i * 86400_000), { prompts: 0, sessions: new Set(), cronOk: 0, cronFail: 0, ratings: [] });
  const hourOfDay = new Array(24).fill(0);
  const projects = new Map<string, number>();
  for (const h of history) {
    const d = byDay.get(localDate(h.timestamp));
    if (d) {
      d.prompts++;
      d.sessions.add(h.sessionId);
    }
    hourOfDay[new Date(h.timestamp).getHours()]++;
    const p = h.project ? basename(h.project) : "?";
    projects.set(p, (projects.get(p) ?? 0) + 1);
  }
  const fails = new Map<string, { failures: number; lastFailureClass?: string }>();
  for (const r of ledger) {
    const d = byDay.get(localDate(Date.parse(r.startedAt)));
    if (r.outcome === "success" && d) d.cronOk++;
    if (r.outcome === "failure") {
      if (d) d.cronFail++;
      const f = fails.get(r.jobId) ?? { failures: 0 };
      f.failures++;
      f.lastFailureClass = r.failureClass ?? f.lastFailureClass;
      fails.set(r.jobId, f);
    }
  }
  for (const r of ratings) byDay.get(localDate(Date.parse(r.timestamp)))?.ratings.push(r.rating);
  const avg = (xs: number[]) => (xs.length ? Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 10) / 10 : null);
  return {
    days: [...byDay].map(([date, d]) => ({ date, prompts: d.prompts, sessions: d.sessions.size, cronOk: d.cronOk, cronFail: d.cronFail, avgRating: avg(d.ratings) })),
    hourOfDay,
    topProjects: [...projects].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([project, prompts]) => ({ project, prompts })),
    ratings: {
      count: ratings.length,
      avg: avg(ratings.map((r) => r.rating)),
      recent: ratings.slice(-10).reverse().map((r) => ({ timestamp: r.timestamp, rating: r.rating, summary: r.sentiment_summary ?? "" })),
    },
    cronFailures: [...fails].sort((a, b) => b[1].failures - a[1].failures).slice(0, 12).map(([jobId, f]) => ({ jobId, ...f })),
  };
}

// ── Skills ──────────────────────────────────────────────────────────────────

export interface SkillInfo {
  name: string;
  category: string;
  description: string;
  path: string;
  workflows: number;
  tools: number;
  updatedAt: string;
}

export function listSkills(): SkillInfo[] {
  const root = join(kayaHome(), "skills");
  const out: SkillInfo[] = [];
  const count = (d: string) => (existsSync(d) ? readdirSync(d).filter((f) => !f.startsWith(".") && !f.startsWith("__")).length : 0);
  for (const cat of existsSync(root) ? readdirSync(root).sort() : []) {
    const catDir = join(root, cat);
    if (!statSync(catDir).isDirectory()) continue;
    for (const sub of readdirSync(catDir).sort()) {
      const dir = join(catDir, sub);
      const skillMd = join(dir, "SKILL.md");
      if (!statSync(dir).isDirectory() || !existsSync(skillMd)) continue;
      const fm = parseFrontmatter(readFileSync(skillMd, "utf8"));
      out.push({
        name: fm.name || sub,
        category: cat,
        description: (fm.description || "").replace(/\s*USE WHEN[\s\S]*/i, "").slice(0, 240),
        path: relative(kayaHome(), skillMd),
        workflows: count(join(dir, "Workflows")),
        tools: count(join(dir, "Tools")),
        updatedAt: statSync(skillMd).mtime.toISOString(),
      });
    }
  }
  return out;
}

// ── Hooks ───────────────────────────────────────────────────────────────────

export interface HookInfo {
  event: string;
  matcher: string;
  command: string;
  file: string | null;
  exists: boolean;
  doc: string;
}

export function listHooks(): HookInfo[] {
  const home = kayaHome();
  const settings = JSON.parse(readText(join(home, "settings.json")) || "{}");
  const out: HookInfo[] = [];
  for (const [event, groups] of Object.entries((settings.hooks ?? {}) as Record<string, { matcher?: string; hooks: { command: string }[] }[]>)) {
    for (const g of groups) {
      for (const h of g.hooks ?? []) {
        const cmd = String(h.command ?? "");
        const fileMatch = cmd.replace(/\$\{?KAYA_DIR\}?|\$\{?KAYA_HOME\}?|~\/\.claude/g, home).match(/(\/[^\s"']+\.(?:ts|sh|js|py))/);
        const file = fileMatch ? fileMatch[1] : null;
        let doc = "";
        if (file && existsSync(file)) {
          const src = readFileSync(file, "utf8").slice(0, 4000);
          doc = (src.match(/\/\*\*([\s\S]*?)\*\//)?.[1] ?? src.match(/^#\s+(.+)$/m)?.[1] ?? "")
            .split("\n").map((l) => l.replace(/^\s*\*\s?/, "").trim()).filter(Boolean).slice(0, 3).join(" ").slice(0, 220);
        }
        out.push({ event, matcher: g.matcher ?? "*", command: cmd, file: file ? relative(home, file) : null, exists: Boolean(file && existsSync(file)), doc });
      }
    }
  }
  return out;
}

// ── Key context + editable files ────────────────────────────────────────────

export interface KeyFile {
  path: string;
  label: string;
  group: string;
  sizeKB: number;
  updatedAt: string;
}

export function keyContext(): { files: KeyFile[]; memory: { file: string; title: string; hook: string }[]; status: string } {
  const home = kayaHome();
  const specs: [string, string, string][] = [
    ["CLAUDE.md", "CLAUDE.md (system prompt root)", "Core"],
    ["CONTEXT-ROUTING.md", "Context routing index", "Core"],
    ["CONTEXT-MAP.md", "Context map", "Core"],
    ["USER/UserContext.md", "User context summary", "User"],
    ["USER/DAIDENTITY.md", "Kaya persona", "User"],
    ["USER/ABOUTME.md", "About Jm", "User"],
    ["USER/PRODUCTIVITY.md", "Productivity prefs", "User"],
    ["USER/TELOS/STATUS.md", "TELOS status", "TELOS"],
    ["USER/TELOS/MISSIONS.md", "Missions", "TELOS"],
    ["USER/TELOS/GOALS.md", "Goals", "TELOS"],
    ["USER/TELOS/LEAD-MEASURES.md", "Lead Measures", "TELOS"],
    ["USER/TELOS/CHALLENGES.md", "Challenges", "TELOS"],
    ["USER/TELOS/PROJECTS.md", "Projects", "TELOS"],
    ["context/CalendarContext.md", "Calendar context", "Live"],
    ["docs/architecture.md", "Architecture source map", "Docs"],
    ["docs/system/PIPELINES.md", "Pipelines", "Docs"],
    ["docs/system/THEHOOKSYSTEM.md", "Hook system", "Docs"],
  ];
  const files = specs
    .filter(([p]) => existsSync(join(home, p)))
    .map(([p, label, group]) => {
      const st = statSync(join(home, p));
      return { path: p, label, group, sizeKB: Math.round(st.size / 1024), updatedAt: st.mtime.toISOString() };
    });
  const memIndex = readText(join(kayaShared(), "memory", "MEMORY.md"));
  const memory = [...memIndex.matchAll(/^- \[([^\]]+)\]\(([^)]+)\)\s*(?:—\s*(.*))?$/gm)].map((m) => ({ title: m[1], file: m[2], hook: (m[3] ?? "").slice(0, 200) }));
  const status = readText(join(home, "USER", "TELOS", "STATUS.md")).slice(0, 4000);
  return { files, memory, status };
}

/** Files the dashboard may open, and which of those it may write. */
export function resolveEditable(rel: string): { abs: string; writable: boolean } {
  const home = kayaHome();
  const mem = join(kayaShared(), "memory");
  const isMem = rel.startsWith("memory:");
  const abs = isMem ? resolve(mem, rel.slice(7)) : resolve(home, rel);
  const under = (root: string) => abs === root || abs.startsWith(root + "/");
  if (isMem ? !under(mem) : !under(home)) throw new Error("path outside Kaya");
  if (/\/(\.git|node_modules)\//.test(abs) || /(\.env|secrets?|credentials?|token)/i.test(basename(abs)) || abs.includes("/KAYASECURITYSYSTEM/")) {
    throw new Error("path not viewable");
  }
  if (!/\.(md|ya?ml|json|jsonl|ts|sh|txt)$/.test(abs)) throw new Error("file type not viewable");
  const writable =
    /\.(md|ya?ml)$/.test(abs) &&
    (isMem ||
      under(join(home, "USER")) ||
      under(join(home, "context")) ||
      under(join(home, "MEMORY", "daemon", "cron", "manifests")) ||
      /\/skills\/.+\/SKILL\.md$/.test(abs) ||
      ["CLAUDE.md", "CONTEXT-ROUTING.md", "CONTEXT-MAP.md"].includes(relative(home, abs)));
  return { abs, writable };
}

export function readEditable(rel: string): { path: string; content: string; writable: boolean; mtimeMs: number } {
  const { abs, writable } = resolveEditable(rel);
  if (!existsSync(abs)) throw new Error("not found");
  const st = statSync(abs);
  if (st.size > 2 * 1024 * 1024) throw new Error("file too large to view");
  return { path: rel, content: readFileSync(abs, "utf8"), writable, mtimeMs: st.mtimeMs };
}

// ── Telegram ────────────────────────────────────────────────────────────────

export function telegram(jobs?: Job[]): {
  recurring: { label: string; cronId: string | null; schedule: string; on: boolean; via: string; description: string }[];
  recent: { timestamp: string; source: string; text: string }[];
  bySource: { source: string; count: number }[];
} {
  const home = kayaHome();
  const all = jobs ?? listJobs();
  const recurring = [];
  for (const j of all) {
    if (!j.manifestPath) continue;
    const yaml = readText(j.manifestPath);
    const output = yaml.match(/^output:\s*(\S+)/m)?.[1] ?? "silent";
    const mentions = /telegram|Deliver\.ts|notify|digest|nudge|briefing/i.test(yaml);
    if (output === "silent" && !mentions) continue;
    recurring.push({
      label: j.label,
      cronId: j.cronId,
      schedule: j.schedule,
      on: j.loaded && !j.disabled && j.manifestEnabled !== false,
      via: output !== "silent" ? `output: ${output}` : "script-delivered",
      description: j.description.slice(0, 200),
    });
  }
  const out = readJsonl<{ timestamp: string; source: string; text: string }>(join(home, "MEMORY", "TELEGRAM", "outbound.jsonl"), 1024 * 1024);
  const counts = new Map<string, number>();
  for (const m of out) counts.set(m.source, (counts.get(m.source) ?? 0) + 1);
  return {
    recurring,
    recent: out.slice(-40).reverse().map((m) => ({ timestamp: m.timestamp, source: m.source, text: String(m.text ?? "").slice(0, 600) })),
    bySource: [...counts].sort((a, b) => b[1] - a[1]).map(([source, count]) => ({ source, count })),
  };
}

// ── Projects + work ─────────────────────────────────────────────────────────

function lucidDb(): Database | null {
  const p = join(kayaHome(), "skills", "Productivity", "LucidTasks", "Data", "lucidtasks.db");
  return existsSync(p) ? new Database(p, { readonly: true }) : null;
}

export function projects(): {
  telos: { project: string; mission: string; goals: string }[];
  lucid: { id: string; name: string; status: string; open: number; done: number }[];
  links: { name: string; url: string; note: string }[];
} {
  const md = readText(join(kayaHome(), "USER", "TELOS", "PROJECTS.md"));
  const telos: { project: string; mission: string; goals: string }[] = [];
  const header = md.split("\n").findIndex((l) => /^\|\s*Project\s*\|/.test(l));
  if (header >= 0) {
    const cols = md.split("\n")[header].split("|").map((c) => c.trim().toLowerCase());
    for (const line of md.split("\n").slice(header + 2)) {
      if (!line.startsWith("|")) break;
      const cells = line.split("|").map((c) => c.trim());
      telos.push({ project: cells[cols.indexOf("project")] ?? "", mission: cells[cols.indexOf("mission")] ?? "", goals: cells[cols.findIndex((c) => c.includes("goal"))] ?? "" });
    }
  }
  const db = lucidDb();
  let lucid: { id: string; name: string; status: string; open: number; done: number }[] = [];
  if (db) {
    try {
      lucid = db
        .query(
          `SELECT p.id, p.name, p.status,
             SUM(CASE WHEN t.status IN ('inbox','next','in_progress','waiting') THEN 1 ELSE 0 END) AS open,
             SUM(CASE WHEN t.status = 'done' THEN 1 ELSE 0 END) AS done
           FROM projects p LEFT JOIN tasks t ON t.project_id = p.id
           WHERE p.status IN ('active','paused')
           GROUP BY p.id ORDER BY open DESC, p.sort_order`,
        )
        .all() as typeof lucid;
    } finally {
      db.close();
    }
  }
  const links = [
    { name: "LucidTasks board", url: "http://127.0.0.1:7777", note: "tasks kanban + triage" },
    { name: "LifeOS dashboard", url: "http://127.0.0.1:31337", note: "habits, WIGs, leads" },
    { name: "AppUsage dashboard", url: "http://127.0.0.1:7745", note: "media / screen time" },
    { name: "EventScout", url: "http://127.0.0.1:4180", note: "community events" },
    { name: "RecipeIndex", url: "http://127.0.0.1:4181", note: "cooking" },
    { name: "Observability", url: "http://127.0.0.1:5173", note: "agent traces (if running)" },
  ];
  return { telos, lucid, links };
}

export function recentWork(): {
  tasks: { id: string; title: string; status: string; project: string | null; disposition: string | null; updated_at: string; completed_at: string | null }[];
  executor: { timestamp: string; taskId: string; title: string; verdict: string; branch: string; verify?: string }[];
  commits: { sha: string; date: string; subject: string }[];
} {
  const db = lucidDb();
  let tasks: ReturnType<typeof recentWork>["tasks"] = [];
  if (db) {
    try {
      tasks = db
        .query(
          `SELECT t.id, t.title, t.status, p.name AS project, t.disposition, t.updated_at, t.completed_at
           FROM tasks t LEFT JOIN projects p ON p.id = t.project_id
           ORDER BY t.updated_at DESC LIMIT 30`,
        )
        .all() as typeof tasks;
    } finally {
      db.close();
    }
  }
  const executor = readJsonl<{ timestamp: string; taskId: string; title: string; verdict: string; branch: string; verify?: { verdict: string } }>(
    join(kayaHome(), "MEMORY", "daemon", "cron", "logs", "autonomous-executor.jsonl"),
    1024 * 1024,
  )
    .filter((e) => e.taskId)
    .slice(-25)
    .reverse()
    .map((e) => ({ timestamp: e.timestamp, taskId: e.taskId, title: e.title, verdict: e.verdict, branch: e.branch, verify: e.verify?.verdict }));
  return { tasks, executor, commits: gitLog(["main", "-25"]) };
}

function gitLog(args: string[]): { sha: string; date: string; subject: string }[] {
  const r = spawnSync("git", ["-C", kayaHome(), "log", "--format=%h%x09%cI%x09%s", ...args], { encoding: "utf8", timeout: 10_000 });
  return (r.stdout ?? "").split("\n").filter(Boolean).map((l) => {
    const [sha, date, subject] = l.split("\t");
    return { sha, date, subject };
  });
}

// ── Systems work ────────────────────────────────────────────────────────────

export function systemsWork(): {
  pipeline: { stage: string; count: number }[];
  activeItems: { id: string; stage: string; title: string; updated_at: string }[];
  techDebt: { timestamp: string; source: string; summary: string; status: string }[];
  failures: { timestamp: string; source: string; summary: string }[];
  unmergedExecutorBranches: { branch: string; date: string; subject: string }[];
} {
  const rt = join(kayaShared(), "runtime");
  const home = kayaHome();
  let pipeline: { stage: string; count: number }[] = [];
  let activeItems: { id: string; stage: string; title: string; updated_at: string }[] = [];
  const pdbPath = join(rt, "pipeline.db");
  if (existsSync(pdbPath)) {
    const pdb = new Database(pdbPath, { readonly: true });
    try {
      pipeline = pdb.query("SELECT stage, COUNT(*) AS count FROM pipeline_items GROUP BY stage ORDER BY count DESC").all() as typeof pipeline;
      activeItems = pdb
        .query("SELECT id, stage, title, updated_at FROM pipeline_items WHERE stage NOT IN ('archived','done','rejected') ORDER BY updated_at DESC LIMIT 25")
        .all() as typeof activeItems;
    } finally {
      pdb.close();
    }
  }
  const summarize = (r: Record<string, unknown>) => {
    const err = r.error as { message?: string } | string | undefined;
    const errText = typeof err === "string" ? err : err?.message && err.message !== "unknown" ? err.message : "";
    const ctx = r.context as { last_assistant_message?: string } | undefined;
    return String(r.summary ?? r.description ?? r.message ?? r.title ?? (errText || ctx?.last_assistant_message) ?? JSON.stringify(r)).replace(/\s+/g, " ").slice(0, 260);
  };
  const techDebt = readJsonl<Record<string, unknown>>(join(rt, "QUEUES", "tech-debt.jsonl"), 512 * 1024)
    .slice(-20).reverse()
    .map((r) => ({ timestamp: String(r.createdAt ?? r.timestamp ?? ""), source: String(r.location ?? r.source ?? r.category ?? ""), summary: summarize(r), status: String(r.status ?? "") }));
  const failures = readJsonl<Record<string, unknown>>(join(rt, "MONITORING", "failure-log.jsonl"), 512 * 1024)
    .slice(-20).reverse()
    .map((r) => ({ timestamp: String(r.ts ?? r.timestamp ?? ""), source: String(r.source ?? r.component ?? ""), summary: summarize(r) }));
  const branches = spawnSync("git", ["-C", home, "for-each-ref", "--no-merged=main", "--sort=-committerdate", "--format=%(refname:short)%09%(committerdate:iso-strict)%09%(subject)", "refs/heads/executor/"], { encoding: "utf8", timeout: 10_000 });
  const unmergedExecutorBranches = (branches.stdout ?? "").split("\n").filter(Boolean).slice(0, 20).map((l) => {
    const [branch, date, subject] = l.split("\t");
    return { branch, date, subject };
  });
  return { pipeline, activeItems, techDebt, failures, unmergedExecutorBranches };
}

// ── Diagrams + graph ────────────────────────────────────────────────────────

export interface Diagram {
  title: string;
  source: string;
  mermaid: string;
}

export function extractMermaid(md: string, source: string): Diagram[] {
  const out: Diagram[] = [];
  const lines = md.split("\n");
  let lastHeading = basename(source, ".md");
  for (let i = 0; i < lines.length; i++) {
    const h = lines[i].match(/^#{1,4}\s+(.+)/);
    if (h) lastHeading = h[1].trim();
    if (lines[i].trim() === "```mermaid") {
      const body: string[] = [];
      for (i++; i < lines.length && lines[i].trim() !== "```"; i++) body.push(lines[i]);
      out.push({ title: lastHeading, source, mermaid: body.join("\n") });
    }
  }
  return out;
}

export function diagrams(): { diagrams: Diagram[]; graph: Record<string, unknown> | null } {
  const home = kayaHome();
  const files = [
    "docs/architecture.md",
    ...["skills/Content/SystemFlowchart/Output/markdown"].flatMap((d) =>
      existsSync(join(home, d)) ? readdirSync(join(home, d)).filter((f) => f.endsWith(".md")).sort().map((f) => `${d}/${f}`) : [],
    ),
  ];
  const seen = new Set<string>();
  const all: Diagram[] = [];
  for (const f of files) {
    for (const d of extractMermaid(readText(join(home, f)), f)) {
      if (seen.has(d.mermaid)) continue;
      seen.add(d.mermaid);
      all.push(d);
    }
  }
  const metaPath = join(kayaShared(), "graph", "meta.json");
  const graph = existsSync(metaPath) ? JSON.parse(readFileSync(metaPath, "utf8")) : null;
  return { diagrams: all, graph };
}

export const _test = { readJsonl, localDate };
