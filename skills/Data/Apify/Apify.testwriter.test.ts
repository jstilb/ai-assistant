/**
 * TestWriter spec-driven tests for Apify skill architecture review fixes.
 * ISC rows 600–606. These tests are written before implementation exists
 * and will fail until the Builder satisfies them.
 *
 * Surface: integration (module-import tests)
 */

import { describe, it, expect, mock } from "bun:test";

// ---------------------------------------------------------------------------
// ISC-600: No `any` types — type safety
// ---------------------------------------------------------------------------
describe("ISC-600: Type safety — no any types", () => {
  it("Apify constructor accepts optional token and returns typed instance", async () => {
    const { Apify } = await import("./index.ts");
    // Token is missing in env — constructor should throw (ISC-603 overlap)
    // We just verify the module exports a class
    expect(typeof Apify).toBe("function");
  });

  it("callActor is generic and returns typed ActorRun with typed output", async () => {
    const { ActorRunSchema } = await import("./index.ts");
    // Verify ActorRunSchema is exported for runtime validation (Zod schema)
    expect(ActorRunSchema).toBeDefined();
    expect(typeof ActorRunSchema.parse).toBe("function");
  });

  it("ApifyDataset.listItems returns typed generic array, not any[]", async () => {
    const { ApifyDataset } = await import("./index.ts");
    // Verify ApifyDataset is still exported
    expect(typeof ApifyDataset).toBe("function");
  });

  it("getAllItems accepts GetAllItemsOptions with maxPages and pageSize", async () => {
    // GetAllItemsOptions interface must be exported
    // We verify it by checking the module exports it or that getAllItems accepts the shape
    const { ApifyDataset } = await import("./index.ts");
    const proto = ApifyDataset.prototype;
    expect(typeof proto.getAllItems).toBe("function");
    // getAllItems must accept options object — verified by TypeScript (noEmit check in build)
  });
});

// ---------------------------------------------------------------------------
// ISC-601: getAllItems() page cap
// ---------------------------------------------------------------------------
describe("ISC-601: getAllItems() page cap", () => {
  it("getAllItems() stops at maxPages=2 and emits a warning when cap is hit", async () => {
    const { ApifyDataset } = await import("./index.ts");

    // Mock the apify-client Dataset
    let callCount = 0;
    const mockListItems = mock(async ({ offset, limit }: { offset: number; limit: number }) => {
      callCount++;
      return {
        items: Array.from({ length: limit }, (_, i) => ({ idx: offset + i })),
        count: limit,
        total: 10000, // large dataset — would loop forever without cap
      };
    });

    // Construct ApifyDataset with a mock client
    const mockClient = {
      dataset: (_id: string) => ({ listItems: mockListItems }),
    };
    // @ts-expect-error — injecting mock client for testing
    const ds = new ApifyDataset(mockClient, "test-dataset-id");

    const warnMessages: string[] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => {
      warnMessages.push(String(args[0]));
    };

    const items = await ds.getAllItems({ maxPages: 2, pageSize: 100 });

    console.warn = originalWarn;

    // Must stop at maxPages=2 (200 items), not loop forever
    expect(callCount).toBe(2);
    expect(items).toHaveLength(200);
    // Must emit a warning about the cap
    expect(warnMessages.some((m) => m.includes("maxPages"))).toBe(true);
  });

  it("getAllItems() uses default maxPages=10 when no options provided", async () => {
    const { ApifyDataset } = await import("./index.ts");

    let callCount = 0;
    const mockListItems = mock(async ({ offset, limit }: { offset: number; limit: number }) => {
      callCount++;
      return {
        items: Array.from({ length: limit }, (_, i) => ({ idx: offset + i })),
        count: limit,
        total: 100000, // very large
      };
    });

    const mockClient = {
      dataset: (_id: string) => ({ listItems: mockListItems }),
    };
    // @ts-expect-error — injecting mock client for testing
    const ds = new ApifyDataset(mockClient, "test-dataset-id");

    const warnMessages: string[] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => {
      warnMessages.push(String(args[0]));
    };

    await ds.getAllItems();

    console.warn = originalWarn;

    // Default cap is 10 pages
    expect(callCount).toBe(10);
    expect(warnMessages.some((m) => m.includes("maxPages"))).toBe(true);
  });

  it("getAllItems() with Infinity maxPages fetches until dataset exhausted", async () => {
    const { ApifyDataset } = await import("./index.ts");

    let callCount = 0;
    const mockListItems = mock(async ({ offset, limit }: { offset: number; limit: number }) => {
      callCount++;
      const total = 2500;
      const count = Math.min(limit, total - offset);
      return {
        items: Array.from({ length: count }, (_, i) => ({ idx: offset + i })),
        count,
        total,
      };
    });

    const mockClient = {
      dataset: (_id: string) => ({ listItems: mockListItems }),
    };
    // @ts-expect-error — injecting mock client for testing
    const ds = new ApifyDataset(mockClient, "test-dataset-id");

    const items = await ds.getAllItems({ maxPages: Infinity, pageSize: 1000 });

    // 2500 items / 1000 per page = 3 pages
    expect(callCount).toBe(3);
    expect(items).toHaveLength(2500);
  });
});

