# CronManager

Production-grade cron job scheduling system for Kaya, providing robust task scheduling with two execution modes.

## Features

- **Standard Cron Expressions**: Full support for minute, hour, day, month, and weekday scheduling
- **Two Execution Types**:
  - **Main Session Jobs**: Enqueue system events for processing in active session
  - **Isolated Session Jobs**: Spawn dedicated agent turns for autonomous execution
- **Persistent State**: Jobs and execution history stored in `~/.claude/MEMORY/daemon/cron/`
- **YAML Job Definitions**: Human-readable job configuration from `skills/ProactiveEngine/Cron/`
- **Wake Modes**: Support for immediate execution (`now`) or scheduled execution
- **Job Management**: Enable, disable, run, and monitor jobs via CLI
- **Execution History**: Track job runs, failures, and performance metrics
- **Auto-backup**: State files backed up before writes

## Installation

The CronManager is installed at:
```
~/.claude/lib/cron/CronManager.ts
```

State files are stored at:
```
~/.claude/MEMORY/daemon/cron/state.json
```

Job definitions are loaded from:
```
~/.claude/skills/ProactiveEngine/Cron/*.yaml
```

## Usage

### CLI Commands

```bash
# List all configured jobs
bun lib/cron/CronManager.ts --list

# Run a job immediately
bun lib/cron/CronManager.ts --run <jobId>

# Add a job from YAML file
bun lib/cron/CronManager.ts --add <yamlPath>

# Enable/disable jobs
bun lib/cron/CronManager.ts --enable <jobId>
bun lib/cron/CronManager.ts --disable <jobId>

# Remove a job
bun lib/cron/CronManager.ts --remove <jobId>

# Show job status
bun lib/cron/CronManager.ts --status <jobId>

# Show execution history
bun lib/cron/CronManager.ts --history <jobId> [limit]

# Run as daemon
bun lib/cron/CronManager.ts --daemon

# Run self-test
bun lib/cron/CronManager.ts --test
```

### Programmatic Usage

```typescript
import { createCronManager } from "~/.claude/lib/cron/CronManager";

const manager = createCronManager({
  jobsDir: "~/.claude/skills/ProactiveEngine/Cron",
  stateDir: "~/.claude/MEMORY/daemon/cron",
  checkInterval: 60000, // 1 minute
});

// Register callback for job execution
manager.onJobExecute(async (job) => {
  console.log(`Executing ${job.id}: ${job.task}`);
  
  if (job.type === 'isolated') {
    // Spawn dedicated agent turn
    // ... spawn isolated session ...
  } else {
    // Enqueue system event
    // ... enqueue to main session ...
  }
  
  return { success: true, output: "Job completed" };
});

// Start the scheduler
await manager.start();
```

## Job Definition Format

Jobs are defined in YAML files under `skills/ProactiveEngine/Cron/`:

```yaml
id: daily-briefing
schedule: "0 8 * * *"           # 8am daily
type: isolated                  # isolated | main
task: |
  Generate morning briefing with:
  - Today's calendar events
  - Priority tasks from Asana
  - Weather forecast
output: voice                   # voice | text | both
enabled: true
wakeMode: schedule              # schedule | now
```

### Job Properties

| Property | Type | Description |
|----------|------|-------------|
| `id` | string | Unique job identifier |
| `schedule` | string | Cron expression (5 fields) |
| `type` | enum | `isolated` for dedicated turns, `main` for event queue |
| `task` | string | Description of the job's task |
| `output` | enum | `voice`, `text`, or `both` |
| `enabled` | boolean | Whether job is active |
| `wakeMode` | enum | `schedule` for cron, `now` for immediate |

## Cron Expression Format

```
┌─── minute (0-59)
│ ┌─── hour (0-23)
│ │ ┌─── day of month (1-31)
│ │ │ ┌─── month (1-12)
│ │ │ │ ┌─── day of week (0-6, Sunday=0)
│ │ │ │ │
* * * * *
```

### Examples

| Expression | Description |
|------------|-------------|
| `0 8 * * *` | Daily at 8am |
| `*/15 * * * *` | Every 15 minutes |
| `0 0 * * 0` | Weekly on Sunday at midnight |
| `0 9 1 * *` | Monthly on the 1st at 9am |
| `30 14 * * 1-5` | Weekdays at 2:30pm |
| `0 */6 * * *` | Every 6 hours |

### Supported Features

- **Wildcards**: `*` matches any value
- **Step values**: `*/n` for intervals
- **Ranges**: `1-5` for Monday through Friday
- **Lists**: `1,3,5` for specific values

## Example Jobs

### Daily Briefing
```yaml
id: daily-briefing
schedule: "0 8 * * *"
type: isolated
task: |
  Generate morning briefing with calendar events,
  priority tasks, weather, and news headlines
output: voice
enabled: true
wakeMode: schedule
```

### Hourly Check
```yaml
id: hourly-check
schedule: "0 * * * *"
type: main
task: Check for urgent items and enqueue notifications
output: text
enabled: true
wakeMode: schedule
```

### Weekly Review
```yaml
id: weekly-review
schedule: "0 9 * * 0"
type: isolated
task: |
  Generate weekly review with completed tasks,
  goals progress, learnings, and upcoming week preview
output: both
enabled: true
wakeMode: schedule
```

## State Management

The CronManager uses the Kaya StateManager for persistence:

- **State File**: `~/.claude/MEMORY/daemon/cron/state.json`
- **Backups**: Automatic backups before each write
- **Schema Validation**: Zod validation on all state operations
- **Atomic Updates**: Transaction support for safe concurrent access

### State Schema

```typescript
{
  jobs: CronJob[],           // All configured jobs
  history: JobExecution[],   // Execution history
  lastCheck: string          // ISO timestamp of last check
}
```

## Integration with ClawdBot Patterns

The CronManager follows ClawdBot architecture patterns:

1. **Two-tier execution**: Main session (event queue) vs isolated session (dedicated turns)
2. **YAML configuration**: Human-readable job definitions
3. **Persistent state**: Jobs survive system restarts
4. **CLI interface**: Full management via command line
5. **Wake modes**: Immediate or scheduled execution

## Error Handling

- Invalid cron expressions throw validation errors
- Failed jobs are tracked in execution history
- Automatic retry on next scheduled run
- Job failures don't block other jobs

## Performance

- **Check interval**: 1 minute by default (configurable)
- **History limit**: 100 executions per job (configurable)
- **Non-blocking**: Jobs execute in background
- **Concurrent-safe**: File locking for state updates

## Testing

Run the self-test suite:
```bash
bun lib/cron/CronManager.ts --test
```

Tests include:
- Cron expression parsing (wildcards, steps, ranges, lists)
- Date matching logic
- Edge cases (weekends, month boundaries)

## Future Enhancements

- [ ] Job dependencies (run A after B completes)
- [ ] Timezone support (currently uses system time)
- [ ] Job priorities (high-priority jobs first)
- [ ] Conditional execution (run if criteria met)
- [ ] Notification on failure
- [ ] Job chaining (one job triggers another)
- [ ] Rate limiting (max N jobs per minute)

## License

Part of the Kaya (Personal AI Infrastructure) system.
