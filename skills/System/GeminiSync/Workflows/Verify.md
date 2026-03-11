# Verify Workflow

Verifies that Gemini CLI is properly configured for Kaya usage.

## Trigger
- "verify gemini", "check gemini setup"
- "is gemini configured"

## Checks

### 1. Directory Check
```bash
[ -d ~/.gemini ] && echo "PASS: .gemini directory exists" || echo "FAIL: .gemini directory missing"
```

### 2. Symlinks Check
```bash
# Required symlinks
ls -la ~/.gemini/hooks ~/.gemini/skills ~/.gemini/MEMORY ~/.gemini/bin ~/.gemini/VoiceServer

# Optional symlinks (target may not exist)
[ -L ~/.gemini/tools ] && [ -d ~/.gemini/tools ] && echo "PASS: tools symlink valid" || echo "INFO: tools symlink broken or missing (optional -- ~/.claude/tools may not exist)"
```

Expected:
- `hooks -> ~/.claude/hooks`
- `skills -> ~/.claude/skills`
- `MEMORY -> ~/.claude/MEMORY`
- `bin -> ~/.claude/bin`
- `VoiceServer -> ~/.claude/VoiceServer`
- `tools -> ~/.claude/tools` (optional -- target may not exist)

### 3. Config Files Check
```bash
# Required files
[ -f ~/.gemini/GEMINI.md ] && echo "PASS: GEMINI.md exists"
[ -f ~/.gemini/settings.json ] && echo "PASS: settings.json exists"
[ -f ~/.gemini/oauth_creds.json ] && echo "PASS: OAuth credentials exist"
```

### 4. Settings Validation
```bash
# Check hooks are configured
jq '.hooks.SessionStart' ~/.gemini/settings.json
jq '.hooks.BeforeTool' ~/.gemini/settings.json
jq '.hooksConfig.enabled' ~/.gemini/settings.json
```

### 5. Hook Executability
```bash
# Check critical hooks are executable
for hook in StartupGreeting LoadContext SecurityValidator; do
  [ -x ~/.claude/hooks/${hook}.hook.ts ] && echo "PASS: $hook executable"
done
```

### 6. Version Check
```bash
gemini --version
```

Expected: 0.26.0 or higher

## Output

```
Gemini CLI Verification Report
==============================
[PASS] .gemini directory exists
[PASS] Symlinks valid: hooks, skills, MEMORY, bin, VoiceServer (tools optional)
[PASS] GEMINI.md exists
[PASS] settings.json exists
[PASS] OAuth credentials present
[PASS] Hooks enabled in settings
[PASS] SessionStart hooks configured (3 hooks)
[PASS] BeforeTool hooks configured (3 matchers)
[PASS] Critical hooks executable
[PASS] Gemini CLI version: 0.26.0

Result: 10/10 checks passed
```

## Notes

- Run this after Reset workflow to confirm success
- Use `gemini` to test actual CLI behavior
- Check Gemini CLI logs at `~/.gemini/logs/` if hooks fail
