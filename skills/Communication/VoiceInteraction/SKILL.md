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
    Auto-start: launchd (com.kaya.realtime-voice.plist)
    Health: http://localhost:8882/health

BATCH - MOBILE (Telegram):
[Voice Message] --> Telegram Bot --> VoiceInputProcessor (local Whisper STT;
    Gemini only as opt-in fallback via allowCloudSTT config, default off)
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
    --> dictation:latest (fine-tuned) --> qwen2.5:1.5b (base)
    --> Claude API (paid; only if allowCloudFallback=true, default off) --> raw
    --> Word overlap validation
    --> Save raw/polished pair for nightly training

BETWEEN-TURN INTERRUPTION (both channels):
[New Input Detected] --> InterruptionHandler --> Cancel current TTS/Inference
    --> Re-process with accumulated context --> New response

PROACTIVE:
[Trigger Event] --> ProactivePinger --> Generate message
    --> VoiceResponseGenerator --> Push via active channel
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
| **VocabularyStore** | Personal vocabulary that primes Whisper + polish toward domain terms | `Tools/VocabularyStore.ts` |
| **DictationTrainer** | Builds/refreshes the local `dictation:latest` Ollama polish model | `Tools/DictationTrainer.ts` |

## Free Voice Stack & Training

The free voice stack (local STT and TTS) and the voice training notes are in `references/FreeVoiceStack.md`. Read it when you change the voice stack.

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

Worked examples are in `references/Examples.md`.

## Configuration, Customization, Setup, File Structure

The config keys, customization, setup requirements, dependencies and the file tree are in `references/ConfigurationAndSetup.md`. Read it when you change settings, set up a machine or look for a file.

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
