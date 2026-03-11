# Calendar Workflow (gcalcli)

Manage Google Calendar via gcalcli CLI.

## Prerequisites

- gcalcli installed (`kaya-cli calendar --version`)
- OAuth2 authentication configured
- Calendar read/write permissions

## Authentication

```bash
# Initial setup
bash ~/.claude/tools/UnixCLI/configure-google-auth.sh

# Test authentication
kaya-cli calendar list
```

## Common Operations

### View Events

```bash
# Today's agenda
kaya-cli calendar agenda

# This week's agenda
kaya-cli calendar agenda --nostarted

# Specific date
kaya-cli calendar agenda 2026-02-01

# Date range
kaya-cli calendar agenda 2026-02-01 2026-02-07

# Next N days
kaya-cli calendar agenda --days 7
```

### Create Events

```bash
# Quick add
kaya-cli calendar add "Meeting with team tomorrow at 2pm"

# Detailed event
kaya-cli calendar add \
    --title "Project Review" \
    --where "Conference Room A" \
    --when "2026-02-01 10:00" \
    --duration 60 \
    --description "Q1 Project Status"

# All-day event
kaya-cli calendar add "Team Offsite" --when "2026-02-15" --allday
```

### Search Events

```bash
# Search by text
kaya-cli calendar search "meeting"

# Search with date range
kaya-cli calendar search "standup" 2026-01-01 2026-01-31
```

### List Calendars

```bash
# Show all calendars
kaya-cli calendar list

# List with details
kaya-cli calendar list --details
```

## Output Formats

**TSV** (recommended for parsing):
```bash
# Agenda as TSV
kaya-cli calendar agenda --tsv

# Parse with awk
kaya-cli calendar agenda --tsv | awk -F'\t' '{print $2 " - " $3}'
```

**Plain text**:
```bash
kaya-cli calendar agenda
```

## Integration Examples

### Count today's events
```bash
event_count=$(kaya-cli calendar agenda --tsv | wc -l)
echo "You have $event_count events today"
```

### Filter events by keyword
```bash
# Show only standup meetings
kaya-cli calendar agenda | grep -i "standup"

# Exclude certain events
kaya-cli calendar agenda | grep -v "optional"
```

### Create recurring notification
```bash
# In cron or scheduled task
kaya-cli calendar agenda --days 1 | head -3 | \
    xargs -I {} echo "Reminder: {}"
```

### Export to file
```bash
# Save this week's agenda
kaya-cli calendar agenda --days 7 > ~/agenda-$(date +%Y%m%d).txt
```

## Error Handling

```bash
if ! kaya-cli calendar list &> /dev/null; then
    echo "Authentication failed or expired"
    echo "Reconfigure: bash ~/.claude/tools/UnixCLI/configure-google-auth.sh"
    exit 1
fi
```

Common errors:
- **Authentication expired**: Re-run `kaya-cli calendar list` to refresh
- **Calendar not found**: Check calendar name with `kaya-cli calendar list`
- **Rate limiting**: Add delays between operations

## Advanced Options

```bash
# Show calendar colors
kaya-cli calendar list --color

# Specify calendar
kaya-cli calendar --calendar "Work" agenda

# Show declined events
kaya-cli calendar agenda --declined

# Military time format
kaya-cli calendar agenda --military

# Include event links
kaya-cli calendar agenda --details
```

## Performance

- List calendars: < 500ms
- Fetch agenda: < 1s for typical week
- Create event: < 1s
- Token refresh: Automatic and transparent

## Documentation

- Official docs: https://github.com/insanum/gcalcli
- Date/time formats: https://github.com/insanum/gcalcli#date-and-time
- Configuration: `~/.local/share/gcalcli/`
