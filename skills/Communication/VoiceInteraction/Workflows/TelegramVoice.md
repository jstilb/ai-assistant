# TelegramVoice Workflow

Generate voice replies to Telegram messages using local TTS (mlx-audio / Kokoro).

## Trigger
"voice reply", "respond with voice", "send voice to telegram"

## Steps

1. Generate text response via Inference
2. Convert to OGG audio via VoiceResponseGenerator
3. Send as voice message via TelegramClient

## Execution

```bash
# Generate voice audio
bun ~/.claude/skills/Communication/VoiceInteraction/Tools/VoiceResponseGenerator.ts telegram "Your response text" /tmp/voice-interaction/reply.ogg

# Send via Telegram
bun ~/.claude/skills/Communication/Telegram/Tools/TelegramClient.ts send-document /tmp/voice-interaction/reply.ogg "Voice reply from Kaya"
```

## Notes
- Integrates with existing Telegram bot for receiving voice messages
- Uses Gemini STT for incoming voice → text transcription
- Uses local TTS (mlx-audio Kokoro-82M) for outgoing text → voice generation
- Falls back to text reply if TTS fails
