---
name: VoiceInteraction
description: Bidirectional voice interaction system with real-time and batch modes. Mobile (Telegram), desktop (local mic/speaker), and real-time WebSocket. USE WHEN voice conversation, talk to Kaya, voice mode, voice chat, speak to Kaya, desktop voice, voice interaction, push to talk, hands free, real-time voice.
---
# VoiceInteraction

Bidirectional voice interaction enabling voice conversations with Kaya from mobile (Telegram), desktop (local microphone/speaker), and real-time WebSocket (low-latency). Two pipeline modes: batch (sequential STT/LLM/TTS) and real-time (streaming via WebSocket on port 8882). Supports Kaya personality injection, between-turn interruption, proactive pinging, and multi-turn conversational flow.

## Architecture

```
REAL-TIME (WebSocket - port 8882):
[Desktop Mic / Telegram Mini App] --> WebSocket --> RealtimeVoiceServer
    --> mlx-whisper STT (localhost:8881)
    --> Gemini 2.0 Flash (with Kaya voice system prompt)
    --> Sentence chunking --> mlx-audio TTS (localhost:8880)
    |-- ON TTS FAILURE --> macOS `say` fallback --> text-only fallback
    --> WebSocket audio response --> Speakers
    Auto-start: launchd (com.pai.realtime-voice.plist)
    Health: http://localhost:8882/health

BATCH - MOBILE (Telegram):
[Voice Message] --> Telegram Bot --> VoiceInputProcessor (Gemini STT)
    --> Inference (standard) --> VoiceResponseGenerator (Local TTS)
    --> Telegram Voice Reply --> [User Hears Response]

BATCH - DESKTOP:
[Microphone Input] --> DesktopVoiceClient (push-to-talk / VAD)
    --> VoiceInputProcessor (local Whisper STT + Polish Pipeline)
    --> Inference --> VoiceResponseGenerator (Local TTS)
    --> Speaker Output --> [User Hears Response]

TTS PIPELINE (inside VoiceResponseGenerator):
[Text] --> LocalTTSClient (HTTP to mlx-audio at localhost:8880)
    --> [Audio Buffer] --> afplay
    |-- ON FAILURE --> macOS `say` fallback

STT POLISH PIPELINE (inside VoiceInputProcessor):
[Raw Whisper Text] --> STTPolishPipeline
    --> dictation:latest (fine-tuned) --> qwen2.5:1.5b (base) --> Claude API --> raw
    --> Word overlap validation
    --> Save raw/polished pair for nightly training

BETWEEN-TURN INTERRUPTION (both channels):
[New Input Detected] --> InterruptionHandler --> Cancel current TTS/Inference
    --> Re-process with accumulated context --> New response

PROACTIVE:
[Trigger Event] --> ProactivePinger --> Generate message
    --> VoiceResponseGenerator --> Push via active channel
```

## Voice Notification

Before any action, send voice notification:
```bash
curl -s -X POST http://localhost:8888/notify \
  -H "Content-Type: application/json" \
  -d '{"message": "Starting voice interaction..."}'
```

## Workflow Routing

| Workflow | Trigger | File |
|----------|---------|------|
| **StartDesktop** | "voice mode", "start voice", "talk to me" | `Workflows/StartDesktop.md` |
| **TelegramVoice** | "voice reply", "respond with voice" | `Workflows/TelegramVoice.md` |
| **ProactivePing** | "ping me", "proactive voice" | `Workflows/ProactivePing.md` |

## Components

| Component | Purpose | Location |
|-----------|---------|----------|
| **RealtimeVoiceServer** | WebSocket server for real-time voice (STT/LLM/TTS pipeline) | `Tools/RealtimeVoiceServer.ts` |
| **VoiceSystemPrompt** | Builds voice-optimized system prompt from DAIDENTITY.md | `Tools/VoiceSystemPrompt.ts` |
| **RealtimeErrorHandler** | Centralized error handling with spoken error messages | `Tools/RealtimeErrorHandler.ts` |
| **RealtimeHealthMonitor** | Session tracking, memory monitoring, /health endpoint | `Tools/RealtimeHealthMonitor.ts` |
| **SentenceChunker** | Streaming sentence boundary detection for TTS chunking | `Tools/SentenceChunker.ts` |
| **VoiceInputProcessor** | Processes incoming voice (STT via Whisper/Gemini) | `Tools/VoiceInputProcessor.ts` |
| **VoiceResponseGenerator** | Generates voice responses (Local mlx-audio TTS) | `Tools/VoiceResponseGenerator.ts` |
| **LocalTTSClient** | HTTP client for mlx-audio server (Kokoro-82M) with macOS say fallback | `Tools/LocalTTSClient.ts` |
| **STTPolishPipeline** | Polishes raw Whisper transcriptions via Ollama/Claude with training pair collection | `Tools/STTPolishPipeline.ts` |
| **VoiceCommon** | Shared constants, config, secrets, schemas, and StateManager instances | `Tools/VoiceCommon.ts` |
| **InterruptionHandler** | Detects and handles between-turn interruptions | `Tools/InterruptionHandler.ts` |
| **ProactivePinger** | Triggers proactive voice outreach on events | `Tools/ProactivePinger.ts` |
| **DesktopVoiceClient** | Local mic/speaker interface (batch, VAD, and real-time modes) | `Tools/DesktopVoiceClient.ts` |

## Channels

