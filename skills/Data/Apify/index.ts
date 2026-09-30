/**
 * Apify Code-First Interface
 *
 * Replaces token-heavy MCP calls with direct code execution.
 * Enables in-code filtering and control flow for massive token savings.
 */

import { ApifyClient } from 'apify-client'
import { z } from 'zod'
import { join } from 'path'
import { getKayaHome } from '../../../lib/core/KayaHome.ts'
import { createAppendLog } from '../../../lib/core/AppendLog.ts'

// ---------------------------------------------------------------------------
// Runtime validation schema (ISC-600 restore, fable-audit batch3 slice 1)
//
// Validates the shape this class actually depends on (id, status, dataset/
// key-value-store ids, timestamps). Deliberately permissive beyond that:
// the real apify-client SDK response uses `actId` (not `actorId` — this
// class's own `actorId` field is populated from the caller's argument, not
// the wire response) and converts every `*At` field to a `Date` instance
// server-side (confirmed against the installed apify-client@2.22 types in
// node_modules/apify-client/dist/resource_clients/actor.d.ts — see
// `ActorRunListItem`/`parseDateFields`). `startedAt`/`finishedAt` accept
// both `string` and `Date` and unknown extra fields pass through so a real,
// valid response is never rejected on a naming/typing technicality.
// ---------------------------------------------------------------------------

export const ActorRunSchema = z.object({
  id: z.string(),
  status: z.enum(['READY', 'RUNNING', 'SUCCEEDED', 'FAILED', 'TIMED-OUT', 'ABORTED', 'ABORTING', 'TIMING-OUT']),
  startedAt: z.union([z.string(), z.date()]),
  finishedAt: z.union([z.string(), z.date()]).optional(),
  defaultDatasetId: z.string(),
  defaultKeyValueStoreId: z.string(),
  buildNumber: z.string().optional(),
  exitCode: z.number().optional(),
  containerUrl: z.string().optional(),
}).passthrough()

/**
 * Validate an actor-run response against ActorRunSchema.
 *
 * WARN-LOUD-AND-PASS, not hard-reject: EventScout's ApifyAdapter imports
 * this class directly as a live, cron-wired fetch tier for 2 real sources.
 * A `.parse()` that throws on any mismatch would turn an API shape drift
 * into a hard production failure on every run. Failures are logged loudly
 * (console.error) so drift is visible — the fear ISC-600 exists to guard
 * against — without adding a new failure mode on the paid, cron-wired path.
 */
