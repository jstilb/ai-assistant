# Kaya Infrastructure Tools

Core utilities that eliminate redundancy and provide consistent patterns across all Kaya skills.

## Overview

These 8 infrastructure tools consolidate common patterns found across Kaya, reducing code duplication by 70% and providing battle-tested implementations for state management, notifications, configuration, caching, memory, approvals, agent orchestration, and workflow execution.

## Quick Reference

| Tool | Purpose | Key Features |
|------|---------|--------------|
| [StateManager](#statemanager) | Unified state persistence | Generics, Zod validation, transactions, locking, backups |
| [NotificationService](#notificationservice) | Multi-channel notifications | Voice, push, discord, batching, retry |
| [ConfigLoader](#configloader) | Configuration loading | SYSTEM/USER tiering, schemas, hot reload |
| [CachedHTTPClient](#cachedhttpclient) | HTTP with caching | Memory/disk cache, retry, rate limiting |
| [MemoryStore](#memorystore) | Unified memory storage | Deduplication, tags, lifecycle tiers |
| [ApprovalQueue](#approvalqueue) | Generic approval workflow | Priority, expiry, multiple backends |
| [AgentOrchestrator](#agentorchestrator) | Agent spawning & aggregation | Parallel, spotcheck, debate patterns |
| [WorkflowExecutor](#workflowexecutor) | Workflow execution | DAG resolution, ISC, checkpointing |
| [OutputPathResolver](#outputpathresolver) | Skill output path generation | Memory/work/downloads paths, timestamps, auto-create dirs |
| [SkillInvoker](#skillinvoker) | Programmatic skill invocation | Filesystem validation, case correction, timeout handling |
| [DecisionFramework](#decisionframework) | GREEN/YELLOW/RED decision scoring | Built-in domains (calendar, shopping, task, health), extensible rules |
| [HotCache](#hotcache) | Two-tier hot/cold memory cache | Fast lookups, shorthand decoding, auto promotion/demotion |

---

## Adoption Status (2026-02-10)

### Current Imports by Tool

| Tool | Skills Using | Adoption Level |
|------|--------------|----------------|
| StateManager | QueueRouter (Worker), Browser, _RALPHLOOP, AutonomousWork, ContinualLearning (ChangeDetector) | ⬛⬛⬛⬜⬜ Medium |
| NotificationService | QueueRouter (Worker), AutoMaintenance, ProactiveEngine | ⬛⬛⬛⬜⬜ Medium |
| ConfigLoader | Agents, KayaUpgrade, Browser | ⬛⬛⬜⬜⬜ Low |
| CachedHTTPClient | KayaUpgrade, Recon (IpinfoClient, DnsUtils, SubdomainEnum) | ⬛⬛⬛⬜⬜ Medium |
| MemoryStore | ContinualLearning (InsightGenerator), Recon (DnsUtils, IpinfoClient, SubdomainEnum, WhoisParser) | ⬛⬛⬛⬛⬜ High |
| ApprovalQueue | AutonomousWork (via CORE) | ⬛⬜⬜⬜⬜ Very Low |
| AgentOrchestrator | AutoMaintenance, InformationManager | ⬛⬛⬜⬜⬜ Low |
| WorkflowExecutor | AutoMaintenance | ⬛⬜⬜⬜⬜ Very Low |
| OutputPathResolver | Prompting, UnixCLI | ⬛⬛⬜⬜⬜ Low |
| SkillInvoker | AutoInfoManager (AutoInfoRunner), ContinualLearning (KnowledgeSynthesizer) | ⬛⬛⬜⬜⬜ Low |
| Inference | 20 importers: hooks (TabState, UpdateTabTitle, ImplicitSentimentCapture, AutoWorkCreation), ContextManager, DigitalMaestro, InformationManager, Kaya, QueueRouter, Obsidian, Evals | ⬛⬛⬛⬛⬛ Very High |

### High-Priority Expansion Targets

Skills that should adopt CORE tools but haven't yet:

| Skill | Recommended Tools | Benefit |
|-------|------------------|---------|
| **OSINT** | CachedHTTPClient, StateManager, MemoryStore, ApprovalQueue | Cache DNS/WHOIS lookups, persist investigation state |
| **Recon** | CachedHTTPClient, StateManager, MemoryStore, ApprovalQueue | Cache cert transparency, track scan authorization |
| **Shopping** | CachedHTTPClient, StateManager, MemoryStore | Cache product APIs, persist cart state |
| **Evals** | StateManager, ApprovalQueue, MemoryStore | Track suite state, human review integration |
| **ContinualLearning** | StateManager, Inference | Replace manual JSON I/O, tier-aware inference |

### Recent Migrations (Completed)

#### QueueRouter/Worker.ts → StateManager + NotificationService

**Before (redundant implementations):**
```typescript
// WRONG: Custom notification function
const VOICE_SERVER_URL = "http://localhost:8888/notify";
async function notify(message: string): Promise<void> {
  await fetch(VOICE_SERVER_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message }),
  });
}

// WRONG: Manual state I/O without validation
function loadWorkerState(): WorkerState {
  return JSON.parse(readFileSync(STATE_FILE, 'utf-8'));
}
function saveWorkerState(state: WorkerState): void {
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}
```

**After:**
```typescript
import { z } from "zod";
import { notifySync } from "../../CORE/Tools/NotificationService.ts";
import { createStateManager, type StateManager } from "../../CORE/Tools/StateManager.ts";

// Zod schema for type-safe validation
const WorkerStateSchema = z.object({
  lastRun: z.string().nullable(),
  lastProcessed: z.string().nullable(),
  itemsProcessed: z.number(),
  itemsFailed: z.number(),
  running: z.boolean(),
  pid: z.number().optional(),
  startedAt: z.string().optional(),
});

// StateManager with validation and backups
const stateManager: StateManager<WorkerState> = createStateManager({
  path: WORKER_STATE_FILE,
  schema: WorkerStateSchema,
  defaults: {
    lastRun: null,
    lastProcessed: null,
    itemsProcessed: 0,
    itemsFailed: 0,
    running: false,
  },
  backupOnWrite: false,
});

// Usage: Replace custom functions
async function loadWorkerState(): Promise<WorkerState> {
  return stateManager.load();
}

// In daemon: Replace notify() with notifySync()
notifySync("Queue worker started");
```

#### AutonomousWork → CORE ApprovalQueue

**Before (duplicate implementation):**
```
skills/AutonomousWork/Tools/ApprovalQueue.ts  # 589 lines - DELETED
```

**After:**
```bash
# SKILL.md now references CORE's ApprovalQueue
bun run ~/.claude/lib/core/ApprovalQueue.ts add --data '{...}' --priority high
```

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
- Voice announcements for user feedback
- Push notifications for mobile alerts
- Discord notifications for team channels
- Any notification need across Kaya

### Quick Start

```typescript
import { notify, notifySync, notifyBatch } from '~/.claude/lib/core/NotificationService.ts';

// Fire-and-forget voice notification
notifySync("Task completed successfully");

// Async with await
await notify({
  message: "Deployment finished",
  channel: "voice",
  title: "Deploy",
});

// Multi-channel
await notify({
  message: "Critical alert",
  channels: ["voice", "push", "discord"],
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
| `voice` | User at computer, needs immediate feedback | Voice server on localhost:8888 |
| `push` | User away, mobile notifications | ntfy topic in settings.json |
| `discord` | Team alerts, persistent logging | Discord webhook URL |

### Key Features
- **Fire-and-Forget:** Notifications never block execution
- **Batching:** Groups rapid-fire notifications into single message
- **Retry:** Automatic retry with exponential backoff
- **Duration-Aware:** Long tasks escalate to push notifications
- **Voice IDs:** Per-agent ElevenLabs voice customization

### CLI Usage
```bash
bun run NotificationService.ts send "Hello world"
bun run NotificationService.ts send "Alert" --channel push --priority high
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
  userPath: '~/.claude/USER/KAYASECURITYSYSTEM/patterns.yaml',
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

## ApprovalQueue

**Purpose:** Generic approval workflow with priority ordering and multiple backends.

### When to Use
- Human-in-the-loop approval workflows
- Queuing items for batch review
- Any workflow requiring explicit approval/rejection

### Quick Start

```typescript
import { createApprovalQueue, FileApprovalQueue } from '~/.claude/lib/core/ApprovalQueue.ts';

// Create queue
const queue = createApprovalQueue('file', '~/.claude/MEMORY/WORK/approvals.json', {
  defaultExpiry: 7, // Days until auto-expire
  onApprove: (item) => console.log(`Approved: ${item.title}`),
  onReject: (item) => console.log(`Rejected: ${item.title}`),
});

// Add item for approval
const id = await queue.add(
  { title: 'Deploy to production', branch: 'main' },
  { priority: 'high' }
);

// List pending items
const pending = await queue.list({ status: 'pending' });

// Approve/reject
await queue.approve(id, 'Looks good!', 'reviewer-name');
await queue.reject(id, 'Needs more tests');

// Batch operations
await queue.batchApprove(['id1', 'id2', 'id3'], 'Batch approved');
```

### Priority Levels

| Priority | Use Case |
|----------|----------|
| `critical` | Requires immediate attention |
| `high` | Should be reviewed soon |
| `normal` | Standard priority (default) |
| `low` | Can wait |

### Key Features
- **Priority Ordering:** Higher priority items surface first
- **Expiry:** Auto-expire items after configurable period
- **Hooks:** onAdd, onApprove, onReject, onExpire callbacks
- **Backends:** Memory (transient) or File (persistent)

### CLI Usage
```bash
bun run ApprovalQueue.ts add --data '{"title":"Deploy"}' --priority high
bun run ApprovalQueue.ts list --status pending
bun run ApprovalQueue.ts approve abc123 --notes "Approved"
bun run ApprovalQueue.ts stats
```

---

## AgentOrchestrator

**Purpose:** Spawn parallel agents, aggregate results, and run structured debates.

### When to Use
- Multi-agent research tasks
- Spotcheck verification pattern
- Council-style debates
- Any parallel agent work

### Quick Start

```typescript
import { orchestrator, createOrchestrator } from '~/.claude/lib/core/AgentOrchestrator.ts';

// Spawn multiple agents
const results = await orchestrator.spawn(
  [
    { type: 'ClaudeResearcher', model: 'sonnet' },
    { type: 'GeminiResearcher', model: 'sonnet' },
  ],
  'Research AI safety developments in 2024',
  { parallel: true, maxConcurrent: 5 }
);

// Spawn with aggregation
const { results, aggregated } = await orchestrator.spawnWithAggregation(
  [{ type: 'Intern', count: 5 }],
  'Analyze this company',
  'synthesis', // voting | synthesis | merge | first | best
);

// Spotcheck pattern
const spotcheck = await orchestrator.spotcheck(
  implementationCode,
  ['No security vulnerabilities', 'All tests pass', 'Follows style guide'],
  { model: 'sonnet', strict: true }
);

// Structured debate
const debate = await orchestrator.debate(
  'Microservices vs Monolith for this project',
  [
    { agent: { type: 'Architect' }, position: 'Pro-microservices' },
    { agent: { type: 'Engineer' }, position: 'Pro-monolith' },
  ],
  3 // rounds
);
```

### Aggregation Strategies

| Strategy | Behavior |
|----------|----------|
| `voting` | Find most common conclusion across agents |
| `synthesis` | Combine all results into unified analysis |
| `merge` | Concatenate all results |
| `first` | Return first successful result |
| `best` | Use judge to pick best result |

### Key Features
- **Parallel Execution:** Configurable concurrency limits
- **Result Aggregation:** 5 strategies for combining outputs
- **Spotcheck Pattern:** Verify work against criteria
- **Debate Workflow:** Multi-round structured debates
- **Cancellation:** Cancel running agents

### CLI Usage
```bash
bun run AgentOrchestrator.ts spawn -a "ClaudeResearcher,GeminiResearcher" -t "Research topic"
bun run AgentOrchestrator.ts aggregate -a "Intern:5" -t "Analysis" -s synthesis
bun run AgentOrchestrator.ts spotcheck -w "code" -c "No bugs,Tests pass"
bun run AgentOrchestrator.ts debate --topic "Architecture decision"
```

---

## WorkflowExecutor

**Purpose:** Execute multi-step workflows with dependencies, checkpointing, and ISC integration.

### When to Use
- Daily/Weekly/Monthly maintenance workflows
- Multi-step processes with dependencies
- Any workflow that needs progress tracking

### Quick Start

```typescript
import { workflowExecutor, createTieredWorkflow } from '~/.claude/lib/core/WorkflowExecutor.ts';

// Define workflow
const config = {
  name: 'MyWorkflow',
  steps: [
    {
      name: 'step1',
      description: 'First step',
      execute: async () => ({ success: true, message: 'Done' }),
    },
    {
      name: 'step2',
      dependsOn: ['step1'], // Run after step1
      execute: async () => ({ success: true }),
      retry: 3, // Retry up to 3 times on failure
    },
    {
      name: 'step3-parallel',
      dependsOn: ['step1'],
      parallel: true, // Can run alongside step2
      execute: async () => ({ success: true }),
    },
  ],
  notifyOnStart: true,
  notifyOnComplete: true,
  checkpointFile: '~/.claude/.checkpoints/myworkflow.json',
};

// Execute with progress
const result = await workflowExecutor.executeWithProgress(config, (step, status) => {
  console.log(`[${status}] ${step}`);
});

// Create tiered workflows (daily/weekly/monthly)
const { daily, weekly, monthly } = createTieredWorkflow(
  'Maintenance',
  [dailyStep1, dailyStep2], // Daily steps
  [weeklyStep1],           // Weekly adds these
  [monthlyStep1]           // Monthly adds these
);
```

### Key Features
- **DAG Resolution:** Topological sort for dependency ordering
- **Parallel Execution:** Steps without dependencies run concurrently
- **Checkpointing:** Resume failed workflows from last checkpoint
- **ISC Integration:** Evaluate Ideal State Criteria on completion
- **Voice Notifications:** Announce workflow start/complete

### CLI Usage
```bash
bun run WorkflowExecutor.ts --workflow daily-maintenance
bun run WorkflowExecutor.ts --resume ~/.claude/.checkpoints/daily.json
bun run WorkflowExecutor.ts --validate workflow.json
```

---

## SkillInvoker

**Purpose:** Programmatic skill invocation with filesystem-based validation.

### When to Use
- Automated workflows that need to invoke other skills
- Tools that orchestrate multiple skill executions
- Any programmatic skill invocation (replaces raw `Bun.spawn` patterns)

### Quick Start

```typescript
import { invokeSkill, skillExists, invokeSkillsSequential } from '~/.claude/lib/core/SkillInvoker.ts';

// Check if skill exists before invocation
if (skillExists('System')) {
  const result = await invokeSkill({
    skill: 'System',
    args: 'integrity',
    timeout: 300000,
  });

  if (result.success) {
    console.log(result.output);
  } else {
    console.error(result.error);
  }
}

// Sequential invocation (stops on first failure)
const results = await invokeSkillsSequential([
  { skill: 'InformationManager', args: 'ProcessScratchPad' },
  { skill: 'ContinualLearning', args: 'SynthesizePatterns' },
]);
```

### Key Features
- **Filesystem Validation:** Validates skills exist by scanning skills/*/SKILL.md
- **Case Correction:** Auto-corrects skill names (e.g., "system" → "System")
- **Timeout Handling:** Configurable timeout with graceful termination
- **Zero Maintenance:** New skills discovered automatically — no index regeneration needed

### CLI Usage
```bash
# Invoke a skill
bun run SkillInvoker.ts --skill System --args "integrity"

# Check if skill exists
bun run SkillInvoker.ts --exists System
bun run SkillInvoker.ts --exists FakeSkill

# List all available skills
bun run SkillInvoker.ts --list
```

### Migration from Raw Spawn

**Before (anti-pattern):**
```typescript
// WRONG: Bypasses validation
Bun.spawn(["claude", "-p", "/System integrity"]);
```

**After:**
```typescript
// CORRECT: Uses validation and case correction
import { invokeSkill } from '~/.claude/lib/core/SkillInvoker';
const result = await invokeSkill({ skill: 'System', args: 'integrity' });
```

---

## Integration Patterns

### Common Combinations

**Maintenance Workflow with Notifications:**
```typescript
import { workflowExecutor } from './WorkflowExecutor.ts';
import { notify } from './NotificationService.ts';
import { memoryStore } from './MemoryStore.ts';

const result = await workflowExecutor.execute({
  name: 'DailyMaintenance',
  steps: [
    { name: 'cleanup', execute: cleanupOldFiles },
    { name: 'backup', execute: backupCriticalData },
  ],
  notifyOnComplete: true,
});

// Capture result
await memoryStore.capture({
  type: 'artifact',
  title: `Daily maintenance ${new Date().toISOString()}`,
  content: JSON.stringify(result),
  tags: ['maintenance', 'daily'],
});
```

**Research with Caching and Memory:**
```typescript
import { cachedFetch } from './CachedHTTPClient.ts';
import { orchestrator } from './AgentOrchestrator.ts';
import { memoryStore } from './MemoryStore.ts';

// Fetch data with caching
const data = await cachedFetch(apiUrl, { ttl: 3600 });

// Research with agents
const { aggregated } = await orchestrator.spawnWithAggregation(
  [{ type: 'Researcher', count: 3 }],
  `Analyze this data: ${data}`,
  'synthesis'
);

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
- Skill-specific approval to ApprovalQueue
- Manual Task() calls to AgentOrchestrator
- Ad-hoc workflows to WorkflowExecutor
- Hardcoded output paths to OutputPathResolver

---

## Roadmap: CORE Tool Expansion

Based on the 2026-02-02 audit, here's the recommended adoption roadmap:

### Phase 1: Remove Redundancies (Complete)
- [x] Delete AutonomousWork/ApprovalQueue.ts duplicate
- [x] Refactor QueueRouter/Worker.ts to use StateManager + NotificationService
- [x] Add Zod validation to QueueRouter/QueueManager.ts

### Phase 2: Critical Expansions (Complete)
- [x] **Add CachedHTTPClient to high-API-call skills**
  - ~~OSINT~~ (empty Tools/ directory)
  - [x] Recon/IpinfoClient.ts: 7-day disk cache for IP lookups
  - [x] Recon/DnsUtils.ts: 30-day disk cache for crt.sh
  - [x] Recon/SubdomainEnum.ts: 30-day disk cache for crt.sh
  - ~~InformationManager~~ (uses CLI tools, not direct HTTP)

- [x] **Add StateManager to stateful skills**
  - [x] ContinualLearning/ChangeDetector.ts: Zod schema + StateManager
  - Shopping: Uses markdown profiles (appropriate for user editing)
  - Evals: Uses YAML suites (appropriate for user editing)

### Phase 3: Full Integration
- [ ] **Add MemoryStore to knowledge-generating skills**
  - ContinualLearning: Capture all synthesized patterns
  - Shopping: Store recommendations and price tracking
  - OSINT/Recon: Investigation findings database

- [ ] **Add ApprovalQueue to authorization-sensitive skills**
  - OSINT: Authorization tracking for active recon
  - Recon: Explicit scan approval
  - Evals: Human review integration

- [ ] **Add Inference to LLM-calling skills**
  - ContinualLearning: fast/standard/smart tier selection
  - Shopping: Consistent model selection for research

### Impact When Complete
- **Redundancy Reduction:** ~1,500 lines of duplicate code removed
- **Consistency Gains:** All state validated, all notifications unified, all outputs standardized
- **New Capabilities:** Cross-skill memory search, unified approval workflows, consistent model selection
