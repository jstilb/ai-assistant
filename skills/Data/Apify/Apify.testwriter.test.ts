/**
 * TestWriter spec-driven tests for Apify skill architecture review fixes.
 * ISC rows 600–606. These tests are written before implementation exists
 * and will fail until the Builder satisfies them.
 *
 * Surface: integration (module-import tests)
 */

import { describe, it, expect, mock, beforeEach } from 'bun:test'

// ---------------------------------------------------------------------------
// ISC-600: No `any` types — type safety
// ---------------------------------------------------------------------------
describe('ISC-600: Type safety — no any types', () => {
  it('Apify constructor accepts optional token and returns typed instance', async () => {
    const { Apify } = await import('./index.ts')
    // Token is missing in env — constructor should throw (ISC-603 overlap)
    // We just verify the module exports a class
    expect(typeof Apify).toBe('function')
  })

  it('callActor is generic and returns typed ActorRun with typed output', async () => {
    const { Apify, ActorRunSchema } = await import('./index.ts')
    // Verify ActorRunSchema is exported for runtime validation (Zod schema)
    expect(ActorRunSchema).toBeDefined()
    expect(typeof ActorRunSchema.parse).toBe('function')
  })

  it('ApifyDataset.listItems returns typed generic array, not any[]', async () => {
    const { ApifyDataset } = await import('./index.ts')
    // Verify ApifyDataset is still exported
    expect(typeof ApifyDataset).toBe('function')
  })

  it('getAllItems accepts GetAllItemsOptions with maxPages and pageSize', async () => {
    // GetAllItemsOptions interface must be exported
    // We verify it by checking the module exports it or that getAllItems accepts the shape
    const { ApifyDataset } = await import('./index.ts')
    const proto = ApifyDataset.prototype
    expect(typeof proto.getAllItems).toBe('function')
    // getAllItems must accept options object — verified by TypeScript (noEmit check in build)
  })
})

// ---------------------------------------------------------------------------
// ISC-601: getAllItems() page cap
// ---------------------------------------------------------------------------
describe('ISC-601: getAllItems() page cap', () => {
  it('getAllItems() stops at maxPages=2 and emits a warning when cap is hit', async () => {
    const { ApifyDataset } = await import('./index.ts')

    // Mock the apify-client Dataset
    let callCount = 0
    const mockListItems = mock(async ({ offset, limit }: { offset: number; limit: number }) => {
      callCount++
      return {
        items: Array.from({ length: limit }, (_, i) => ({ idx: offset + i })),
        count: limit,
        total: 10000, // large dataset — would loop forever without cap
      }
    })

    // Construct ApifyDataset with a mock client
    const mockClient = {
      dataset: (_id: string) => ({ listItems: mockListItems }),
    }
    // @ts-expect-error — injecting mock client for testing
    const ds = new ApifyDataset(mockClient, 'test-dataset-id')

    const warnMessages: string[] = []
    const originalWarn = console.warn
    console.warn = (...args: unknown[]) => { warnMessages.push(String(args[0])) }

    const items = await ds.getAllItems({ maxPages: 2, pageSize: 100 })

    console.warn = originalWarn

    // Must stop at maxPages=2 (200 items), not loop forever
    expect(callCount).toBe(2)
    expect(items).toHaveLength(200)
    // Must emit a warning about the cap
    expect(warnMessages.some(m => m.includes('maxPages'))).toBe(true)
  })

  it('getAllItems() uses default maxPages=10 when no options provided', async () => {
    const { ApifyDataset } = await import('./index.ts')

    let callCount = 0
    const mockListItems = mock(async ({ offset, limit }: { offset: number; limit: number }) => {
      callCount++
      return {
        items: Array.from({ length: limit }, (_, i) => ({ idx: offset + i })),
        count: limit,
        total: 100000, // very large
      }
    })

    const mockClient = {
      dataset: (_id: string) => ({ listItems: mockListItems }),
    }
    // @ts-expect-error — injecting mock client for testing
    const ds = new ApifyDataset(mockClient, 'test-dataset-id')

    const warnMessages: string[] = []
    const originalWarn = console.warn
    console.warn = (...args: unknown[]) => { warnMessages.push(String(args[0])) }

    await ds.getAllItems()

    console.warn = originalWarn

    // Default cap is 10 pages
    expect(callCount).toBe(10)
    expect(warnMessages.some(m => m.includes('maxPages'))).toBe(true)
  })

  it('getAllItems() with Infinity maxPages fetches until dataset exhausted', async () => {
    const { ApifyDataset } = await import('./index.ts')

    let callCount = 0
    const mockListItems = mock(async ({ offset, limit }: { offset: number; limit: number }) => {
      callCount++
      const total = 2500
      const count = Math.min(limit, total - offset)
      return {
        items: Array.from({ length: count }, (_, i) => ({ idx: offset + i })),
        count,
        total,
      }
    })

    const mockClient = {
      dataset: (_id: string) => ({ listItems: mockListItems }),
    }
    // @ts-expect-error — injecting mock client for testing
    const ds = new ApifyDataset(mockClient, 'test-dataset-id')

    const items = await ds.getAllItems({ maxPages: Infinity, pageSize: 1000 })

    // 2500 items / 1000 per page = 3 pages
    expect(callCount).toBe(3)
    expect(items).toHaveLength(2500)
  })
})

