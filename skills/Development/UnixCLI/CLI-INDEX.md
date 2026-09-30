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
| `kaya-cli chrome` | Chrome browser (via chrome-cli) | `kaya-cli chrome tabs --json` |
| `kaya-cli stripe` | Payments | `kaya-cli stripe customers list` |
| `kaya-cli supabase` | Database | `kaya-cli supabase db diff` |
| `kaya-cli firebase` | Firebase | `kaya-cli firebase deploy` |
| `kaya-cli slack` | Slack messaging | `kaya-cli slack "#channel" "msg"` |
| `kaya-cli op` | 1Password secrets | `kaya-cli op item get "API Key"` |
| `kaya-cli linear` | Linear issues | `kaya-cli linear issues --json` |
| `kaya-cli gitlab` | GitLab operations | `kaya-cli gitlab mr list` |
| `kaya-cli playwright` | Browser automation (via Browse.ts) | `kaya-cli pw https://example.com` |
| `kaya-cli lifeos` | LifeOS habit/lead/WIG board | `kaya-cli lifeos board` |
| `kaya-cli sqlui` | Read-only SQL workbench for events.db | `kaya-cli sqlui` |
| `kaya-cli eventscout` | Browse/query SD events | `kaya-cli es query "comedy tonight"` |
| `kaya-cli repl` | Interactive shell | `kaya-cli repl` |
| `kaya-cli verify` | Verify plan completion | `kaya-cli verify plan.md` |

---

Not a `kaya-cli` subcommand but a related terminal tool: `obs` (standalone `obsidian-cli`
shell alias, configured in `~/.zshrc`, not routed through the dispatcher) — see
[Workflow](Workflows/Obsidian.md).

---

**Full documentation:** `skills/Development/UnixCLI/SKILL.md`
