---
name: Telegram
description: Two-way Telegram messaging with Kaya. Text and voice messages are processed by Claude with Kaya context. USE WHEN send telegram, telegram message, message me, notify mobile, text me, mobile notification, OR telegram.
---
# Telegram

Two-way Telegram integration with Kaya. Send and receive messages via Telegram, including voice transcription.

## Architecture

```
User sends message/voice/image → Telegram API → Long Polling → TelegramBot.ts
                                                                   ↓
                                                  ┌────────────────┼────────────────┐
                                                  │                │                │
                                              Text handler    Voice handler    Image handler
                                                  │                │                │
                                                  │          Gemini STT        Gemini Vision
                                                  │                │                │
                                                  └────────┬───────┘────────────────┘
                                                           ↓
                                               Sanitize input (Sanitizer.ts)
                                                           ↓
                                               TelegramGateway pipeline:
                                                 1. Load session (SessionManager)
                                                 2. Inject context (ContextInjector)
                                                 3. Claude CLI inference
                                                 4. Capture learning (LearningCapture)
                                                 5. Generate TTS (VoiceResponder)
                                                           ↓
                                               Sanitize output (scrub credentials)
                                                           ↓
                                               Split + send → Telegram
```

## Features

- **Text Messages**: Send text → Claude responds with Kaya context
- **Voice Messages**: Voice → Gemini transcription → Claude response
- **Conversation Memory**: Persists context across messages (last 20 messages loaded)
- **Persistent Service**: Auto-starts on login via launchd
- **Security**: Only responds to authorized chat ID

## Voice Notification

Use `notifySync()` from `skills/CORE/Tools/NotificationService.ts`

## Workflow Routing

| Workflow | Trigger | File |
|----------|---------|------|
| **SendMessage** | "send telegram", "message me" | `Workflows/SendMessage.md` |

## Quick Reference

### Start/Stop Bot

```bash
# Via CLI wrapper
telegram-bot start          # Start bot
telegram-bot stop           # Stop bot
telegram-bot status         # Check status
telegram-bot logs           # Tail logs

# Via launchd (persistent)
launchctl load ~/Library/LaunchAgents/com.pai.telegram-bot.plist
launchctl unload ~/Library/LaunchAgents/com.pai.telegram-bot.plist
```

### Send Messages (Outbound)

```bash
# Send text
bun ~/.claude/skills/Telegram/Tools/TelegramClient.ts send "Your message here"

# Send photo
bun ~/.claude/skills/Telegram/Tools/TelegramClient.ts send-photo /path/to/image.png "Caption"

# Send document
bun ~/.claude/skills/Telegram/Tools/TelegramClient.ts send-document /path/to/file.pdf "Caption"
```

### Telegram Commands (From Mobile)

| Command | Description |
|---------|-------------|
| `/start` | Welcome message |
| `/help` | Show available commands |
| `/status` | Bot uptime and status |

## Examples

**Example 1: Text conversation**
```
User (Telegram): "What's on my calendar today?"
→ TelegramBot receives message
→ Claude processes with Kaya context
→ Kaya: "You have 3 meetings today..."
```

**Example 2: Voice message**
```
User (Telegram): [Voice note: "Remind me to check the deployment"]
→ TelegramBot downloads OGG audio
→ Gemini transcribes: "Remind me to check the deployment"
→ Claude responds with confirmation
→ Kaya: "🎤 *Jm said:* 'Remind me to check the deployment'\n\nI'll make a note..."
```

**Example 3: Send notification from Kaya**
```
User: "Message me when the build is done"
→ After build completes
→ TelegramClient.ts send "Build completed successfully"
→ User receives Telegram notification on mobile
```

## Setup

### 1. Create Telegram Bot

