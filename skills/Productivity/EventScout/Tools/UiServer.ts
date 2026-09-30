/**
 * UiServer.ts — minimalist local web UI for browsing the EventScout cache.
 *
 * Launched via `bun cli.ts ui`. Serves a single static page (ui/index.html)
 * plus a small JSON API over the live cache. No build step, no dependencies
 * beyond what the skill already uses.
 *
 * Endpoints:
 *   GET  /                     → the UI (ui/index.html)
 *   GET  /api/data             → { events, lastUpdated, sources[], saved[] }
 *   POST /api/saved/add        → { id } save an event (star / "interested")
 *   POST /api/saved/remove     → { id } unsave an event
 *   POST /api/refresh          → start a full prefetch (all sources)
 *   POST /api/refresh/source   → { id } start a single-source refresh
 *   GET  /api/refresh/status   → live status of the running/last refresh
 *
 * The refresh endpoints spawn the existing CLI (`bun cli.ts prefetch|refresh`)
 * as a child process so the UI reuses the exact ingest path the cron/prefetch
 * job uses. Only one refresh runs at a time. The child inherits this process's
 * env so it reads/writes the SAME cache file the server serves.
 */

import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { readEvents } from "./Cache.ts";
import { loadSources } from "./SourceManager.ts";
import { readSaved, saveEvent, unsaveEvent } from "./SavedEvents.ts";
import { resolveRemoteAccess, withRemoteAuth } from "../../../../lib/core/RemoteAccess.ts";

const THIS_DIR = dirname(fileURLToPath(import.meta.url));
const SKILL_DIR = resolve(THIS_DIR, "..");
const INDEX_HTML = resolve(SKILL_DIR, "ui", "index.html");
const CLI_PATH = resolve(SKILL_DIR, "cli.ts");

// ----------------------------------------------------------------------------
// Refresh job state (single-flight)
// ----------------------------------------------------------------------------

type RefreshJob = {
  kind: "all" | "source";
  label: string;
  startedAt: string;
  running: boolean;
  exitCode: number | null;
  lines: string[]; // tail of child stdout/stderr
};

let job: RefreshJob | null = null;
let child: ReturnType<typeof Bun.spawn> | null = null;

const MAX_LINES = 80;

function pushLine(text: string): void {
  if (!job) return;
  for (const raw of text.split("\n")) {
    const line = raw.replace(/\s+$/, "");
    if (line === "") continue;
    job.lines.push(line);
  }
  if (job.lines.length > MAX_LINES) {
    job.lines = job.lines.slice(job.lines.length - MAX_LINES);
  }
}

async function streamInto(stream: ReadableStream<Uint8Array> | null): Promise<void> {
  if (!stream) return;
  const decoder = new TextDecoder();
  const reader = stream.getReader();
  let buf = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const nl = buf.lastIndexOf("\n");
    if (nl >= 0) {
      pushLine(buf.slice(0, nl));
      buf = buf.slice(nl + 1);
    }
  }
  if (buf) pushLine(buf);
}

function startRefresh(kind: "all" | "source", sourceId?: string): { ok: boolean; error?: string } {
  if (job?.running) {
    return { ok: false, error: "A refresh is already running." };
  }
  const args =
    kind === "all" ? [CLI_PATH, "prefetch"] : [CLI_PATH, "refresh", sourceId ?? ""];
  if (kind === "source" && !sourceId) {
    return { ok: false, error: "Missing source id." };
  }

  job = {
    kind,
    label: kind === "all" ? "Refreshing all sources" : `Refreshing ${sourceId}`,
    startedAt: new Date().toISOString(),
    running: true,
    exitCode: null,
    lines: [],
  };

  child = Bun.spawn(["bun", ...args], {
    cwd: SKILL_DIR,
    env: { ...process.env },
    stdout: "pipe",
    stderr: "pipe",
  });

  // Stream both pipes into the line buffer.
  void streamInto(child.stdout as ReadableStream<Uint8Array>);
  void streamInto(child.stderr as ReadableStream<Uint8Array>);

  // Mark done on exit.
  void child.exited.then((code) => {
    if (job) {
      job.running = false;
      job.exitCode = code;
      pushLine(code === 0 ? "✓ Done." : `✗ Exited with code ${code}.`);
    }
    child = null;
  });

  return { ok: true };
}

// ----------------------------------------------------------------------------
// API payload
// ----------------------------------------------------------------------------