// ---------------------------------------------------------------------------
// ISC-602: Error handling — retry and timeout
// ---------------------------------------------------------------------------
describe("ISC-602: Error handling — retry and timeout", () => {
  it("waitForRun defaults to waitSecs=300 when no options provided", async () => {
    // We test the behavior by mocking the client.run().waitForFinish and checking args
    const { Apify } = await import("./index.ts");

    let capturedWaitSecs: number | undefined;
    const mockWaitForFinish = mock(async ({ waitSecs }: { waitSecs: number }) => {
      capturedWaitSecs = waitSecs;
      return {
        id: "run-1",
        actorId: "actor-1",
        status: "SUCCEEDED",
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
        defaultDatasetId: "ds-1",
        defaultKeyValueStoreId: "kvs-1",
      };
    });

    const mockClient = {
      run: (_id: string) => ({ waitForFinish: mockWaitForFinish }),
    };

    process.env.APIFY_TOKEN = "test-token";
    const apify = new Apify("test-token");
    // @ts-expect-error — injecting mock client for testing
    apify["client"] = mockClient;

    await apify.waitForRun("run-1");

    expect(capturedWaitSecs).toBe(300);
  });

  // T5-04 (plans/audits/remediation/theme5-apify-retry-restore.md): callActor makes at most
  // 2 attempts, retries only transient errors (429, 5xx, network codes), and never a 4xx.
  // The naive "retry any error 3 times" spec was replaced by these three fixtures.
  describe("callActor retry (T5-04)", () => {
    const okRun = {
      id: "run-retry",
      actorId: "actor/test",
      status: "SUCCEEDED",
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      defaultDatasetId: "ds-retry",
      defaultKeyValueStoreId: "kvs-retry",
    };

    /** An error shaped like apify-client's ApifyApiError (name + statusCode). */
    const apiError = (statusCode: number) =>
      Object.assign(new Error(`HTTP ${statusCode}`), { name: "ApifyApiError", statusCode });

    async function makeApify(callImpl: () => Promise<unknown>) {
      const { Apify } = await import("./index.ts");
      const mockCall = mock(callImpl);
      const apify = new Apify("test-token");
      // @ts-expect-error — injecting mock client for testing
      apify["client"] = { actor: (_id: string) => ({ call: mockCall }) };
      // Private field (bracket access is allowed): set to 0 so the test does not wait.
      apify["retryDelayMs"] = 0;
      return { apify, mockCall };
    }

    /** Run `fn` with a temp KAYA_HOME and return the audit entries it wrote. */
    async function withTempKayaHome(fn: () => Promise<void>): Promise<Array<Record<string, unknown>>> {
      const { mkdtempSync, readFileSync, existsSync, rmSync } = await import("node:fs");
      const { join } = await import("node:path");
      const { tmpdir } = await import("node:os");
      const dir = mkdtempSync(join(tmpdir(), "apify-retry-"));
      const saved = process.env.KAYA_HOME;
      process.env.KAYA_HOME = dir;
      try {
        await fn();
        await new Promise((r) => setTimeout(r, 50)); // success audit write is async
        const logPath = join(dir, "MEMORY", "MONITORING", "audit", "apify-runs.jsonl");
        if (!existsSync(logPath)) return [];
        return readFileSync(logPath, "utf-8")
          .split("\n")
          .filter(Boolean)
          .map((l) => JSON.parse(l) as Record<string, unknown>);
      } finally {
        if (saved === undefined) delete process.env.KAYA_HOME;
        else process.env.KAYA_HOME = saved;
        rmSync(dir, { recursive: true, force: true });
      }
    }

    it("retries once after a transient 500 and returns the second run", async () => {
      let calls = 0;
      const { apify, mockCall } = await makeApify(async () => {
        calls++;
        if (calls === 1) throw apiError(500);
        return okRun;
      });

      let result: Awaited<ReturnType<typeof apify.callActor>> | undefined;
      await withTempKayaHome(async () => {
        result = await apify.callActor("actor/test", { key: "value" });
      });

      expect(mockCall).toHaveBeenCalledTimes(2);
      expect(result?.id).toBe("run-retry");
    });

    it("retries a 429 and a network error code", async () => {
      for (const transient of [apiError(429), Object.assign(new Error("reset"), { code: "ECONNRESET" })]) {
        let calls = 0;
        const { apify, mockCall } = await makeApify(async () => {
          calls++;
          if (calls === 1) throw transient;
          return okRun;
        });
        await withTempKayaHome(async () => {
          await apify.callActor("actor/test", {});
        });
        expect(mockCall).toHaveBeenCalledTimes(2);
      }
    });

    it("does not retry a permanent 404 and rethrows the original error", async () => {
      const original = apiError(404);
      const { apify, mockCall } = await makeApify(async () => {
        throw original;
      });

      const entries = await withTempKayaHome(async () => {
        await expect(apify.callActor("actor/test", {})).rejects.toBe(original);
      });

      expect(mockCall).toHaveBeenCalledTimes(1);
      expect(entries).toHaveLength(1);
      expect(entries[0]?.status).toBe("ERROR");
    });

    it("does not retry a plain Error with no status or network code", async () => {
      const { apify, mockCall } = await makeApify(async () => {
        throw new Error("Network error");
      });

      await withTempKayaHome(async () => {
        await expect(apify.callActor("actor/test", {})).rejects.toThrow("Network error");
      });

      expect(mockCall).toHaveBeenCalledTimes(1);
    });

    it("stops after 2 attempts on a persistent 500, logs RETRY_EXHAUSTED, and rethrows", async () => {
      const original = apiError(503);
      const { apify, mockCall } = await makeApify(async () => {
        throw original;
      });

      const entries = await withTempKayaHome(async () => {
        await expect(apify.callActor("actor/test", { q: "x" })).rejects.toBe(original);
      });

      expect(mockCall).toHaveBeenCalledTimes(2);
      expect(entries).toHaveLength(1);
      expect(entries[0]?.status).toBe("RETRY_EXHAUSTED");
      expect(entries[0]?.actorId).toBe("actor/test");
      expect(entries[0]?.error).toBe("HTTP 503");
    });
  });
});

