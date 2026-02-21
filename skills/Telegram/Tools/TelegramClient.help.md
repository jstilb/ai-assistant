# TelegramClient.ts

Telegram Bot API client for Kaya mobile notifications.

## Usage

```bash
bun ~/.claude/skills/Telegram/Tools/TelegramClient.ts <command> [options]
```

## Commands

| Command | Description |
|---------|-------------|
| `send <message>` | Send text message (supports Markdown) |
| `send-photo <path> [caption]` | Send image with optional caption |
| `send-document <path> [caption]` | Send file with optional caption |
| `get-chat-id` | Discover your chat ID after messaging bot |

## Examples

```bash
# Send simple message
bun TelegramClient.ts send "Build complete!"

# Send with Markdown formatting
bun TelegramClient.ts send "*Success!* All tests passing."

# Send screenshot
bun TelegramClient.ts send-photo ./screenshot.png "Current state"

# Send log file
bun TelegramClient.ts send-document ./build.log "Build output"

# Get your chat ID (setup step)
bun TelegramClient.ts get-chat-id
```

## Configuration

Requires `telegram` section in `~/.claude/secrets.json`:

```json
{
  "telegram": {
    "bot_token": "123456789:ABCdefGHIjklMNOpqrsTUVwxyz",
    "chat_id": "123456789"
  }
}
```

## Markdown Support

Messages support Telegram Markdown:
- `*bold*` → **bold**
- `_italic_` → *italic*
- `` `code` `` → `code`
- `[link](url)` → hyperlink

## Exit Codes

| Code | Meaning |
|------|---------|
| 0 | Success |
| 1 | Error (missing config, network failure, etc.) |

## See Also

- Skill: `~/.claude/skills/Telegram/SKILL.md`
- Workflow: `~/.claude/skills/Telegram/Workflows/SendMessage.md`
