# Status Line

**Customize the Claude Code status line display.**

The status line appears at the bottom of your Claude Code interface, showing useful information at a glance.

---

## Configuration

The status line is configured in `settings.json`:

```json
{
  "statusLine": {
    "type": "command",
    "command": "${KAYA_DIR}/statusline-command.sh"
  }
}
```

---

## Default Status Line

Kaya's default status line shows:
- Kaya branding
- Current location (city, country)
- Weather conditions
- System metrics

---

## Customization

To customize the status line:

1. **Create your own script:**
   ```bash
   #!/bin/bash
   # ~/.claude/skills/CORE/USER/STATUSLINE/custom-statusline.sh

   echo "Your custom status info here"
   ```

2. **Make it executable:**
   ```bash
   chmod +x custom-statusline.sh
   ```

3. **Update settings.json:**
   ```json
   {
     "statusLine": {
       "type": "command",
       "command": "${KAYA_DIR}/skills/CORE/USER/STATUSLINE/custom-statusline.sh"
     }
   }
   ```

---

## Example Custom Status Lines

### Minimal
```bash
#!/bin/bash
echo "Kaya | $(date '+%H:%M')"
```

### With Git Info
```bash
#!/bin/bash
branch=$(git branch --show-current 2>/dev/null || echo "no-repo")
echo "Kaya | $branch | $(date '+%H:%M')"
```

### With System Stats
```bash
#!/bin/bash
cpu=$(top -l 1 | grep "CPU usage" | awk '{print $3}')
echo "Kaya | CPU: $cpu | $(date '+%H:%M')"
```

---

## Available Information

You can include any of these in your status line:
- Date/time
- Git branch/status
- Current directory
- System metrics (CPU, memory)
- Weather (requires API)
- Custom project info

---

*Place custom scripts in this directory and reference them in settings.json.*
