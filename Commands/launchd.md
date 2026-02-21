# /launchd - Manage Kaya Scheduled Jobs

Monitor and control Kaya launchd jobs for automated workflows.

## Usage

```
/launchd [status|start|stop|load|unload|logs] [job-name]
```

## Arguments

| Argument | Description |
|----------|-------------|
| `status` | Show status of all Kaya launchd jobs (default) |
| `start [job]` | Manually trigger a job now |
| `stop [job]` | Stop a running job |
| `load [job]` | Load/enable a job |
| `unload [job]` | Unload/disable a job |
| `logs [job]` | Show recent logs for a job |
| `reload [job]` | Unload then load a job (after config changes) |

## Job Names

Use short names (without `com.pai.` prefix):

| Short Name | Full Name | Schedule |
|------------|-----------|----------|
| `maintenance-daily` | com.pai.maintenance-daily | 6am daily |
| `maintenance-weekly` | com.pai.maintenance-weekly | Sunday 3am |
| `maintenance-monthly` | com.pai.maintenance-monthly | 1st 4am |
| `knowledge-daily` | com.pai.knowledge-daily | 7am daily |
| `knowledge-weekly` | com.pai.knowledge-weekly | Sunday 6am |
| `knowledge-monthly` | com.pai.knowledge-monthly | 1st 5am |
| `tasks-daily` | com.pai.tasks-daily | 8am daily |
| `tasks-weekly` | com.pai.tasks-weekly | Sunday 8am |
| `tasks-monthly` | com.pai.tasks-monthly | 1st 6am |

## Examples

```
/launchd                        # Show all job statuses
/launchd status                 # Same as above
/launchd start tasks-daily      # Run tasks-daily now
/launchd logs maintenance-weekly # Show recent logs
/launchd reload knowledge-daily  # Reload after config change
/launchd unload tasks-monthly   # Disable monthly task cleanup
```

## Execution

When this command is invoked:

### /launchd status (default)

```bash
# List all Kaya jobs with status
launchctl list | grep com.pai
```

Then format as table:

| Job | Status | Last Exit | Next Run |
|-----|--------|-----------|----------|
| maintenance-daily | Loaded | 0 (success) | 6am |
| tasks-daily | Loaded | 0 (success) | 8am |
| ... | ... | ... | ... |

**Status meanings:**
- PID shown = Currently running
- `-` = Loaded, waiting for schedule
- Exit `0` = Last run succeeded
- Exit `1+` = Last run failed

### /launchd start [job]

```bash
launchctl start com.pai.[job]
```

### /launchd stop [job]

```bash
launchctl stop com.pai.[job]
```

### /launchd load [job]

```bash
launchctl load ~/Library/LaunchAgents/com.pai.[job].plist
```

### /launchd unload [job]

```bash
launchctl unload ~/Library/LaunchAgents/com.pai.[job].plist
```

### /launchd reload [job]

```bash
launchctl unload ~/Library/LaunchAgents/com.pai.[job].plist
launchctl load ~/Library/LaunchAgents/com.pai.[job].plist
```

### /launchd logs [job]

```bash
# Show last 50 lines of job log
tail -50 ~/.claude/logs/[job]-launchd.log

# Also check error log
tail -20 ~/.claude/logs/[job]-launchd-error.log
```

## Troubleshooting

**Job not running on schedule:**
1. Check if loaded: `/launchd status`
2. Check logs: `/launchd logs [job]`
3. Try manual run: `/launchd start [job]`
4. Reload: `/launchd reload [job]`

**Job failing (exit code > 0):**
1. Check error log: `tail ~/.claude/logs/[job]-launchd-error.log`
2. Check main log: `/launchd logs [job]`
3. Run manually to see output: `/launchd start [job]`

**Load all Kaya jobs:**
```bash
for plist in ~/Library/LaunchAgents/com.pai.*.plist; do
  launchctl load "$plist"
done
```

**Unload all Kaya jobs:**
```bash
for plist in ~/Library/LaunchAgents/com.pai.*.plist; do
  launchctl unload "$plist"
done
```
