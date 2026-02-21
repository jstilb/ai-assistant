# Kaya Infrastructure Inventory

**Living reference for all available infrastructure.** Consult before building new skills.

---

## Quick Decision Tree

| Need | Tool | When to Use |
|------|------|-------------|
| Persist state | StateManager | JSON state surviving sessions |
| Send notifications | NotificationService | Voice/push/discord alerts |
| HTTP with caching | CachedHTTPClient | External API calls |
| Store memories | MemoryStore | Learnings, decisions, research |
| Human approval | ApprovalQueue | Human-in-loop workflows |
| Parallel agents | AgentOrchestrator | Multi-agent tasks |
| Multi-step workflows | WorkflowExecutor | DAG-based execution |
| Resolve output paths | OutputPathResolver | File output location |
| Invoke other skills | SkillInvoker | Programmatic skill calls |
| AI inference | Inference.ts | Fast/Standard/Smart calls |
| Load configuration | ConfigLoader | SYSTEM/USER tiered configs |

---

## CORE Tools (11 Primary)

Located in `skills/CORE/Tools/`. Import directly or use CLI.

### StateManager

**Purpose:** Type-safe state persistence with Zod validation, transactions, locking, backups.

```typescript
import { createStateManager } from '~/.claude/skills/CORE/Tools/StateManager.ts';
import { z } from 'zod';

const manager = createStateManager({
  path: '~/.claude/MEMORY/myskill/state.json',
  schema: z.object({ count: z.number(), items: z.array(z.string()) }),
  defaults: { count: 0, items: [] },
  backupOnWrite: true,
});

const state = await manager.get();
await manager.transaction(s => { s.count++; return s; });
```

**CLI:**
```bash
bun StateManager.ts get --path state.json
bun StateManager.ts set --path state.json --data '{"count": 5}'
```

---

### NotificationService

**Purpose:** Multi-channel notifications (voice, push, discord) with batching and retry.

```typescript
import { notify, notifySync, notifyBatch } from '~/.claude/skills/CORE/Tools/NotificationService.ts';

// Fire-and-forget (recommended)
notifySync("Task completed");

// Async with await
await notify({ message: "Done", channel: "voice" });

// Multi-channel
await notify({ message: "Alert", channels: ["voice", "push"], priority: "high" });
```

**CLI:**
```bash
bun NotificationService.ts send "Hello"
bun NotificationService.ts send "Alert" --channel push --priority high
```

---

### CachedHTTPClient

**Purpose:** HTTP with memory/disk caching, retry, rate limiting.

```typescript
import { cachedFetch, createCachedClient } from '~/.claude/skills/CORE/Tools/CachedHTTPClient.ts';

// Simple cached fetch
const data = await cachedFetch('https://api.example.com/data', { ttl: 300 });

// Dedicated client with rate limiting
const client = createCachedClient({
  baseUrl: 'https://api.example.com',
  cache: { type: 'disk', directory: '~/.claude/.cache/api', ttl: 3600 },
  rateLimit: { requests: 10, window: 60000 },
});
```

---

### MemoryStore

**Purpose:** Unified memory storage with deduplication, tags, lifecycle tiers.

```typescript
import { memoryStore } from '~/.claude/skills/CORE/Tools/MemoryStore.ts';

await memoryStore.capture({
  type: 'learning',
  category: 'ALGORITHM',
  title: 'Pattern discovered',
  content: 'Details...',
  tags: ['algorithm', 'pattern'],
  tier: 'warm',
});

const results = await memoryStore.search({ type: 'learning', tags: ['algorithm'] });
```

**Memory types:** `learning`, `decision`, `artifact`, `insight`, `signal`, `research`

---

### ApprovalQueue

**Purpose:** Human-in-loop approval workflows with priority and expiry.

```typescript
import { createApprovalQueue } from '~/.claude/skills/CORE/Tools/ApprovalQueue.ts';

const queue = createApprovalQueue('file', '~/.claude/MEMORY/approvals.json', {
  defaultExpiry: 7,
  onApprove: (item) => console.log(`Approved: ${item.title}`),
});

const id = await queue.add({ title: 'Deploy' }, { priority: 'high' });
await queue.approve(id, 'Looks good');
```

**CLI:**
```bash
bun ApprovalQueue.ts add --data '{"title":"Deploy"}' --priority high
bun ApprovalQueue.ts list --status pending
bun ApprovalQueue.ts approve abc123 --notes "Approved"
```

