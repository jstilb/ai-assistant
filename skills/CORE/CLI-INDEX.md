# Kaya CLI Tools (kaya-cli)

**Auto-loaded at session start.** Unix-style CLI tools for external services.

All tools support `--json` output for piping. Run `kaya-cli --help` for full list.

---

## Available Services

| Command | Purpose | Example |
|---------|---------|---------|
| `kaya-cli tasks` | Task management (LucidTasks) | `kaya-cli tasks --json` |
| `kaya-cli calendar` | Google Calendar | `kaya-cli gcal today` |
| `kaya-cli gmail` | Email operations | `kaya-cli gmail search "from:boss"` |
| `kaya-cli youtube` | Video download | `kaya-cli yt --dump-json URL` |
| `kaya-cli drive` | Google Drive sync | `kaya-cli drive ls remote:` |
| `kaya-cli weather` | Weather conditions | `kaya-cli weather "San Francisco"` |
| `kaya-cli places` | Location discovery | `kaya-cli places "coffee near me"` |
| `kaya-cli sheets` | Google Sheets | `kaya-cli sheets read SHEET_ID` |
| `kaya-cli github` | GitHub operations | `kaya-cli gh pr list` |
| `kaya-cli gh profile` | GitHub profile management | `kaya-cli gh profile status --json` |
| `kaya-cli bluesky` | Bluesky social | `kaya-cli bsky post "Hello"` |
| `kaya-cli gemini` | Gemini AI | `kaya-cli gemini "query"` |
| `kaya-cli notebooklm` | NotebookLM | `kaya-cli nlm query "topic"` |
| `kaya-cli toon` | JSON <-> TOON conversion | `kaya-cli toon encode data.json` |
| `kaya-cli stripe` | Payments | `kaya-cli stripe customers list` |
| `kaya-cli supabase` | Database | `kaya-cli supabase db diff` |
| `kaya-cli firebase` | Firebase | `kaya-cli firebase deploy` |
| `kaya-cli slack` | Slack messaging | `kaya-cli slack "#channel" "msg"` |
| `kaya-cli op` | 1Password secrets | `kaya-cli op item get "API Key"` |
| `kaya-cli linear` | Linear issues | `kaya-cli linear issues --json` |
| `kaya-cli repl` | Interactive shell | `kaya-cli repl` |

---

## Common Patterns

### Piping JSON Output
```bash
kaya-cli tasks --json | jq '.[] | select(.due_date != null)'
```

### Calendar Operations
```bash
kaya-cli gcal today                    # Today's events
kaya-cli gcal week                     # This week
kaya-cli gcal add "Meeting" tomorrow 2pm 3pm
```

### Email Operations
```bash
kaya-cli gmail unread                  # Unread messages
kaya-cli gmail search "is:starred"    # Starred messages
kaya-cli gmail send to@email.com "Subject" "Body"
```

### Task Management
```bash
kaya-cli tasks --json                              # List all tasks as JSON
kaya-cli tasks add "Task name"                     # Add new task to inbox
kaya-cli lt stats                                  # Task statistics
kaya-cli linear issues --state "In Progress"
```

### TOON Format Conversion
```bash
kaya-cli toon encode data.json              # JSON file → TOON
cat data.json | kaya-cli toon encode        # Pipe JSON → TOON
kaya-cli toon decode data.toon -p           # TOON → pretty JSON
kaya-cli toon stats data.json               # Show token savings
kaya-cli tasks --json | kaya-cli toon encode        # Pipe from other CLIs
```

### GitHub Profile
```bash
kaya-cli gh profile status                    # Full profile overview
kaya-cli gh profile pins --json               # Pinned repos as JSON
kaya-cli gh profile bio "New bio"             # Update bio
kaya-cli gh profile topics repo t1 t2         # Set repo topics
kaya-cli gh profile analytics repo --json     # Traffic analytics
```

---

**Full documentation:** `skills/UnixCLI/SKILL.md`
