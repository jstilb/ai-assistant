# Asana Automation Suite

Production-grade TypeScript automation tools for Asana task management using the REST API.

## Overview

This suite eliminates manual task management overhead by providing CLI tools for:

- **Backlog Bankruptcy**: One-time cleanup of stale tasks and legacy projects
- **My Tasks Organization**: Daily auto-organization by due dates
- **Task Maintenance**: Weekly health reports and stale task flagging
- **AsanaClient**: Reusable REST API client with retry logic and rate limiting

## Setup

### 1. Install Dependencies

All tools use Bun runtime (already installed in Kaya):

```bash
cd ~/.claude/skills/UnixCLI/Tools
```

### 2. Get Asana Personal Access Token

1. Go to: https://app.asana.com/0/my-apps
2. Click **"Create new token"**
3. Name: `Kaya Automation`
4. Copy the token (save it immediately - you can't view it again)

### 3. Configure Secrets

Add your Asana credentials to `~/.claude/secrets.json`:

```json
{
  "asana": {
    "personal_access_token": "YOUR_TOKEN_HERE",
    "workspace_gid": "1204453550639466"
  }
}
```

**Security**: This file is gitignored. Never commit API tokens to version control.

### 4. Verify Setup

Test authentication:

```bash
bun run AsanaClient.ts
```

(This will error on missing main(), but if authentication works, you'll get a different error than "missing token")

## Tools

### AsanaClient.ts

Core REST API client used by all other tools. Provides:

- Authentication with Personal Access Token
- Automatic retry with exponential backoff
- Rate limit handling (150 requests/min)
- Typed interfaces for all Asana resources
- Batch operations with progress callbacks

**Usage in your own scripts**:

```typescript
import { createAsanaClient } from './AsanaClient';

const client = await createAsanaClient();
const tasks = await client.getTasks(projectGid);
```

### BacklogBankruptcy.ts

One-time cleanup tool for executing the backlog bankruptcy plan.

**What it does**:
- Archives 3 legacy projects (Spain, Misc, San Diego)
- Deletes 51 stale tasks across 7 projects
- Creates Ideas sections in Lucidview & Youtube
- Moves 18 tasks to Ideas sections

**Usage**:

```bash
# Preview changes (ALWAYS run this first)
bun run BacklogBankruptcy.ts --dry-run

# Execute after reviewing preview
bun run BacklogBankruptcy.ts --execute

# Get JSON output for automation
bun run BacklogBankruptcy.ts --execute --json
```

**Safety**:
- Deleted tasks go to trash (30-day recovery window)
- Archived projects remain searchable
- Results saved to `~/.claude/MEMORY/State/Asana/`

### MyTasksOrganizer.ts

Auto-organizes My Tasks into time-based sections.

**Organization logic**:
- **In Progress (Weekly)**: Tasks due within 7 days
- **Prioritized (Monthly)**: Tasks due within 30 days
- **Recently Assigned (Unassigned)**: No due date (left alone)

**Usage**:

```bash
# Show current state
bun run MyTasksOrganizer.ts --report

# Preview organization
bun run MyTasksOrganizer.ts --dry-run

# Execute organization
bun run MyTasksOrganizer.ts
```

**Recommended**: Run daily via cron or during morning planning ritual.

### TaskMaintenance.ts

Generates project health reports and flags stale tasks.

**What it analyzes**:
- Backlog health (tasks >90 days old)
- In Progress health (tasks >14 days without updates)
- Completed tasks older than 30 days
- Per-project health scores (0-100)

**Usage**:

```bash
# Generate health report
bun run TaskMaintenance.ts check

# Preview cleanup actions
bun run TaskMaintenance.ts cleanup --dry-run

# Execute cleanup
bun run TaskMaintenance.ts cleanup --execute

# JSON output for dashboards
bun run TaskMaintenance.ts check --json
```

**Recommended**: Run weekly during review ritual.

## Automation with Cron

Add to your crontab for automated execution:

```bash
# Daily My Tasks organization (9 AM)
0 9 * * * cd ~/.claude/skills/UnixCLI/Tools && bun run MyTasksOrganizer.ts

# Weekly maintenance report (Monday 10 AM)
0 10 * * 1 cd ~/.claude/skills/UnixCLI/Tools && bun run TaskMaintenance.ts check
```

Or use launchd on macOS (see Kaya hooks system for examples).

## Project Configuration

The `config.json` file contains project mappings:

```json
{
  "workspace_gid": "1204453550639466",
  "projects": [
    { "name": "Creative", "gid": "1204453649977928" },
    { "name": "Adventurer", "gid": "1204453649977949" },
    ...
  ]
}
```

Update this file when adding/removing projects.

## Troubleshooting

### "Secrets file not found"

Create `~/.claude/secrets.json` with your Asana credentials (see Setup step 3).

### "Missing asana.personal_access_token"

Add the `asana` section to `~/.claude/secrets.json` with your token from https://app.asana.com/0/my-apps.

### "Rate limit hit"

The tools automatically handle rate limits with exponential backoff. Wait for the retry.

### "My Tasks sections not found"

Ensure your My Tasks has these exact section names:
- `Prioritized (Monthly)`
- `In Progress (Weekly)`
- `Recently Assigned (Unassigned)`

Create them manually in Asana if missing.

### Authentication errors (401)

Your token may have expired or been revoked. Generate a new one at https://app.asana.com/0/my-apps.

## API Reference

### AsanaClient Methods

**Task Operations**:
- `getTasks(projectGid, optFields?)` - List all tasks in a project
- `deleteTask(taskGid)` - Delete a task (moves to trash)
- `updateTask(taskGid, updates)` - Update task properties
- `createTask(projectGid, task)` - Create a new task
- `moveTaskToSection(sectionGid, taskGid)` - Move task to section
- `deleteTasks(taskGids, onProgress?)` - Batch delete with progress

**Project Operations**:
- `getProjects(archived?)` - List workspace projects
- `archiveProject(projectGid)` - Archive a project

**Section Operations**:
- `getSections(projectGid)` - List project sections
- `createSection(projectGid, name)` - Create a section

**User Operations**:
- `getCurrentUser()` - Get authenticated user info

## Development

### Adding New Tools

1. Import `AsanaClient`:
   ```typescript
   import { createAsanaClient } from './AsanaClient';
   ```

2. Create client instance:
   ```typescript
   const client = await createAsanaClient();
   ```

3. Use client methods:
   ```typescript
   const tasks = await client.getTasks(projectGid);
   ```

### Testing

Always use `--dry-run` mode first:

```bash
bun run YourTool.ts --dry-run
```

### Error Handling

All tools collect errors without stopping execution:

```typescript
try {
  await client.deleteTask(taskGid);
} catch (error) {
  console.error(`Failed: ${error}`);
  result.errors.push(error);
}
```

## Architecture

```
AsanaClient.ts (Foundation)
    ↓
    ├── BacklogBankruptcy.ts (One-time cleanup)
    ├── MyTasksOrganizer.ts (Daily automation)
    └── TaskMaintenance.ts (Weekly reports)
```

All tools use the shared `AsanaClient` for consistency and reusability.

## Security

- **Tokens**: Stored in `~/.claude/secrets.json` (gitignored)
- **Rate Limiting**: Automatic throttling to respect API limits
- **Dry-Run Mode**: Preview all changes before execution
- **Audit Trail**: Results saved to MEMORY for review

## Support

For issues or questions:
1. Check this README
2. Review tool help: `bun run <tool> --help`
3. Check `~/.claude/MEMORY/State/Asana/` for execution logs
4. Verify authentication with Asana API docs: https://developers.asana.com/

## Future Enhancements

- Custom field automation (Priority, Energy)
- Tag-based batch operations
- Workflow templates
- Calendar integration
- Slack/Discord notifications
- Web dashboard for health metrics

---

**Version**: 1.0.0
**Last Updated**: 2026-01-26
