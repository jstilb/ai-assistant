---
name: PianoVideo
description: Turn a song/audio file into a piano arrangement — stem separation (Demucs), transcription (ByteDance piano model + Basic Pitch), two-hand arrangement, MIDI, sheet music (MusicXML + PDF) and a Synthesia-style falling-notes video. Code lives in its own repo, ~/projects/piano2video. USE WHEN synthesia, piano video, falling notes, transcribe song to piano, song to sheet music, audio to midi, piano cover, piano arrangement of a song, learn a song on piano.
---
# PianoVideo (piano2video) — moved out of Kaya

On 2026-11-04 (Jm) piano2video became its own project, with its full history:

- Code, `SKILL.md` (how to run), `DESIGN.md` (design log): `~/projects/piano2video` (private `github.com/[user]/piano2video`).
- Data (bank, models, datasets, outputs): `~/projects/piano2video/data/` — gitignored, never committed.
- Direction: `~/projects/piano2video/data/ALIGNMENT.md`.

Read `~/projects/piano2video/SKILL.md` and follow it. Old notes that say `~/.kaya/piano2video/X` mean
`~/projects/piano2video/data/X`; `skills/Content/PianoVideo/X` means `~/projects/piano2video/X`.
The code's history before the move is also in this repo's git log (`git log -- skills/Content/PianoVideo`).
