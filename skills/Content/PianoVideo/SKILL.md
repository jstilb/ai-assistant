---
name: PianoVideo
description: Turn a song/audio file into a piano arrangement — stem separation (Demucs), transcription (ByteDance piano model + Basic Pitch), two-hand arrangement, MIDI, sheet music (MusicXML + PDF) and a Synthesia-style falling-notes video. USE WHEN synthesia, piano video, falling notes, transcribe song to piano, song to sheet music, audio to midi, piano cover, piano arrangement of a song, learn a song on piano.
---
# PianoVideo (piano2video)

Song in → `.mid` + `.musicxml` + `.pdf` + `.mp4` (falling-notes video) out. Runs fully locally.

Design, tool research and the **open arrangement decision**: `DESIGN.md` (read §4 before choosing flags).

## Setup (once)

```bash
skills/Content/PianoVideo/Tools/setup.sh   # Python 3.11 venv at ~/.kaya/venvs/piano2video + ~165 MB piano model
```

Needs `ffmpeg`, `uv` and `cairo` (Homebrew).

## Use

```bash
P=skills/Content/PianoVideo/Tools/piano2video

$P song.mp3                                   # provisional default: --source arrange --parts lead+accomp
$P song.mp3 --source piano                    # only the song's existing piano part
$P song.mp3 --parts lead                      # melody only (right hand)
$P song.mp3 --all-variants                    # all 4 combinations, to compare
$P song.mp3 --lead-stem guitar                # melody lives in the guitar, not vocals
$P song.mp3 --start 30 --duration 45          # trim
$P song.mp3 --audio-track original            # video soundtrack: synth (default) | original | mix | none
```

Outputs go to `~/.kaya/piano2video/out/<song-slug>/`:

| File | What |
|---|---|
| `<source>_<parts>.mid` | performance MIDI, tracks "Piano RH" / "Piano LH" |
| `<source>_<parts>.musicxml` | grand-staff score, opens in MuseScore for editing |
| `<source>_<parts>.pdf` | engraved sheet music |
| `<source>_<parts>.mp4` | Synthesia-style video, 1280×720@30 |
| `stems/`, `tx/` | cached Demucs stems and raw transcriptions (re-runs skip them; `--force` redoes) |
| `report.json` | stem levels, bpm, per-variant note counts and paths |

Runtime is about 2 min for a 73 s song on CPU, most of it Demucs and the piano model. Re-arranging a cached song takes seconds.

## Tests

```bash
~/.kaya/venvs/piano2video/bin/python -m pytest skills/Content/PianoVideo/__tests__ -q
```

## Files

- `Tools/p2v/pipeline.py` — CLI and stages (ingest, separate, transcribe, beats, outputs)
- `Tools/p2v/arrange.py` — pure note transforms and the two arrangement recipes
- `Tools/p2v/notation.py` — quantize, music21 score, MusicXML, Verovio PDF
- `Tools/p2v/render.py` — falling-notes renderer and additive synth
