---
name: VoiceNotes
description: Transcribe mobile & desktop voice notes and organize them into Obsidian. Drops audio in an inbox folder (local or iCloud Drive), transcribes locally via faster-whisper, then an LLM cleans and routes each note into the right vault folder. USE WHEN voice note, voice memo, transcribe audio, dictation to notes, capture voice into obsidian, process voice notes, voice journal, audio note.
---
# VoiceNotes

Turn spoken voice notes — recorded on your **phone** or **desktop** — into clean, organized Obsidian notes. You drop an audio file into an inbox folder; Kaya transcribes it locally with faster-whisper, then uses an LLM to clean the transcript, give it a title/summary/tags, pull out action items, and file it under the best-fitting vault folder. Audio is archived (never deleted), and every file is processed exactly once.

This is the **batch / capture** counterpart to `Communication/VoiceInteraction` (which is real-time, conversational voice). VoiceNotes is for asynchronous "record a thought, find it organized later."

## How it flows

```
[iPhone Voice Memo / desktop recording]
   │  (share / save / export the audio file)
   ▼
INBOX folders (scanned):
   ~/VoiceNotesInbox                                            (desktop)
   ~/Library/Mobile Documents/.../CloudDocs/VoiceNotesInbox     (iCloud → iPhone Files app)
   Apple Voice Memos Recordings dir                             (auto, if present on this Mac)
   │
   ▼  VoiceNotesProcessor.ts
1. transcribe  → lib/core/extract-transcript.py (faster-whisper, local, large-v3)
2. organize    → inference() cleans transcript, picks a vault folder, extracts action items
3. write       → <Category>/Voice Notes/<date>-<slug>.md  (frontmatter + summary + body + raw)
4. archive     → audio moved to ~/.kaya/voicenotes/archive; hash recorded in the ledger
```

Idempotent: each audio file is keyed by a content hash in `~/.kaya/voicenotes/ledger.json`, so re-runs and renamed files are never double-processed.

## Quick reference

```bash
P=~/.claude/skills/Content/VoiceNotes/Tools/VoiceNotesProcessor.ts

bun $P scan                       # list inbox sources + pending audio files
bun $P run                        # transcribe + organize everything pending
bun $P run --dry-run              # show what would happen, write nothing
bun $P run --model large-v3       # override whisper model (default: large-v3)
bun $P run --keep-audio           # leave audio in the inbox (don't archive)
bun $P process-file <audio-path>  # process one specific file
bun $P status                     # ledger stats + recent notes
```

## Capturing a note (the phone path)

1. Record a Voice Memo on the iPhone.
2. Share it → **Save to Files** → `iCloud Drive / VoiceNotesInbox`.
   (Create that folder once in the Files app; it syncs to the Mac automatically.)
3. Next time `run` fires (manually, or via the launchd job below), it lands in Obsidian.

Desktop: record with any app, save the file into `~/VoiceNotesInbox`.

## Output note shape

```markdown
---
title: "Surf Trip Planning"
created: 2026-06-23T21:17:41.000Z
source: voice-note
device: mobile           # inferred from the inbox the file came from
audio: "2026-06-23-idea-memo.m4a"
duration_sec: 9
transcription_model: large-v3
tags: [voice-note, surf, travel-planning]
---
# Surf Trip Planning

> [!summary] One-line summary of the note.

Lightly cleaned body (filler removed, paragraphs/bullets added — meaning preserved).

## Action Items
- [ ] Book flights
- [ ] Find a board rental

## Raw Transcript
> [!note]- Original transcription
> verbatim whisper output, kept for fidelity
```

## Components

| Component | Purpose | Location |
|-----------|---------|----------|
| **VoiceNotesProcessor** | Scan → transcribe → organize → write → archive pipeline + CLI | `Tools/VoiceNotesProcessor.ts` |
| **config** | Defaults + user override loader; source folders, vault, model | `Tools/config.ts` |
| **run wrapper** | Cron-safe wrapper (ensures inboxes, logs, runs `run`) | `Config/voicenotes-run.sh` |
| **launchd plist** | Periodic auto-processing template | `Config/com.pai.voicenotes.plist` |

## Configuration

Defaults live in `Tools/config.ts`. Override any field via
`USER/SKILLCUSTOMIZATIONS/VoiceNotes/config.json` (see `config.json.example`):

| Key | Default | Description |
|-----|---------|-------------|
| `sources` | `~/VoiceNotesInbox`, iCloud `VoiceNotesInbox`, Apple Voice Memos (if present) | Folders scanned for audio |
| `vaultPath` | `~/Desktop/obsidian` | Obsidian vault root |
| `noteSubfolder` | `Voice Notes` | Subfolder (under the routed category) for notes |
| `defaultCategory` | `Voice Notes` | Top-level folder used when no category fits |
| `whisperModel` | `large-v3` | faster-whisper model |
| `archiveDir` | `~/.kaya/voicenotes/archive` | Where processed audio is moved |
| `keepAudio` | `false` | If true, leave audio in the inbox |
| `ledgerPath` | `~/.kaya/voicenotes/ledger.json` | Processed-file ledger |
| `inferenceLevel` | `standard` | LLM tier for the organize step |

## Automation (auto-installed by the standard plist fleet)

A periodic launchd job processes new notes without manual runs. `bin/rebuild-plists.sh`
unconditionally generates and (re)loads `com.pai.voicenotes.plist` as part of its standard
"Persistent Services" fleet (`bin/rebuild-plists.sh:1051-1084`) — there is no opt-in gate, so any
run of the standard plist-rebuild workflow installs/reloads this job every 30 minutes regardless of
whether Jm made an explicit install decision:

```bash
# Wrapper (idempotent; safe to run anytime)
bash ~/.claude/skills/Content/VoiceNotes/Config/voicenotes-run.sh

# Manual install/reload, if not going through the standard rebuild:
cp ~/.claude/skills/Content/VoiceNotes/Config/com.pai.voicenotes.plist ~/Library/LaunchAgents/
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.pai.voicenotes.plist
# (or just run bin/rebuild-plists.sh, which already manages this plist)
```

## Integration

### Uses
- `lib/core/extract-transcript.py` — local faster-whisper transcription (PEP 723 uv script)
- `lib/core/Inference.ts` — the organize/routing LLM step
- `~/Desktop/obsidian` — destination vault

### Relationship to VoiceInteraction
- `Communication/VoiceInteraction` = real-time spoken conversation (STT→LLM→TTS).
- `Content/VoiceNotes` = batch capture of recorded memos into the knowledge vault.
- They share the same local whisper backend; neither depends on the other.

## Requirements
- `uv` (runs `extract-transcript.py`; auto-installs faster-whisper on first run)
- `bun`
- macOS `afinfo` (optional — used for audio duration; absent is fine)
