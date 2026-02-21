# MEMORY/State -- Persistent State Files

> This directory stores JSON state files that maintain cross-session
> continuity for various Kaya subsystems. Excluded from the public
> repository as it contains runtime state.

## Purpose

State files provide persistent memory for hooks and skills that need to track information across sessions. Each file is a JSON document managed by the StateManager utility.

## Files

| File | Purpose |
|------|---------|
| `context-session.json` | Current session context profile and loaded files |
| `context-classification.json` | Context routing classification cache |
| `integrity-state.json` | System integrity checksums for drift detection |
| `tab-title.json` | Terminal tab title state |

## Example: context-session.json

```json
{
  "activeProfile": "development",
  "loadedContexts": ["CORE", "Development", "Browser"],
  "sessionStartTime": "2026-02-20T14:30:00Z",
  "lastClassification": "engineering-task"
}
```

## Example: integrity-state.json

```json
{
  "lastCheck": "2026-02-20T14:30:00Z",
  "checksums": {
    "settings.json": "sha256:abc123...",
    "CLAUDE.md": "sha256:def456..."
  },
  "driftDetected": false
}
```

## How It Works

State files are read/written using `skills/CORE/Tools/StateManager.ts`, which provides atomic read-modify-write operations with validation. Never edit state files manually -- use the StateManager API.
