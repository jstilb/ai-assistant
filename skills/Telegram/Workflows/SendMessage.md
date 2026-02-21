# SendMessage Workflow

Manual workflow for sending Telegram messages.

## Trigger

User says: "send telegram", "message me", "text me", "notify via telegram"

## Steps

### 1. Compose Message

Determine message content from user request. Support:
- Plain text
- Markdown formatting (`*bold*`, `_italic_`, `` `code` ``)
- Multi-line messages

### 2. Send via CLI

```bash
bun ~/.claude/skills/Telegram/Tools/TelegramClient.ts send "Your message"
```

### 3. Confirm Delivery

Report success or error to user.

## Examples

### Simple Message

User: "Send me a telegram saying the build is done"

```bash
bun ~/.claude/skills/Telegram/Tools/TelegramClient.ts send "Build complete!"
```

### With Formatting

User: "Message me the test results on telegram"

```bash
bun ~/.claude/skills/Telegram/Tools/TelegramClient.ts send "*Test Results*
✅ 47 passed
❌ 2 failed
⏱️ Duration: 12.3s"
```

### With Attachment

User: "Send me this screenshot on telegram"

```bash
bun ~/.claude/skills/Telegram/Tools/TelegramClient.ts send-photo /path/to/screenshot.png "Current state"
```

## Error Handling

| Error | Resolution |
|-------|------------|
| `bot_token not found` | User needs to set up bot and add to secrets.json |
| `chat_id not found` | User needs to message bot and run get-chat-id |
| `Network error` | Check internet connection |

## Notes

- Messages are one-way (send only)
- Bot cannot receive or process replies
- For interactive features, user should message bot directly
