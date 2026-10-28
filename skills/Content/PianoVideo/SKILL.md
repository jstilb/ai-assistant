---
name: PianoVideo
description: Turn a song/audio file into a piano arrangement — stem separation (Demucs), transcription (ByteDance piano model + Basic Pitch), two-hand arrangement, MIDI, sheet music (MusicXML + PDF) and a Synthesia-style falling-notes video. USE WHEN synthesia, piano video, falling notes, transcribe song to piano, song to sheet music, audio to midi, piano cover, piano arrangement of a song, learn a song on piano.
---
# PianoVideo (piano2video)

Song in → `.mid` + `.musicxml` + `.pdf` + `.mp4` (falling-notes video) out. Runs fully locally.

Design, tool research and the **arrangement decision** (versatile: every song type, Jm 2026-10-27): `DESIGN.md` (read §4 before choosing flags).

## Setup (once)

```bash
skills/Content/PianoVideo/Tools/setup.sh   # Python 3.11 venv at ~/.kaya/venvs/piano2video + ~165 MB piano model + ~81 MB Beat This! weights + ~471 MB SOME singing-note weights (SHA-256 checked)
```

Needs `ffmpeg`, `uv` and `cairo` (Homebrew).

## Use

```bash
P=skills/Content/PianoVideo/Tools/piano2video

$P song.mp3                                   # default: --source auto --parts lead+accomp (auto: piano / hybrid / arrange from the stem levels)
$P song.mp3 --source piano                    # only the song's existing piano part
$P song.mp3 --source hybrid                   # piano-led song with vocals: the sung melody over the song's own piano part
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
$P song.mp3 --lead-f0 pyin                   # sung lead: auto (default; SOME for vocals) | some | pyin | basicpitch
$P song.mp3 --beats notes                    # score grid from the transcribed notes alone (default: beat-this)
```

A URL's audio is downloaded once to `<out>/downloads/<url hash>/` and reused on re-runs (`--force` downloads again); a failed download stops with yt-dlp's error. **Personal practice only: respect copyright.** Verified on Wikimedia Commons (2026-10-26) and YouTube (2026-10-27, yt-dlp 2026.10.21).