// ---------------------------------------------------------------------------
// ISC-602: Error handling — retry and timeout
// ---------------------------------------------------------------------------
describe('ISC-602: Error handling — retry and timeout', () => {
  it('waitForRun defaults to waitSecs=300 when no options provided', async () => {
    // We test the behavior by mocking the client.run().waitForFinish and checking args
    const { Apify } = await import('./index.ts')

    let capturedWaitSecs: number | undefined
    const mockWaitForFinish = mock(async ({ waitSecs }: { waitSecs: number }) => {
      capturedWaitSecs = waitSecs
      return {
        id: 'run-1',
        actorId: 'actor-1',
        status: 'SUCCEEDED',
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
        defaultDatasetId: 'ds-1',
        defaultKeyValueStoreId: 'kvs-1',
      }
    })

    const mockClient = {
      run: (_id: string) => ({ waitForFinish: mockWaitForFinish }),
    }

    process.env.APIFY_TOKEN = 'test-token'
    const apify = new Apify('test-token')
    // @ts-expect-error — injecting mock client for testing
    apify['client'] = mockClient

    await apify.waitForRun('run-1')

    expect(capturedWaitSecs).toBe(300)
  })

  // NEEDS-JM (fable-audit batch3, slice 1): retry-with-backoff was deliberately
  // NOT restored to index.ts. It multiplies cost on a *paid* actor run if
  // failures are non-transient, so restoring it is gated on Jm's sign-off
  // (see plans/audits/fable-audit-apify-2026-07-17.md §7 Needs-Jm #1).
  // Marked `.todo` — a pending spec bun reports explicitly (not a silent skip),
  // so the suite stays green while this stays visibly tracked. When Jm approves
  // restoring withRetry(), flip `.todo` → `it` and it should pass as written.
  it.todo('callActor retries up to 3 times on network failure before throwing', async () => {
    const { Apify } = await import('./index.ts')

    let attempts = 0
    const mockCall = mock(async () => {
      attempts++
      throw new Error('Network error')
    })

    const mockClient = {
      actor: (_id: string) => ({ call: mockCall }),
    }

    const apify = new Apify('test-token')
    // @ts-expect-error — injecting mock client for testing
    apify['client'] = mockClient

    await expect(
      apify.callActor('actor/test', { key: 'value' })
    ).rejects.toThrow()

    // Must have retried 3 times total
    expect(attempts).toBe(3)
  }, 30000) // allow time for backoff
})

