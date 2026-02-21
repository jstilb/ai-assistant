# StartDesktop Workflow

Start the desktop voice interaction client for hands-free conversation with Kaya.

## Trigger
"voice mode", "start voice", "talk to me", "desktop voice", "real-time voice"

## Steps

1. Verify microphone permissions (sox/rec available)
2. Start DesktopVoiceClient in configured mode
3. Confirm to user that voice mode is active

## Execution

### Real-Time Mode (Recommended)

Connects via WebSocket to the real-time voice server on port 8882. Provides the lowest latency experience with Kaya personality and streaming TTS. Falls back to batch pipeline if the server is unavailable.

```bash
# Start real-time voice mode (auto-fallback to batch if server unavailable)
bun ~/.claude/skills/VoiceInteraction/Tools/DesktopVoiceClient.ts start --mode=realtime
```

### Batch Pipeline Modes

```bash
# Start desktop voice client (push-to-talk mode)
bun ~/.claude/skills/VoiceInteraction/Tools/DesktopVoiceClient.ts start

# Or with VAD mode (always-listening)
bun ~/.claude/skills/VoiceInteraction/Tools/DesktopVoiceClient.ts start --mode=vad
```

### Management

```bash
# Stop desktop voice
bun ~/.claude/skills/VoiceInteraction/Tools/DesktopVoiceClient.ts stop

# Check status
bun ~/.claude/skills/VoiceInteraction/Tools/DesktopVoiceClient.ts status

# Check real-time server health
bun ~/.claude/skills/VoiceInteraction/Tools/RealtimeHealthMonitor.ts status
```

## Notes
- Requires sox: `brew install sox`
- Requires microphone permission for terminal
- Real-time mode uses Gemini 2.0 Flash for LLM inference (lowest latency)
- Batch mode uses Inference.ts (configurable level)
- TTS fallback chain: MLX TTS (Kokoro) -> macOS `say` -> text-only
- Say "goodbye" or "stop listening" to end session
- Real-time server auto-starts via launchd (com.pai.realtime-voice.plist)