| Channel | Mode | Activation | Best For |
|---------|------|-----------|----------|
| **Real-time (Desktop)** | WebSocket streaming | `--mode=realtime` | Lowest latency, natural conversation |
| **Telegram Mini App** | WebSocket via tunnel | Open Mini App | Mobile real-time voice |
| **Telegram** | Voice messages (async) | Send voice note | Mobile, on-the-go |
| **Desktop Batch** | Sequential mic/speaker | Push-to-talk or VAD | Offline/fallback |

## Quick Reference

### Real-Time Voice Mode (Recommended)

```bash
# Start real-time voice (WebSocket to port 8882, auto-fallback to batch)
bun ~/.claude/skills/Communication/VoiceInteraction/Tools/DesktopVoiceClient.ts start --mode=realtime

# Check real-time server health
bun ~/.claude/skills/Communication/VoiceInteraction/Tools/RealtimeHealthMonitor.ts status

# Preview voice system prompt (Kaya personality)
bun ~/.claude/skills/Communication/VoiceInteraction/Tools/VoiceSystemPrompt.ts preview

# Test error handling
bun ~/.claude/skills/Communication/VoiceInteraction/Tools/RealtimeErrorHandler.ts test

# Start/stop real-time server manually (normally auto-started via launchd)
bun ~/.claude/skills/Communication/VoiceInteraction/Tools/RealtimeVoiceServer.ts
```

### Desktop Voice Mode (Batch Pipeline)

```bash
# Start desktop voice (push-to-talk mode)
bun ~/.claude/skills/Communication/VoiceInteraction/Tools/DesktopVoiceClient.ts start

# Start with VAD (always-listening)
bun ~/.claude/skills/Communication/VoiceInteraction/Tools/DesktopVoiceClient.ts start --mode=vad

# Stop desktop voice
bun ~/.claude/skills/Communication/VoiceInteraction/Tools/DesktopVoiceClient.ts stop

# Check status
bun ~/.claude/skills/Communication/VoiceInteraction/Tools/DesktopVoiceClient.ts status
```

### Voice Response Generation

```bash
# Generate and play via local TTS (mlx-audio)
bun ~/.claude/skills/Communication/VoiceInteraction/Tools/VoiceResponseGenerator.ts speak "Hello Jm"

# Generate to file
bun ~/.claude/skills/Communication/VoiceInteraction/Tools/VoiceResponseGenerator.ts generate "Your message here"
```

### Local TTS Control

```bash
# Check local TTS server health and config
bun ~/.claude/skills/Communication/VoiceInteraction/Tools/LocalTTSClient.ts health

# Speak text directly (for testing)
bun ~/.claude/skills/Communication/VoiceInteraction/Tools/LocalTTSClient.ts speak "Hello world"

# Change default voice
bun ~/.claude/skills/Communication/VoiceInteraction/Tools/LocalTTSClient.ts set-voice af_bella

# Change default model
bun ~/.claude/skills/Communication/VoiceInteraction/Tools/LocalTTSClient.ts set-model kokoro
```

### Proactive Pinging

```bash
# Send proactive voice message
bun ~/.claude/skills/Communication/VoiceInteraction/Tools/ProactivePinger.ts send "Meeting in 10 minutes"

# Schedule a ping
bun ~/.claude/skills/Communication/VoiceInteraction/Tools/ProactivePinger.ts schedule --at "2026-02-05T09:00:00" --message "Good morning"
```

## Examples

**Example 1: Desktop voice conversation**
```
User: "Start voice mode"
--> DesktopVoiceClient starts listening
--> User presses hotkey, speaks: "What's on my calendar?"
--> VoiceInputProcessor transcribes via local Whisper
--> Inference generates response
--> VoiceResponseGenerator plays through speakers
--> Kaya: "You have three meetings today. First one at 10am with the design team."
```

**Example 2: Telegram voice reply**
```
Jm sends voice note: "Hey Kaya, what's the weather?"
--> Telegram bot receives OGG audio
--> VoiceInputProcessor transcribes via Gemini
--> Inference generates response
--> VoiceResponseGenerator creates local TTS audio
--> Telegram sends voice reply
```

**Example 3: Proactive ping**
```
Calendar event in 10 minutes
--> ProactivePinger triggers
--> VoiceResponseGenerator creates audio: "Meeting with design team in 10 minutes"
--> Routes to active channel (desktop if running, else Telegram)
```

**Example 4: Between-turn interruption**
```
Kaya is speaking a long response through speakers
--> User starts new turn (VAD detects new speech)
--> InterruptionHandler cancels current TTS playback (between-turn, not mid-stream)
--> New input captured and processed
--> Fresh response generated with conversation context
```

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
+-- com.pai.realtime-voice.plist           # Auto-start real-time voice server
```

## Integration

### Uses
- `~/.claude/secrets.json` - Gemini API key (voice LLM + STT), Telegram credentials
- `~/.claude/settings.json` - Local voice config (localVoice), voice parameters, identity
- `lib/core/VoiceInput.ts` - Desktop STT via local Whisper
- `lib/core/NotificationService.ts` - Voice notifications
- `lib/core/Inference.ts` - AI response generation
- `lib/core/StateManager.ts` - Local TTS config, polish config, interruption state, session state
- `lib/core/CachedHTTPClient.ts` - All HTTP calls (mlx-audio TTS, Gemini STT, Ollama polish)
- `skills/Communication/Telegram/` - Mobile voice channel

### Feeds Into
- Desktop voice conversations
- Telegram voice replies
- Proactive notification system
- ProactiveEngine scheduled triggers

### MCPs Used
- None (CachedHTTPClient for mlx-audio/Gemini/Ollama APIs, local Whisper for desktop STT)
