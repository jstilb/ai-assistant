---
compressed_from: skills/CORE/CLI-INDEX.md
compressed_at: 2026-02-09T03:14:23.514Z
original_lines: 76
compressed_lines: 52
---

# Kaya CLI Tools (kaya-cli)

**Auto-loaded at session start.** Unix-style CLI tools for external services. All tools support `--json` output. Run `kaya-cli --help` for full list.

## Available Services

| Command | Purpose | Example |
|---------|---------|---------|
| `kaya-cli tasks` | Task management | `kaya-cli tasks --json` |
| `kaya-cli calendar` | Google Calendar | `kaya-cli gcal today` |
| `kaya-cli gmail` | Email operations | `kaya-cli gmail search "from:boss"` |
| `kaya-cli youtube` | Video download | `kaya-cli yt --dump-json URL` |
| `kaya-cli drive` | Google Drive sync | `kaya-cli drive ls remote:` |
| `kaya-cli weather` | Weather conditions | `kaya-cli weather "San Francisco"` |
| `kaya-cli places` | Location discovery | `kaya-cli places "coffee near me"` |
| `kaya-cli sheets` | Google Sheets | `kaya-cli sheets read SHEET_ID` |
| `kaya-cli github` | GitHub operations | `kaya-cli gh pr list` |
| `kaya-cli gh profile` | GitHub profile | `kaya-cli gh profile status --json` |
| `kaya-cli bluesky` | Bluesky social | `kaya-cli bsky post "Hello"` |
| `kaya-cli gemini` | Gemini AI | `kaya-cli gemini "query"` |
| `kaya-cli notebooklm` | NotebookLM | `kaya-cli nlm query "topic"` |
| `kaya-cli stripe` | Payments | `kaya-cli stripe customers list` |
| `kaya-cli supabase` | Database | `kaya-cli supabase db diff` |
| `kaya-cli firebase` | Firebase | `kaya-cli firebase deploy` |
| `kaya-cli slack` | Slack messaging | `kaya-cli slack "#channel" "msg"` |
| `kaya-cli op` | 1Password secrets | `kaya-cli op item get "API Key"` |
| `kaya-cli linear` | Linear issues | `kaya-cli linear issues --json` |
| `kaya-cli repl` | Interactive shell | `kaya-cli repl` |

## Common Patterns

**Piping JSON:** `kaya-cli tasks --json | jq '.[] | select(.due_on != null)'`

**Calendar:**
- `kaya-cli gcal today` / `week`
- `kaya-cli gcal add "Meeting" tomorrow 2pm 3pm`

**Email:**
- `kaya-cli gmail unread` / `search "is:starred"`
- `kaya-cli gmail send to@email.com "Subject" "Body"`

**Tasks:**
- `kaya-cli tasks --project "Project Name"`
- `kaya-cli linear issues --state "In Progress"`

**GitHub Profile:**
- `kaya-cli gh profile status` / `pins --json`
- `kaya-cli gh profile bio "New bio"`
- `kaya-cli gh profile topics repo t1 t2`
- `kaya-cli gh profile analytics repo --json`

**Full documentation:** `skills/UnixCLI/SKILL.md`