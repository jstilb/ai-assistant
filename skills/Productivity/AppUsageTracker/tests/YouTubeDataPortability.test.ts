/**
 * YouTubeDataPortability.test.ts — verifies the DPA pull orchestrator using a
 * DI-stub HTTP fetcher. NEVER touches the real Google APIs.
 *
 * Coverage:
 *  - Happy path: refresh token → initiate → poll (IN_PROGRESS → COMPLETE) →
 *    download urls → files land at destDir.
 *  - FAILED state surfaces a typed error.
 *  - 429-shaped error from initiate (24h cooldown) surfaces with body intact.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadDPAConfig,
  loadGoogleOAuthClient,
  pullDPAArchive,
  type DPAConfig,
  type HttpFetcher,
  type HttpResponse,
} from "../Tools/YouTubeDataPortability.ts";

const CFG: DPAConfig = {
  clientId: "test-client-id.apps.googleusercontent.com",
  clientSecret: "test-secret",
  refreshToken: "test-refresh",
};

let dest: string;

beforeEach(() => {
  dest = mkdtempSync(join(tmpdir(), "dpa-test-"));
});

afterEach(() => {
  if (dest) rmSync(dest, { recursive: true, force: true });
});

interface Call {
  url: string;
  method: string;
  body?: string;
}

function makeStubFetcher(handlers: Array<(call: Call) => HttpResponse | Promise<HttpResponse>>): { http: HttpFetcher; calls: Call[] } {
  const calls: Call[] = [];
  let i = 0;
  const http: HttpFetcher = async (req) => {
    const call: Call = { url: req.url, method: req.method, body: req.body };
    calls.push(call);
    const handler = handlers[i++];
    if (!handler) throw new Error(`unexpected extra HTTP call #${i}: ${req.method} ${req.url}`);
    return handler(call);
  };
  return { http, calls };
}

function jsonOk(obj: unknown): HttpResponse {
  return { status: 200, headers: { "content-type": "application/json" }, body: JSON.stringify(obj) };
}

function bin(content: Uint8Array): HttpResponse {
  return { status: 200, headers: { "content-type": "application/octet-stream" }, body: content };
}

test("happy path: refresh → initiate → poll twice → download two urls", async () => {
  const fakeZip = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0xde, 0xad, 0xbe, 0xef]); // bare PK header
  const { http, calls } = makeStubFetcher([
    // 1. token refresh
    () => jsonOk({ access_token: "stub-access-token", expires_in: 3599, token_type: "Bearer" }),
    // 2. initiate
    () => jsonOk({ archiveJobId: "job-123", accessType: "ACCESS_TYPE_TIME_BASED" }),
    // 3. first poll — still running
    () => jsonOk({ state: "IN_PROGRESS", urls: [], name: "archiveJobs/job-123/portabilityArchiveState" }),
    // 4. second poll — complete with two signed URLs
    () => jsonOk({
      state: "COMPLETE",
      urls: ["https://storage.googleapis.com/dpa/job-123/part-0001.zip", "https://storage.googleapis.com/dpa/job-123/part-0002.zip"],
      name: "archiveJobs/job-123/portabilityArchiveState",
    }),
    // 5. download #1
    () => bin(fakeZip),
    // 6. download #2
    () => bin(fakeZip),
  ]);

  const result = await pullDPAArchive(CFG, ["myactivity.youtube"], dest, { http, intervalMs: 1, maxWaitMs: 5_000 });

  expect(result.archiveJobId).toBe("job-123");
  expect(result.accessType).toBe("ACCESS_TYPE_TIME_BASED");
  expect(result.files.length).toBe(2);
  for (const f of result.files) {
    expect(existsSync(f)).toBe(true);
    expect(readFileSync(f).byteLength).toBe(fakeZip.byteLength);
  }
  expect(readdirSync(dest).length).toBe(2);

  // Verify call sequence + auth headers
  expect(calls[0].url).toBe("https://oauth2.googleapis.com/token");
  expect(calls[0].method).toBe("POST");
  expect(calls[0].body).toContain("grant_type=refresh_token");
  expect(calls[0].body).toContain("refresh_token=test-refresh");

  expect(calls[1].url).toBe("https://dataportability.googleapis.com/v1/portabilityArchive:initiate");
  expect(calls[1].method).toBe("POST");
  const initBody = JSON.parse(calls[1].body ?? "{}");
  expect(initBody.resources).toEqual(["myactivity.youtube"]);

  expect(calls[2].url).toBe("https://dataportability.googleapis.com/v1/archiveJobs/job-123/portabilityArchiveState");
  expect(calls[2].method).toBe("GET");
  expect(calls[3].url).toBe(calls[2].url);
  expect(calls[4].url.startsWith("https://storage.googleapis.com/")).toBe(true);
});

test("FAILED state surfaces typed error after poll", async () => {
  const { http } = makeStubFetcher([
    () => jsonOk({ access_token: "t", expires_in: 3599, token_type: "Bearer" }),
    () => jsonOk({ archiveJobId: "job-fail", accessType: "ACCESS_TYPE_TIME_BASED" }),
    () => jsonOk({ state: "FAILED", urls: [], name: "archiveJobs/job-fail/portabilityArchiveState" }),
  ]);

  await expect(
    pullDPAArchive(CFG, ["myactivity.youtube"], dest, { http, intervalMs: 1, maxWaitMs: 5_000 }),
  ).rejects.toThrow(/FAILED/);
});

test("initiate returns 429 cooldown — error includes status + body", async () => {
  const { http } = makeStubFetcher([
    () => jsonOk({ access_token: "t", expires_in: 3599, token_type: "Bearer" }),
    () => ({
      status: 429,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ error: { message: "Requested resources have already been exported. You can initiate another export after 2026-05-13T22:00:00Z" } }),
    }),
  ]);

  await expect(
    pullDPAArchive(CFG, ["myactivity.youtube"], dest, { http, intervalMs: 1, maxWaitMs: 5_000 }),
  ).rejects.toThrow(/already been exported|429/);
});

test("poll loop times out cleanly if maxWaitMs exceeded", async () => {
  const { http } = makeStubFetcher([
    () => jsonOk({ access_token: "t", expires_in: 3599, token_type: "Bearer" }),
    () => jsonOk({ archiveJobId: "job-slow", accessType: "ACCESS_TYPE_TIME_BASED" }),
    () => jsonOk({ state: "IN_PROGRESS", urls: [], name: "archiveJobs/job-slow/portabilityArchiveState" }),
    () => jsonOk({ state: "IN_PROGRESS", urls: [], name: "archiveJobs/job-slow/portabilityArchiveState" }),
    () => jsonOk({ state: "IN_PROGRESS", urls: [], name: "archiveJobs/job-slow/portabilityArchiveState" }),
    () => jsonOk({ state: "IN_PROGRESS", urls: [], name: "archiveJobs/job-slow/portabilityArchiveState" }),
    () => jsonOk({ state: "IN_PROGRESS", urls: [], name: "archiveJobs/job-slow/portabilityArchiveState" }),
    () => jsonOk({ state: "IN_PROGRESS", urls: [], name: "archiveJobs/job-slow/portabilityArchiveState" }),
    () => jsonOk({ state: "IN_PROGRESS", urls: [], name: "archiveJobs/job-slow/portabilityArchiveState" }),
    () => jsonOk({ state: "IN_PROGRESS", urls: [], name: "archiveJobs/job-slow/portabilityArchiveState" }),
  ]);

  await expect(
    pullDPAArchive(CFG, ["myactivity.youtube"], dest, { http, intervalMs: 5, maxWaitMs: 30 }),
  ).rejects.toThrow(/timeout|maxWait/i);
});

test("loadGoogleOAuthClient: parses gcalcli-shaped {installed: {client_id, client_secret}}", () => {
  const path = join(dest, "client_secret.json");
  writeFileSync(path, JSON.stringify({
    installed: {
      client_id: "111-aaaa.apps.googleusercontent.com",
      client_secret: "GOCSPX-abc",
      project_id: "kaya-484418",
      redirect_uris: ["http://localhost"],
    },
  }));
  const client = loadGoogleOAuthClient(path);
  expect(client.clientId).toBe("111-aaaa.apps.googleusercontent.com");
  expect(client.clientSecret).toBe("GOCSPX-abc");
});

test("loadGoogleOAuthClient: throws when file missing", () => {
  const missingPath = join(dest, "does-not-exist.json");
  expect(() => loadGoogleOAuthClient(missingPath)).toThrow(/missing/);
});

test("loadGoogleOAuthClient: throws when client_id is empty/absent", () => {
  const path = join(dest, "bad-client.json");
  writeFileSync(path, JSON.stringify({ installed: { client_secret: "x" } }));
  expect(() => loadGoogleOAuthClient(path)).toThrow(/client_id/);
});

test("loadDPAConfig: composes gcalcli client + secrets.json refresh_token", () => {
  const clientPath = join(dest, "client_secret.json");
  writeFileSync(clientPath, JSON.stringify({ installed: { client_id: "cid", client_secret: "sec" } }));
  const secretsPath = join(dest, "secrets.json");
  writeFileSync(secretsPath, JSON.stringify({ GOOGLE_DPA_REFRESH_TOKEN: "1//refresh", OTHER: "x" }));
  const cfg = loadDPAConfig(secretsPath, clientPath);
  expect(cfg.clientId).toBe("cid");
  expect(cfg.clientSecret).toBe("sec");
  expect(cfg.refreshToken).toBe("1//refresh");
});

test("loadDPAConfig: throws when GOOGLE_DPA_REFRESH_TOKEN missing", () => {
  const clientPath = join(dest, "client_secret.json");
  writeFileSync(clientPath, JSON.stringify({ installed: { client_id: "cid", client_secret: "sec" } }));
  const secretsPath = join(dest, "secrets.json");
  writeFileSync(secretsPath, JSON.stringify({ UNRELATED: "x" }));
  expect(() => loadDPAConfig(secretsPath, clientPath)).toThrow(/GOOGLE_DPA_REFRESH_TOKEN/);
});
