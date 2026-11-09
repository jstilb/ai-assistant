# EventScout — Event Ingest

EventScout pulls San Diego events from many remote feeds into one local cache, then ranks them for Jm. This glossary covers the ingest side: where events come from and how one feed becomes cached events. Decisions: `docs/adr/`.

## Language

**Event Source**:
One entry in `Tools/sources.json`: an id, a URL and a Fetch Tier.
_Avoid_: feed, site, provider

**Fetch Tier**:
How an Event Source is fetched (`rss`, `ics`, `spa`, `html-llm`, `sitemap-llm`, …); `api` means a bespoke adapter for one source, exempt from fuzzy dedup.
_Avoid_: source type, fetch mode

**Source Adapter**:
The function `(source) => Promise<EventItem[]>` that fetches one Event Source; every item it returns carries that source's id.
Error modes: it throws when the primary fetch fails (non-2xx or network), when no transport tier returns content, when every LLM extraction attempt fails, or when the first page of a paginated source fails. It may degrade, and always logs it, when a later page fails (it stops and keeps the earlier pages), when a secondary fetch fails (Ctycms tags, SitemapLlm detail pages or batches while one succeeds, RSS enrichment), or when one item is malformed. A successful fetch with no events returns `[]`.
_Avoid_: fetcher, scraper, plugin

**Prefetch**:
The scheduled ingest of every enabled Event Source into the cache (`cli.ts prefetch`).
_Avoid_: crawl, sync

**Hybrid Refresh**:
The query-time ingest of the Event Sources chosen for one query (`cli.ts query --refresh`).
_Avoid_: live pull, refetch

**Horizon**:
The maximum number of days ahead that an ingested event may start (`EVENTSCOUT_HORIZON_DAYS`, default 120).
_Avoid_: window, cap

## Relationships

- An **Event Source** has exactly one **Fetch Tier**.
- A **Fetch Tier** other than `api` maps to one **Source Adapter**; an `api` **Event Source** maps to its own **Source Adapter** by source id.
- **Prefetch** and **Hybrid Refresh** both reach each **Source Adapter** through one `ingestSource`, which checks the source id and applies the **Horizon** once.

## Example dialogue

> **Dev:** "Padres changed its feed. Do I add a new **Fetch Tier**?"
> **Domain expert:** "No. Padres is an `api` **Event Source**: change its **Source Adapter**. Add a **Fetch Tier** only for a new feed format that many sources share."
> **Dev:** "And if my adapter returns games 200 days out?"
> **Domain expert:** "Ingest drops them at the **Horizon**. The adapter does not filter by the Horizon itself."

## Flagged ambiguities

- "tier" also names BrightData's transport levels inside SPAAdapter (Tier 1–4) — resolved: **Fetch Tier** is only the `fetchTier` field of an **Event Source**; say "transport tier" for BrightData levels.
