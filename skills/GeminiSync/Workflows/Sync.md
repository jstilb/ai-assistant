# Sync Workflow

Syncs Kaya configuration from Claude Code to Gemini CLI.

## Trigger
- "sync gemini", "update gemini"
- "migrate to gemini", "setup gemini"

## Prerequisites

- Gemini CLI installed (`gemini --version`)
- Auth configured (`~/.gemini/oauth_creds.json` exists)

## Steps

### 1. Verify Claude Directory

```bash
[ -d ~/.claude ] || { echo "FAIL: ~/.claude not found"; exit 1; }
[ -f ~/.claude/settings.json ] || { echo "FAIL: Claude settings.json not found"; exit 1; }
```

### 2. Create/Update Symlinks

```bash
cd ~/.gemini

# Required symlinks (create if not exists)
[ -L hooks ] || ln -sf ~/.claude/hooks hooks
[ -L skills ] || ln -sf ~/.claude/skills skills
[ -L MEMORY ] || ln -sf ~/.claude/MEMORY MEMORY
[ -L bin ] || ln -sf ~/.claude/bin bin
# tools symlink is optional -- ~/.claude/tools may not exist yet
[ -d ~/.claude/tools ] && { [ -L tools ] || ln -sf ~/.claude/tools tools; } || echo "SKIP: ~/.claude/tools does not exist (optional)"
[ -L VoiceServer ] || ln -sf ~/.claude/VoiceServer VoiceServer
[ -L KAYASECURITYSYSTEM ] || ln -sf ~/.claude/KAYASECURITYSYSTEM KAYASECURITYSYSTEM
```

### 3. Generate GEMINI.md

Create `~/.gemini/GEMINI.md` with:
- Reference to skills/CORE/SKILL.md
- Reference to skills/_USERCONTEXT/SKILL.md
- Setup instructions for new users

### 4. Generate settings.json

Create `~/.gemini/settings.json` with:
- Hook event mappings (Claude → Gemini format)
- Kaya identity configuration
- Gemini CLI preferences

**Key mappings:**
| Claude Event | Gemini Event |
|--------------|--------------|
| PreToolUse | BeforeTool |
| PostToolUse | AfterTool |
| UserPromptSubmit | BeforeAgent |
| SessionStart | SessionStart |
| SessionEnd | SessionEnd |

### 5. Verify Installation

Run the Verify workflow to confirm success.

## Output

```
Sync complete.
- Symlinks: hooks, skills, MEMORY, bin, VoiceServer, KAYASECURITYSYSTEM (tools if ~/.claude/tools exists)
- Config: GEMINI.md, settings.json
- Version: gemini 0.26.0

Run 'gemini' to test.
```

## Notes

- Sync is incremental - only creates missing symlinks
- settings.json is regenerated each time (not merged)
- Use Reset workflow first if you want a clean slate
- **antigravity directory**: `~/.gemini/antigravity/` is Gemini CLI's internal cache (code_tracker, implicit context, knowledge). It is managed by Gemini CLI itself and should NOT be deleted during sync. The Reset workflow removes it as part of a clean slate -- if you want to preserve Gemini's learned context across resets, back it up first
