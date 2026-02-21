# Reset Workflow

Resets the .gemini directory to a clean state, preserving authentication files.

## Trigger
- "reset gemini", "clean gemini setup"
- "gemini not working", "fix gemini hooks"

## Steps

1. **Backup Auth Files**
   ```bash
   # These files are preserved in place (not deleted)
   # - oauth_creds.json (Google OAuth)
   # - google_accounts.json (Account config)
   # - installation_id (CLI installation ID)
   # - state.json (CLI state)
   ```

2. **Remove Old Customizations**
   ```bash
   cd ~/.gemini
   rm -rf hooks settings.json tmp policies antigravity statusline*.sh CLAUDE.md GEMINI.md 2>/dev/null
   ```

3. **Create Symlinks**
   ```bash
   cd ~/.gemini
   ln -sf ~/.claude/hooks hooks
   # Other symlinks should already exist from initial setup:
   # - skills -> ~/.claude/skills
   # - MEMORY -> ~/.claude/MEMORY
   # - bin -> ~/.claude/bin
   # - tools -> ~/.claude/tools (optional -- target may not exist)
   # - VoiceServer -> ~/.claude/VoiceServer
   # - KAYASECURITYSYSTEM -> ~/.claude/KAYASECURITYSYSTEM
   ```

4. **Create GEMINI.md**
   - Write the Gemini context file pointing to CORE skill
   - Use the template from SKILL.md architecture section

5. **Create settings.json**
   - Map Claude hook events to Gemini hook events
   - Use absolute paths to hooks in ~/.claude/hooks/
   - Include Kaya identity configuration (daidentity, principal)

## Output

```
Reset complete. .gemini directory cleaned and synced with .claude.
Preserved: oauth_creds.json, google_accounts.json, installation_id, state.json
Created: hooks symlink, GEMINI.md, settings.json
```

## Notes

- Always backup auth files first
- Symlinks point to .claude as source of truth
- settings.json uses Gemini hook event names (BeforeTool, AfterTool, etc.)