function validateActorRun(run: unknown, context: string): void {
  const result = ActorRunSchema.safeParse(run)
  if (!result.success) {
    console.error(
      `[Apify] ActorRun response failed schema validation in ${context}(): ` +
      result.error.issues.map(i => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ')
    )
  }
}

// ---------------------------------------------------------------------------
// Interfaces (typed generics, no `any` — kept from d543dd98f)
// ---------------------------------------------------------------------------

export interface Actor {
  id: string
  name: string
  username: string
  title: string
  description?: string
  createdAt?: string
  modifiedAt?: string
  stats?: {
    totalRuns?: number
    lastRunStartedAt?: string
  }
}

export interface ActorRunOutput<T = unknown> {
  body: T
  contentType: string
}

export interface ActorRun<TOutput = unknown> {
  id: string
  actorId: string
  status: 'READY' | 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'TIMED-OUT' | 'ABORTED' | 'ABORTING' | 'TIMING-OUT'
  startedAt: string
  finishedAt?: string
  defaultDatasetId: string
  defaultKeyValueStoreId: string
  buildNumber?: string
  exitCode?: number
  containerUrl?: string
  output?: ActorRunOutput<TOutput>
}

export interface DatasetOptions {
  offset?: number
  limit?: number
  fields?: string[]
  omit?: string[]
  clean?: boolean
}

export interface GetAllItemsOptions {
  /** Default: 10 — hard cap. Pass Infinity to disable. */
  maxPages?: number
  /** Default: 1000 */
  pageSize?: number
}

// ---------------------------------------------------------------------------
// JSONL audit log (ISC-604 restore)
// ---------------------------------------------------------------------------

export interface ApifyRunAuditEntry {
  ts: number
  actorId: string
  runId?: string
  /** First 100 chars of JSON.stringify(input) — avoids logging PII */
  inputSummary: string
  startedAt: string
  finishedAt?: string
  status: string
  durationMs?: number
  datasetId?: string
  itemCount?: number
  error?: string
}

export function logActorRun(entry: ApifyRunAuditEntry): void {
  try {
    const logPath = join(getKayaHome(), 'MEMORY', 'MONITORING', 'audit', 'apify-runs.jsonl')
    // A fresh AppendLog per call (not a module-level singleton): getKayaHome()
    // can change between calls (e.g. tests overriding KAYA_HOME), so the
    // target path must be re-resolved every time rather than cached against
    // a stale directory. createAppendLog() itself is a cheap, stateless
    // factory — this adds no per-call I/O beyond the append.
    createAppendLog(logPath).append(entry)
  } catch {
    // Fire-and-forget: log failures must not interrupt the caller
  }
}

// ---------------------------------------------------------------------------
// Main Apify class
// ---------------------------------------------------------------------------

/**
 * Main Apify client for code-first operations
 */
export class Apify {
  private client: ApifyClient

  constructor(token?: string) {
    // ISC-603 restore: canonical token resolution — APIFY_TOKEN only, no
    // APIFY_API_KEY fallback — and fail loud when no token resolves at all.
    // Safe on the live path: EventScout's ApifyAdapter always passes an
    // explicit token loaded from secrets.json, so this throw cannot fire
    // on the cron-wired seam. It only changes behavior for the dead
    // actor-wrapper library's bare `new Apify()` call sites, which have 0
    // consumers today.
    const resolvedToken = token ?? process.env.APIFY_TOKEN
    if (!resolvedToken) {
      throw new Error(
        'Apify token is required. Set APIFY_TOKEN environment variable or pass token to constructor.\n' +
        'Get your token at: https://console.apify.com/account/integrations'
      )
    }
    this.client = new ApifyClient({ token: resolvedToken })
  }

  /**
   * Search for actors by keyword
   *
   * Fetches actors and filters client-side by query (name, title, description).
   * For better performance with many actors, consider listing all and caching.
   *
   * @param query - Search query (actor name, description, etc.)
   * @param options - Search options
   * @returns Array of matching actors
   */
  async search(query: string, options?: {
    limit?: number
    offset?: number
  }): Promise<Actor[]> {
    // Fetch more actors than needed to ensure we get enough matches
    const fetchLimit = Math.max((options?.limit ?? 10) * 3, 30)

    const { items } = await this.client.actors().list({
      limit: fetchLimit,
      offset: options?.offset ?? 0
    })

    // Filter client-side by query
    // Match if ANY word in query appears in actor fields
    const queryWords = query.toLowerCase().split(/\s+/)
    const filtered = items.filter((actor) => {
      const a = actor as Actor
      const name = (a.name || '').toLowerCase()
      const title = (a.title || '').toLowerCase()
      const description = (a.description || '').toLowerCase()
      const username = (a.username || '').toLowerCase()
      const searchText = `${name} ${title} ${description} ${username}`

      // Match if any query word is found
      return queryWords.some(word => searchText.includes(word))
    })

    // Return requested number of matches
    return filtered.slice(0, options?.limit ?? 10) as Actor[]
  }

  /**
   * Call (execute) an actor
   *
   * Validates the response shape (ISC-600) and writes a fire-and-forget
   * JSONL audit entry (ISC-604) on completion. Does NOT retry on failure —
   * retry-with-backoff was deliberately not restored here (touches paid
   * actor-run cost; Needs-Jm per fable-audit batch3).
   *
   * @param actorId - Actor ID or "username/actor-name"
   * @param input - Actor input configuration
   * @param options - Runtime options (memory, timeout)
   * @returns Actor run information
   */
  async callActor<TInput extends Record<string, unknown>, TOutput = unknown>(
    actorId: string,
    input: TInput,
    options?: {
      memory?: number    // Memory in MB (128, 256, 512, 1024, etc.)
      timeout?: number   // Timeout in seconds
      build?: string     // Build number or tag
    }
  ): Promise<ActorRun<TOutput>> {
    const startedAt = new Date().toISOString()
    const inputSummary = JSON.stringify(input).slice(0, 100)

    const run = await this.client.actor(actorId).call(input, {
      memory: options?.memory,
      timeout: options?.timeout,
      build: options?.build
    })

    validateActorRun(run, 'callActor')
    const result = run as unknown as ActorRun<TOutput>

    // ISC-604: async fire-and-forget audit log
    Promise.resolve().then(() => {
      logActorRun({
        ts: Date.now(),
        actorId,
        runId: result.id,
        inputSummary,
        startedAt,
        finishedAt: result.finishedAt,
        status: result.status,
        durationMs: result.finishedAt
          ? new Date(result.finishedAt).getTime() - new Date(startedAt).getTime()
          : undefined,
        datasetId: result.defaultDatasetId,
      })
    }).catch(() => {/* fire-and-forget */})

    return result
  }

  /**
   * Get dataset interface for reading and filtering data
   *
   * @param datasetId - Dataset ID from actor run
   * @returns ApifyDataset instance
   */
  getDataset(datasetId: string): ApifyDataset {
    return new ApifyDataset(this.client, datasetId)
  }

  /**
   * Get actor run status
   *
   * @param runId - Run ID
   * @returns Run information
   */
  async getRun(runId: string): Promise<ActorRun> {
    const run = await this.client.run(runId).get()
    validateActorRun(run, 'getRun')
    return run as unknown as ActorRun
  }

  /**
   * Wait for actor run to finish
   *
   * ISC-602 restore (default-timeout half only — the retry half of ISC-602
   * is Needs-Jm, see callActor doc above): defaults to a 300-second
   * (5-minute) timeout so callers don't block indefinitely by omission.
   * Pass waitSecs explicitly to override. Writes a JSONL audit entry with
   * final status (ISC-604).
   *
   * @param runId - Run ID
   * @param options - Wait options (waitSecs defaults to 300)
   * @returns Final run information
   */
  async waitForRun<TOutput = unknown>(
    runId: string,
    options?: { waitSecs?: number }
  ): Promise<ActorRun<TOutput>> {
    const waitSecs = options?.waitSecs ?? 300

    const run = await this.client.run(runId).waitForFinish({ waitSecs })
    validateActorRun(run, 'waitForRun')
    const result = run as unknown as ActorRun<TOutput>

    // ISC-604: audit log final status
    Promise.resolve().then(() => {
      logActorRun({
        ts: Date.now(),
        actorId: result.actorId,
        runId: result.id,
        inputSummary: '(waitForRun — input not available)',
        startedAt: result.startedAt,
        finishedAt: result.finishedAt,
        status: result.status,
        durationMs: result.finishedAt
          ? new Date(result.finishedAt).getTime() - new Date(result.startedAt).getTime()
          : undefined,
        datasetId: result.defaultDatasetId,
      })
    }).catch(() => {/* fire-and-forget */})

    return result
  }
}

// ---------------------------------------------------------------------------
// Dataset class
// ---------------------------------------------------------------------------

/**
 * Dataset interface for reading and filtering data
 *
 * KEY FEATURE: Filter data in code BEFORE returning to model context
 * This is where the massive token savings happen!
 */
export class ApifyDataset {
  constructor(
    private client: ApifyClient,
    private datasetId: string
  ) {}

  /**
   * List dataset items
   *
   * @param options - List options (pagination, fields)
   * @returns Array of dataset items
   */
  async listItems<TItem = unknown>(options?: DatasetOptions): Promise<TItem[]> {
    const { items } = await this.client.dataset(this.datasetId).listItems({
      offset: options?.offset,
      limit: options?.limit,
      fields: options?.fields,
      omit: options?.omit,
      clean: options?.clean
    })

    return items as TItem[]
  }

  /**
   * Get all dataset items with automatic pagination.
   *
   * ISC-601 restore: stops at maxPages (default: 10, i.e. 10,000 items at
   * default pageSize=1000). Pass `maxPages: Infinity` to disable the cap
   * explicitly. Per-call options, not a constructor param — matches the
   * TestWriter spec (Apify.testwriter.test.ts) and Tools/ApifyTool.ts's
   * `dataset` command, which already called `getAllItems({ maxPages,
   * pageSize })` and was type-broken against the pre-restore 0-arg
   * signature. EventScout's live ApifyAdapter never calls this method (it
   * reads via `listItems({ limit: 1 })` directly), so this cannot affect
   * the live cron-wired seam.
   *
   * @returns Array of all items up to the cap
   */
  async getAllItems<TItem = unknown>(options?: GetAllItemsOptions): Promise<TItem[]> {
    const maxPages = options?.maxPages ?? 10
    const pageSize = options?.pageSize ?? 1000
    const allItems: TItem[] = []
    let offset = 0
    let pages = 0

    while (true) {
      if (pages >= maxPages) {
        console.warn(
          `[Apify] getAllItems() reached maxPages=${maxPages} cap at ${allItems.length} items. ` +
          `Pass maxPages: Infinity to disable.`
        )
        break
      }

      const { items, count, total } = await this.client.dataset(this.datasetId).listItems({
        offset,
        limit: pageSize
      })

      allItems.push(...(items as TItem[]))
      pages++

      if (offset + count >= total) break
      offset += pageSize
    }

    return allItems
  }

  /**
   * Helper: Filter items by predicate function
   *
   * @param predicate - Filter function
   * @param options - Pagination options for underlying getAllItems call
   * @returns Filtered items
   */
  async filter<TItem = unknown>(
    predicate: (item: TItem) => boolean,
    options?: GetAllItemsOptions
  ): Promise<TItem[]> {
    const items = await this.getAllItems<TItem>(options)
    return items.filter(predicate)
  }

  /**
   * Helper: Get top N items by sort function
   *
   * @param sortFn - Sort comparison function
   * @param limit - Number of items to return
   * @param options - Pagination options for underlying getAllItems call
   * @returns Top N sorted items
   */
  async top<TItem = unknown>(
    sortFn: (a: TItem, b: TItem) => number,
    limit: number,
    options?: GetAllItemsOptions
  ): Promise<TItem[]> {
    const items = await this.getAllItems<TItem>(options)
    return items.sort(sortFn).slice(0, limit)
  }
}

// Re-export for convenience
export { ApifyClient }
