# ADR-002: JSON-Based Memory Persistence

## Status

Accepted

## Date

2024-11-15

## Context

The AI assistant needs to maintain state across sessions -- learned preferences, work queue status, cron job state, and voice event history. The persistence mechanism must be:

- Git-trackable (changes are visible in diffs)
- Zero-infrastructure (no database server)
- Human-debuggable (readable without special tools)
- Corruption-resistant (concurrent writes from parallel agents)

Options considered:
1. **SQLite** -- Embedded database, great for queries, binary format
2. **JSON files** -- Plain text, git-friendly, human-readable
3. **JSONL append-only logs** -- Append-only for concurrent safety
4. **Redis** -- In-memory with persistence, requires running server

## Decision

Use JSON files in a `MEMORY/` directory for structured state, and JSONL (JSON Lines) for append-only event logs.

## Rationale

- **Git integration**: JSON diffs are meaningful. A state change from `"status": "pending"` to `"status": "complete"` shows exactly what changed in a git diff.
- **Zero infrastructure**: No database server to install, configure, or maintain. The filesystem is the database.
- **Human debugging**: When a skill behaves unexpectedly, `cat MEMORY/State/work-queue-state.json` immediately shows the current state.
- **JSONL for events**: Learning signals, voice events, and validation logs use append-only JSONL format, which is safe for concurrent writes (each line is an atomic append).

## Consequences

- **Positive**: State changes are auditable through git history. Every learning signal has a timestamp and can be traced.
- **Positive**: Backup is a git push. Recovery is a git checkout.
- **Negative**: No query capabilities. Finding "all learnings with sentiment > 4" requires reading and filtering the JSONL file.
- **Negative**: File-level locking for JSON state can cause contention under heavy parallel agent load. Mitigated by backup files with timestamps.