// ---------------------------------------------------------------------------
// ISC-603: Token validation — canonical APIFY_TOKEN env var
// ---------------------------------------------------------------------------
describe('ISC-603: Token validation', () => {
  it('Apify constructor throws a clear error when no token is provided and APIFY_TOKEN is unset', async () => {
    const { Apify } = await import('./index.ts')

    const savedToken = process.env.APIFY_TOKEN
    const savedApiKey = process.env.APIFY_API_KEY
    delete process.env.APIFY_TOKEN
    delete process.env.APIFY_API_KEY

    let thrownError: Error | null = null
    try {
      new Apify()
    } catch (e) {
      thrownError = e as Error
    }

    process.env.APIFY_TOKEN = savedToken ?? ''
    if (savedApiKey) process.env.APIFY_API_KEY = savedApiKey

    expect(thrownError).not.toBeNull()
    expect(thrownError!.message).toContain('APIFY_TOKEN')
    // Must NOT silently accept undefined token
    expect(thrownError!.message.length).toBeGreaterThan(20)
  })

  it('Apify constructor does NOT fall back to APIFY_API_KEY — only APIFY_TOKEN is canonical', async () => {
    // Re-import fresh to avoid module cache issues
    const { Apify } = await import('./index.ts')

    const savedToken = process.env.APIFY_TOKEN
    const savedApiKey = process.env.APIFY_API_KEY
    delete process.env.APIFY_TOKEN
    process.env.APIFY_API_KEY = 'old-key-should-not-work'

    let thrownError: Error | null = null
    try {
      new Apify()
    } catch (e) {
      thrownError = e as Error
    }

    process.env.APIFY_TOKEN = savedToken ?? ''
    if (savedApiKey) process.env.APIFY_API_KEY = savedApiKey
    else delete process.env.APIFY_API_KEY

    // Must throw — APIFY_API_KEY is no longer a fallback
    expect(thrownError).not.toBeNull()
    expect(thrownError!.message).toContain('APIFY_TOKEN')
  })
})

// ---------------------------------------------------------------------------
// ISC-604: JSONL audit log
// ---------------------------------------------------------------------------
describe('ISC-604: JSONL audit log', () => {
  it('logActorRun is exported from index.ts', async () => {
    const mod = await import('./index.ts')
    // The module must export logActorRun or expose it via a named export
    expect(typeof (mod as Record<string, unknown>).logActorRun).toBe('function')
  })

  it('callActor writes an audit log entry after a successful run', async () => {
    const { Apify } = await import('./index.ts')
    const { existsSync, readFileSync, mkdirSync } = await import('fs')
    const { join } = await import('path')
    const os = await import('os')

    // Override KAYA_HOME so we write to a temp dir
    const tmpDir = join(os.tmpdir(), `apify-test-${Date.now()}`)
    mkdirSync(join(tmpDir, 'MEMORY', 'MONITORING', 'audit'), { recursive: true })
    const savedKayaHome = process.env.KAYA_HOME
    process.env.KAYA_HOME = tmpDir

    const mockRun = {
      id: 'run-audit-test',
      actorId: 'test/actor',
      status: 'SUCCEEDED',
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      defaultDatasetId: 'ds-audit',
      defaultKeyValueStoreId: 'kvs-audit',
    }

    const mockCall = mock(async () => mockRun)
    const mockClient = {
      actor: (_id: string) => ({ call: mockCall }),
    }

    const apify = new Apify('test-token')
    // @ts-expect-error — injecting mock client for testing
    apify['client'] = mockClient

    await apify.callActor('test/actor', { query: 'test' })

    // Give async log write a tick to complete
    await new Promise(r => setTimeout(r, 50))

    const logPath = join(tmpDir, 'MEMORY', 'MONITORING', 'audit', 'apify-runs.jsonl')
    expect(existsSync(logPath)).toBe(true)

    const logContent = readFileSync(logPath, 'utf-8').trim()
    expect(logContent.length).toBeGreaterThan(0)

    const entry = JSON.parse(logContent.split('\n')[0])
    expect(entry.actorId).toBe('test/actor')
    expect(entry.status).toBe('SUCCEEDED')
    expect(typeof entry.ts).toBe('number')

    process.env.KAYA_HOME = savedKayaHome ?? ''
  })
})
