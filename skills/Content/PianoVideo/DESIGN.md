# piano2video — Design

Song/audio file → isolated stems → piano arrangement → **MIDI + sheet music (MusicXML/PDF) + Synthesia-style falling-notes video**.

Status: thin end-to-end slice **built and verified** 2026-10-20 (task t-mvfkuj6y-3vvsui). The arrangement decision (§4) is **open for Jm**. Every option is implemented behind flags, so choosing one only changes a default. The 2026-10-26 `piano`-mode fixes (hands, key lengths, tempo, solo-piano input) are measured against Starlight's sheet music in §7. The later 2026-10-26 work (meter and score grid, readable notation, tempo map, key changes, finer scoring harness) is measured against the cover artist's own score of "Connections" in §8. The §8 open items were taken up next: lead sheet and arrange-mode hands (§9), the sung lead (§10), a 19-piece corpus check with the hand search and the two-voice and downbeat findings (§11), and learner video styling and URL input (§6).

---

## 1. Pipeline

```
song.(mp3|wav|opus|m4a|mp4…)
  │ 1 ingest      ffmpeg → 44.1 kHz stereo wav (optional --start/--duration trim)
  ▼
input.wav
  │ 2 separate    Demucs htdemucs_6s → vocals · drums · bass · guitar · piano · other
  ▼               stems quieter than (loudest − 30 dB) are treated as absent
stems/*.wav
  │ 3 transcribe  piano stem  → ByteDance high-res piano model (notes + velocity + pedal)
  │                 (solo-piano recording: the original mix instead — Demucs only adds artefacts; §7)
  │               other stems → Spotify Basic Pitch (instrument-agnostic, polyphonic)
  ▼               cached as tx/<stem>.json (tx/piano-mix.json)
raw notes
  │ 4 arrange     recipe chosen by --source × --parts  (§4)
  │               skyline melody · register fitting · chord thinning · de-doubling · hand split
  │               piano: texture-following hand split + key-press lengths (§3)
  ▼
two-hand arrangement (seconds, performance timing)
  │ 5 score grid  one per source (meter.py, §3): beats on one level → tatums (eighths) → bar length
  │               + downbeats → seconds ↔ score quarters; key plan (key changes) from the same notes
  ▼
  │ 6 outputs     <variant>.mid        score-time MIDI: ticks = score quarters, tempo map keeps the
  │                                    recording's timing; meter, keys, RH/LH tracks, key lengths + CC64 pedal
  │               <variant>.musicxml   grand staff on the grid: detected meter (incl. 6/8, 12/8),
  │                                    pickups, key changes, tempo marks, visible rests
  │               <variant>.pdf        engraved by Verovio → cairosvg
  │               <variant>.mp4        1280×720@30 falling notes, RH green / LH blue, keys light up;
  ▼                                    soundtrack = synthesized transcription (or original / mix)
~/.kaya/piano2video/out/<song>/  (+ report.json)
```

Stages 1–3 are cached per song in the work dir. Re-running with a different `--source/--parts` only redoes arrangement and outputs, which takes seconds. `--force` clears the cache.

## 2. Tool research — what was chosen and why

