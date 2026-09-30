---
name: ContentAggregator
description: Content and news aggregation pipeline that collects, filters, deduplicates, and delivers high-value content from RSS feeds and other sources. USE WHEN content aggregation, news digest, RSS feeds, content sources, morning news, aggregate content, news pipeline, add RSS feed, manage sources, generate digest.
---

# ContentAggregator

Automated content collection pipeline that replaces passive media scrolling with curated, high-signal content delivery. Collects from RSS/Atom feeds, deduplicates, filters by topic relevance, and renders clean Markdown digests.

**Status:** Built and tested; runs daily via the `content-daily` cron job at 05:00, which invokes `Tools/Pipeline.ts`. Can also be invoked manually (`bun Tools/Pipeline.ts`) — see "Feeds Into" below for current DailyBriefing behavior.

## Voice Notification

**When executing a workflow, do BOTH:**

1. **Send voice notification** using `notifySync()` from `lib/core/NotificationService.ts`:
   ```typescript
   import { notifySync } from "~/.claude/lib/core/NotificationService.ts";
   notifySync("Running the Collect workflow in ContentAggregator to fetch feeds");
   ```

2. **Output text notification**:
   ```
   Running the **Collect** workflow in the **ContentAggregator** skill to fetch feeds...
   ```

**Full documentation:** `~/.claude/docs/system/THENOTIFICATIONSYSTEM.md`

## Workflow Routing

| Workflow | Trigger | File |
|----------|---------|------|
| **Collect** | "collect content", "run collection", "fetch feeds" | `Workflows/Collect.md` |
| **Digest** | "generate digest", "content digest", "news digest" | `Workflows/Digest.md` |
| **Sources** | "manage sources", "add source", "list sources", "remove source" | `Workflows/Sources.md` |

## Examples

**Example 1: Run content collection**
```
User: "Collect content from my feeds"
-> Invokes Collect workflow
-> Fetches all enabled RSS sources via CachedHTTPClient
-> Deduplicates and stores items via StateManager
-> Reports collection summary with item counts
```

**Example 2: Generate a digest**
```
User: "Generate a news digest for today"
-> Invokes Digest workflow
-> Loads recent items from content store
-> Filters by topic relevance and trust score
-> Renders Markdown digest to MEMORY/DIGESTS/
-> Returns digest preview
```

**Example 3: Add a new source**
```
User: "Add the Ars Technica RSS feed"
-> Invokes Sources workflow
-> Validates feed URL is accessible via CachedHTTPClient
-> Adds source with URL, topics, trust score
-> Persists to Tools/Sources.json via StateManager
-> Confirms source added
```

## Pipeline

```
Sources (RSS/Atom) -> Pipeline.ts -> Dedup -> Store -> DigestRenderer
```

1. **Pipeline.ts** orchestrates the full collection cycle
2. **SourceManager.ts** handles CRUD operations on feed sources
3. Content is fetched via `CachedHTTPClient` with caching and rate limiting
4. State is persisted via `StateManager` (sources config, content store)
5. Digests are rendered as Markdown to `MEMORY/DIGESTS/`

## Quick Reference

- **Sources Config:** `Tools/Sources.json` - registered content sources
- **Tools:** Pipeline.ts, SourceManager.ts
- **Output:** `MEMORY/DIGESTS/` - rendered Markdown digests
- **Archive:** `MEMORY/CONTENT/` - collected content archive (date-partitioned)
- **CLI:** `bun Tools/Pipeline.ts [--dry-run] [--json]`

## Integration

### Uses
- `lib/core/CachedHTTPClient.ts` - HTTP fetching with caching and rate limiting
- `lib/core/StateManager.ts` - State persistence for sources and content store
- `lib/core/NotificationService.ts` - Delivery notifications

### Feeds Into
- `MEMORY/DIGESTS/` - Written digest logs
- `DailyBriefing` - Integration point exists (`DigestRenderer.generateNewsBlock()`, manual `--news-block` CLI flag) but DailyBriefing's live `DataGatherer.ts` does not call it — it reads `ContentStore.searchItems()` directly and falls back to WebSearch whenever the store has no items within the last 24h. WebSearch remains that fallback for whenever the store is thin (e.g. after a gap in the daily cron run); with `content-daily` running (see Status above), the store is expected to stay fresh.

### MCPs Used
- None
