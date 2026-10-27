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
$P song.mp3 --parts lead+chords               # lead sheet: melody, chord symbols, LH block chords
$P song.mp3 --parts lead+chords --chord-vocab full   # chords also maj7, m7, dim, sus4 (default: major, minor, 7)
$P song.mp3 --all-variants                    # all 6 combinations, to compare
$P song.mp3 --lead-stem guitar                # melody lives in the guitar, not vocals
$P song.mp3 --start 30 --duration 45          # trim
$P "https://www.youtube.com/watch?v=…" --start 30 --duration 45   # web video (yt-dlp): name/title default to the video title
$P song.mp3 --audio-track original            # video soundtrack: synth (default) | original | mix | none
$P song.mp3 --piano-input stem                # piano model hears: auto (default; mix if solo piano) | mix | stem
$P song.mp3 --note-names                    # letter names (spelled for the key) on falling notes
$P song.mp3 --lead-f0 basicpitch             # sung lead: auto (default; pYIN for vocals) | pyin | basicpitch
```

A URL's audio is downloaded once to `<out>/downloads/<url hash>/` and reused on re-runs (`--force` downloads again); a failed download stops with yt-dlp's error. **Personal practice only: respect copyright.** Measured 2026-10-26: Wikimedia Commons works; YouTube returned HTTP 403 with the installed yt-dlp 2026.03.17 (it is older than 90 days: `brew upgrade yt-dlp` is the likely fix).

In `--source piano` (and for the accompaniment in `--source arrange`), hands follow the texture and how fast each hand would have to move (not a fixed middle C), so a free hand shares a wide figure, and note lengths are key presses (the pedal stays in the MIDI as CC64 and in the synth). For every source the score gets a detected meter (2/4 3/4 4/4 6/8 9/8 12/8), bar lines and pickups, tempo marks where the tempo moves, key changes, and visible rests. Measured against sheet music: Starlight `DESIGN.md` §7, Connections §8.

`--parts lead+chords` recognises chords per beat from the accompaniment (`arrange`: harmony + bass stems; `piano`: the whole piano part) and writes them as chord symbols over the melody, with root-position block chords (bass in C3–B3) in the left hand, struck at each chord change and bar line. On POP909's piano arrangements it gets the chord right (major/minor) 92% of the time (§9).

Outputs go to `~/.kaya/piano2video/out/<song-slug>/`:

| File | What |
|---|---|
| `<source>_<parts>.mid` | MIDI in score time (bars, meter, keys, tempo map; plays back with the recording's timing), tracks "Piano RH" / "Piano LH" |
| `<source>_<parts>.musicxml` | grand-staff score, opens in MuseScore for editing |
| `<source>_<parts>.pdf` | engraved sheet music |
| `<source>_<parts>.mp4` | Synthesia-style video, 1280×720@30: bar lines (fainter beat lines) fall with the notes, "Bar N" counter = the PDF's bar number, struck keys flash for 0.2 s |
| `stems/`, `tx/` | cached Demucs stems and raw transcriptions (re-runs skip them; `--force` redoes) |
| `report.json` | stem levels, piano input (mix/stem), tempo, the score grid per source (seconds ↔ score quarters, meter), per-variant notes, meter, key signatures and paths |

Runtime is about 2 min for a 73 s song on CPU, most of it Demucs and the piano model. Re-arranging a cached song takes seconds.

## Tests

```bash
DYLD_FALLBACK_LIBRARY_PATH=/opt/homebrew/lib ~/.kaya/venvs/piano2video/bin/python -m pytest "$PWD/skills/Content/PianoVideo/__tests__" -q
```

## Score a run against sheet music

When a song has ground truth (MusicXML or MIDI; a PDF goes through OMR first, e.g. `homr` in `~/.kaya/venvs/omr`):

```bash
cd skills/Content/PianoVideo/Tools && ~/.kaya/venvs/piano2video/bin/python -m p2v.evaluate \
  ~/.kaya/piano2video/out/<song> --reference ref.musicxml [--span START END] [--staves 1,2]
```

It aligns the score to the recording (DTW, then each onset snapped to the recording's own onsets: ~7 ms median error) and scores every cached transcription and variant: notes, hands, melody, note lengths, key, and the engraved score itself (where each note sits in its bar, how long it is written, notes shorter than an eighth, ties), plus beats at every metrical level and bar lines (downbeat F). `bar_check` lists bars whose notes don't match the recording: check it before trusting a score (a published sheet is often another arrangement). `--span` = the seconds the reference covers; `--staves` drops staves the recording doesn't play (bottom kept staff = left hand). Compare runs against each other: an arrangement is not a transcript.

## Check a change on the corpus (19 performed pieces)

Before changing a tuned setting, check that it holds beyond Connections and Starlight (`DESIGN.md` §11):

```bash
cd skills/Content/PianoVideo/Tools && P=~/.kaya/venvs/piano2video/bin/python
$P -m p2v.corpus fetch                                   # once: ASAP scores + 90 s MAESTRO excerpts (~600 MB)
$P -m p2v.corpus run --label mine --input midi           # performance MIDI in: the stages after transcription
$P -m p2v.corpus run --label mine-audio --input audio    # the recordings (transcriptions cached)
$P -m p2v.corpus compare base-midi mine                  # per piece; means for the tune half, the held-out half, all
```

Adopt a change only when the held-out half agrees. Results: `~/.kaya/piano2video/corpus/results/`.

## Files

- `Tools/p2v/pipeline.py` — CLI and stages (ingest, separate, transcribe, outputs, score-time MIDI)
- `Tools/p2v/arrange.py` — pure note transforms and the two arrangement recipes
- `Tools/p2v/chords.py` — chord recognition (beat profiles, templates, Viterbi) and the lead sheet's left hand
- `Tools/p2v/melody.py` — sung lead: pYIN f0 contour → notes (`DESIGN.md` §10)
- `Tools/p2v/meter.py` — score grid: beats, subdivision, tatums, bar length, downbeats (seconds ↔ score quarters)
- `Tools/p2v/notation.py` — quantize, key plan, tempo marks, music21 score, MusicXML, Verovio PDF
- `Tools/p2v/render.py` — falling-notes renderer and additive synth
- `Tools/p2v/evaluate.py` — ground-truth scoring (score→audio alignment + mir_eval)
- `Tools/p2v/corpus.py` — the same measures on 19 ASAP pieces with MAESTRO audio (fetch, run, compare)
