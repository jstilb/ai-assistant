# Workflow: Process Voice Notes

**Trigger:** "process my voice notes", "transcribe my voice memos", "any new voice notes?", "organize my voice notes into obsidian"

## Steps

1. **Check what's pending.**
   ```bash
   bun ~/.claude/skills/Content/VoiceNotes/Tools/VoiceNotesProcessor.ts scan
   ```
   Reports each inbox source (✓ exists / · missing) and lists pending audio with its inferred device.

2. **Process everything.**
   ```bash
   bun ~/.claude/skills/Content/VoiceNotes/Tools/VoiceNotesProcessor.ts run
   ```
   For each file: transcribe (faster-whisper) → organize (LLM) → write the note under
   `<Category>/Voice Notes/` → archive the audio. Prints the note path + chosen category per file.

   - Add `--dry-run` to preview without writing.
   - Add `--model large-v3` / `--model base.en` to trade accuracy for speed.
   - Add `--keep-audio` to leave the audio in the inbox.

3. **Report back to Jm.** Summarize: how many notes processed, their titles, and which vault
   folders they landed in. Flag any note tagged `needs-review` (the LLM organize step fell back).

4. **Single file** (e.g. a path Jm hands you):
   ```bash
   bun ~/.claude/skills/Content/VoiceNotes/Tools/VoiceNotesProcessor.ts process-file "/path/to/memo.m4a"
   ```

## Notes
- Idempotent: already-processed files (by content hash) are skipped, so it's always safe to re-run.
- Originals are archived to `~/.kaya/voicenotes/archive`, never deleted.
- To capture from the phone: save a Voice Memo to `iCloud Drive / VoiceNotesInbox` (Files app).
