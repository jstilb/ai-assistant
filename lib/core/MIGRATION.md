# Migration Guide: Legacy Patterns → Infrastructure Tools

This guide shows how to migrate from manual/scattered patterns to the unified infrastructure tools.

---

## StateManager: From Manual File I/O

### Before (Manual State Management)

```typescript
// skills/MySkill/workflow.ts
import { readFileSync, writeFileSync, existsSync } from 'fs';

const STATE_FILE = join(KAYA_DIR, 'MEMORY', 'myskill-state.json');

// Load state
function loadState() {
  if (!existsSync(STATE_FILE)) {
    return { items: [], lastRun: null };
  }
  const raw = readFileSync(STATE_FILE, 'utf-8');
  return JSON.parse(raw);
}

// Save state (no validation, no locking, no backups)
function saveState(state: any) {
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

// Update state (not atomic)
const state = loadState();
state.items.push('new item');
state.lastRun = new Date().toISOString();
saveState(state);
```

**Problems:**
- No type safety
- No schema validation
- No atomic operations
- No file locking (race conditions)
- No backups
- Manual serialization

### After (Using StateManager)

```typescript
// skills/MySkill/workflow.ts
import { createStateManager } from '~/.claude/lib/core/StateManager';
import { z } from 'zod';

// Define schema for validation
const StateSchema = z.object({
  items: z.array(z.string()),
  lastRun: z.string().nullable(),
});

type MyState = z.infer<typeof StateSchema>;

// Create manager (once)
const stateManager = createStateManager({
  path: join(KAYA_DIR, 'MEMORY', 'myskill-state.json'),
  schema: StateSchema,
  defaults: { items: [], lastRun: null },
  backupOnWrite: true,
});

// Atomic update with validation
await stateManager.update(state => ({
  ...state,
  items: [...state.items, 'new item'],
  lastRun: new Date().toISOString(),
}));
```

**Benefits:**
- Full TypeScript type safety
- Automatic Zod validation
- Atomic read-modify-write
- File locking prevents races
- Auto-backup on every write
- Transaction support with rollback

---

## NotificationService: From curl Commands

### Before (Scattered curl Calls)

```typescript
// Pattern found in 68+ skill files
import { exec } from 'child_process';

function notify(message: string) {
  const payload = JSON.stringify({
    message,
    voice_id: 'iLVmqjzCGGvqtMCk6vVQ',
    title: 'Agent',
  });

  exec(
    `curl -X POST http://localhost:8888/notify -H "Content-Type: application/json" -d '${payload}'`,
    (error) => {
      if (error) console.error('Notification failed:', error);
    }
  );
}

notify("Task complete");
```

**Problems:**
- No retry logic
- No batching
- No fallback channels
- Blocks execution
- Error-prone JSON escaping
- No health checks
- Duplicated across 68+ files

### After (Using NotificationService)

```typescript
import { notifySync, notify } from '~/.claude/lib/core/NotificationService';

// Fire-and-forget (most common)
notifySync("Task complete");

// With options
await notify("Critical alert", {
  channel: 'voice',
  priority: 'high',
  fallback: true, // Auto-fallback to push/discord if voice fails
});

// Batch notifications
await service.batch([
  "Step 1 done",
  "Step 2 done",
  "Step 3 done",
]); // Sent as single combined message
```

**Benefits:**
- Automatic retry with backoff
- Multi-channel support (voice, push, discord)
- Intelligent batching
- Fallback chain
- Never blocks execution
- Health checks
- Offline queuing
- Centralized configuration

---

## ConfigLoader: From Direct File Reads

### Before (Manual Config Loading)

```typescript
// Every skill reimplements this
import { readFileSync, existsSync } from 'fs';

function loadSettings() {
  const settingsPath = join(KAYA_DIR, 'settings.json');
  if (!existsSync(settingsPath)) return {};
  return JSON.parse(readFileSync(settingsPath, 'utf-8'));
}