// ---------------------------------------------------------------------------
// ISC-603: Token validation — canonical APIFY_TOKEN env var
// ---------------------------------------------------------------------------
describe("ISC-603: Token validation", () => {
  it("Apify constructor throws a clear error when no token is provided and APIFY_TOKEN is unset", async () => {
    const { Apify } = await import("./index.ts");

    const savedToken = process.env.APIFY_TOKEN;
    const savedApiKey = process.env.APIFY_API_KEY;
    delete process.env.APIFY_TOKEN;
    delete process.env.APIFY_API_KEY;

    let thrownError: Error | null = null;
    try {
      new Apify();
    } catch (e) {
      thrownError = e as Error;
    }

    process.env.APIFY_TOKEN = savedToken ?? "";
    if (savedApiKey) process.env.APIFY_API_KEY = savedApiKey;

    expect(thrownError).not.toBeNull();
    expect(thrownError!.message).toContain("APIFY_TOKEN");
    // Must NOT silently accept undefined token
    expect(thrownError!.message.length).toBeGreaterThan(20);
  });

  it("Apify constructor does NOT fall back to APIFY_API_KEY — only APIFY_TOKEN is canonical", async () => {
    // Re-import fresh to avoid module cache issues
    const { Apify } = await import("./index.ts");

    const savedToken = process.env.APIFY_TOKEN;
    const savedApiKey = process.env.APIFY_API_KEY;
    delete process.env.APIFY_TOKEN;
    process.env.APIFY_API_KEY = "old-key-should-not-work";

    let thrownError: Error | null = null;
    try {
      new Apify();
    } catch (e) {
      thrownError = e as Error;
    }

    process.env.APIFY_TOKEN = savedToken ?? "";
    if (savedApiKey) process.env.APIFY_API_KEY = savedApiKey;
    else delete process.env.APIFY_API_KEY;

    // Must throw — APIFY_API_KEY is no longer a fallback
    expect(thrownError).not.toBeNull();
    expect(thrownError!.message).toContain("APIFY_TOKEN");
  });
});