| Stage | Chosen | Alternatives considered | Why |
|---|---|---|---|
| Source separation | **Demucs v4 `htdemucs_6s`** (Meta) | `htdemucs` (4-stem), Spleeter, Open-Unmix, UVR/MDX-Net, BS-RoFormer | It's the only widely available open model with a dedicated **piano** stem, which the "piano-only" option needs. It also has a guitar stem, so harmony can be pulled from guitar and piano separately. It installs locally from pip. BS-RoFormer separates vocals better but has no piano stem. |
| Piano transcription | **ByteDance high-resolution piano transcription** (Kong et al. 2021, `piano_transcription_inference`) | Basic Pitch, Google Onsets&Frames / MT3, Transkun | Note F1 ≈ 0.97 on MAESTRO. It's also robust on a separated (slightly artefacted) piano stem: the sample came out at 1,122 notes with plausible voicings. MT3 is multi-instrument but heavy (JAX/T5) and painful to install. |
| Non-piano transcription | **Spotify Basic Pitch** | CREPE/pYIN (monophonic f0), MT3 | Works on any instrument, handles polyphony (needed for guitar chords), is light (ONNX/CoreML) and takes about 1 s per stem. For the vocal lead the pipeline adds a skyline step on top to get a monophonic line, which avoids a second f0 model. |
| Beat / tempo / meter | **librosa beat_track** in `meter.py`: a Viterbi tempo path through the tempogram (one metrical level), run again at the tatum (eighth), then bar length + downbeats by dynamic programming over bass / harmony-change / long-note accents | madmom (RNN + DBN downbeat tracker), BeatNet, "Beat This!" (CPJKU 2024) | Already a dependency, and no new pip package (those need Jm's approval). The onset curve is built from the transcribed notes, bass ×3. A trained downbeat model would likely beat the hand-built bar step (§8 limits). |
| MIDI | **mido** (writing), **pretty_midi** (reading) | pretty_midi only | The MIDI is written in score time (ticks = quarters) with a tempo map, a pickup time signature, key signatures and CC64; pretty_midi can't write tempo changes. |
| Notation | **music21 → MusicXML**, engraved by **Verovio** (+ cairosvg/pypdf → PDF) | MuseScore CLI, LilyPond | Everything installs from pip (cairo comes from Homebrew), so there's no GUI app to install. MusicXML opens in MuseScore for hand-editing. |
| Video | **Custom PIL renderer → ffmpeg** (in `render.py`) | MIDIVisualizer, SeeMusic, Synthesia (recorded), Neothesia | Headless, scriptable and dependency-free. It renders 73 s in about 6 s. MIDIVisualizer gives a fancier look but needs a GUI/GL context and manual config. The `.mid` output loads directly into any of those if Jm wants a prettier render. |
| Audio for video | Built-in additive synth | FluidSynth + soundfont | No soundfont dependency, and you hear exactly what was transcribed. `--audio-track original|mix` is also available. |

Environment gotchas (all handled in setup.sh / the code):
- Demucs on **MPS fails** (`Output channels > 65536`). The pipeline runs it on CPU, which takes about 30 s for a 73 s song on an M-series chip.
- Demucs needs **torchaudio < 2.9**, so torch and torchaudio are pinned to 2.5.1.
- Basic Pitch → resampy needs `pkg_resources`, so setuptools is pinned below 70.
- The `piano_transcription_inference` helper `load_audio` breaks on librosa 0.11 (we use `librosa.load` instead). Its checkpoint auto-download also fails, so `setup.sh` fetches it from zenodo (~165 MB, slow).
- cairosvg needs `DYLD_FALLBACK_LIBRARY_PATH=/opt/homebrew/lib`, which the wrapper sets.
- Verovio text glyphs (♩) don't render through cairosvg, so the tempo mark is text: "≈ 129 bpm" ("≈ 108 bpm (dotted quarter)" in 6/8 or 12/8).
- music21's MusicXML export fills gaps with **hidden** rests (`print-object="no"`); `build_score` fills them with visible rests first.

## 3. Arrangement transforms (`Tools/p2v/arrange.py`, unit-tested)

- **skyline(top|bottom)**: reduces polyphony to one line. Near-simultaneous onsets (35 ms or less) count as a chord, and the extreme pitch wins. Inner voices under a held note are dropped. A new, more extreme note truncates the held one. Used for the vocal lead (Basic Pitch emits harmonics and doublings), the piano top line, and the bass line.
- **fit_register**: picks one octave shift for the whole line so its contour is kept, then folds outliers. Lead goes to E4–E6, accompaniment to C3–B4, bass to E1–E3.
- **limit_polyphony**: thins each chord to N notes (default 4). The top and bottom notes are always kept, then the loudest inner notes.
- **merge_same_pitch**: unions overlapping notes of the same pitch, which happens when guitar, piano and other stems all play the same chord.
- **drop_doubled**: removes accompaniment notes that double a sounding melody or bass note.
- **assign_hands**: lead → RH, bass → LH, accompaniment split at middle C. Used for melody-only variants. `arrange` mode keeps lead → RH and bass → LH but splits the accompaniment with `local_splits` (below): on Viva la FAI `arrange/lead+accomp`, stepwise accompaniment figures changing hand 10/55 → 3/55, RH accompaniment that spans more than 15 semitones with the held melody note 4/207 → 0/124, unplayable onset clusters 1/454 → 0/454, hand crossings 0 → 0.
- **local_splits**: a per-note split pitch from the texture. Among notes sounding within ±1.5 s (about a bar), take the widest pitch gap, biased toward middle C. Skip any split that leaves a hand a chord wider than 15 semitones (onsets stay reliable when pedalled lengths don't). Each semitone a hand's share of the window spans beyond an octave costs 1 (`span_cost`, since §8: the widest gap alone gave Connections' left hand a tenth-wide arpeggio). Allow one hand only for compact passages or a clearly high/low register. Moving away from the previous split costs 2 per octave, and a 5-note median removes flicker. Gap splits below G2 are ignored, so a left-hand octave (A1–A2) can't pull the split under the bass.
- **assign_hands_adaptive** (`piano` mode, and the accompaniment in `arrange` mode, §9): since §11 a beam search over onset groups, with `local_splits` as one cost among four. Each group splits at one point of its sorted pitches (lead notes stay right, bass notes left). Costs: a hand's move beyond 10 semitones divided by the time since its last onset (+0.15 s), a note nearer the other hand's last position ("lane", 4 per octave), a note on the far side of the texture split (3 per octave), register (LH above E4, RH below G3, 2 per octave). A split that leaves a hand wider than 15 semitones or more than 5 notes is not considered. The widest-gap rule alone counted pedal-held notes as busy and gave the right hand a whole 15-semitone figure while the left hand rested (Connections bars 46–49).
- **key_lengths** (`piano` mode): the piano model reports when a note stops *sounding*, which under pedal is seconds after the key came up. Within a hand, a key is assumed up by that hand's next onset (legato). The sounding end stays in `Note.sound_end` for the synth, and the MIDI carries the model's CC64 pedal. `piano/lead` is the right hand's top line after this step. A voice-aware variant (top line and bass held to their own next note) was checked in §8 and not adopted.

### Score grid (`Tools/p2v/meter.py`, unit-tested)

The score needs a map from seconds to score position, not just beats. It is built per source from the transcribed notes, in levels:

1. **Beats on one level**: a Viterbi path through the tempogram (states 50–170 bpm, cost on every change in log tempo) instead of a frame-wise argmax. The argmax flipped between dotted-quarter and half-note beats on Connections.
2. **Subdivision**: 3 (compound meter) when off-beat onsets sit at ⅓ and ⅔ of the beat and outweigh those at ½ (and ¼, ¾) by 1.5×, else 2.
3. **Tatums**: the beat tracker runs again at subdivision × the local beat tempo, so every eighth gets a time.
4. **Bars**: the bar length (2/4 3/4 4/4 or 6/8 9/8 12/8) whose best phase gives the largest accent contrast; then downbeats by dynamic programming over per-tatum accents (bass onset below its neighbourhood, pitch-class change over 4 beats, long note), bars of m ± 2 tatums at a cost of 1.5 per tatum off.
5. **Fit**: each bar maps onto exactly one written bar. Where the tracker slipped a tatum, the one where no note starts is dropped (or a missing one is added in the widest gap), so onsets stay on the grid. The bar holding the first note is bar 0, so a pickup sits at its end.

### Notation (`Tools/p2v/notation.py`)

- Onsets snap to the tatum (eighth), or to a 16th only when clearly between two eighths (0.15 tatum margin).
- Each hand is a chord sequence; a held note is cut at the hand's next onset. An off-beat note also ends at the next beat when any hand starts a note there (the pedal, not the finger, holds it); a syncopation over an empty beat keeps its length. A note is written at least a tatum long when the hand has time (a detached chord reads as an eighth, not a 16th and a rest).
- A variant that starts later than the source (a melody line without the opening bass note) drops the empty bars before its first note; `report.json` keeps the shift (`score_offset_q`) for the harness.
- Every gap gets a visible rest. The meter, the tempo marks (a new mark where the bar tempo moves ≥ 10% for 4 bars) and the key signatures (Krumhansl–Schmuckler per bar over ±4 bars; a change only after 8 bars favour another signature by 0.1) come from the grid and the key plan. Pitches are spelled for the key in force.

## 4. ⚠ OPEN DECISION — arrangement (Jm to decide)

Two independent axes, both implemented. `--all-variants` renders all four combinations for one song so you can compare them side by side.

### Axis A: what gets transcribed — `--source`

| Option | Meaning | Good for | Weak for |
|---|---|---|---|
| `piano` | Transcribe **only the piano that's already in the song** (Demucs piano stem → piano model). | Piano-led songs (Into My Arms, Clair de Lune, Für Elise). Highest fidelity, because it's the real part. | Anything without a piano. The tool refuses rather than producing junk. The result can be hard (pro voicings, full range). |
| `arrange` | **Re-voice the song's core components for piano**: melody stem (vocals by default, `--lead-stem guitar` etc.) → RH, chordal stems (piano + guitar + other) → thinned voicings, bass stem → LH. | Any song: rock, R&B, electronic. Produces a "piano cover". | Less faithful. Voicings come from transcribed guitar/synth, so they're more machine-like. |

### Axis B: how much — `--parts`

| Option | Meaning |
|---|---|
| `lead` | Melody only, right hand. Good for learning a tune or for a beginner. |
| `lead+accomp` | Melody plus accompaniment, two hands. This is the full piece. |

### Evidence gathered (not a decision)

- Jm's `Piano Repertoire.md` is mostly **non-piano songs**: Star Treatment, Light Years, Sober, Redbone, Divinity, Starlight, Last Night on Earth. Only Into My Arms, Clair de Lune and Für Elise are piano-led. Several are tagged "(lead)", meaning a lead sheet is wanted.
- Jm is early in the Bill Hilton course (lessons 4–6: reading the left-hand staff). Dense two-hand transcriptions will be hard to read.
- On the sample (piano + vocals), `piano/lead+accomp` was the most faithful (1,104 notes). `arrange/lead+accomp` was more playable and carries the sung melody (848 notes). `piano/lead` pulled the piano's top line, which is *not* the sung melody.

### Recommendation (pending Jm)

**`--source arrange --parts lead+accomp`**. It's the only mode that works for most of the repertoire, and it puts the actual sung melody in the right hand. `piano` mode stays available for piano-led songs. For learning, run `--parts lead` first. The CLI uses this as a **provisional** default. To lock in a different choice, change the `default=` on `--source` / `--parts` in `Tools/p2v/pipeline.py` and update this section.

A third shape, **built 2026-10-26: the lead-sheet mode** `--parts lead+chords` (melody plus chord symbols, LH block chords). It is the most beginner-friendly and matches the "(lead)" tags. Chords are recognised per beat from the harmony notes and measured on POP909 (§9). It is one more option on axis B; it does not change the default.

**Decision:** _\_\_\_ (Jm)_ — date: ____

## 5. Verified slice (2026-10-20)

Sample: "Viva la FAI (piano-vocals)", Wikimedia Commons, **CC BY 3.0**, 73 s, piano + voice. Stored at `~/.kaya/piano2video/samples/viva_la_fai.opus`.

```
Tools/piano2video ~/.kaya/piano2video/samples/viva_la_fai.opus \
  --name viva-la-fai --title "Viva la FAI" --all-variants
```

- Total wall time was about 1 min 53 s (Demucs 30 s, piano model 40 s, Basic Pitch 6 s, four videos about 6 s each).
- Stem levels: vocals −15.6 dB, piano −22.2 dB, everything else ≤ −55 dB, so those stems were correctly treated as absent.
- Detected F major at ≈ 129 bpm. MusicXML has the 1-flat key with only 4 accidentals.
- Four variants were written, each with `.mid`, `.musicxml`, `.pdf` (2–3 pages) and `.mp4` (73.09 s, h264 + aac, 2192 frames).
- Sync check: onset-envelope cross-correlation between the synthesized transcription and the original piano stem peaks at a **−23 ms** lag, one analysis frame, so the timing is correct.
- `__tests__/test_p2v.py`: 24 unit tests over the transforms, quantization, spelling, keyboard geometry, frame pixels and synth.

## 6. Known limits / next slices

1. Meter, subdivision and downbeats are detected since §8 (12/8 on Connections, 4/4 on Starlight and Viva la FAI). Downbeats still slip by one eighth in some bars (Connections: 81% of bar lines exact; Starlight's soft intro 44% against a loosely aligned reference). On 19 classical pieces (§11) the grid is the weak link: meter right on 21%, downbeat F 0.33, and the annotated beats alone would double downbeat F, so beat tracking is the cause. A trained beat/downbeat model ("Beat This!") is the next step; it needs a new pip package, so Jm's approval.
2. ~~The vocal melody inherits Basic Pitch's octave and vibrato artefacts.~~ Done 2026-10-26: a pYIN f0 front-end is the default for a vocal lead (§10). CREPE/RMVPE would need new pip packages (Jm's approval); pYIN's remaining gap to the annotators (F 0.57 vs 0.72) is the next target.
3. Notation writes one voice per hand: a held melody note over moving inner notes is cut at the next onset. Measured on the corpus (§11): at most 3.4% of notes would gain from a held-melody voice, both pop references write one voice, and two voices are harder to read, so it is not built. Loosely timed playing (Viva la FAI) still gives many 16ths (39% of notes). For performance-ready scores, hand-edit the MusicXML in MuseScore.
4. Lead-sheet mode: built (`--parts lead+chords`, §9). Open: chord recognition from vocals-only songs has no harmony stem; slash chords and the LH voicing are not measured; the vocabulary is major, minor and 7 by default.
5. ✅ Learner styling done 2026-10-26 (`render.py`): bar and beat lines from the score grid fall with the notes, a "Bar N" counter uses the PDF's numbers (after `lead_in`), struck keys flash for 0.2 s, and `--note-names` labels notes. On Connections the bar numbers' first onsets match the MusicXML in 18 of 18 checked bars (10 in `piano_lead-accomp`, 8 in `piano_lead`, whose `lead_in` is one bar), and bar lines sit within about 25 ms of the downbeat notes. Still open: particle effects, a sheet strip.
6. ✅ Done 2026-10-26: an http(s) URL as input goes through yt-dlp (`fetch_url`, cached in `<out>/downloads/`), and the name and title default to the video title. Respect copyright: only for personal practice. Verified on Wikimedia Commons; YouTube gave HTTP 403 with the installed yt-dlp 2026.03.17 (too old).

## 7. Ground-truth check: Jai Wolf – Starlight (2026-10-26)

**Recording:** "Jai Wolf – Starlight (Piano Version) [Official Audio]", 215 s, solo piano.

**Reference:** the Scribd "Starlight" sheet (document 379100208). It is a *Piano and Voice* arrangement of the original vocal song. An OpenCode/Kimi agent saved the 11 page images to `~/.kaya/piano2video/reference/starlight-scribd/`. OMR was `homr` 0.7.0 (`~/.kaya/venvs/omr`) on pages upscaled 3×. It read the riff exactly, but it lost left-hand bars on pages 5–10 and failed on page 11.

The sheet is not a transcript of this recording. Only the **8-bar intro (0–17.1 s)** is the same music: the right-hand riff E3 D#4 E4 D#4 B3 G#3 F#3 over left-hand whole-note chords. The sheet has A×4 then E×4, while the recording plays E×4 then A×4. The recording also plays G#3 where the sheet's riff has D#4. From 17 s the piano version plays its own accompaniment.

The reference excerpt is `~/.kaya/piano2video/reference/starlight-intro.musicxml`: OMR page 2, bars 5–8 then 1–4. Right-hand bars 3–4 were repaired by hand, because OMR dropped notes there and the page shows the same riff in all 8 bars.

**Scoring command:** `python -m p2v.evaluate <work> --reference starlight-intro.musicxml --span 0 17.13`, on `piano/lead+accomp`:

| | Before | After |
|---|---|---|
| Notes F1 (exact pitch) | 0.59 | 0.60 (ceiling ≈ 0.85: the arrangement differs) |
| Hand agreement (bottom staff = LH) | 0.32 | **1.00** |
| Our length / written length, median | 6.7× | **0.99×** (IQR 0.87–1.10) |
| Melody F1 (RH top line) | 0.22 | **0.69** |
| `piano/lead` melody F1 | 0.03 | **0.69** |
| Intro tempo (aligned sheet: 114.6) | 92.3 | **117.5** (body ≈ 92–96) |
| Beat F-measure | 0.23 | 0.52 (a floor: the aligned grid jitters ±150 ms; tracked downbeats sit within 20 ms of the bass onsets) |

**Causes found, all general:**
1. **Hands** were split at a fixed middle C, so a right-hand riff that dips below C4 changed hands on every note. Fix: `local_splits` (§3).
2. **Lengths** were the pedalled sound, not the key press. The pedal is down for 99% of the song, and note ends land on pedal releases 20% of the time against 3% by chance. Fix: `key_lengths` (§3).
3. **Tempo** was one global value, but the recording slows from about 115 to about 92 bpm. Fix: time-varying, bass-weighted beat tracking (§2).
4. **Input:** Demucs on solo piano added 165 notes that the mix transcription doesn't have. Precision dropped (0.60 against 0.65), and the extra notes misled the hand split. Fix: `--piano-input auto` transcribes the mix when the other stems together are ≥ 15 dB under the piano.

Two earlier bugs were fixed the same day: D# was spelled as E♭ in sharp keys, and `arrange` used a silent vocal stem as its melody.

**Out-of-sample check (no ground truth), Viva la FAI:** unplayable chords (one hand spanning more than 15 semitones or playing more than 5 notes) dropped from 21.2% to 1.4%. Bass onsets on a beat rose from 0.75 to 0.81. The tempo stayed at 129 bpm.

**Limits:** exact ground truth covers 17 s of one song, and the split parameters (1.5 s window, 15-semitone reach, bias, stickiness) were tuned on it. Viva la FAI is the only out-of-sample check. The score still has some 16th-note splits, and meter and downbeat are not detected. `arrange` mode still splits hands at middle C and is unmeasured.

*Later the same day (§8):* the harness was made finer (the numbers above use the old DTW-only alignment; the same run scores note F1 0.61 with the new one), these parameters were re-measured on a second piece, and meter, notation and tempo were reworked. Starlight's intro after §8 (`jai-wolf-starlight-v3`): bar position of written notes 0.98 (was 0.00), written length 0.95 (0.64), no notes shorter than an eighth (16%), ties 5% (16%), quarter-beat F 0.61 (0.24 for the grid the v2 score was actually built on).

## 8. Ground-truth check: Connections (2026-10-26)

**Recording:** "Connections by Michel Brown (Piano Cover)", Jennie Chen's YouTube cover (2018, 225 s), solo piano. Copy: `~/.kaya/piano2video/samples/connections/connections.mp3`.

**Reference:** the cover artist's own score, linked from the video description: flat.io "Connection by Michel Brown (work in progress)", 36 bars of 6/4 in A major at 168 qpm. Its MusicXML/MIDI export is a paid feature (HTTP 402) and was not used. The score data the public viewer loads (flat.io's MusicXML-as-JSON) is saved as `reference/connections-flat/connections.flat.json` and converted by `scratch/flat_to_musicxml.py`. In bars 16, 23 and 24 the JSON's cached note positions were stale (8 beats in a 6-beat bar); positions were rebuilt from each voice's note order and lengths (MusicXML semantics), after which every bar holds exactly 6 beats. Bar 36 holds a single note (the work in progress stops there), so the reference is **bars 1–35** (461 notes, 0.9–79.05 s): `reference/connections-b1-35.musicxml`.

**Match check:** the new `bar_check` scores the transcription against every score bar: pitch-class onset F1 0.84–1.00 in all 35 bars. This score is the recording, note for note, including the rubato opening. (It is written in 6/4 but felt in dotted quarters: 12/8 has the same bars.)

**Scoring command:** `python -m p2v.evaluate <work> --reference connections-b1-35.musicxml --span 0.9 79.05`, on `piano/lead+accomp`. "Before" is the code after §7, scored with the new harness.

| | Before | After |
|---|---|---|
| Transcription note F1 | 0.976 | 0.976 (no change to the stage) |
| Hand agreement | 0.76 | **0.85** |
| Melody F1 (RH top line) / `piano/lead` | 0.74 / 0.74 | **0.82 / 0.82** |
| Meter | 4/4 (assumed) | **12/8** (detected) |
| Written notes in the right place in the bar | 0.16 | **0.93** (0.94 within a 16th) |
| Written length = the score's | 0.00 | **0.69** (ratio IQR 1.0–1.5) |
| Notes shorter than an eighth (score: 0%) | 45% | **1.3%** |
| Tied notes (score: 0.2%) | 8.4% | **1.8%** |
| Beat F (best level: dotted quarter) | 0.64 | **0.89** |
| Downbeat F (bar lines) | – | **0.81** |

**Harness first (open item 3).** DTW frames are 46 ms. Each reference onset is now snapped to the recording's own onsets (librosa, 5.8 ms hops, backtracked: flux peaks lag the piano model's onsets by 20–37 ms, backtracked ones by ~2 ms), outliers against neighbours are dropped, and a line is drawn between snapped onsets where at most one in between was missed (DTW wobbles 50–100 ms on single notes). Alignment self-test (a transcription re-timed through a warped tempo): median error 19 → 7 ms, p90 54 → 22 ms, self-score F1 0.976 → 0.991 (Connections); 22 → 9 ms, 0.982 → 0.986 (Starlight). Starlight's intro note F1 0.597 → 0.612 with no pipeline change. New measures: written position and length against the reference through the pipeline's grid, reading load (symbols per bar, short notes, ties), beat F at every metrical level, downbeat F, and the per-bar match check.

**Causes found, all general:**
1. **The beat changed level.** On Connections the tracker flipped between dotted-quarter and half-note beats (15% of bars got 3 beats). Fix: a Viterbi tempo path (§3, score grid). 94% of bars then have 4 beats; Starlight's 115 → 92 change and a synthetic 120 → 90 change are still followed.
2. **4/4 and a quarter beat were assumed.** In compound meter the eighths sit at ⅓ and ⅔ of the beat, which a 16th grid can't write (45% of notes came out shorter than an eighth). Fix: meter.py — subdivision, tatums, bar length, downbeats. A one-beat harmony window put Starlight's bar lines on its riff's last note and read Connections as 6/8; four beats fixed both.
3. **Rubato bars gained or lost an eighth** (27% of bars) and even stretching pushed onsets onto 16ths. Fix: `fit_bar` drops the slipped tatum where no note starts.
4. **Notation.** Off-beat arpeggio notes were tied into the next beat, detached chords were written as a 16th and a rest, and music21 wrote the gap-filling rests as hidden. Fix: the notation rules in §3.
5. **Hands.** The widest gap gave the left hand a tenth-wide arpeggio (F#3–A4); the pianist plays F#3–F#4 | G#4–E5. Fix: `span_cost`.
6. **Bleed steered the beat.** The grid followed every transcribed stem, including Basic Pitch on Demucs bleed in the silent vocal stem: rebuilding the old Connections grid from its piano notes alone placed only 225 of 453 written notes within 100 ms, against 442 with the bleed notes included. Fix: one grid per source, from that source's notes; silent stems are no longer transcribed.
7. **Tempo and key** were one value per piece. Fix: tempo marks (Starlight now shows ≈ 116 then ≈ 97), a MIDI tempo map in score time, and a conservative key plan (no piece here changes key; Starlight's right-hand line alone read 4 → 5 → 4 sharps, so keys come from all of a source's notes).

**Transcription (open item 8).** F1 0.976 (precision 0.985, recall 0.967) on bars 1–35. 15 notes missed, 11 of them soft left-hand notes struck together with a louder right-hand note; about 3 possible ghosts or repeats; no octave errors. The mix beat the Demucs stem again (F1 0.976 vs 0.972), so the solo-piano rule holds on a second piece. No change to this stage.

**Re-measured parameters (open item 4).** `local_splits` window, reach, bias, stick and one-hand span, one step either way: no piece's hand agreement improves (reach 17 makes 16% of Viva la FAI's chords unplayable). `key_lengths`: a voice-aware release changed no written length and made played lengths 1.5× the written ones, so legato-per-hand stays (open item 5). `SOLO_PIANO_DB`: others-vs-piano is −33 dB here, −24 dB on Starlight, +6.6 dB on Viva la FAI. Bass ×3: 1, 2, 3 and 5 give the same beat and downbeat F on both references. All unchanged.

**Out-of-sample check (no ground truth), Viva la FAI** (`viva-la-fai-v3`, run from scratch, `piano/lead+accomp`, against `viva-la-fai-v2`): unplayable chords 0.7% → 0.2%, notes shorter than an eighth 58% → 40%, ties 0.9% → 0.5%, meter 4/4 at 129, key F major, bass onsets on a counted beat 0.76 (the old tracker's own beats: 0.77). Demucs is not fully deterministic: this run's piano stem gave 1,101 notes (1,095 before), so small differences are expected. One regression was found and fixed on the way: a tatum guide built from local onset spacing jumped to the wrong subdivision on Viva's loosely timed playing (161 instead of 129 beats a minute); with `fit_bar` repairing slips the guide was not needed and is gone. `arrange` mode still runs (both variants, 4/4; `arrange/lead+accomp` short notes 54% → 37%).

**Limits / still open:**
- Ground truth is 35 bars of one piece (Connections) plus 8 bars of another (Starlight's intro, a different arrangement). Several new parameters (harmony window, DP cost, span cost) were chosen where Connections improved and Starlight held; that is two pieces, not a corpus.
- Downbeats: 81% of Connections' bar lines are exact; the misses are single bars one eighth late, where the left hand rests on beat 1 or its low note comes on the second eighth. A trained downbeat model (needs Jm's approval for a new pip package) is the likely next step.
- One voice per hand (both references write that way too); held melody notes over moving inner notes are cut.
- Loosely timed playing still yields many 16ths (Viva la FAI 39%).
- Out of scope here (non-piano, later): arrange-mode hand split at middle C, a vocal f0 front-end, lead-sheet mode, video styling, YouTube input.

All five were taken up the same evening: §11 (corpus, downbeats, hands, voices), §9 (lead sheet, arrange hands), §10 (sung lead), §6 items 5–6 (video, URL input).

## 9. Lead-sheet mode and chord recognition (2026-10-26)

`--parts lead+chords`: the right hand is the `lead` melody; chord symbols (music21 `ChordSymbol`, spelled for the key) go above the treble staff; the left hand plays one block chord per chord span, struck again at each bar line. Voicing: the bass (root, or a slash bass) in C3–B3, the other tones in close position above it, a seventh chord without its fifth, so the hand spans at most an octave. Chords come from the harmony and bass stems (`arrange`) or the whole piano part (`piano`).

**Recognizer** (`Tools/p2v/chords.py`, pure numpy). For each beat of the score grid: a pitch-class profile (sounding time × velocity) and a bass profile (frames where a pitch class is the lowest note). Score per chord = cosine with its template + 0.2 × bass share on the root − 0.08 per tone beyond three. "N" scores 0.25. A Viterbi path charges 0.3 for a change on a bar line or half bar and 0.6 on any other beat. Vocabulary: major, minor, 7 (`--chord-vocab full` adds maj7, m7, dim, sus4). A slash bass is written when another chord tone is the lowest note for ≥ 60% of the chord.

**Evidence: POP909** (909 pop songs as piano-arrangement MIDI with chord and beat annotations, MIT; `~/.kaya/piano2video/datasets/POP909/`). Input: the BRIDGE + PIANO tracks (the accompaniment, not the melody). Grid: POP909's own beat annotations, or `meter.score_grid` on the notes. Scored with `mir_eval.chord` against `chord_midi.txt`. Six parameters were grid-searched (432 settings) on songs **001–454**; all numbers below are on the other half, songs **455–909 (n = 455)**, mean ± SD over songs (median). Script: `~/.kaya/piano2video/scratch/agentC/pop909_eval.py`.

| Condition | Root | Major/minor | Changes on an annotated beat | on a bar line (reference: 0.61) | Changes / reference changes |
|---|---|---|---|---|---|
| Untuned start values, POP909 beats | 0.924 ± 0.063 | 0.912 ± 0.067 | – | – | – |
| **Tuned, POP909 beats** | **0.932 ± 0.055** (0.946) | **0.922 ± 0.059** (0.936) | 0.997 | 0.57 ± 0.21 | 0.88 ± 0.10 |
| Tuned, PIANO track only | 0.946 ± 0.049 | 0.942 ± 0.048 | – | – | – |
| **Tuned, `score_grid` beats** (the pipeline's own grid) | **0.928 ± 0.053** | **0.918 ± 0.057** | 0.92 ± 0.10 | 0.51 ± 0.23 | 0.93 ± 0.11 |
| Full vocabulary, POP909 beats | 0.926 ± 0.060 | 0.886 ± 0.082 | – | – | – |

Notes: (1) The tuning surface is flat: the best 8 of 432 settings are within 0.001 major/minor of each other on the tuning half. (2) The full vocabulary scores lower on major/minor (sevenths are mistaken for other triads' extensions); it stays an option. (3) POP909's chord labels came, as far as I know, from an automatic chord extractor (not checked here), so these figures may be agreement with another algorithm, not with a musician. (4) This is clean MIDI. On transcribed audio the notes have errors, and nothing measured that here.

**Rendered checks** (`~/.kaya/piano2video/out-agentC/`, page 1 looked at): Viva la FAI `arrange/lead+chords` (F major) reads F, B♭, C (I, IV, V) with changes on bar lines and half bars. Connections `piano/lead+chords` (A major) reads F♯m, D, A, Bm (vi, IV, I, ii). Both are plausible for the key. The flat and sharp in chord symbols are Verovio SMuFL glyphs cairosvg can't draw; `engrave_pdf` writes them as text b / #.

## 10. Sung lead: pYIN f0 front-end (2026-10-26)

`--lead-f0 auto|pyin|basicpitch` (`Tools/p2v/melody.py`). `auto` = pYIN when the lead stem is `vocals`, else Basic Pitch + skyline (measured on singing only). pYIN (librosa, C2–C6, 11.6 ms frames) gives a contour; a frame is voiced when pYIN found any pitch candidate (probability above its 0.01 floor) and is within 30 dB of the loudest frame. `contour_to_notes`: gaps ≤ 35 ms are bridged, frames > 9 semitones off a 0.5 s running median fold by octaves, the contour is median-smoothed over 0.12 s and rounded, and runs shorter than 0.12 s (vibrato swings, glides) join the nearest-pitch neighbour. Cached as `tx/<stem>-f0.json`.

Ground truth: **Vocadito** (Zenodo 5578807, CC BY 4.0), 40 solo-singing excerpts, annotator A1 notes. mir_eval: onset ±50 ms, pitch ±50 cents; F(offs) adds offset ratio 0.2. Octave errors = share of onset-matched notes 12 or 24 semitones off. Notes/ref = estimated ÷ reference note count (fragmentation > 1). "Demucs" = the same 40 excerpts laid over a solo-piano recording (Connections) at −6 dB and separated by `htdemucs_6s`, scored on the vocals stem.

| Audio | Front-end | Note F | F (offs) | Onset F | Octave err. | Notes/ref |
|---|---|---|---|---|---|---|
| solo | annotator A2 vs A1 (ceiling) | 0.723 | 0.634 | 0.817 | 0.0% | 0.84 |
| solo | Basic Pitch + skyline (before) | 0.532 | 0.361 | 0.611 | 0.8% | 0.88 |
| solo | **pYIN (now)** | **0.570** | **0.427** | **0.709** | 0.1% | 0.89 |
| solo | hybrid: Basic Pitch notes, pYIN pitch | 0.533 | 0.363 | 0.611 | 0.0% | 0.88 |
| solo | hybrid: octave fix only | 0.537 | 0.363 | 0.611 | 0.1% | 0.88 |
| Demucs | Basic Pitch + skyline (before) | 0.530 | 0.357 | 0.613 | 1.2% | 0.87 |
| Demucs | **pYIN (now)** | **0.568** | **0.404** | **0.706** | 0.0% | 0.88 |
| Demucs | hybrid: octave fix only | 0.536 | 0.358 | 0.613 | 0.2% | 0.87 |

The gain is onsets and note boundaries, not octaves: Basic Pitch's octave errors were already rare on these singers. The hybrids keep Basic Pitch's onsets and gain almost nothing. Rejected settings: pYIN's own HMM voiced flag (49% of unvoiced frames voiced; F 0.48), voiced probability ≥ 0.5 (recall 0.30), 0.07 s smoothing / 0.08 s minimum note (1.26× fragmentation). The parameters were tuned on the same 40 excerpts (no held-out split), so the solo numbers are optimistic; the Demucs run used the same parameters untouched.

Real song, Viva la FAI `--source arrange --parts lead` (pipeline before/after): 152 → 142 notes, jumps > 7 semitones between consecutive notes 8 → 6, notes < 100 ms 0.7% → 0%. Side effect, fixed: in `--parts lead` the beat grid followed the lead notes only, and with pYIN it moved from ≈ 129 to ≈ 108 beats/min (37 → 32 bars). `arrange` now always transcribes the active harmony and bass stems, so every arrange variant's grid follows the whole texture: ≈ 129 again with the pYIN lead.

## 11. Corpus check: 19 performed pieces (2026-10-26)

The §8 limit "two pieces, not a corpus" is now a harness. `Tools/p2v/corpus.py` scores the stages after transcription on **ASAP** (Foscarin et al. 2020, CC BY-NC-SA 4.0: scores, performance MIDI and every annotated beat and downbeat) with the real recordings from **MAESTRO** v3 (CC BY-NC-SA 4.0), 90 s of each, read straight out of MAESTRO's 108 GB zip with HTTP range requests (about 30 MB per piece). Data: `~/.kaya/piano2video/corpus/`.

```
cd skills/Content/PianoVideo/Tools
python -m p2v.corpus fetch                                # once: ASAP clone + 19 excerpts
python -m p2v.corpus run --label L [--input audio|midi] [--pieces tune|check|0,3]
python -m p2v.corpus compare A B                          # per piece + means (tune / check / all)
```

- **Pieces:** 19 one-meter pieces chosen for melody over accompaniment where possible: five in 4/4, four in 3/4, two in 2/4, five in 6/8, two in 12/8, one in 9/8 (`PIECES`). Even indices tune, odd ones check: a setting is adopted only when the held-out half agrees.
- **No guessed alignment:** score quarters map to performance seconds through the annotated beats; between two beats, score and played onset groups are matched in order by shared pitches. 97–99% of score notes then sit within 100 ms of their played note (straight lines between beats missed 21% by more than 100 ms in slow 6/8). ASAP's cut performances start 0.5 s before the `start` in its metadata (measured on all three cut pieces).
- **Inputs:** `audio` = the pipeline's own transcription of the recording; `midi` = the performance MIDI, key-ups extended by the pedal, to isolate the later stages.
- **Measures:** beat F at the annotated level and the best of ×½, ×2, ×3; downbeat F of the score's bar lines; meter = the score's; note, hand (staff) and melody agreement; written position in the bar and written length; reading load. The scores are classical, not pop covers: Connections and Starlight (§7, §8) stay the targets, and the corpus says whether a change holds elsewhere. Written lengths are compared with the score MIDI's lengths, which carry MuseScore's playback articulation: compare runs, not absolute values.

**Baseline** (main before this work; means over 19 pieces):

| | Recording (audio) | Performance MIDI | Connections (§8) |
|---|---|---|---|
| Note F1 (transcription) | 0.952 | – | 0.976 |
| Hand agreement | 0.878 | 0.876 | 0.85 |
| Melody F1 | 0.854 | 0.846 | 0.82 |
| Meter = the score's | 21% | 21% | yes |
| Beat F, annotated level / best level | 0.458 / 0.502 | 0.484 / 0.522 | 0.89 |
| Downbeat F | 0.330 | 0.355 | 0.81 |
| Notes in the right place in the bar | 0.119 | 0.126 | 0.93 |

**Finding 1 — the score grid does not generalize (open item: bar lines).** Transcription and hands hold up on the corpus; the grid does not. Meter is right on 4 of 19 pieces. The tracker usually finds eighths: a 6/8 dotted quarter near 40 beats a minute is outside its 50–170 range, and simple-meter pieces at 60–70 come out at the double. Diagnostic (`--input midi`): feeding the *annotated* beats into the rest of `meter.py` raises downbeat F from 0.355 to **0.705** and meter from 21% to 53% (68% when the subdivision is also given). So most of the loss is beat tracking itself (level and position), not the bar step. Tried and **not adopted**: a 30–200 range with the prior at 80 doubled meter accuracy (tune 20% → 50%, held-out 22% → 44%; downbeat F 0.32 → 0.42 and 0.39 → 0.40) with Connections and Starlight unchanged, but the tracker then no longer follows a short fast opening (the unit test's 6 bars at 120 then 90), and the looser change cost that restores it collapses the corpus (meter 0–10%: the level flips). A trained beat and downbeat model is the fix that fits this evidence: "Beat This!" (`beat-this` 1.1.0, MIT, adds only `rotary-embedding-torch`; torch unchanged) — **a new pip package, so Jm's approval** (the install was blocked pending it). ASAP is likely in its training data, so judge it on Connections, Starlight and Viva la FAI, and on the corpus only with its cross-validation folds.

**Finding 2 — hands (open item: Connections bars 46–49).** On the corpus the widest-gap split gave the right hand 9% of the notes the score puts in the left hand, against 2% the other way; in Rachmaninoff op. 23/4, 32% of notes went right while our left hand rested. Bars 46–49 are the same pattern: pedal-held notes made the left hand look busy, so the widest gap fell between the bass and a whole 15-semitone figure. `assign_hands_adaptive` is now a beam search (§3) that keeps the texture split as one cost and adds hand movement over time and lane. Hand agreement, the code before → after:

| | Corpus tune half | Held-out half | Connections | Starlight |
|---|---|---|---|---|
| Performance MIDI | 0.850 → 0.875 | 0.905 → 0.921 | 0.850 → 0.874 | 1.00 → 1.00 |
| Recording (transcribed) | 0.853 → 0.871 | 0.906 → 0.924 | – | – |

Melody F1 rises with it (corpus 0.854 → 0.869, Connections 0.822 → 0.851). One step either way on each weight moves no number above by more than 0.015. Costs: Connections' written-length agreement 0.689 → 0.664 (where a hand's notes are cut moves with the hands); ties 1.8% → 1.3%. In bars 46–49 the left hand now takes F#4, A4 and G#4 while the right keeps C#5–A5 (unit test on the transcribed excerpt). Starlight's unplayable chords 0.8% → 0.3%; Viva la FAI 0.2% (piano) and 0/454 (arrange) unchanged.

**Finding 3 — one voice per hand stays (open item: two voices).** The corpus scores do write voices, so the question is measurable there: of 12,143 matched notes, 6.2% are held in the score over a later note in the same staff, 5.5% are written shorter by us at those places, and 3.4% are a hand's top note — the most a held-melody second voice could fix. Both pop references write one voice per hand (0% to gain), and two voices make a staff harder to read for a beginner. Not built.

**Limits:** classical piano is not the target style, and its rubato is harder than most covers; the corpus checks generality, it does not set targets. 90 s per piece. The beat and downbeat numbers are what the next step (a trained tracker) has to move.
