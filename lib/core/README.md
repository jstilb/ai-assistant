# Kaya Infrastructure Tools

Core utilities that eliminate redundancy and provide consistent patterns across all Kaya skills.

## Overview

These infrastructure tools consolidate common patterns found across Kaya: state persistence, notifications, configuration, HTTP caching, memory storage and output paths. Each one has a Zod-validated API and tests in `lib/core/`.

## Quick Reference

| Tool | Purpose | Key Features |
|------|---------|--------------|
| [StateManager](#statemanager) | Unified state persistence | Generics, Zod validation, transactions, locking, backups |
| [NotificationService](#notificationservice) | Multi-channel notifications | Log, discord, telegram, email, batching, retry |
| [ConfigLoader](#configloader) | Configuration loading | SYSTEM/USER tiering, schemas, hot reload |
| [CachedHTTPClient](#cachedhttpclient) | HTTP with caching | Memory/disk cache, retry, rate limiting |
| [MemoryStore](#memorystore) | Unified memory storage | Deduplication, tags, lifecycle tiers |
| [OutputPathResolver](#outputpathresolver) | Skill output path generation | Memory/work/downloads paths, timestamps, auto-create dirs |

---

## Adoption Status (2026-11-04)

Counts are non-test `.ts` files that import the tool (`git grep` on `lib/`, `skills/`, `bin/`, `hooks/`).

| Tool | Main importers |
|------|----------------|
| StateManager | AgentMonitor (6), lib/core (5), JobSearch (4), KayaUpgrade (4), Browser, VoiceInteraction, InteriorDesign (3 each) |
| NotificationService | KayaUpgrade (4), QueueRouter, InteriorDesign, LucidTasks (3 each), AgentMonitor (2) |
| ConfigLoader | lib/core (6), Browser, VoiceInteraction (2 each), AutonomousWork, VaultGraph |
| CachedHTTPClient | VoiceInteraction (6), ContentAggregator, MoodBoard, UnixCLI, KayaUpgrade, JobSearch, DailyBriefing (2 each) |
| MemoryStore | lib/core, QueueRouter, AutonomousWork, KayaUpgrade (2 each), AgentMonitor, Evals, LucidTasks, IssueTrace |
| OutputPathResolver | lib/core only (no skill imports it) |

Skills that this table once listed (OSINT, Recon, ContinualLearning, _RALPHLOOP, DigitalMaestro, Prompting) no longer exist.
`Inference.ts` is documented in `CLAUDE.md`, not here.

---

## StateManager

**Purpose:** Type-safe state persistence with transactions, locking, and automatic backups.

### When to Use
- Persisting skill state between sessions
- Managing configuration that changes over time
- Any JSON-serializable state that needs durability

### Quick Start

```typescript
import { createStateManager } from '~/.claude/lib/core/StateManager.ts';
import { z } from 'zod';

// Define schema
const MyStateSchema = z.object({
  count: z.number(),
  items: z.array(z.string()),
  lastUpdated: z.string().optional(),
});

// Create manager
const manager = createStateManager({
  path: '~/.claude/MEMORY/myskill/state.json',
  schema: MyStateSchema,
  defaults: { count: 0, items: [] },
  backupOnWrite: true,
});

// Read state
const state = await manager.get();

// Update with transaction (atomic, handles locking)
await manager.transaction(state => {
  state.count++;
  state.items.push('new item');
  state.lastUpdated = new Date().toISOString();
  return state;
});
```

### Key Features
- **Type Safety:** Full TypeScript generics with Zod schema validation
- **Transactions:** Atomic read-modify-write with automatic locking
- **Backups:** Automatic backup on write with configurable retention
- **File Watching:** Optional hot-reload when file changes externally

### CLI Usage
```bash
bun run StateManager.ts get --path ~/.claude/MEMORY/state.json
bun run StateManager.ts set --path ~/.claude/MEMORY/state.json --data '{"count": 5}'
bun run StateManager.ts backup --path ~/.claude/MEMORY/state.json
```

---

## NotificationService

**Purpose:** Multi-channel notifications with batching, retry, and duration-aware routing.

### When to Use
- Record-only logging (default `log` channel)
- Telegram notifications for mobile alerts
- Discord notifications for team channels
- Any notification need across Kaya

### Quick Start

```typescript
import { notify, notifySync, notifyBatch } from '~/.claude/lib/core/NotificationService.ts';

// Fire-and-forget; default 'log' channel records to MEMORY/NOTIFICATIONS/notifications.jsonl (no push)
notifySync("Task completed successfully");

// Async with await
await notify({
  message: "Deployment finished",
  channel: "telegram",
  title: "Deploy",
});

// Multi-channel
await notify({
  message: "Critical alert",
  channels: ["telegram", "discord"],
  priority: "high",
});

// Batch notifications (auto-groups within window)
notifyBatch([
  { message: "Step 1 done" },
  { message: "Step 2 done" },
  { message: "Step 3 done" },
]); // Sends as single combined notification
```

### Channels

| Channel | When Used | Configuration |
|---------|-----------|---------------|
| `log` | Default. Record-only to `MEMORY/NOTIFICATIONS/notifications.jsonl` (no push, no audio) | None |
| `telegram` | Reach Jm on his phone (pass `channel: 'telegram'` explicitly, or use `AlertGate.sendAlert`) | Telegram bot token |
| `email` | Email delivery | Email config |
| `discord` | Team alerts, persistent logging | Discord webhook URL |

### Key Features
- **Fire-and-Forget:** Notifications never block execution
- **Batching:** Groups rapid-fire notifications into single message
- **Retry:** Automatic retry with exponential backoff

### CLI Usage
```bash
bun run NotificationService.ts send "Hello world"
bun run NotificationService.ts send "Alert" --channel discord --priority high
bun run NotificationService.ts batch "Step 1" "Step 2" "Step 3"
```

---

## ConfigLoader

**Purpose:** Load configuration with SYSTEM/USER tiering, schema validation, and hot reload.

### When to Use
- Loading settings.json
- Loading any tiered configuration (USER overrides SYSTEM)
- Skill-specific configuration with defaults

### Quick Start

```typescript
import { loadSettings, loadTieredConfig, createConfigLoader } from '~/.claude/lib/core/ConfigLoader.ts';

// Load main settings.json
const settings = loadSettings();
console.log(settings.principal.name);
console.log(settings.daidentity.voiceId);

// Load tiered config (checks USER first, then SYSTEM)
const securityConfig = loadTieredConfig({
  userPath: '~/.claude/KAYASECURITYSYSTEM/patterns.yaml',
  systemPath: '~/.claude/KAYASECURITYSYSTEM/patterns.example.yaml',
});

// Custom config with schema
const configLoader = createConfigLoader({
  basePath: '~/.claude/skills/MySkill',
  schema: MyConfigSchema,
  defaults: { enabled: true, threshold: 0.5 },
  watchForChanges: true,
});

const config = await configLoader.load();
configLoader.onChange((newConfig) => {
  console.log('Config updated:', newConfig);
});
```

### Key Features
- **SYSTEM/USER Tiering:** USER config overrides SYSTEM defaults
- **Schema Validation:** Zod schemas ensure config correctness
- **Hot Reload:** Watch for changes and notify subscribers
- **Environment Override:** Env vars can override config values

### CLI Usage
```bash
bun run ConfigLoader.ts settings
bun run ConfigLoader.ts tiered --user path/to/user.json --system path/to/system.json
bun run ConfigLoader.ts validate --path config.json --schema schema.json
```

---

## CachedHTTPClient

**Purpose:** HTTP requests with caching, retry, and rate limiting.

### When to Use
- External API calls that benefit from caching
- Rate-limited APIs that need request throttling
- Any HTTP request that might fail transiently

### Quick Start

```typescript
import { cachedFetch, createCachedClient } from '~/.claude/lib/core/CachedHTTPClient.ts';

// Simple cached fetch
const data = await cachedFetch('https://api.example.com/data', {
  ttl: 300, // Cache for 5 minutes
});

// Create dedicated client
const client = createCachedClient({
  baseUrl: 'https://api.example.com',
  headers: { 'Authorization': 'Bearer token' },
  cache: {
    type: 'disk',
    directory: '~/.claude/.cache/api',
    ttl: 3600,
  },
  retry: {
    attempts: 3,
    backoff: 'exponential',
  },
  rateLimit: {
    requests: 10,
    window: 60000, // 10 requests per minute
  },
});

const response = await client.get('/endpoint');
const posted = await client.post('/data', { body: { key: 'value' } });
```

### Key Features
- **Caching:** Memory or disk-based with configurable TTL
- **Retry:** Automatic retry with linear/exponential backoff
- **Rate Limiting:** Token bucket algorithm for API limits
- **Cache Invalidation:** Manual or TTL-based invalidation

### CLI Usage
```bash
bun run CachedHTTPClient.ts fetch "https://api.example.com/data" --ttl 300
bun run CachedHTTPClient.ts clear-cache
bun run CachedHTTPClient.ts stats
```

---

## MemoryStore

**Purpose:** Unified memory storage with deduplication, tags, and lifecycle tiers.

### When to Use
- Capturing learnings, insights, decisions
- Research outputs that need persistence
- Any content that should be searchable later

### Quick Start

```typescript
import { memoryStore, createMemoryStore } from '~/.claude/lib/core/MemoryStore.ts';

// Capture a learning
const entry = await memoryStore.capture({
  type: 'learning',
  category: 'ALGORITHM',
  title: 'ISC Pattern Improvement',
  content: 'Discovered that smaller ISC criteria lead to faster convergence...',
  tags: ['algorithm', 'isc', 'optimization'],
  tier: 'warm', // hot (7 days) -> warm (indefinite) -> cold (archived)
});

// Search memories
const results = await memoryStore.search({
  type: 'learning',
  tags: ['algorithm'],
  since: '2024-01-01',
  limit: 10,
});

// Find similar content (deduplication)
const similar = await memoryStore.findSimilar(newContent, 0.85);
if (similar.length > 0) {
  console.log('Similar entry exists:', similar[0].id);
}
```

### Memory Types

| Type | Purpose | Example |
|------|---------|---------|
| `learning` | Captured insights | ISC improvements, patterns |
| `decision` | Architectural decisions | Tech stack choices |
| `artifact` | Generated outputs | Reports, analyses |
| `insight` | Quick observations | User preferences |
| `signal` | Rating/sentiment signals | 5-star rating |
| `research` | Research outputs | Multi-agent research |

### Key Features
- **Auto-Deduplication:** Content hashing prevents duplicates
- **Lifecycle Tiers:** hot -> warm -> cold with auto-archiving
- **Full-Text Search:** Search across all memory content
- **Cross-Skill Indexing:** Fast lookups by type, tag, category

### CLI Usage
```bash
bun run MemoryStore.ts capture --type learning --title "Pattern" --content "..."
bun run MemoryStore.ts search --type learning --tags "algorithm,isc"
bun run MemoryStore.ts stats
bun run MemoryStore.ts consolidate
```

---

## Integration Patterns

### Common Combinations

**Research with Caching and Memory:**
```typescript
import { cachedFetch } from './CachedHTTPClient.ts';
import { memoryStore } from './MemoryStore.ts';

// Fetch data with caching
const data = await cachedFetch(apiUrl, { ttl: 3600 });

// Research with subagents (spawn via the Agent tool)
const aggregated = await researchWithSubagents(data);

// Store results
await memoryStore.capture({
  type: 'research',
  title: 'API Data Analysis',
  content: aggregated,
  tags: ['research', 'api-analysis'],
});
```

---

## Migration from Legacy Patterns

### Migrating Legacy MEMORY Files

Use `MigrateToMemoryStore.ts` to migrate existing MEMORY markdown files to the new MemoryStore:

```bash
# Preview what would be migrated (dry-run)
bun lib/core/MigrateToMemoryStore.ts --all --dry-run

# Migrate LEARNING directory
bun lib/core/MigrateToMemoryStore.ts --source MEMORY/LEARNING --type learning

# Migrate research directory
bun lib/core/MigrateToMemoryStore.ts --source MEMORY/research --type research

# Migrate everything at once
bun lib/core/MigrateToMemoryStore.ts --all
```

**Features:**
- Parses YAML frontmatter from markdown files
- Extracts category from directory structure (e.g., LEARNING/ALGORITHM → category: ALGORITHM)
- Preserves original file dates as metadata
- Auto-deduplication via content hashing
- Progress reporting with statistics

**Directory Mapping:**
- `MEMORY/LEARNING` → type: learning (with category extraction)
- `MEMORY/research` → type: research
- `MEMORY/KAYASYSTEMUPDATES` → type: artifact
- `MEMORY/decisions` → type: decision

### Migrating Code Patterns

See `MIGRATION.md` for detailed migration instructions from:
- Custom state load/save to StateManager
- curl notifications to NotificationService
- Direct settings reads to ConfigLoader
- Scattered fetch() to CachedHTTPClient
- Multiple memory directories to MemoryStore
- Hardcoded output paths to OutputPathResolver