function loadConfig() {
  const userPath = join(KAYA_DIR, 'USER/config.yaml');
  const systemPath = join(KAYA_DIR, 'docs/system/config.yaml');

  // Manual tiering logic (repeated everywhere)
  if (existsSync(userPath)) {
    return parseYaml(readFileSync(userPath, 'utf-8'));
  }
  if (existsSync(systemPath)) {
    return parseYaml(readFileSync(systemPath, 'utf-8'));
  }
  return DEFAULT_CONFIG;
}

const settings = loadSettings();
const config = loadConfig();
```

**Problems:**
- No validation
- Manual tiering logic
- No caching
- No hot reload
- Duplicated across skills

### After (Using ConfigLoader)

```typescript
import {
  loadSettings,
  loadTieredConfig,
  createConfigLoader
} from '~/.claude/lib/core/ConfigLoader';
import { z } from 'zod';

// Load settings.json (cached)
const settings = loadSettings();
console.log(settings.principal.name);

// Load tiered config with schema
const BrowserConfigSchema = z.object({
  browser: z.string(),
  headless: z.boolean(),
});

const config = loadTieredConfig('browser', BrowserConfigSchema, {
  browser: 'Chrome',
  headless: true,
});

// With hot reload
const loader = createConfigLoader({
  key: 'security',
  schema: SecuritySchema,
  defaults: DEFAULT_SECURITY,
  watchChanges: true,
});

loader.watch((newConfig, changed) => {
  console.log('Config updated:', changed);
});
```

**Benefits:**
- Automatic USER → SYSTEM → defaults tiering
- Zod schema validation
- Caching with TTL
- Hot reload support
- Environment variable overrides
- Single source of truth

---

## CachedHTTPClient: From Raw fetch()

### Before (Scattered fetch Calls)

```typescript
// Found in KayaUpgrade, Research, Browser skills
async function fetchContent(url: string) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }
  return response.text();
}

// No caching, no retry, no rate limiting
const content = await fetchContent('https://api.example.com/data');
```

**Problems:**
- No caching (refetch every time)
- No retry on transient failures
- No rate limiting
- No request deduplication
- Repeated error handling

### After (Using CachedHTTPClient)

```typescript
import { httpClient } from '~/.claude/lib/core/CachedHTTPClient';

// Simple cached fetch
const content = await httpClient.fetchText('https://api.example.com/data', {
  cache: 'disk',
  ttl: 3600, // Cache for 1 hour
  retry: 3,  // Retry 3 times with exponential backoff
});

// Hash-based change detection (KayaUpgrade pattern)
const result = await httpClient.fetchWithHash(
  'https://blog.anthropic.com/feed',
  previousHash
);

if (result.changed) {
  // Content changed - process it
  processNewContent(result.data);
} else {
  // Same content - skip processing
  console.log('No changes detected');
}
```

**Benefits:**
- Memory + disk caching with TTL
- Automatic retry with backoff
- Rate limiting per domain
- Circuit breaker for failing endpoints
- Request deduplication (concurrent identical requests)
- Content hash for change detection

---

## MemoryStore: From Multiple Memory Directories

### Before (Scattered Memory Files)

```typescript
// ContinualLearning creates files in MEMORY/LEARNING/
function captureLearning(content: string) {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const filename = `${timestamp}_LEARNING_${sanitize(title)}.md`;
  const path = join(KAYA_DIR, 'MEMORY/LEARNING/ALGORITHM', getMonth(), filename);

  writeFileSync(path, content);
}

// Research skill creates files in MEMORY/research/
function saveResearch(data: any) {
  const filename = `research-${Date.now()}.json`;
  writeFileSync(join(KAYA_DIR, 'MEMORY/research', filename), JSON.stringify(data));
}