In `--source piano`, hands follow the texture and how fast each hand would have to move (not a fixed middle C), so a free hand shares a wide figure, and note lengths are key presses (the pedal stays in the MIDI as CC64 and in the synth). In `--source arrange` the band's accompaniment and bass are put on the score's eighth grid, and each chord keeps at most three of the recognised chord's tones, voiced within an octave under the melody (right hand) or over the bass (left hand): no note shorter than an eighth, no unplayable chord (`DESIGN.md` §20). Where the voice rests a bar or more (a drop, a riff), the right hand plays the band's own line: one voice tracked through all the band's stems that prefers small steps and the high register (`DESIGN.md` §23), and a song with no vocals and no piano (an instrumental track) is arranged from that line throughout (`DESIGN.md` §21; before, it gave no output). In `--source hybrid` a piano note that the hand cannot reach together with the sung note (or with the left hand's lowest note) goes to the other hand, an octave nearer, or is dropped, so almost no written chord spans more than 15 semitones (on the bank's piano songs with vocals, 7 of about 3,300 onsets still do: notes more than 0.25 s apart that the score writes as one chord, and chords of 6 notes; `DESIGN.md` §24). For every source the score gets a detected meter (2/4 3/4 4/4 6/8 9/8 12/8), bar lines and pickups, tempo marks where the tempo moves, key changes, and visible rests. Measured against sheet music: Starlight `DESIGN.md` §7, Connections §8.

The score grid (default `--beats beat-this`) comes from Beat This! (a trained beat and downbeat tracker, run on the recording) where its beats are regular, and from the transcribed notes, at the model's meter, where they are not (a soft intro without bass). Against the pop references: Connections' bar lines 81% → 92% right, notes in the right place in the bar 0.93 → 0.95, Starlight unchanged; on held-out classical pieces the meter is right 67% of the time instead of 11% (`DESIGN.md` §12). Electronic tracks whose synths sound just after the beat keep a straight 4/4 (not 12/8), and a beat over 200 a minute is read as eighths (`DESIGN.md` §22: the tempo level is right on 6 of the 7 instrumental sections, before 4). It needs the verified weights in `~/.kaya/piano2video/models/beat_this/` (`final0.ckpt`, fetched by `setup.sh`; the SHA-256 is checked at every load). Without them a run stops and says so; `--beats notes` uses the notes alone.

`--parts lead+chords` recognises chords per beat of the score grid and writes them as chord symbols over the melody, with root-position block chords (bass in C3–B3) in the left hand, struck at each chord change and bar line. By default (`--chord-model btc`) a trained chord model (BTC, MIT) hears the recording, and the transcribed accompaniment adds sevenths and slash basses (`hybrid`/`arrange`: every stem but the melody's; `piano`: the whole piano part). On the bank's songs with vocals it gets the chord right (major/minor) about 88% of the time on the held-out half (§19). It needs the verified weights in `~/.kaya/piano2video/models/btc/` (`btc_model.pt`, fetched by `setup.sh`; the SHA-256 is checked at every load); the `arrange` accompaniment keeps the same chords' tones (§20). Without the weights a lead-sheet or `arrange` run stops and says so, and `--chord-model notes` uses the notes alone.

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

## Measure every song type (the bank)

The bank scores all five song types with one command (`DESIGN.md` §13, §21): T1 solo piano covers, T2 classical piano, T3 piano-led songs with vocals, T4 songs with no piano, T5 instrumental sections (a drop, an instrumental track). Every song is run through the whole pipeline (all variants, no video) and scored on what any arrangement must keep (meter, tempo, bar lines, key, melody, chords), on fidelity where a piano reference exists, and on playability for every song.

```bash
cd skills/Content/PianoVideo/Tools && P=~/.kaya/venvs/piano2video/bin/python
$P -m p2v.bank list                                      # songs: type, tune/check half, reference
$P -m p2v.bank run --label mine [--types T3,T4] [--half tune] [--set meter.SURE_CV=0.15] [-- --beats notes]
$P -m p2v.bank compare base mine [--variant auto_lead-accomp]
$P -m p2v.bank add-hooktheory <entry key> --id <name> --type T4 --half check   # a HookTheory song as a reference
```

Choose settings on the tune half of each type and report the held-out (check) half. `--redo tx` (or `stems`) when the change is in transcription (or separation). Data: `~/.kaya/piano2video/bank/` (never in the repo).

## Check a change on the corpus (19 performed pieces)

Before changing a tuned setting, check that it holds beyond Connections and Starlight (`DESIGN.md` §11):

```bash
cd skills/Content/PianoVideo/Tools && P=~/.kaya/venvs/piano2video/bin/python
$P -m p2v.corpus fetch                                   # once: ASAP scores + 90 s MAESTRO excerpts (~600 MB)
$P -m p2v.corpus run --label mine --input midi           # performance MIDI in: the stages after transcription
$P -m p2v.corpus run --label mine-audio --input audio    # the recordings (transcriptions cached)
$P -m p2v.corpus run --label nt --beats notes            # the note grid alone (default: beat-this, each piece heard by the fold model that never trained on it)
$P -m p2v.corpus compare base-midi mine                  # per piece; means for the tune half, the held-out half, all
```

Adopt a change only when the held-out half agrees. Results: `~/.kaya/piano2video/corpus/results/`.

## Files

- `Tools/p2v/pipeline.py` — CLI and stages (ingest, separate, transcribe, outputs, score-time MIDI)
- `Tools/p2v/arrange.py` — pure note transforms and the three arrangement recipes (piano, arrange, hybrid)
- `Tools/p2v/chords.py` — chord recognition (beat profiles, templates, Viterbi) and the lead sheet's left hand
- `Tools/p2v/melody.py` — sung lead: pYIN f0 contour → notes (`DESIGN.md` §10)
- `Tools/p2v/some.py` — sung lead (the default for vocals): the SOME singing-note model → notes; weights pinned by SHA-256 (`DESIGN.md` §15)
- `Tools/p2v/meter.py` — score grid: beats, subdivision, tatums, bar length, downbeats (seconds ↔ score quarters); the default Beat This! path (`model_grid`, spliced with the note grid by `spliced_grid`)
- `Tools/p2v/notation.py` — quantize, key plan, tempo marks, music21 score, MusicXML, Verovio PDF
- `Tools/p2v/render.py` — falling-notes renderer and additive synth
- `Tools/p2v/evaluate.py` — ground-truth scoring (score→audio alignment + mir_eval)
- `Tools/p2v/corpus.py` — the same measures on 19 ASAP pieces with MAESTRO audio (fetch, run, compare)
- `Tools/p2v/bank.py` — the measurement bank: every song type, one command (run, compare, add-hooktheory)