// ---------------------------------------------------------------------------
// ISC-604: JSONL audit log
// ---------------------------------------------------------------------------
describe("ISC-604: JSONL audit log", () => {
  it("logActorRun is exported from index.ts", async () => {
    const mod = await import("./index.ts");
    // The module must export logActorRun or expose it via a named export
    expect(typeof (mod as Record<string, unknown>).logActorRun).toBe("function");
  });

  it("callActor writes an audit log entry after a successful run", async () => {
    const { Apify } = await import("./index.ts");
    const { existsSync, readFileSync, mkdirSync } = await import("node:fs");
    const { join } = await import("node:path");
    const os = await import("node:os");

    // Override KAYA_HOME so we write to a temp dir
    const tmpDir = join(os.tmpdir(), `apify-test-${Date.now()}`);
    mkdirSync(join(tmpDir, "MEMORY", "MONITORING", "audit"), { recursive: true });
    const savedKayaHome = process.env.KAYA_HOME;
    process.env.KAYA_HOME = tmpDir;

    const mockRun = {
      id: "run-audit-test",
      actorId: "test/actor",
      status: "SUCCEEDED",
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      defaultDatasetId: "ds-audit",
      defaultKeyValueStoreId: "kvs-audit",
    };

    const mockCall = mock(async () => mockRun);
    const mockClient = {
      actor: (_id: string) => ({ call: mockCall }),
    };

    const apify = new Apify("test-token");
    // @ts-expect-error — injecting mock client for testing
    apify["client"] = mockClient;

    await apify.callActor("test/actor", { query: "test" });

    // Give async log write a tick to complete
    await new Promise((r) => setTimeout(r, 50));

    const logPath = join(tmpDir, "MEMORY", "MONITORING", "audit", "apify-runs.jsonl");
    expect(existsSync(logPath)).toBe(true);

    const logContent = readFileSync(logPath, "utf-8").trim();
    expect(logContent.length).toBeGreaterThan(0);

    const entry = JSON.parse(logContent.split("\n")[0] ?? "");
    expect(entry.actorId).toBe("test/actor");
    expect(entry.status).toBe("SUCCEEDED");
    expect(typeof entry.ts).toBe("number");

    process.env.KAYA_HOME = savedKayaHome ?? "";
  });
});
