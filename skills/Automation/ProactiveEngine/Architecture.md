# ProactiveEngine Architecture

## Philosophy

Traditional AI assistants are reactive—they wait for you to ask. ProactiveEngine inverts this relationship by enabling Kaya to:
- **Reach out first** when something needs attention
- **Schedule recurring patterns** (daily briefings, weekly reviews)
- **Monitor conditions** and alert when thresholds are crossed
- **Maintain continuity** across sessions through scheduled checkpoints

This aligns with Kaya's goal of *euphoric surprise*—imagine opening your laptop to find your morning briefing already prepared, or receiving a thoughtful evening summary without asking.

---

## Three-Layer System

```
┌─────────────────────────────────────────────────────┐
│                  ProactiveEngine                     │
│                   (Orchestration)                    │
└─────────────┬───────────────────────────────────────┘
              │
    ┌─────────┴──────────┬──────────────┐
    │                    │              │
    ▼                    ▼              ▼
┌────────┐         ┌──────────┐   ┌──────────┐
│ Daemon │         │   Cron   │   │  Queue   │
│ System │         │  System  │   │  System  │
└────────┘         └──────────┘   └──────────┘
```

**Daemon System**: Long-running processes (file watchers, monitors)
**Cron System**: Time-based scheduled tasks (daily, weekly, monthly)
**Queue System**: Event-driven tasks (triggered by conditions, not time)

---

## Integration Points

- **Voice Server**: Deliver briefings audibly
- **Notification System**: Push alerts for time-sensitive items
- **Memory System**: Context for personalized briefings
- **Hook System**: Trigger proactive behaviors on lifecycle events

---

## Library Components

There is no in-process daemon or gateway process. The daemon (its long-running
gateway process, its in-process job scheduler, and its WebSocket-based control
plane) was deleted outright in slice D1 (2026-07-03) — it wasn't running, and
its last job couldn't fire. See `MEMORY/daemon/cron/jobs.retired/README.md`
for the retirement record.

Cron scheduling now runs entirely via launchd:

| Component | Location | Purpose |
|-----------|----------|---------|
| **run-cron-job.ts** | `bin/run-cron-job.ts` | Wrapper every launchd plist invokes to run a job |
| **migrate-crons-to-launchd.ts** | `bin/migrate-crons-to-launchd.ts` | Generates + installs launchd plists from the jobs manifest |
| **JobSpawner** | `lib/cron/JobSpawner.ts` | Shared spawn+timeout+classify primitive |
| **MessageQueue** | `lib/messaging/MessageQueue.ts` | Outbound message queue |

---

## Daemon System (Future)

Long-running processes for continuous monitoring:

- **File watchers**: React to file system changes
- **Condition monitors**: Alert when metrics cross thresholds
- **Deadline trackers**: Proactive reminders before due dates
- **Context collectors**: Gather relevant info before scheduled meetings

---

## Queue System (Future)

Event-driven task execution:

- **Approval queues**: Human-in-loop decisions
- **Retry queues**: Failed operations with backoff
- **Priority queues**: Urgent tasks jump ahead
- **Batch queues**: Accumulate similar tasks for efficiency