function buildData(): string {
  const events = readEvents();
  const sources = loadSources().map((s) => ({
    id: s.id,
    name: s.name,
    lastFetched: s.lastFetched ?? null,
    enabled: s.enabled,
  }));
  // lastUpdated lives on the cache file; readEvents() drops it, so re-read it
  // cheaply from the same module surface by reading the raw file is avoided —
  // instead derive freshness from the newest fetchedAt we have.
  const newestFetched = events.reduce<string>(
    (acc, e) => (e.fetchedAt > acc ? e.fetchedAt : acc),
    ""
  );
  return JSON.stringify({ events, sources, lastUpdated: newestFetched, saved: readSaved() });
}

// ----------------------------------------------------------------------------
// Server
// ----------------------------------------------------------------------------

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

export function startUiServer(): ReturnType<typeof Bun.serve> {
  const port = Number(process.env["EVENTSCOUT_UI_PORT"] ?? 4180);
  // Loopback + auth-free by default; phone access is opt-in via
  // `eventscout_ui_bind` + `eventscout_ui_token` in secrets.json (lib/core/RemoteAccess.ts).
  const { bind, token } = resolveRemoteAccess({
    secretPrefix: "eventscout_ui",
    bindEnv: "EVENTSCOUT_UI_BIND",
    tokenEnv: "EVENTSCOUT_UI_TOKEN",
  });

  const server = Bun.serve({
    port,
    hostname: bind,
    idleTimeout: 0,
    fetch: withRemoteAuth(handle, token, "kaya_eventscout", ["/health"]),
  });

  async function handle(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const { pathname } = url;

    try {
      if (pathname === "/health") return json({ ok: true });

      if (pathname === "/" || pathname === "/index.html") {
        return new Response(readFileSync(INDEX_HTML, "utf-8"), {
          headers: { "content-type": "text/html; charset=utf-8" },
        });
      }

      if (pathname === "/api/data") {
        return new Response(buildData(), {
          headers: { "content-type": "application/json" },
        });
      }

      if (pathname === "/api/saved/add" && req.method === "POST") {
        const body = (await req.json().catch(() => ({}))) as {
          id?: string;
          event?: unknown;
        };
        if (!body.id) return json({ error: "Missing event id." }, 400);
        // Cache copy is authoritative; the client may pass its own snapshot
        // as a fallback for events that already rotated out of the cache
        // (unsave → re-save of a past event). saveEvent Zod-validates it.
        const event =
          readEvents().find((e) => e.id === body.id) ??
          (body.event as Parameters<typeof saveEvent>[0] | undefined);
        if (!event) return json({ error: `Event not in cache: ${body.id}` }, 404);
        const { added } = saveEvent(event);
        return json({ added, saved: readSaved() });
      }

      if (pathname === "/api/saved/remove" && req.method === "POST") {
        const body = (await req.json().catch(() => ({}))) as { id?: string };
        if (!body.id) return json({ error: "Missing event id." }, 400);
        const { removed } = unsaveEvent(body.id);
        return json({ removed, saved: readSaved() });
      }

      if (pathname === "/api/refresh" && req.method === "POST") {
        const r = startRefresh("all");
        return r.ok ? json({ started: true }) : json({ error: r.error }, 409);
      }

      if (pathname === "/api/refresh/source" && req.method === "POST") {
        const body = (await req.json().catch(() => ({}))) as { id?: string };
        const r = startRefresh("source", body.id);
        return r.ok ? json({ started: true }) : json({ error: r.error }, 400);
      }

      if (pathname === "/api/refresh/status") {
        return json(
          job
            ? {
                active: true,
                kind: job.kind,
                label: job.label,
                startedAt: job.startedAt,
                running: job.running,
                exitCode: job.exitCode,
                lines: job.lines,
              }
            : { active: false }
        );
      }

      return new Response("Not found", { status: 404 });
    } catch (err) {
      return json({ error: (err as Error).message }, 500);
    }
  }

  const addr = `http://localhost:${server.port}`;
  console.log(`\nEventScout UI → ${addr}${bind === "127.0.0.1" ? "" : ` (bound ${bind}, token auth ${token ? "ON" : "OFF"})`}\n`);
  console.log("  • Browse, filter, and search the cached events catalog.");
  console.log("  • Refresh all sources or a single source from the toolbar.");
  console.log("  • Ctrl-C to stop.\n");

  // Best-effort: open the default browser on macOS (skip when headless).
  if (process.platform === "darwin" && process.env["EVENTSCOUT_UI_NO_OPEN"] !== "1") {
    try {
      Bun.spawn(["open", addr], { stdout: "ignore", stderr: "ignore" });
    } catch {
      /* non-fatal */
    }
  }

  return server;
}

if (import.meta.main) {
  startUiServer();
}
