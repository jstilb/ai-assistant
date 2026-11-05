# VoiceInteraction: examples

Moved out of `SKILL.md`.

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
