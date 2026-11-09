import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { EventItem } from "../Tools/types.ts";

test("cached query returns every result without provider imports or side effects", async () => {
  const directory = mkdtempSync(join(tmpdir(), "eventscout-query-offline-"));
  const paths = {
    cache: join(directory, "cache.json"),
    sources: join(directory, "sources.json"),
    profile: join(directory, "profile.json"),
    state: join(directory, "state.json"),
  };
  const home = { lat: 32.7157, lng: -117.1611 };
  const events: EventItem[] = Array.from({ length: 13 }, (_, index) => ({
    id: `offline-${index}`,
    title: `Offline event ${String(index).padStart(2, "0")}`,
    startDatetime: `2026-06-${String(index === 12 ? 25 : index + 1).padStart(2, "0")}T19:00:00-07:00`,
    allDay: false,
    venue: "Offline venue",
    ...home,
    category: "community",
    tags: [],
    isFree: false,
    sourceUrl: `https://example.com/offline/${index}`,
    sources: [{ sourceId: "offline", url: "https://example.com/offline" }],
    fetchedAt: "2026-05-31T12:00:00Z",
    status: "scheduled",
  }));
  const inputs = {
    [paths.cache]: JSON.stringify({ events, lastUpdated: "2026-05-31T12:00:00Z" }),
    [paths.sources]: JSON.stringify([{ id: "offline", name: "Offline source", url: "https://example.com/offline", fetchTier: "ics", enabled: true, pollInterval: 60 }]),
    [paths.profile]: JSON.stringify({ homeLocation: { ...home, label: "Offline home" }, defaultRadiusMiles: 25 }),
    [paths.state]: "{}",
  };
  const context = { rawQuery: "offline events", window: { start: "2026-06-01T00:00:00-07:00", end: "2026-06-12T23:59:59-07:00" }, home, radiusMiles: 25 };
  const queryPath = resolve(import.meta.dir, "../Tools/Query.ts");
  const script = `
    import { createRequire, syncBuiltinESMExports } from "node:module";
    import { resolve } from "node:path";
    import { fileURLToPath } from "node:url";
    import assert from "node:assert/strict";
    const fs = createRequire(import.meta.url)("node:fs");
    const allowedReads = new Set(${JSON.stringify(Object.keys(inputs))});
    const hits = [];
    function forbidden(action) { hits.push(action); throw new Error("OFFLINE_GUARD: " + action); }
    const read = fs.readFileSync;
    fs.readFileSync = (path, ...args) => {
      const resolved = path instanceof URL ? fileURLToPath(path) : resolve(String(path));
      if (!allowedReads.has(resolved)) return forbidden("read: " + resolved);
      return Reflect.apply(read, fs, [path, ...args]);
    };
    for (const name of ["writeFileSync", "writeFile", "appendFileSync", "appendFile", "mkdirSync", "mkdir", "rmSync", "rm", "unlinkSync", "unlink", "renameSync", "rename", "copyFileSync", "copyFile", "openSync", "open", "createWriteStream", "readFile", "createReadStream"]) {
      fs[name] = () => forbidden("fs." + name);
    }
    syncBuiltinESMExports();
    globalThis.fetch = () => forbidden("fetch");
    for (const name of ["WebSocket", "EventSource"]) globalThis[name] = function () { return forbidden(name); };
    for (const name of ["connect", "listen", "serve", "spawn", "spawnSync", "write", "file"]) Bun[name] = () => forbidden("Bun." + name);
    Bun.plugin({ name: "offline-query-provider-guard", setup(build) {
      build.onResolve({ filter: /(?:^|\\/)(?:Inference|Ingest)\\.ts$/ }, args => forbidden("provider import: " + args.path));
      build.onResolve({ filter: /^(node:)?(https?|http2|net|tls|dgram|dns|child_process|worker_threads)(\\/|$)/ }, args => forbidden("module: " + args.path));
    }});
    const { queryHybrid } = await import(${JSON.stringify(queryPath)});
    const result = await queryHybrid(${JSON.stringify(context)}, Infinity, false);
    const ids = ${JSON.stringify(events.slice(0, 12).map(event => event.id))};
    assert.deepEqual(result.events.map(event => event.id), ids);
    assert.deepEqual(result.rankedEvents.map(event => event.id), ids);
    assert.deepEqual(result.refreshedSources, []);
    assert.deepEqual(result.skippedSources, []);
    assert(result.markdown.includes("Top 10 of 12 matches"));
    assert(result.markdown.includes("### More matches (2)"));
    for (const title of ${JSON.stringify(events.slice(0, 12).map(event => event.title))}) assert.equal(result.markdown.split(title).length - 1, 1);
    assert(!result.markdown.includes("Offline event 12"));
    assert.deepEqual(hits, []);
    console.log("OFFLINE_QUERY_PASSED");
  `;
  try {
    for (const [path, bytes] of Object.entries(inputs)) writeFileSync(path, bytes);
    const child = Bun.spawn([process.execPath, "--eval", script], {
      cwd: directory,
      env: {
        PATH: "/opt/homebrew/bin:/usr/bin:/bin",
        NODE_PATH: process.env.NODE_PATH ?? "~/.claude/node_modules",
        TZ: "America/Los_Angeles",
        KAYA_HOME: directory,
        KAYA_DIR: directory,
        EVENTSCOUT_CACHE_PATH: paths.cache,
        EVENTSCOUT_SOURCES_PATH: paths.sources,
        EVENTSCOUT_SOURCE_STATE_PATH: paths.state,
        EVENTSCOUT_PROFILE_PATH: paths.profile,
        EVENTSCOUT_GEOCACHE_PATH: join(directory, "unused-geocache.json"),
        EVENTSCOUT_DISABLE_RERANK: "1",
      },
      stdout: "pipe",
      stderr: "pipe",
      timeout: 10_000,
    });
    const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: "" });
    expect(stdout).toContain("OFFLINE_QUERY_PASSED");
    for (const [path, bytes] of Object.entries(inputs)) expect(readFileSync(path, "utf8")).toBe(bytes);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}, 15_000);
