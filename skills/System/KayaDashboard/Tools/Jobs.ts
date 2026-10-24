/**
 * Jobs.ts — launchd + cron-manifest inventory, toggle, and run-now for the Kaya dashboard.
 *
 * A "job" is one ~/Library/LaunchAgents/com.{kaya,pai}.*.plist. When its ProgramArguments
 * route through bin/run-cron-job.ts <id>, the job also has a manifest at
 * MEMORY/daemon/cron/manifests/<id>.yaml and rows in MEMORY/daemon/cron/run-ledger.jsonl.
 *
 * Toggle semantics (both layers, so the job is OFF everywhere that can fire it):
 *   off → `launchctl disable` (persists across reboot) + `launchctl bootout`
 *         + manifest `enabled: false` (run-cron-job.ts + job-reconciler.ts both honor it)
 *   on  → manifest `enabled: true` + `launchctl enable` + `launchctl bootstrap`
 *
 * Run-now semantics:
 *   cron-wrapper job → detached `bun bin/run-cron-job.ts <id> --catchup` (a plain kickstart
 *                      would exit skip.cron-mismatch — run-cron-job re-validates the slot)
 *   KeepAlive service → `launchctl kickstart -k` (restart)
 *   anything else    → `launchctl kickstart`
 *
 * All shelling goes through the injectable `Exec` so the logic is unit-testable.
 */

import { existsSync, readFileSync, readdirSync, writeFileSync, renameSync, openSync, statSync, readSync, closeSync } from "fs";
import { join, basename } from "path";
import { spawn, spawnSync } from "child_process";
import { homedir } from "os";
import { getKayaHome } from "../../../../lib/core/KayaHome.ts";
import { createAppendLog } from "../../../../lib/core/AppendLog.ts";

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}
export type Exec = (cmd: string, args: string[]) => ExecResult;

export const realExec: Exec = (cmd, args) => {
  const r = spawnSync(cmd, args, { encoding: "utf8", timeout: 15_000 });
  return { code: r.status ?? -1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
};

export interface Job {
  label: string;
  plistPath: string;
  program: string[];
  /** Human-readable schedule (cron expr from manifest, or launchd interval). */
  schedule: string;
  kind: "cron" | "service" | "interval" | "calendar" | "on-demand";
  /** run-cron-job.ts manifest id, when the plist routes through the cron wrapper. */
  cronId: string | null;
  manifestPath: string | null;
  manifestEnabled: boolean | null;
  description: string;
  loaded: boolean;
  disabled: boolean;
  pid: number | null;
  lastExit: number | null;
  stdoutPath: string | null;
  stderrPath: string | null;
  lastRun: { startedAt: string; outcome: string; failureClass?: string } | null;
  keepAlive: boolean;
}

export interface JobsPaths {
  launchAgentsDir: string;
  manifestDir: string;
  ledgerPath: string;
  actionLogPath: string;
  kayaHome: string;
}

export function defaultPaths(): JobsPaths {
  const home = getKayaHome();
  return {
    launchAgentsDir: join(homedir(), "Library", "LaunchAgents"),
    manifestDir: join(home, "MEMORY", "daemon", "cron", "manifests"),
    ledgerPath: join(home, "MEMORY", "daemon", "cron", "run-ledger.jsonl"),
    actionLogPath: join(home, "logs", "kaya-dashboard-actions.jsonl"),
    kayaHome: home,
  };
}

export const SELF_LABEL = "com.kaya.dashboard";
const LABEL_RE = /^com\.(kaya|pai)\.[A-Za-z0-9._-]+$/;

export function uid(): string {
  return String(process.getuid?.() ?? 501);
}

// ── Pure parsers ────────────────────────────────────────────────────────────

/** Parse `launchctl list` → label → {pid, lastExit}. Column 1 is PID ("-" = not running), column 2 last exit. */
export function parseLaunchctlList(out: string): Map<string, { pid: number | null; lastExit: number | null }> {
  const m = new Map<string, { pid: number | null; lastExit: number | null }>();
  for (const line of out.split("\n").slice(1)) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 3) continue;
    const [pid, status, label] = parts;
    m.set(label, {
      pid: pid === "-" ? null : Number(pid),
      lastExit: status === "-" ? null : Number(status),
    });
  }
  return m;
}

/** Parse `launchctl print-disabled gui/<uid>` → set of disabled labels. */
export function parseDisabled(out: string): Set<string> {
  const s = new Set<string>();
  for (const m of out.matchAll(/"([^"]+)"\s*=>\s*(disabled|true)/g)) s.add(m[1]);
  return s;
}