// System skill creates files in MEMORY/KAYASYSTEMUPDATES/
// ... and so on (5+ different patterns)
```

**Problems:**
- No unified schema
- No deduplication
- No search/indexing
- Manual filename generation
- No lifecycle management
- Scattered across directories
- No tags or metadata

### After (Using MemoryStore)

```typescript
import { memoryStore } from '~/.claude/lib/core/MemoryStore';

// Capture learning (auto-deduplicates)
await memoryStore.capture({
  type: 'learning',
  category: 'ALGORITHM',
  title: 'ISC Pattern Improvement',
  content: 'Discovered that smaller ISC criteria...',
  tags: ['algorithm', 'isc', 'optimization'],
  tier: 'warm',
});

// Capture research
await memoryStore.capture({
  type: 'research',
  title: 'AI Safety Research',
  content: researchData,
  tags: ['ai-safety', 'research'],
});

// Search across all memory types
const results = await memoryStore.search({
  tags: ['algorithm'],
  since: '2024-01-01',
  limit: 10,
});

// Find similar content (prevents duplicates)
const similar = await memoryStore.findSimilar(newContent, 0.85);
if (similar.length > 0) {
  console.log('Similar entry already exists');
}
```

**Benefits:**
- Unified schema across all memory types
- Automatic deduplication via content hashing
- Tag-based search
- Lifecycle tiers (hot → warm → cold)
- Cross-skill indexing
- TTL support
- Full-text search

---

## ApprovalQueue: From Ad-hoc Approval Logic

### Before (Custom Approval Logic)

```typescript
// Each skill implements approval differently
interface PendingItem {
  id: string;
  data: any;
  createdAt: string;
}

const pendingItems: PendingItem[] = [];

function addForApproval(data: any) {
  pendingItems.push({
    id: randomUUID(),
    data,
    createdAt: new Date().toISOString(),
  });
}

function approve(id: string) {
  const index = pendingItems.findIndex(i => i.id === id);
  if (index !== -1) {
    const item = pendingItems[index];
    pendingItems.splice(index, 1);
    // Execute approval logic
  }
}
```

**Problems:**
- No persistence (lost on restart)
- No priority ordering
- No expiry
- No batch operations
- Duplicated across skills

### After (Using ApprovalQueue)

```typescript
import { createApprovalQueue } from '~/.claude/lib/core/ApprovalQueue';
import { z } from 'zod';

const ItemSchema = z.object({
  title: z.string(),
  description: z.string(),
});

const queue = createApprovalQueue({
  schema: ItemSchema,
  defaultExpiry: 7, // days
  onApprove: async (item) => {
    console.log(`Approved: ${item.title}`);
    await executeApproval(item);
  },
});

// Add with priority
const id = await queue.add(
  { title: 'Deploy to prod', description: '...' },
  { priority: 'high' }
);

// List by priority
const pending = await queue.list({ status: 'pending' });

// Batch approve
await queue.batchApprove([id1, id2, id3], 'Batch approved');

// Auto-cleanup expired
await queue.cleanup(30); // Remove items > 30 days old
```

**Benefits:**
- File-based persistence
- Priority ordering
- Expiry with auto-cleanup
- Batch operations
- Hooks for approval/rejection
- Statistics and filtering

---

## AgentOrchestrator: From Manual Task() Calls

### Before (Manual Agent Spawning)

```typescript
// Scattered across skills
async function spawnResearchers() {
  const results = await Promise.all([
    Task({
      subagent_type: 'ClaudeResearcher',
      prompt: 'Research AI safety',
    }),
    Task({
      subagent_type: 'GeminiResearcher',
      prompt: 'Research AI safety',
    }),
  ]);

  // Manual result aggregation
  const combined = results.map(r => r.result).join('\n\n');
  return combined;
}
```

**Problems:**
- No result aggregation strategies
- No spotcheck pattern
- No debate workflow
- Manual Promise handling
- No voice announcements
- Duplicated orchestration logic

### After (Using AgentOrchestrator)

```typescript
import { orchestrator } from '~/.claude/lib/core/AgentOrchestrator';

