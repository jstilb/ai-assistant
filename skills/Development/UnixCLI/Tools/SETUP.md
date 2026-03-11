# Asana Automation Setup Guide

Quick start guide for setting up the Asana automation suite.

## Step 1: Get Your Asana Personal Access Token

1. **Go to Asana Developer Console**:
   - Visit: https://app.asana.com/0/my-apps
   - Log in if needed

2. **Create New Token**:
   - Click "Create new token"
   - Name: `Kaya Automation`
   - Click "Create"

3. **Copy Token**:
   - **IMPORTANT**: Copy the token immediately
   - You won't be able to see it again
   - Save it temporarily somewhere safe

## Step 2: Add Token to Secrets File

1. **Open secrets file**:
   ```bash
   code ~/.claude/secrets.json
   ```
   (or use your preferred editor)

2. **Add Asana section**:
   ```json
   {
     "asana": {
       "personal_access_token": "PASTE_YOUR_TOKEN_HERE",
       "workspace_gid": "1204453550639466"
     }
   }
   ```

3. **Save and close**

## Step 3: Verify Setup

Test that authentication works:

```bash
cd ~/.claude/skills/Development/UnixCLI/Tools
bun run MyTasksOrganizer.ts --report
```

If you see your My Tasks summary, authentication is working!

## Step 4: Run Backlog Bankruptcy (One-Time)

**IMPORTANT**: Always dry-run first!

```bash
# Preview what will happen
bun run BacklogBankruptcy.ts --dry-run
```

Review the output carefully. When ready:

```bash
# Execute the cleanup
bun run BacklogBankruptcy.ts --execute
```

This will:
- Archive 3 legacy projects
- Delete 51 stale tasks
- Create Ideas sections
- Move 18 tasks to Ideas

## Step 5: Set Up Daily Automation (Optional)

Add to your morning routine or set up a cron job:

```bash
# Organize My Tasks by due dates
bun run MyTasksOrganizer.ts
```

Or automate with cron (run `crontab -e`):

```
# Daily at 9 AM
0 9 * * * cd ~/.claude/skills/Development/UnixCLI/Tools && bun run MyTasksOrganizer.ts
```

## Step 6: Weekly Health Reports (Optional)

Run every Monday or during weekly review:

```bash
bun run TaskMaintenance.ts check
```

This generates a health report showing:
- Stale backlog items (>90 days)
- Stuck in-progress tasks (>14 days)
- Project health scores

---

## Troubleshooting

### Error: "Secrets file not found"

Create `~/.claude/secrets.json`:

```bash
touch ~/.claude/secrets.json
code ~/.claude/secrets.json
```

Then add the asana section (see Step 2).

### Error: "Missing asana.personal_access_token"

You haven't added the `asana` section to your secrets file. See Step 2.

### Error: "My Tasks sections not found"

Your My Tasks needs these exact section names:
- `Prioritized (Monthly)`
- `In Progress (Weekly)`
- `Recently Assigned (Unassigned)`

Go to Asana and create them manually in your My Tasks.

### Error: 401 Unauthorized

Your token is invalid or expired. Generate a new one:
1. Go to https://app.asana.com/0/my-apps
2. Delete the old token
3. Create a new token
4. Update `~/.claude/secrets.json`

---

## Quick Reference

**Preview changes**:
```bash
bun run <tool> --dry-run
```

**Get help**:
```bash
bun run <tool> --help
```

**View results**:
```bash
ls -la ~/.claude/MEMORY/State/Asana/
ls -la ~/.claude/MEMORY/Reports/Asana/
```

---

**Next**: Read [README.md](./README.md) for detailed usage and API reference.
