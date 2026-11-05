# VoiceInteraction: free voice stack and training

Moved out of `SKILL.md`. Read it when you change the STT, TTS or voice training setup.

## Free Voice Stack & Training

The voice pipeline is free/local end to end by default. Paid cloud services
are opt-in fallbacks, each behind its own flag (all default **false**):

| Path | Free default | Paid fallback | Gate |
|------|--------------|---------------|------|
| STT (Telegram voice notes + files) | Local Whisper (`transcribeBuffer`) | Gemini API | `voiceInteraction.allowCloudSTT` |
| TTS (Telegram voice replies) | Kokoro via mlx-audio :8880 | ElevenLabs | `voiceInteraction.allowCloudTTS` |
| Transcription polish | Ollama (`dictation:latest` → `qwen2.5:1.5b`) | Claude API | STTPolish `allowCloudFallback` (`enable-cloud`/`disable-cloud` CLI) |

Training the free stack on Jm's vocabulary:

- **Vocabulary** lives in `USER/SKILLCUSTOMIZATIONS/VoiceInteraction/vocabulary.json`
  (edit directly or `bun Tools/VocabularyStore.ts add <term>`). It feeds
  Whisper's `--initial-prompt` (decoding bias), the polish prompt, and the
  dictation model's system prompt.
- **Dictation model**: `bun Tools/DictationTrainer.ts train` rebuilds
  `dictation:latest` from the vocabulary + curated seed pairs
  (`Config/dictation-seed-pairs.jsonl`) + accumulated raw→polished pairs
  (`data/pairs.jsonl`, written automatically on every accepted polish).
  Re-run after growing the vocabulary or accumulating new pairs;
  `compare` evals it against the base model; reverse with
  `ollama rm dictation:latest`.
- **Hallucination guards**: polish output is rejected (raw text passes
  through) when word overlap drops below 85% or more than one new content
  word appears — few-shot examples can otherwise leak into output.