// Spawn with aggregation
const { results, aggregated } = await orchestrator.spawnWithAggregation(
  [
    { type: 'ClaudeResearcher', model: 'sonnet' },
    { type: 'GeminiResearcher', model: 'sonnet' },
  ],
  'Research AI safety advancements in 2024',
  'synthesis' // voting | synthesis | merge | first | best
);

// Spotcheck pattern
const check = await orchestrator.spotcheck(
  implementationCode,
  ['No vulnerabilities', 'Tests pass', 'Style guide']
);

if (!check.passed) {
  console.log('Issues found:', check.issues);
}

// Structured debate
const debate = await orchestrator.debate(
  'Microservices vs Monolith',
  [
    { agent: { type: 'Architect' }, position: 'Pro-microservices' },
    { agent: { type: 'Engineer' }, position: 'Pro-monolith' },
  ],
  3 // rounds
);
```

**Benefits:**
- 5 aggregation strategies
- Spotcheck verification pattern
- Council-style debates
- Voice announcements
- Progress callbacks
- Concurrency limits

---

## WorkflowExecutor: From Ad-hoc Workflows

### Before (Manual Workflow Logic)

```typescript
// Found in maintenance skills
async function runDailyMaintenance() {
  try {
    await cleanupOldFiles();
    await backupData();
    await updateCache();
    console.log('Daily maintenance complete');
  } catch (error) {
    console.error('Maintenance failed:', error);
  }
}
```

**Problems:**
- No dependency resolution
- No parallel execution
- No retry logic
- No progress tracking
- No checkpointing
- No ISC integration
- Duplicated across skills

### After (Using WorkflowExecutor)

```typescript
import { workflowExecutor } from '~/.claude/lib/core/WorkflowExecutor';

const workflow = {
  name: 'daily-maintenance',
  steps: [
    {
      name: 'cleanup',
      execute: async () => {
        await cleanupOldFiles();
        return { success: true, metrics: { filesRemoved: 10 } };
      },
      retry: 2,
    },
    {
      name: 'backup',
      execute: async () => {
        await backupData();
        return { success: true };
      },
      dependsOn: ['cleanup'],
    },
    {
      name: 'cache-update',
      execute: async () => {
        await updateCache();
        return { success: true };
      },
      dependsOn: ['cleanup'],
      parallel: true, // Can run alongside backup
    },
  ],
  isc: {
    criteria: ['All files cleaned', 'Backup completed', 'Cache updated'],
    checkFn: (results) => ({
      met: results.get('cleanup')?.success &&
            results.get('backup')?.success &&
            results.get('cache-update')?.success,
      score: 100,
      unmetCriteria: [],
    }),
  },
  notifyOnComplete: true,
  checkpointFile: '~/.claude/.checkpoints/daily.json',
};

const result = await workflowExecutor.execute(workflow);