/** Describe a launchd StartCalendarInterval / StartInterval in words. */
export function describeLaunchdSchedule(plist: Record<string, unknown>): { text: string; kind: Job["kind"] } {
  if (plist.KeepAlive) return { text: "always on (KeepAlive)", kind: "service" };
  if (typeof plist.StartInterval === "number") {
    const s = plist.StartInterval as number;
    return { text: s % 3600 === 0 ? `every ${s / 3600}h` : s % 60 === 0 ? `every ${s / 60}m` : `every ${s}s`, kind: "interval" };
  }
  const cal = plist.StartCalendarInterval;
  if (cal) {
    const entries = (Array.isArray(cal) ? cal : [cal]) as Record<string, number>[];
    const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
    const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    const fmt = (e: Record<string, number>) => {
      const hh = e.Hour !== undefined ? String(e.Hour).padStart(2, "0") : "**";
      const mm = e.Minute !== undefined ? String(e.Minute).padStart(2, "0") : "00";
      const parts = [`${hh}:${mm}`];
      if (e.Weekday !== undefined) parts.unshift(days[e.Weekday % 7]);
      if (e.Day !== undefined) parts.unshift(`day ${e.Day}`);
      if (e.Month !== undefined) parts.unshift(months[(e.Month - 1) % 12]);
      return parts.join(" ");
    };
    const shown = entries.slice(0, 4).map(fmt).join(", ");
    return { text: entries.length > 4 ? `${shown} +${entries.length - 4} more` : shown, kind: "calendar" };
  }
  if (plist.RunAtLoad) return { text: "at load", kind: "on-demand" };
  return { text: "on demand", kind: "on-demand" };
}

/** Extract the cron manifest id from ProgramArguments routed through run-cron-job.ts. */
export function cronIdFromProgram(program: string[]): string | null {
  const i = program.findIndex((a) => a.endsWith("run-cron-job.ts"));
  return i >= 0 && program[i + 1] && !program[i + 1].startsWith("-") ? program[i + 1] : null;
}

