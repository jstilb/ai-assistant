---
status: proposed
---

# The Source Adapter is a plain function behind one resolver

The ingest module used to know each adapter's private entry shape: a switch over the Fetch Tier plus a chain of `source.id ===` checks for `api` sources, and a test-only entry (`ingestAllWithAdapters`) that skipped the dispatch and applied the Horizon a second time. We decided that a **Source Adapter** is a plain function `(source: EventSource) => Promise<EventItem[]>`, resolved by one `adapterFor(source)` over two static maps: `TIER_ADAPTERS` (exhaustive over the Fetch Tiers by `satisfies Record<Exclude<FetchTier, "api">, SourceAdapter>`) and `API_ADAPTERS` (keyed by each api adapter's exported `SOURCE_ID`). `ingestSource(source, resolve = adapterFor)` is the one path for Prefetch, Hybrid Refresh and tests: it resolves, calls, checks that every item carries `sources[0].sourceId === source.id` (before the Horizon, so drift fails even when every item is past it), then applies the Horizon once. Tests cross the same seam with a fake resolver (`ingestAll(sources, { adapterFor })`). Parsing, fetch windows and pagination dedup stay inside each adapter, because they differ per source. There is no shared fetch port: `globalThis.fetch` is already the HTTP seam, and the planned error-mode test stubs it.

## Considered Options

- **Phased adapter + transport port** (`requests` / `parse` / `toItem` + `Transport.get`) — rejected: SPA (LLM windows, Playwright escalation), SitemapLlm (walk + LLM batches), RSS and DanceStudioPro each need an escape hatch, so the interface grows per hatch and becomes shallow; it also rewrites 16 adapters.
- **Self-registering adapters** (`registerSourceAdapter(...)` in each file + a barrel import) — rejected: loses compile-time exhaustiveness, a missing barrel import fails only at run time, and a global mutable registry hurts test isolation. Its keying (tier, or source id for `api`) is kept, as static maps.
- **Ports at HTTP** (`(source, ctx: { fetch, now })`) — rejected: it layers over the existing `globalThis.fetch` seam instead of replacing it, and does not cover BrightData, Playwright or the LLM, so `ctx` widens or stays partial.

## Consequences

- A new adapter is one file + one map line (+ one `FetchTierSchema` value for a new tier); the compiler rejects a new tier with no adapter.
- An `api` source id lives in `sources.json` and in the adapter's exported `SOURCE_ID`; a test resolves every enabled source in `sources.json`, so a rename fails a test, and a stamped id that drifts from the source id fails that source loudly at run time.
- The cross-adapter error-mode contract (when a Source Adapter must throw) is added to `CONTEXT.md` with its seam test in a later slice (plan P05 S4).