if (!result.success) {
  console.log('Failed at step:', result.failedStep);
}
```

**Benefits:**
- DAG-based dependency resolution
- Parallel execution
- Retry with backoff
- Progress callbacks
- Checkpointing (resume on failure)
- ISC integration
- Voice notifications

---

## Migration Checklist

When migrating a skill to use infrastructure tools:

### 1. State Management
- [ ] Replace manual `readFileSync`/`writeFileSync` with `StateManager`
- [ ] Add Zod schema for validation
- [ ] Use `manager.update()` for atomic operations
- [ ] Enable `backupOnWrite` for critical state

### 2. Notifications
- [ ] Replace all `curl` commands with `notifySync()` or `notify()`
- [ ] Use `batch()` for grouped messages
- [ ] Add appropriate voice IDs for agents
- [ ] Configure fallback channels

### 3. Configuration
- [ ] Replace manual config reads with `ConfigLoader`
- [ ] Use `loadTieredConfig()` for USER/SYSTEM pattern
- [ ] Add Zod schemas for config validation
- [ ] Use `loadSettings()` for settings.json access

### 4. HTTP Requests
- [ ] Replace `fetch()` with `httpClient.fetch()`
- [ ] Add caching with appropriate TTL
- [ ] Use `fetchWithHash()` for change detection
- [ ] Enable retry for transient failures

### 5. Memory Capture
- [ ] Migrate to `memoryStore.capture()`
- [ ] Add appropriate tags for searchability
- [ ] Use correct `type` and `category`
- [ ] Set appropriate `tier` (hot/warm/cold)

### 6. Approval Workflows
- [ ] Create `ApprovalQueue` instance
- [ ] Define Zod schema for approval items
- [ ] Add hooks for approval/rejection
- [ ] Use batch operations where applicable

### 7. Agent Spawning
- [ ] Replace manual `Task()` calls with `orchestrator.spawn()`
- [ ] Use aggregation strategies
- [ ] Add spotcheck for verification
- [ ] Use debates for decision-making

### 8. Workflows
- [ ] Define workflow config with steps
- [ ] Add dependencies with `dependsOn`
- [ ] Enable parallel execution where safe
- [ ] Add ISC criteria
- [ ] Enable checkpointing for long workflows

---

## Testing After Migration

Run comprehensive tests after migrating:

```bash
# Test state management
bun test lib/core/StateManager.test.ts

# Test notifications
bun run lib/core/NotificationService.ts --test "Migration test"

# Test config loading
bun run lib/core/ConfigLoader.ts --settings

# Test HTTP client
bun run lib/core/CachedHTTPClient.ts --stats

# Test memory store
bun run lib/core/MemoryStore.ts stats

# Test approval queue
bun run lib/core/ApprovalQueue.ts stats

# Test orchestrator
bun test lib/core/AgentOrchestrator.test.ts

# Test workflow executor
bun test lib/core/WorkflowExecutor.test.ts
```

---

## Common Patterns

### Pattern: Daily/Weekly/Monthly Workflows

```typescript
import { createTieredWorkflow } from '~/.claude/lib/core/WorkflowExecutor';

const { daily, weekly, monthly } = createTieredWorkflow(
  'Maintenance',
  [cleanupStep, backupStep],        // Daily
  [weeklyReportStep],                // Weekly = daily + this
  [monthlyAuditStep]                 // Monthly = weekly + this
);

await workflowExecutor.execute(daily);
```

### Pattern: Research with Caching

```typescript
import { httpClient } from '~/.claude/lib/core/CachedHTTPClient';
import { orchestrator } from '~/.claude/lib/core/AgentOrchestrator';
import { memoryStore } from '~/.claude/lib/core/MemoryStore';

// Fetch with caching
const data = await httpClient.fetchText(apiUrl, { cache: 'disk', ttl: 3600 });

// Research with agents
const { aggregated } = await orchestrator.spawnWithAggregation(
  [{ type: 'Researcher', count: 3 }],
  `Analyze: ${data}`,
  'synthesis'
);

// Store results
await memoryStore.capture({
  type: 'research',
  title: 'API Analysis',
  content: aggregated,
  tags: ['research'],
});
```

### Pattern: State + Notifications + Memory

```typescript
import { stateManager } from './state-manager';
import { notify } from '~/.claude/lib/core/NotificationService';
import { memoryStore } from '~/.claude/lib/core/MemoryStore';

// Update state atomically
const state = await stateManager.update(s => ({
  ...s,
  processedCount: s.processedCount + 1,
}));

// Notify user
await notify(`Processed ${state.processedCount} items`);

// Capture for memory
await memoryStore.capture({
  type: 'signal',
  title: 'Processing Progress',
  content: `${state.processedCount} items processed`,
  tags: ['processing'],
});
```

---

## Support

- **Documentation:** `lib/core/README.md`
- **Examples:** Each tool has example usage in header comments
- **Tests:** `*.test.ts` files show comprehensive usage
- **CLI help:** Run any tool with `--help` flag