1. Open Telegram and message [@BotFather](https://t.me/BotFather)
2. Send `/newbot`
3. Choose a name (e.g., "Kaya Notifications")
4. Choose a username (must end in `bot`, e.g., `kaya_notifications_bot`)
5. Save the bot token BotFather provides

### 2. Get Your Chat ID

1. Message your new bot (say anything)
2. Run: `bun ~/.claude/skills/Telegram/Tools/TelegramClient.ts get-chat-id`
3. Copy the chat ID from output

### 3. Configure secrets.json

Add to `~/.claude/secrets.json`:

```json
{
  "telegram": {
    "bot_token": "123456789:ABCdefGHIjklMNOpqrsTUVwxyz",
    "chat_id": "123456789"
  }
}
```

### 4. Start the Bot

```bash
# Manual start
telegram-bot start

# Or enable persistent service
launchctl load ~/Library/LaunchAgents/com.pai.telegram-bot.plist
```

## File Structure

```
skills/Telegram/
├── SKILL.md                    # This file
├── Tools/
│   ├── TelegramClient.ts       # Outbound messaging CLI
│   ├── TelegramConfig.ts       # Shared config (secrets + settings)
│   └── TelegramFormatting.ts   # Shared message formatting utilities
├── Server/
│   ├── TelegramBot.ts          # Main bot server (routing + reply)
│   ├── memory.ts               # DEPRECATED - Legacy conversation persistence
│   ├── package.json            # Dependencies (telegraf)
│   ├── handlers/
│   │   ├── text.ts             # Text message handler (gateway pipeline)
│   │   ├── voice.ts            # Voice transcription handler (Gemini STT)
│   │   └── image.ts            # Image handler (download + Gemini Vision)
│   └── gateway/
│       ├── KayaMobileGateway.ts    # Interface + types
│       ├── TelegramGateway.ts      # Pipeline: session → context → Claude → learning
│       ├── SessionManager.ts       # Persistent sessions (JSONL + auto-summarize)
│       ├── ContextInjector.ts      # ContextManager bridge for mobile
│       ├── LearningCapture.ts      # Rating/sentiment signal capture
│       ├── VoiceResponder.ts       # TTS voice response (mlx-audio/ElevenLabs)
│       └── Sanitizer.ts           # Input/output sanitization
└── Workflows/
    └── SendMessage.md          # Outbound workflow

MEMORY/TELEGRAM/                # Conversation storage
├── context.md                  # Rolling context summary (legacy)
├── conversations/              # Daily JSONL logs (legacy)
│   └── YYYY-MM-DD.jsonl
└── sessions/                   # Persistent sessions (current)
    ├── {id}.jsonl              # Exchange log per session
    ├── {id}-meta.json          # Session metadata
    └── {id}-summary.md         # Auto-generated summary
```

## Conversation Memory

The bot uses **SessionManager** for persistent multi-day sessions with auto-summarization:

**Storage:**
- `MEMORY/TELEGRAM/sessions/{id}.jsonl` - Exchange log per session
- `MEMORY/TELEGRAM/sessions/{id}-meta.json` - Session metadata (profile, exchange count)
- `MEMORY/TELEGRAM/sessions/{id}-summary.md` - Auto-generated summary of older exchanges

**How it works:**
1. On each message, `SessionManager.loadSession()` loads or creates a session
2. If idle > 6 hours, a new session segment is created (history preserved)
3. `ContextInjector` classifies intent and builds a system prompt with personality + session context
4. After Claude responds, `recordExchange()` appends to JSONL and updates metadata
5. Every 20 exchanges, older messages are auto-summarized via Claude (Haiku)
6. `LearningCapture` detects ratings/sentiment and writes to `MEMORY/LEARNING/SIGNALS/`

**Limits:**
- 30 recent exchanges in memory (older ones summarized)
- 200 exchanges max before forced summarization
- New session segment after 6h idle
- 4000 token budget for mobile system prompt

**Legacy:** `memory.ts` (Moltbot-style JSONL) is deprecated but retained as fallback

## Security

- Bot token stored in gitignored `secrets.json`
- Chat ID ensures messages only go to authorized recipient
- Voice messages processed locally via Gemini API
- Claude API calls use Kaya OAuth token
- Conversation logs stored locally in MEMORY/TELEGRAM/

## Troubleshooting

**Bot not responding**
→ Check status: `telegram-bot status`
→ Check logs: `telegram-bot logs`

**"telegram.bot_token not found"**
→ Add telegram section to `~/.claude/secrets.json`

**Voice transcription failing**
→ Verify `GEMINI_API_KEY` in secrets.json
→ Check logs for Gemini API errors

**Bot stops after reboot**
→ Load launchd agent: `launchctl load ~/Library/LaunchAgents/com.pai.telegram-bot.plist`

## Integration

### Uses
- `~/.claude/secrets.json` - Bot token, chat ID, API keys
- `~/.claude/settings.json` - Identity (Kaya name, principal name)
- `MEMORY/TELEGRAM/` - Conversation persistence
- Gemini API - Voice transcription
- Claude CLI - Response generation (uses subscription, not API key)

### Feeds Into
- Mobile notification system
- Background agent completion alerts
- Kaya proactive messaging
- Conversation memory for context persistence

### MCPs Used
- None (direct HTTP to Telegram/Gemini APIs, Claude via CLI)