---

### AgentOrchestrator

**Purpose:** Spawn parallel agents, aggregate results, run debates, spotcheck pattern.

```typescript
import { orchestrator } from '~/.claude/skills/CORE/Tools/AgentOrchestrator.ts';

// Parallel research
const results = await orchestrator.spawn(
  [{ type: 'ClaudeResearcher' }, { type: 'GeminiResearcher' }],
  'Research topic',
  { parallel: true }
);

// Spotcheck (verify work against criteria)
const spotcheck = await orchestrator.spotcheck(
  implementationCode,
  ['No vulnerabilities', 'All tests pass'],
  { model: 'sonnet' }
);

// Structured debate
const debate = await orchestrator.debate('Microservices vs Monolith', [
  { agent: { type: 'Architect' }, position: 'Pro-microservices' },
  { agent: { type: 'Engineer' }, position: 'Pro-monolith' },
], 3);
```

**Aggregation strategies:** `voting`, `synthesis`, `merge`, `first`, `best`

---

### WorkflowExecutor

**Purpose:** Multi-step workflows with DAG resolution, checkpointing, ISC integration.

```typescript
import { workflowExecutor, createTieredWorkflow } from '~/.claude/skills/CORE/Tools/WorkflowExecutor.ts';

const result = await workflowExecutor.executeWithProgress({
  name: 'MyWorkflow',
  steps: [
    { name: 'step1', execute: async () => ({ success: true }) },
    { name: 'step2', dependsOn: ['step1'], execute: async () => ({ success: true }) },
  ],
  notifyOnComplete: true,
}, (step, status) => console.log(`[${status}] ${step}`));
```

---

### OutputPathResolver

**Purpose:** Generate consistent output paths for skill artifacts.

```typescript
import { resolveOutputPath, ensureOutputDir } from '~/.claude/skills/CORE/Tools/OutputPathResolver.ts';

const { path } = await resolveOutputPath({
  skill: 'MySkill',
  title: 'output-file',
  // type: 'memory' | 'work' | 'downloads' | 'custom'
});
ensureOutputDir(path);
await Bun.write(path, content);
```

**Default path:** `~/.claude/MEMORY/[SkillName]/[YYYY-MM-DD]/`

---

### SkillInvoker

**Purpose:** Programmatic skill invocation with index validation and case correction.

```typescript
import { invokeSkill, skillExists } from '~/.claude/skills/CORE/Tools/SkillInvoker.ts';

if (skillExists('System')) {
  const result = await invokeSkill({
    skill: 'System',
    args: 'integrity',
    timeout: 300000,
  });
}
```

**CLI:**
```bash
bun SkillInvoker.ts --skill System --args "integrity"
bun SkillInvoker.ts --exists System
bun SkillInvoker.ts --list
```

---

### Inference

**Purpose:** AI inference using Claude Code subscription (fast/standard/smart tiers).

```bash
# Fast (Haiku) - classification, extraction
echo "Your prompt" | bun ~/.claude/skills/CORE/Tools/Inference.ts fast

# Standard (Sonnet) - general analysis
echo "Your prompt" | bun ~/.claude/skills/CORE/Tools/Inference.ts standard

# Smart (Opus) - complex reasoning
echo "Your prompt" | bun ~/.claude/skills/CORE/Tools/Inference.ts smart
```

**Level selection:**
| Level | Model | Use Case | Latency |
|-------|-------|----------|---------|
| `fast` | Haiku | Classification, extraction | ~10-15s |
| `standard` | Sonnet | Analysis, summarization | ~15-30s |
| `smart` | Opus | Complex reasoning | ~60-90s |

Default to `fast`. Escalate only when quality requires it.

---

### ConfigLoader

**Purpose:** Configuration loading with SYSTEM/USER tiering, schema validation.

```typescript
import { loadSettings, loadTieredConfig } from '~/.claude/skills/CORE/Tools/ConfigLoader.ts';

const settings = loadSettings();
console.log(settings.principal.name);

const securityConfig = loadTieredConfig({
  userPath: '~/.claude/skills/CORE/USER/KAYASECURITYSYSTEM/patterns.yaml',
  systemPath: '~/.claude/KAYASECURITYSYSTEM/patterns.example.yaml',
});
```

---

## External CLIs (Installed)