/** Minimal field reads from a manifest yaml (no full parse needed for display). */
export function readManifestFields(yaml: string): { schedule: string | null; enabled: boolean; description: string } {
  const schedule = yaml.match(/^schedule:\s*["']?([^"'\n]+)["']?\s*$/m)?.[1]?.trim() ?? null;
  const en = yaml.match(/^enabled:[ \t]*(true|false)[ \t]*$/m)?.[1];
  let description = "";
  const block = yaml.match(/^description:\s*\|?\s*\n((?:[ \t]+.*\n?)+)/m);
  if (block) description = block[1].split("\n").map((l) => l.trim()).filter(Boolean).join(" ");
  else description = yaml.match(/^description:\s*["']?(.+?)["']?\s*$/m)?.[1] ?? "";
  if (!description) description = yaml.match(/^task:\s*["']?(.+?)["']?\s*$/m)?.[1] ?? "";
  return { schedule, enabled: en === undefined ? true : en === "true", description };
}

/** Rewrite (or append) the top-level `enabled:` line, preserving every comment and field. */
export function setManifestEnabled(yaml: string, enabled: boolean): string {
  if (/^enabled:[ \t]*(true|false)[ \t]*$/m.test(yaml)) {
    return yaml.replace(/^enabled:[ \t]*(true|false)[ \t]*$/m, `enabled: ${enabled}`);
  }
  return yaml.replace(/\n*$/, "\n") + `enabled: ${enabled}\n`;
}

/** Read the last `bytes` of a file (for big append-only logs like the run ledger). */
export function tailFile(path: string, bytes = 256 * 1024): string {
  if (!existsSync(path)) return "";
  const size = statSync(path).size;
  const start = Math.max(0, size - bytes);
  const fd = openSync(path, "r");
  try {
    const buf = Buffer.alloc(size - start);
    readSync(fd, buf, 0, buf.length, start);
    const s = buf.toString("utf8");
    return start > 0 ? s.slice(s.indexOf("\n") + 1) : s;
  } finally {
    closeSync(fd);
  }
}

/** Last ledger row per jobId from the tail of run-ledger.jsonl. */
export function lastRunsFromLedger(text: string): Map<string, { startedAt: string; outcome: string; failureClass?: string }> {
  const m = new Map<string, { startedAt: string; outcome: string; failureClass?: string }>();
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line);
      if (r.jobId) m.set(r.jobId, { startedAt: r.startedAt, outcome: r.outcome, failureClass: r.failureClass });
    } catch {
      // partial line at the tail boundary — skip
    }
  }
  return m;
}

// ── Inventory ───────────────────────────────────────────────────────────────

function readPlist(path: string, exec: Exec): Record<string, unknown> | null {
  const r = exec("/usr/bin/plutil", ["-convert", "json", "-o", "-", path]);
  if (r.code !== 0) return null;
  try {
    return JSON.parse(r.stdout);
  } catch {
    return null;
  }
}

export function listJobs(paths: JobsPaths = defaultPaths(), exec: Exec = realExec): Job[] {
  const files = existsSync(paths.launchAgentsDir)
    ? readdirSync(paths.launchAgentsDir).filter((f) => /^com\.(kaya|pai)\..+\.plist$/.test(f)).sort()
    : [];
  const listed = parseLaunchctlList(exec("/bin/launchctl", ["list"]).stdout);
  const disabled = parseDisabled(exec("/bin/launchctl", ["print-disabled", `gui/${uid()}`]).stdout);
  const ledger = lastRunsFromLedger(tailFile(paths.ledgerPath, 2 * 1024 * 1024));

  const jobs: Job[] = [];
  for (const f of files) {
    const plistPath = join(paths.launchAgentsDir, f);
    const p = readPlist(plistPath, exec);
    const label = (p?.Label as string) ?? basename(f, ".plist");
    const program = ((p?.ProgramArguments as string[]) ?? (p?.Program ? [p.Program as string] : [])).map(String);
    const cronId = cronIdFromProgram(program);
    const manifestPath = cronId ? join(paths.manifestDir, `${cronId}.yaml`) : null;
    const manifest = manifestPath && existsSync(manifestPath) ? readManifestFields(readFileSync(manifestPath, "utf8")) : null;
    const sched = p ? describeLaunchdSchedule(p) : { text: "unreadable plist", kind: "on-demand" as const };
    const state = listed.get(label);
    jobs.push({
      label,
      plistPath,
      program,
      schedule: manifest?.schedule ? `cron ${manifest.schedule}` : sched.text,
      kind: cronId ? "cron" : sched.kind,
      cronId,
      manifestPath: manifest ? manifestPath : null,
      manifestEnabled: manifest ? manifest.enabled : null,
      description: manifest?.description ?? "",
      loaded: state !== undefined,
      disabled: disabled.has(label),
      pid: state?.pid ?? null,
      lastExit: state?.lastExit ?? null,
      stdoutPath: (p?.StandardOutPath as string) ?? null,
      stderrPath: (p?.StandardErrorPath as string) ?? null,
      lastRun: cronId ? (ledger.get(cronId) ?? null) : null,
      keepAlive: Boolean(p?.KeepAlive),
    });
  }
  return jobs;
}

/** A job is "on" when launchd would fire it AND (if manifest-backed) the manifest allows it. */
export function isOn(j: Pick<Job, "loaded" | "disabled" | "manifestEnabled">): boolean {
  return j.loaded && !j.disabled && j.manifestEnabled !== false;
}

// ── Actions ─────────────────────────────────────────────────────────────────

export interface ActionResult {
  ok: boolean;
  label: string;
  action: string;
  steps: string[];
  error?: string;
  job?: Job;
}

function findJob(label: string, paths: JobsPaths, exec: Exec): Job {
  if (!LABEL_RE.test(label)) throw new Error(`refusing non-Kaya label: ${label}`);
  const job = listJobs(paths, exec).find((j) => j.label === label);
  if (!job) throw new Error(`no LaunchAgent plist for ${label}`);
  return job;
}

function logAction(paths: JobsPaths, entry: Record<string, unknown>): void {
  try {
    createAppendLog(paths.actionLogPath).append({ timestamp: new Date().toISOString(), ...entry });
  } catch {
    // audit log is best-effort; the action result is still returned to the caller
  }
}

export function toggleJob(label: string, enable: boolean, paths: JobsPaths = defaultPaths(), exec: Exec = realExec): ActionResult {
  const action = enable ? "enable" : "disable";
  const steps: string[] = [];
  try {
    if (label === SELF_LABEL && !enable) throw new Error("refusing to disable the dashboard from inside the dashboard");
    const job = findJob(label, paths, exec);
    const target = `gui/${uid()}/${label}`;

    if (job.manifestPath) {
      const before = readFileSync(job.manifestPath, "utf8");
      const after = setManifestEnabled(before, enable);
      if (after !== before) {
        const tmp = `${job.manifestPath}.tmp-dashboard`;
        writeFileSync(tmp, after);
        renameSync(tmp, job.manifestPath);
      }
      steps.push(`manifest ${basename(job.manifestPath)} enabled: ${enable}`);
    }

    if (enable) {
      const en = exec("/bin/launchctl", ["enable", target]);
      steps.push(`launchctl enable → ${en.code}`);
      if (!job.loaded) {
        const bs = exec("/bin/launchctl", ["bootstrap", `gui/${uid()}`, job.plistPath]);
        steps.push(`launchctl bootstrap → ${bs.code}${bs.stderr.trim() ? ` (${bs.stderr.trim()})` : ""}`);
      }
    } else {
      const dis = exec("/bin/launchctl", ["disable", target]);
      steps.push(`launchctl disable → ${dis.code}`);
      if (job.loaded) {
        const bo = exec("/bin/launchctl", ["bootout", target]);
        steps.push(`launchctl bootout → ${bo.code}${bo.stderr.trim() ? ` (${bo.stderr.trim()})` : ""}`);
      }
    }

    const after = listJobs(paths, exec).find((j) => j.label === label);
    const ok = after ? isOn(after) === enable : false;
    const res: ActionResult = { ok, label, action, steps, job: after, error: ok ? undefined : "post-action state does not match the request" };
    logAction(paths, { action, label, ok, steps });
    return res;
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    logAction(paths, { action, label, ok: false, steps, error });
    return { ok: false, label, action, steps, error };
  }
}

export type Spawner = (cmd: string, args: string[], opts: { cwd: string; env: Record<string, string>; stdout: string | null; stderr: string | null }) => number | undefined;

export const realSpawner: Spawner = (cmd, args, opts) => {
  const out = opts.stdout ? openSync(opts.stdout, "a") : "ignore";
  const err = opts.stderr ? openSync(opts.stderr, "a") : "ignore";
  const child = spawn(cmd, args, { cwd: opts.cwd, env: opts.env, detached: true, stdio: ["ignore", out, err] });
  child.unref();
  return child.pid;
};

export function runJob(label: string, paths: JobsPaths = defaultPaths(), exec: Exec = realExec, spawner: Spawner = realSpawner): ActionResult {
  const steps: string[] = [];
  try {
    if (label === SELF_LABEL) throw new Error("use launchctl kickstart -k to restart the dashboard itself");
    const job = findJob(label, paths, exec);
    if (job.cronId) {
      const p = readPlist(job.plistPath, exec) ?? {};
      const env = { ...(process.env as Record<string, string>), ...((p.EnvironmentVariables as Record<string, string>) ?? {}) };
      delete env.CLAUDECODE; // de-nest: run-cron-job spawns `claude -p`
      const wrapper = job.program.find((a) => a.endsWith("run-cron-job.ts"))!;
      const bun = job.program[0];
      const pid = spawner(bun, [wrapper, job.cronId, "--catchup"], {
        cwd: (p.WorkingDirectory as string) ?? paths.kayaHome,
        env,
        stdout: job.stdoutPath,
        stderr: job.stderrPath,
      });
      steps.push(`spawned ${basename(wrapper)} ${job.cronId} --catchup (pid ${pid ?? "?"})`);
    } else {
      if (!job.loaded) throw new Error("job is not loaded — enable it first");
      const args = job.keepAlive ? ["kickstart", "-k", `gui/${uid()}/${label}`] : ["kickstart", `gui/${uid()}/${label}`];
      const r = exec("/bin/launchctl", args);
      steps.push(`launchctl ${args.join(" ")} → ${r.code}${r.stderr.trim() ? ` (${r.stderr.trim()})` : ""}`);
      if (r.code !== 0) throw new Error(`kickstart failed (${r.code})`);
    }
    logAction(paths, { action: "run", label, ok: true, steps });
    return { ok: true, label, action: "run", steps };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    logAction(paths, { action: "run", label, ok: false, steps, error });
    return { ok: false, label, action: "run", steps, error };
  }
}

/** Last N lines of a job's stdout/stderr logs. */
export function jobLogs(label: string, lines = 60, paths: JobsPaths = defaultPaths(), exec: Exec = realExec): { stdout: string; stderr: string } {
  const job = findJob(label, paths, exec);
  const last = (p: string | null) => (p ? tailFile(p, 64 * 1024).split("\n").slice(-lines).join("\n") : "");
  return { stdout: last(job.stdoutPath), stderr: last(job.stderrPath) };
}
