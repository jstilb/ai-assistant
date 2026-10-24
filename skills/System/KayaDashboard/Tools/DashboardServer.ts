#!/usr/bin/env bun
/**
 * DashboardServer.ts — Kaya dashboard: a window into Kaya's brain and work, on 127.0.0.1:7790.
 *
 * Sections (hash-routed single page): Overview · Sessions · Usage · Jobs (toggle/run/logs) ·
 * Telegram · Skills · Hooks · Context (view + edit key files and memory) · Projects ·
 * Recent work · Systems work · Diagrams. Data comes from Collectors.ts (read-only) and
 * Jobs.ts (the only module that mutates — launchd + manifest `enabled`).
 *
 * Loopback-only, no auth (same posture as the LucidTasks board). Mutating routes require the
 * `x-kaya-dashboard: 1` header, which a cross-site page can't send without a CORS preflight
 * this server never grants — so a random web page can't toggle jobs through your browser.
 *
 * Run:
 *   bun run skills/System/KayaDashboard/Tools/DashboardServer.ts          # :7790
 *   KAYA_DASH_PORT=7791 bun run …/DashboardServer.ts
 * In production com.kaya.dashboard (KeepAlive, from bin/rebuild-plists.sh) keeps it up.
 * After editing: launchctl kickstart -k gui/$UID/com.kaya.dashboard (bun caches compiled TS).
 *
 * @module KayaDashboard/DashboardServer
 */

import { existsSync, statSync, writeFileSync, renameSync, readFileSync } from "fs";
import { join } from "path";
import * as C from "./Collectors.ts";
import { listJobs, toggleJob, runJob, jobLogs, isOn } from "./Jobs.ts";

export const PORT = Number(process.env.KAYA_DASH_PORT ?? 7790);
const HOST = "127.0.0.1";
const CLIENT_HTML = readFileSync(join(import.meta.dir, "client.html"), "utf8");

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });

function safe<T>(fn: () => T): T | { error: string } {
  try {
    return fn();
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

export function overview() {
  const jobs = safe(() => listJobs());
  const j = Array.isArray(jobs) ? jobs : [];
  const usage = safe(() => C.usagePatterns(7));
  const diag = safe(() => C.diagrams());
  const sessions = safe(() => C.recentSessions(200));
  const today = new Date().toISOString().slice(0, 10);
  return {
    generatedAt: new Date().toISOString(),
    jobs: {
      total: j.length,
      on: j.filter(isOn).length,
      off: j.filter((x) => !isOn(x)).length,
      running: j.filter((x) => x.pid !== null).length,
      lastRunFailed: j.filter((x) => x.lastRun?.outcome === "failure").map((x) => ({ label: x.label, failureClass: x.lastRun?.failureClass })),
      nonZeroExit: j.filter((x) => x.lastExit !== null && x.lastExit !== 0 && x.pid === null).map((x) => ({ label: x.label, lastExit: x.lastExit })),
    },
    usage: "error" in usage ? usage : { days: usage.days, ratings: { avg: usage.ratings.avg, count: usage.ratings.count } },
    sessions: Array.isArray(sessions)
      ? { last14d: sessions.length, interactive: sessions.filter((s) => s.interactive).length, today: sessions.filter((s) => s.updatedAt.startsWith(today)).length }
      : sessions,
    graph: "error" in diag ? null : diag.graph,
    skills: (safe(() => C.listSkills().length) as number) ?? 0,
    hooks: (safe(() => C.listHooks().length) as number) ?? 0,
  };
}

function needsHeader(req: Request): Response | null {
  return req.headers.get("x-kaya-dashboard") === "1" ? null : json({ error: "missing x-kaya-dashboard header" }, 403);
}

export async function handleRequest(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const p = url.pathname;
  const m = req.method;

  if (p === "/" || p === "/index.html") return new Response(CLIENT_HTML, { headers: { "content-type": "text/html; charset=utf-8" } });
  if (p === "/healthz") return json({ ok: true, port: PORT, kayaHome: C.kayaHome() });

  if (m === "GET") {
    switch (p) {
      case "/api/overview":
        return json(overview());
      case "/api/sessions":
        return json(safe(() => C.recentSessions(Number(url.searchParams.get("limit") ?? 60))));
      case "/api/usage":
        return json(safe(() => C.usagePatterns(Number(url.searchParams.get("days") ?? 30))));
      case "/api/jobs":
        return json(safe(() => listJobs().map((j) => ({ ...j, on: isOn(j) }))));
      case "/api/skills":
        return json(safe(C.listSkills));
      case "/api/hooks":
        return json(safe(C.listHooks));
      case "/api/context":
        return json(safe(C.keyContext));
      case "/api/telegram":
        return json(safe(() => C.telegram()));
      case "/api/projects":
        return json(safe(C.projects));
      case "/api/work":
        return json(safe(C.recentWork));
      case "/api/systems":
        return json(safe(C.systemsWork));
      case "/api/diagrams":
        return json(safe(C.diagrams));
      case "/api/file":
        return json(safe(() => C.readEditable(url.searchParams.get("path") ?? "")));
    }
    const sess = p.match(/^\/api\/sessions\/([0-9a-f-]{36})$/);
    if (sess) return json(safe(() => C.sessionTranscript(sess[1])));
    const logs = p.match(/^\/api\/jobs\/([^/]+)\/logs$/);
    if (logs) return json(safe(() => jobLogs(decodeURIComponent(logs[1]), Number(url.searchParams.get("lines") ?? 80))));
  }

  if (m === "POST" || m === "PUT") {
    const deny = needsHeader(req);
    if (deny) return deny;
    const toggle = p.match(/^\/api\/jobs\/([^/]+)\/toggle$/);
    if (toggle && m === "POST") {
      const body = (await req.json().catch(() => ({}))) as { enable?: boolean };
      if (typeof body.enable !== "boolean") return json({ error: "body.enable must be boolean" }, 400);
      const r = toggleJob(decodeURIComponent(toggle[1]), body.enable);
      return json(r, r.ok ? 200 : 500);
    }
    const run = p.match(/^\/api\/jobs\/([^/]+)\/run$/);
    if (run && m === "POST") {
      const r = runJob(decodeURIComponent(run[1]));
      return json(r, r.ok ? 200 : 500);
    }
    if (p === "/api/file" && m === "PUT") {
      const body = (await req.json().catch(() => ({}))) as { path?: string; content?: string; mtimeMs?: number };
      if (typeof body.path !== "string" || typeof body.content !== "string") return json({ error: "path and content required" }, 400);
      try {
        const { abs, writable } = C.resolveEditable(body.path);
        if (!writable) return json({ error: "file is read-only in the dashboard" }, 403);
        if (existsSync(abs) && body.mtimeMs !== undefined && Math.abs(statSync(abs).mtimeMs - body.mtimeMs) > 1) {
          return json({ error: "file changed on disk since you opened it — reload before saving" }, 409);
        }
        const tmp = `${abs}.tmp-dashboard`;
        writeFileSync(tmp, body.content);
        renameSync(tmp, abs);
        return json({ ok: true, path: body.path, mtimeMs: statSync(abs).mtimeMs });
      } catch (err) {
        return json({ error: err instanceof Error ? err.message : String(err) }, 400);
      }
    }
  }
  return json({ error: "not found" }, 404);
}

if (import.meta.main) {
  const server = Bun.serve({
    hostname: HOST,
    port: PORT,
    idleTimeout: 60,
    fetch: async (req) => {
      try {
        return await handleRequest(req);
      } catch (err) {
        console.error("[KayaDashboard] handler error:", err);
        return json({ error: err instanceof Error ? err.message : String(err) }, 500);
      }
    },
  });
  console.log(`Kaya dashboard → http://${server.hostname}:${server.port}  (KAYA_HOME=${C.kayaHome()})`);
}
