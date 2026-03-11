---
name: GeminiSync
description: Sync Kaya infrastructure from Claude Code to Gemini CLI. USE WHEN migrate to gemini, setup gemini, sync gemini, gemini hooks, update gemini config, gemini not working.
---

# GeminiSync Skill

Synchronizes Kaya (Personal AI Infrastructure) configuration from Claude Code (`~/.claude`) to Gemini CLI (`~/.gemini`). Uses a symlink-based approach to share resources while maintaining Gemini-specific configuration.

## Voice Notification

→ Use `notifySync()` from `lib/core/NotificationService.ts`

---

## Architecture

### Symlink Strategy

The .gemini directory uses symlinks to share resources with .claude:

| Symlinked (Shared) | Description |
|-------------------|-------------|
| `hooks/` | Lifecycle event handlers (same hooks work in both) |
| `skills/` | Skill modules |
| `MEMORY/` | Session history, learnings |
| `bin/` | Executable scripts |
| `tools/` | CLI utilities (optional -- target may not exist) |
| `VoiceServer/` | Voice synthesis service |
| `KAYASECURITYSYSTEM/` | Security framework |

### Gemini-Specific Files

| File | Description |
|------|-------------|
| `GEMINI.md` | Context file for Gemini CLI (equivalent to CLAUDE.md) |
| `settings.json` | Gemini CLI configuration with hook mappings |
| `oauth_creds.json` | Google OAuth credentials (preserved during reset) |
| `google_accounts.json` | Google account config (preserved during reset) |
| `installation_id` | Gemini CLI installation ID (preserved) |
| `state.json` | Gemini CLI state (preserved) |

### Hook Event Mapping

| Claude Code | Gemini CLI | Description |
|-------------|------------|-------------|
| `PreToolUse` | `BeforeTool` | Before tool execution |
| `PostToolUse` | `AfterTool` | After tool execution |
| `UserPromptSubmit` | `BeforeAgent` | Before agent loop starts |
| `SessionStart` | `SessionStart` | Session initialization |
| `SessionEnd` | `SessionEnd` | Session cleanup |

### Tool Matcher Mapping

| Claude Tool | Gemini Tool |
|-------------|-------------|
| `Bash` | `run_shell_command` |
| `Edit`, `Write` | `write_file` |
| `Read` | `read_file` |
| `Glob` | `glob` |
| `Grep` | `search_file_content` |

---

## Workflow Routing

| Workflow | Trigger | File |
|----------|---------|------|
| **Reset** | "reset gemini", "clean gemini setup" | `Workflows/Reset.md` |
| **Sync** | "sync gemini", "update gemini" | `Workflows/Sync.md` |
| **Verify** | "verify gemini", "check gemini setup" | `Workflows/Verify.md` |

---

## When to Activate This Skill

### Reset Triggers
- "reset gemini", "clean gemini setup"
- "gemini not working", "fix gemini hooks"

### Sync Triggers
- "sync gemini", "update gemini"
- "migrate to gemini", "setup gemini"

### Verify Triggers
- "verify gemini", "check gemini"
- "is gemini configured"

---

## Quick Start

### Full Reset and Sync (Recommended)

1. **Backup auth files** (preserved automatically)
2. **Remove old customizations**:
   ```bash
   cd ~/.gemini && rm -rf hooks settings.json tmp policies antigravity statusline*.sh CLAUDE.md GEMINI.md
   ```
3. **Create symlink for hooks**:
   ```bash
   ln -sf ~/.claude/hooks ~/.gemini/hooks
   ```
4. **Create GEMINI.md** - Points to CLAUDE.md
5. **Create settings.json** - Maps Claude hooks to Gemini hook events

### Manual Verification

```bash
# Check symlinks are correct
ls -la ~/.gemini/

# Verify hooks are accessible
ls -la ~/.gemini/hooks/

# Test Gemini CLI
gemini --version
```

---

## Customization

| Option | Default | Description |
|--------|---------|-------------|
| **Sync frequency** | Manual (on demand) | How often to re-sync; run Sync workflow after any Kaya structural change |
| **Symlinks to maintain** | hooks, skills, MEMORY, bin, VoiceServer, KAYASECURITYSYSTEM | Core set; `tools` is optional (only if `~/.claude/tools` exists) |
| **Hook translation mappings** | See Hook Event Mapping table above | Override in `settings.json` if Gemini CLI introduces new event names |
| **Tool matcher mappings** | See Tool Matcher Mapping table above | Override in `settings.json` if Gemini CLI renames tools |
| **Preserved auth files** | oauth_creds.json, google_accounts.json, installation_id, state.json | Files never deleted during Reset workflow |
| **Clean antigravity on reset** | No (Gemini-managed) | Set to Yes in Reset workflow if stale; see Troubleshooting |

---

## Gemini CLI Versions

- **v0.26.0** (Current) - Agent Skills, Gemini 3 models
- Built-in `gemini hooks migrate --from-claude` command available

---

## Examples

**Example 1: Reset and sync**
```
User: "reset gemini and sync with claude"
→ Invokes Reset workflow
→ Preserves auth files (oauth_creds.json, google_accounts.json)
→ Removes old hooks and settings
→ Creates symlinks
→ Writes new settings.json with hook mappings
→ Reports: "Gemini CLI synced with Claude Code"
```

**Example 2: Verify setup**
```
User: "is gemini configured correctly"
→ Invokes Verify workflow
→ Checks symlinks exist and are valid
→ Verifies settings.json has correct hook mappings
→ Tests hook executability
→ Reports: "PASS: All 8 checks passed"
```

---

## Integration

### Uses
- **~/.claude/** - Source of truth for Kaya configuration
- **Filesystem** - Symlink management
- **Gemini CLI** - Target installation

### Feeds Into
- **Gemini CLI** - Configured for Kaya usage
- **Shared MEMORY** - Both CLIs use same memory store

### MCPs Used
- None (filesystem operations only)

---

## Troubleshooting

### Hooks not firing
1. Check `hooksConfig.enabled` is `true` in settings.json
2. Verify symlink: `ls -la ~/.gemini/hooks`
3. Check hook files are executable: `ls -la ~/.claude/hooks/*.ts`

### Auth issues
1. Re-authenticate: `gemini` and select "Login with Google"
2. Check oauth_creds.json exists

### Skill not loading
1. Verify skills symlink: `ls -la ~/.gemini/skills`
2. Check GEMINI.md points to CORE skill

### Stale antigravity directory
The `~/.gemini/antigravity/` directory is Gemini CLI's internal cache (code_tracker, brain, implicit context, knowledge). It is managed by Gemini CLI, not by this skill. The Reset workflow removes it as part of a clean slate. If Gemini CLI behaves unexpectedly after a reset, the antigravity cache will rebuild automatically on next use.

---

**This skill enables seamless Kaya usage across both Claude Code and Gemini CLI.**
