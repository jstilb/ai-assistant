# VoiceInteraction: configuration, customization, setup, file structure

Moved out of `SKILL.md`. Sections: Configuration, Customization, Setup (requirements, dependencies), File Structure. Read it when you change settings, set up the machine or look for a file.

## Configuration

Voice settings from `settings.json`:
```json
{
  "daidentity": {
    "localVoice": {
      "id": "af_heart",
      "model": "kokoro",
      "speed": 1.1
    },
    "voice": {
      "stability": 0.35,
      "similarity_boost": 0.8,
      "style": 0.9,
      "volume": 0.8
    }
  }
}
```

Desktop mode settings (defaults):
```json
{
  "voiceInteraction": {
    "activation": "push-to-talk",
    "hotkey": "F13",
    "vadSensitivity": 0.5,
    "silenceThreshold": 1.5,
    "maxRecordingDuration": 120,
    "whisperModel": "base.en",
    "inferenceLevel": "standard",
    "autoPlayResponse": true
  }
}
```

Local TTS config (persisted via StateManager at `/tmp/voice-interaction/local-tts-config.json`):
```json
{
  "enabled": true,
  "serverUrl": "http://localhost:8880",
  "defaultModel": "kokoro",
  "defaultVoice": "af_heart",
  "defaultSpeed": 1.1,
  "timeoutMs": 15000,
  "totalRequests": 0,
  "totalFallbacks": 0,
  "lastUpdated": "2026-02-17T00:00:00.000Z"
}
```

| Setting | Default | Description |
|---------|---------|-------------|
| `enabled` | `true` | Whether local TTS is active; `false` falls back to macOS `say` |
| `serverUrl` | `http://localhost:8880` | mlx-audio server URL |
| `defaultModel` | `kokoro` | TTS model (kokoro, chatterbox, qwen3-tts) |
| `defaultVoice` | `af_heart` | Kokoro voice ID |
| `defaultSpeed` | `1.1` | Speech speed multiplier |
| `timeoutMs` | `15000` | Request timeout in ms |

## Customization

User-specific overrides live in `USER/SKILLCUSTOMIZATIONS/VoiceInteraction/`:

| File | Purpose |
|------|---------|
| `PREFERENCES.md` | Free-form voice preferences (loaded as context) |
| `config.json` | JSON overrides merged into VoiceInteractionConfig |

Configurable settings via `config.json`:

| Key | Type | Description |
|-----|------|-------------|
| `mode` | `"push-to-talk" \| "vad"` | Desktop activation mode |
| `whisperModel` | `string` | Whisper model for local STT (e.g. `"base.en"`, `"small.en"`) |
| `silenceThreshold` | `number` | VAD silence detection threshold |
| `silenceDuration` | `number` | Seconds of silence before end-of-speech |
| `inferenceLevel` | `"fast" \| "standard" \| "smart"` | LLM inference tier for voice responses |

Voice identity is configured in `settings.json` under `daidentity.localVoice` (voice ID, model, speed).

## Setup

### Requirements

```bash
# Audio recording
brew install sox

# Local transcription (managed by VoiceInput tool)
# faster-whisper via uv (auto-installed)

# Microphone permissions
# System Settings > Privacy & Security > Microphone > Terminal
```

### Dependencies

| Dependency | Status | Notes |
|------------|--------|-------|
| VoiceInput CORE tool | Exists | Local Whisper STT via sox + faster-whisper |
| Telegram skill | Exists | Two-way messaging with voice support |
| mlx-audio server | Running | Local TTS at localhost:8880 (Kokoro-82M) |
| Ollama | Running | STT polish via qwen2.5:1.5b at localhost:11434 |
| Gemini API | Configured | STT for Telegram voice messages |
| sox (brew) | Required | Audio recording on desktop |

## File Structure

```
skills/Communication/VoiceInteraction/
+-- SKILL.md                               # This file
+-- Tools/
|   +-- VoiceCommon.ts                     # Shared constants, config, schemas, state managers
|   +-- RealtimeVoiceServer.ts             # WebSocket server for real-time voice (port 8882)
|   +-- VoiceSystemPrompt.ts              # Voice-optimized system prompt builder
|   +-- RealtimeErrorHandler.ts           # Centralized error handling with spoken errors
|   +-- RealtimeHealthMonitor.ts          # Health checks, metrics, capacity management
|   +-- SentenceChunker.ts               # Streaming sentence boundary detection for TTS
|   +-- VoiceInputProcessor.ts             # STT processing (Whisper + Gemini)
|   +-- VoiceResponseGenerator.ts          # TTS via local mlx-audio (Kokoro)
|   +-- LocalTTSClient.ts                 # HTTP client for mlx-audio server
|   +-- STTPolishPipeline.ts              # Polish raw Whisper transcriptions via Ollama
|   +-- InterruptionHandler.ts             # Cancel in-flight responses
|   +-- ProactivePinger.ts                 # Event-driven voice outreach
|   +-- DesktopVoiceClient.ts              # Desktop client (batch + real-time modes)
|   +-- LocalTTSClient.test.ts             # Tests: Local TTS client
|   +-- STTPolishPipeline.test.ts          # Tests: STT polish pipeline
|   +-- DesktopVoiceClient.test.ts         # Tests: Desktop voice client
|   +-- InterruptionHandler.test.ts        # Tests: Interruption handler
|   +-- ProactivePinger.test.ts            # Tests: Proactive pinger
+-- WebApp/
|   +-- index.html                         # Telegram Mini App voice interface
+-- Workflows/
    +-- StartDesktop.md                    # Desktop voice mode workflow
    +-- TelegramVoice.md                   # Telegram voice reply workflow
    +-- ProactivePing.md                   # Proactive voice ping workflow

~/Library/LaunchAgents/
+-- com.kaya.realtime-voice.plist           # Auto-start real-time voice server
```