Available on this system via `which`:

| CLI | Purpose | Example |
|-----|---------|---------|
| `yt-dlp` | YouTube/media downloads | `yt-dlp --extract-audio URL` |
| `gcalcli` | Google Calendar | `gcalcli agenda` |
| `rclone` | Cloud sync | `rclone sync local: remote:` |
| `gh` | GitHub CLI | `gh pr create`, `gh issue view` |
| `bsky` | Bluesky social | `bsky post "message"` |
| `jq` | JSON processing | `cat file.json \| jq '.key'` |

---

## UnixCLI Tools (10)

Located in `skills/UnixCLI/Tools/`. Run via bun.

| Tool | Purpose | Usage |
|------|---------|-------|
| `AsanaFullExporter.ts` | Asana→LucidTasks importer (migration tool) | `bun AsanaFullExporter.ts --dry-run` |
| `MigrationRunner.ts` | Asana migration orchestrator | `bun MigrationRunner.ts` |
| `BacklogBankruptcy.ts` | Bulk task cleanup | Clear old/stale tasks |
| `MyTasksOrganizer.ts` | Personal task organization | Organize assigned tasks |
| `NotebookLM.ts` | NotebookLM integration | Create/manage notebooks |
| `Places.ts` | Google Places API | Find places, get details |
| `Sheets.ts` | Google Sheets | Read/write spreadsheets |
| `TaskMaintenance.ts` | Task maintenance | Clean up task data |
| `Weather.ts` | Weather data | `bun Weather.ts --location "City"` |

---

## Composable Skills

High-value skills to compose with rather than duplicate:

| Skill | Purpose | When to Compose |
|-------|---------|-----------------|
| **Research** | Multi-agent research | Need deep web research |
| **Browser** | Web automation | UI verification, screenshots |
| **Agents** | Custom agent creation | Named agents with voices |
| **Fabric** | Prompt patterns | Content transformation |
| **Evals** | Testing framework | Verify behavior |
| **THEALGORITHM** | Execution engine | Complex multi-step tasks |
| **ContinualLearning** | Pattern synthesis | Capture insights |
| **InformationManager** | Context gathering | User data collection |

---

## Anti-Patterns to Avoid

| Instead Of | Use | Why |
|------------|-----|-----|
| `Bun.spawn(["claude", ...])` | SkillInvoker | Validation, case correction |
| `curl localhost:8888/notify` | NotificationService.notifySync() | Batching, retry, channels |
| `JSON.parse(Bun.file(...))` | StateManager | Validation, transactions, backups |
| Direct `fetch()` for APIs | CachedHTTPClient | Caching, rate limiting, retry |
| `ANTHROPIC_API_KEY` usage | Inference.ts | Uses subscription, consistent tiers |
| `process.env.SECRET` | ConfigLoader + secrets.json | Centralized secret management |
| Hardcoded output paths | OutputPathResolver | Consistent paths, auto-create dirs |
| Custom memory I/O | MemoryStore | Deduplication, search, tiers |

---

## Integration Examples

### Maintenance Workflow with Notifications

```typescript
import { workflowExecutor } from './WorkflowExecutor.ts';
import { notifySync } from './NotificationService.ts';
import { memoryStore } from './MemoryStore.ts';

const result = await workflowExecutor.execute({
  name: 'DailyMaintenance',
  steps: [
    { name: 'cleanup', execute: cleanupOldFiles },
    { name: 'backup', execute: backupCriticalData },
  ],
  notifyOnComplete: true,
});

await memoryStore.capture({
  type: 'artifact',
  title: `Maintenance ${new Date().toISOString()}`,
  content: JSON.stringify(result),
  tags: ['maintenance'],
});
```

### Research with Caching

```typescript
import { cachedFetch } from './CachedHTTPClient.ts';
import { orchestrator } from './AgentOrchestrator.ts';
import { memoryStore } from './MemoryStore.ts';

const data = await cachedFetch(apiUrl, { ttl: 3600 });
const { aggregated } = await orchestrator.spawnWithAggregation(
  [{ type: 'Researcher', count: 3 }],
  `Analyze: ${data}`,
  'synthesis'
);
await memoryStore.capture({ type: 'research', title: 'Analysis', content: aggregated });
```

---

**Last updated:** 2026-02-02
**Full tool documentation:** `skills/CORE/Tools/README.md`
