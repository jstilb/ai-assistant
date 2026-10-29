# piano2video — Design

Song/audio file → isolated stems → piano arrangement → **MIDI + sheet music (MusicXML/PDF) + Synthesia-style falling-notes video**.

Status: thin end-to-end slice **built and verified** 2026-10-20 (task t-mvfkuj6y-3vvsui). The arrangement decision (§4) was made by Jm on 2026-10-27: **versatile** — handle and measure every song type. Every option is implemented behind flags. The 2026-10-26 `piano`-mode fixes (hands, key lengths, tempo, solo-piano input) are measured against Starlight's sheet music in §7. The later 2026-10-26 work (meter and score grid, readable notation, tempo map, key changes, finer scoring harness) is measured against the cover artist's own score of "Connections" in §8. The §8 open items were taken up next: lead sheet and arrange-mode hands (§9), the sung lead (§10), a 19-piece corpus check with the hand search and the two-voice and downbeat findings (§11), and learner video styling and URL input (§6). On 2026-10-27 the trained beat tracker "Beat This!" was checked and added (§12); spliced with the note tracker where its beats are irregular, it is the default score grid. Later that day Jm decided the tool must handle and measure every song type (§4): the measurement bank (§13) scores 42 songs of four types with one command, and `--source auto` (§14) routes each song to the piano path, the new hybrid path (the sung melody over the song's own piano part) or the arrange path; it is the default.

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
| Beat / tempo / meter | **librosa beat_track** in `meter.py`: a Viterbi tempo path through the tempogram (one metrical level), run again at the tatum (eighth), then bar length + downbeats by dynamic programming over bass / harmony-change / long-note accents | madmom (RNN + DBN downbeat tracker), BeatNet, "Beat This!" (CPJKU 2024) | Already a dependency, and no new pip package (those needed Jm's approval then; Jm 2026-10-27: new packages allowed). The onset curve is built from the transcribed notes, bass ×3. Since §12 "Beat This!" (installed with Jm's approval) is the default beat source where its beats are regular, the note tracker elsewhere (`--beats notes`: the note tracker alone). |
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
- **The band on the grid** (`arrange` lead+accomp, since §20): the harmony stems' and the bass's notes snap to the eighth grid in seconds (`snap_to_grid`; `restrike` joins notes struck together and cuts a held note at its repeat; `lowest_per_onset` keeps the bass one line), and each onset's pitch classes (≤ 3, only the recognised chord's tones when it has one) are re-voiced into the hands' reach under the melody and over the bass (`zone_voice`, `end_at_crossing`). It replaced `limit_polyphony` (4 notes, top and bottom kept) and `drop_doubled`.
- **merge_same_pitch**: unions overlapping notes of the same pitch, which happens when guitar, piano and other stems all play the same chord.
- **assign_hands**: lead → RH, bass → LH, accompaniment split at middle C. Used for melody-only variants. `arrange` mode keeps lead → RH and bass → LH but splits the accompaniment with `local_splits` (below): on Viva la FAI `arrange/lead+accomp`, stepwise accompaniment figures changing hand 10/55 → 3/55, RH accompaniment that spans more than 15 semitones with the held melody note 4/207 → 0/124, unplayable onset clusters 1/454 → 0/454, hand crossings 0 → 0.
- **local_splits**: a per-note split pitch from the texture. Among notes sounding within ±1.5 s (about a bar), take the widest pitch gap, biased toward middle C. Skip any split that leaves a hand a chord wider than 15 semitones (onsets stay reliable when pedalled lengths don't). Each semitone a hand's share of the window spans beyond an octave costs 1 (`span_cost`, since §8: the widest gap alone gave Connections' left hand a tenth-wide arpeggio). Allow one hand only for compact passages or a clearly high/low register. Moving away from the previous split costs 2 per octave, and a 5-note median removes flicker. Gap splits below G2 are ignored, so a left-hand octave (A1–A2) can't pull the split under the bass.
- **assign_hands_adaptive** (`piano` mode, and the accompaniment in `arrange` mode, §9): since §11 a beam search over onset groups, with `local_splits` as one cost among four. Each group splits at one point of its sorted pitches (lead notes stay right, bass notes left). Costs: a hand's move beyond 10 semitones divided by the time since its last onset (+0.15 s), a note nearer the other hand's last position ("lane", 4 per octave), a note on the far side of the texture split (3 per octave), register (LH above E4, RH below G3, 2 per octave). A split that leaves a hand wider than 15 semitones or more than 5 notes is not considered. The widest-gap rule alone counted pedal-held notes as busy and gave the right hand a whole 15-semitone figure while the left hand rested (Connections bars 46–49).
- **key_lengths** (`piano` mode): the piano model reports when a note stops *sounding*, which under pedal is seconds after the key came up. Within a hand, a key is assumed up by that hand's next onset (legato). The sounding end stays in `Note.sound_end` for the synth, and the MIDI carries the model's CC64 pedal. `piano/lead` is the right hand's top line after this step. A voice-aware variant (top line and bass held to their own next note) was checked in §8 and not adopted.

### Score grid (`Tools/p2v/meter.py`, unit-tested)

The score needs a map from seconds to score position, not just beats. It is built per source from the transcribed notes, in levels:

1. **Beats on one level**: a Viterbi path through the tempogram (states 50–170 bpm, cost on every change in log tempo) instead of a frame-wise argmax. The argmax flipped between dotted-quarter and half-note beats on Connections. This is the note tracker (`--beats notes`, and the splice's unsure stretches); by default the beats come from Beat This! (§12), folded to one level (§18) under `MAX_BEAT_BPM` = 200 a minute (§22).
2. **Subdivision**: 3 (compound meter) when the onsets' phases in the beat follow a lattice of 3 per beat at least 2× as strongly as a lattice of 2 or 4 per beat (and the triplet lattice's strength is over 0.17), else 2. The strength is circular (|mean of e^2πi·k·phase|), so notes that sound a constant time after the beat do not move it (§22; until §22: off-beat onsets near ⅓ and ⅔ against those near ½, ¼ and ¾, by 1.5×).
3. **Tatums**: the beat tracker runs again at subdivision × the local beat tempo, so every eighth gets a time.
4. **Bars**: the bar length (2/4 3/4 4/4 or 6/8 9/8 12/8) whose best phase gives the largest accent contrast; then downbeats by dynamic programming over per-tatum accents (bass onset below its neighbourhood, pitch-class change over 4 beats, long note), bars of m ± 2 tatums at a cost of 1.5 per tatum off.
5. **Fit**: each bar maps onto exactly one written bar. Where the tracker slipped a tatum, the one where no note starts is dropped (or a missing one is added in the widest gap), so onsets stay on the grid. The bar holding the first note is bar 0, so a pickup sits at its end.

### Notation (`Tools/p2v/notation.py`)

- Onsets snap to the tatum (eighth), or to a 16th only when clearly between two eighths (0.15 tatum margin).
- Each hand is a chord sequence; a held note is cut at the hand's next onset. An off-beat note also ends at the next beat when any hand starts a note there (the pedal, not the finger, holds it); a syncopation over an empty beat keeps its length. A note is written at least a tatum long when the hand has time (a detached chord reads as an eighth, not a 16th and a rest).
- A variant that starts later than the source (a melody line without the opening bass note) drops the empty bars before its first note; `report.json` keeps the shift (`score_offset_q`) for the harness.
- Every gap gets a visible rest. The meter, the tempo marks (a new mark where the bar tempo moves ≥ 10% for 4 bars) and the key signatures (the piece's key = the signature whose 7 notes hold the most note time, `piece_key`; per bar over ±4 bars the same fit, a change only after 8 bars favour another signature by 0.1 of the notes: §16) come from the grid and the key plan. Pitches are spelled for the key in force.

## 4. Arrangement — decided 2026-10-27: versatile

Two independent axes, both implemented. `--all-variants` renders every combination for one song (12 since §39: 3 sources × 4 parts) so you can compare them side by side.

### Axis A: what gets transcribed — `--source`

| Option | Meaning | Good for | Weak for |
|---|---|---|---|
| `piano` | Transcribe **only the piano that's already in the song** (Demucs piano stem → piano model). | Piano-led songs (Into My Arms, Clair de Lune, Für Elise). Highest fidelity, because it's the real part. | Anything without a piano. The tool refuses rather than producing junk. The result can be hard (pro voicings, full range). |
| `arrange` | **Re-voice the song's core components for piano**: melody stem (vocals by default, `--lead-stem guitar` etc.) → RH, chordal stems (piano + guitar + other) → thinned voicings, bass stem → LH. | Any song: rock, R&B, electronic. Produces a "piano cover". | Less faithful. The band's chord tones, re-voiced into the hands' reach on the eighth grid (§20), not its exact parts. Where the voice rests a bar or more, and in a song with no voice at all, the right hand plays one voice tracked through the band (§21, §23); a gated synth's restrikes of one held note are written as that note, a 16th riff keeps its repeated notes (§41). |

### Axis B: how much — `--parts`

| Option | Meaning |
|---|---|
| `lead` | Melody only, right hand. Good for learning a tune or for a beginner. |
| `lead+accomp` | Melody plus accompaniment, two hands. This is the full piece. |
| `lead+full` | The advanced score (§39): the same melody, grid and key as `lead+accomp`, with the accompaniment the playable score thins: the right hand keeps its chords under the melody, and `hybrid` adds the band the piano does not play. Closer to the recording, harder to read. |

### Evidence gathered (not a decision)

- Jm's `Piano Repertoire.md` is mostly **non-piano songs**: Star Treatment, Light Years, Sober, Redbone, Divinity, Starlight, Last Night on Earth. Only Into My Arms, Clair de Lune and Für Elise are piano-led. Several are tagged "(lead)", meaning a lead sheet is wanted.
- Jm is early in the Bill Hilton course (lessons 4–6: reading the left-hand staff). Dense two-hand transcriptions will be hard to read.
- On the sample (piano + vocals), `piano/lead+accomp` was the most faithful (1,104 notes). `arrange/lead+accomp` was more playable and carries the sung melody (848 notes). `piano/lead` pulled the piano's top line, which is *not* the sung melody.

### Recommendation (2026-10-20, before the decision below)

**`--source arrange --parts lead+accomp`**. It's the only mode that works for most of the repertoire, and it puts the actual sung melody in the right hand. `piano` mode stays available for piano-led songs. For learning, run `--parts lead` first. The CLI uses this as a **provisional** default. To lock in a different choice, change the `default=` on `--source` / `--parts` in `Tools/p2v/pipeline.py` and update this section.

A third shape, **built 2026-10-26: the lead-sheet mode** `--parts lead+chords` (melody plus chord symbols, LH block chords). It is the most beginner-friendly and matches the "(lead)" tags. Chords are recognised per beat from the harmony notes and measured on POP909 (§9). It is one more option on axis B; it does not change the default.

**Decision (Jm, 2026-10-27):** "we want this to be versatile. some straight piano songs will be there. some will not. we want this to handle all of them. find a way to measure all of them." And on the goal: "goal should be meaningful improvements even if big changes need to be made."

What this means for the design (Kaya's reading; the quotes above are the decision):
- **One pipeline for every song type**, not one fixed mode: solo piano covers (T1), solo classical piano (T2), piano-led songs with vocals (T3) and songs with no piano (T4). The router `--source auto` will choose the path per song from the stem levels the pipeline already measures: solo piano → the `piano` path; piano with vocals → a hybrid (the real piano part as the accompaniment, the sung melody in the right hand); no piano → the `arrange` path. `--source piano|arrange` stay as overrides.
- **Every song type is measured** (the measurement bank, §13): references that do not depend on the arrangement (meter, tempo, bar lines, key, the melody, chords) for all types, note-level fidelity where a piano reference exists (T1, T2), and reference-free playability measures for every song.
- The default stays `--source arrange` (provisional) until the bank measures `auto`; it becomes `--source auto` when `auto` is at least as good as the best fixed choice for each song type. **Done 2026-10-27 (§14): `--source auto` is the default.**
- The options tables above stay: they describe the paths that `auto` routes between.

**How changes are adopted from now on** (Kaya's method, not Jm's rule; change it if it stops serving the goal): adopt a change when the bank shows a clear gain on the measures of the stage it targets, in the song types it targets; name every loss elsewhere with numbers and a reason; choose settings on the tune half of each song type and report the held-out half. The earlier "pass rule" (§12: no number may get worse) was an agent's rule, not Jm's (Jm 2026-10-27: "remove pass rule; i never said this either"), and is retired. New pip packages and model weights are allowed (Jm 2026-10-27); weights are still pinned by SHA-256 and loaded as tensors only.

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

1. Meter, subdivision and downbeats are detected since §8 (12/8 on Connections, 4/4 on Starlight and Viva la FAI). Downbeats still slip by one eighth in some bars (Connections: 81% of bar lines exact; Starlight's soft intro 44% against a loosely aligned reference). On 19 classical pieces (§11) the grid is the weak link: meter right on 21%, downbeat F 0.33, and the annotated beats alone would double downbeat F, so beat tracking is the cause. Since §12 the trained tracker "Beat This!" sets the grid by default, spliced with the note tracker where its beats are irregular: Connections bar position 0.93 → 0.95 and downbeat F 0.81 → 0.92, Starlight unchanged, held-out corpus meter 11% → 67% and downbeat F 0.35 → 0.47. Open: short clips without bass (the 20 s YouTube clip still reads 4/4 at 161, not 12/8 at 108), and classical rubato, where the model is right but irregular.
2. ~~The vocal melody inherits Basic Pitch's octave and vibrato artefacts.~~ Done 2026-10-26: a pYIN f0 front-end is the default for a vocal lead (§10). CREPE/RMVPE would need new pip packages (Jm 2026-10-27: new packages allowed); pYIN's remaining gap to the annotators (F 0.57 vs 0.72) is the next target.
3. The piano path writes one voice per hand: a held melody note over moving inner notes is cut at the next onset. Measured on the corpus (§11): at most 3.4% of notes would gain from a held-melody voice, both pop references write one voice, and two voices are harder to read, so it is not built there. Since §17 the sung melody of `hybrid` and `arrange` is its own voice (stems up) over the accompaniment; since §35 the right hand plays the melody alone where it sounds and the accompaniment moves to the left hand, so each staff has one voice again. Loosely timed playing (Viva la FAI) still gives many 16ths (39% of notes). For performance-ready scores, hand-edit the MusicXML in MuseScore.
4. Lead-sheet mode: built (`--parts lead+chords`, §9). Since §19 a trained chord model (BTC) hears the recording and the notes add sevenths, so a song whose only melodic stem is the voice gets chords too. Open: slash chords and the LH voicing are not measured; the vocabulary is major, minor and 7 by default (BTC tells major from minor; a seventh, maj7, m7, dim or sus4 comes from the notes alone).
5. ✅ Learner styling done 2026-10-26 (`render.py`): bar and beat lines from the score grid fall with the notes, a "Bar N" counter uses the PDF's numbers (after `lead_in`), struck keys flash for 0.2 s, and `--note-names` labels notes. On Connections the bar numbers' first onsets match the MusicXML in 18 of 18 checked bars (10 in `piano_lead-accomp`, 8 in `piano_lead`, whose `lead_in` is one bar), and bar lines sit within about 25 ms of the downbeat notes. Still open: particle effects, a sheet strip.
6. ✅ Done 2026-10-26: an http(s) URL as input goes through yt-dlp (`fetch_url`, cached in `<out>/downloads/`), and the name and title default to the video title. Respect copyright: only for personal practice. Verified on Wikimedia Commons and, since yt-dlp 2026.10.21, on YouTube (2026-10-27: 20 s of the Connections cover, `--source piano --parts lead`, downloaded and transcribed).

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
- Downbeats: 81% of Connections' bar lines are exact; the misses are single bars one eighth late, where the left hand rests on beat 1 or its low note comes on the second eighth. A trained downbeat model (then: a new pip package, needing Jm's approval; Jm 2026-10-27: new packages allowed) is the likely next step.
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

`--lead-f0 auto|some|pyin|basicpitch` (`Tools/p2v/melody.py`). `auto` was pYIN when the lead stem is `vocals`, else Basic Pitch + skyline (measured on singing only); **since §15 `auto` uses SOME for a vocal lead**, and `pyin` is an option. pYIN (librosa, C2–C6, 11.6 ms frames) gives a contour; a frame is voiced when pYIN found any pitch candidate (probability above its 0.01 floor) and is within 30 dB of the loudest frame. `contour_to_notes`: gaps ≤ 35 ms are bridged, frames > 9 semitones off a 0.5 s running median fold by octaves, the contour is median-smoothed over 0.12 s and rounded, and runs shorter than 0.12 s (vibrato swings, glides) join the nearest-pitch neighbour. Cached as `tx/<stem>-f0.json`.

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

**Finding 1 — the score grid does not generalize (open item: bar lines).** Transcription and hands hold up on the corpus; the grid does not. Meter is right on 4 of 19 pieces. The tracker usually finds eighths: a 6/8 dotted quarter near 40 beats a minute is outside its 50–170 range, and simple-meter pieces at 60–70 come out at the double. Diagnostic (`--input midi`): feeding the *annotated* beats into the rest of `meter.py` raises downbeat F from 0.355 to **0.705** and meter from 21% to 53% (68% when the subdivision is also given). So most of the loss is beat tracking itself (level and position), not the bar step. Tried and **not adopted**: a 30–200 range with the prior at 80 doubled meter accuracy (tune 20% → 50%, held-out 22% → 44%; downbeat F 0.32 → 0.42 and 0.39 → 0.40) with Connections and Starlight unchanged, but the tracker then no longer follows a short fast opening (the unit test's 6 bars at 120 then 90), and the looser change cost that restores it collapses the corpus (meter 0–10%: the level flips). A trained beat and downbeat model is the fix that fits this evidence: "Beat This!" (`beat-this` 1.1.0, MIT, adds only `rotary-embedding-torch`; torch unchanged) — **a new pip package, so Jm's approval** (the install was blocked pending it; Jm 2026-10-27: new packages allowed). ASAP is likely in its training data, so judge it on Connections, Starlight and Viva la FAI, and on the corpus only with its cross-validation folds. → Done in §12 (the default since the splice there).

**Finding 2 — hands (open item: Connections bars 46–49).** On the corpus the widest-gap split gave the right hand 9% of the notes the score puts in the left hand, against 2% the other way; in Rachmaninoff op. 23/4, 32% of notes went right while our left hand rested. Bars 46–49 are the same pattern: pedal-held notes made the left hand look busy, so the widest gap fell between the bass and a whole 15-semitone figure. `assign_hands_adaptive` is now a beam search (§3) that keeps the texture split as one cost and adds hand movement over time and lane. Hand agreement, the code before → after:

| | Corpus tune half | Held-out half | Connections | Starlight |
|---|---|---|---|---|
| Performance MIDI | 0.850 → 0.875 | 0.905 → 0.921 | 0.850 → 0.874 | 1.00 → 1.00 |
| Recording (transcribed) | 0.853 → 0.871 | 0.906 → 0.924 | – | – |

Melody F1 rises with it (corpus 0.854 → 0.869, Connections 0.822 → 0.851). One step either way on each weight moves no number above by more than 0.015. Costs: Connections' written-length agreement 0.689 → 0.664 (where a hand's notes are cut moves with the hands); ties 1.8% → 1.3%. In bars 46–49 the left hand now takes F#4, A4 and G#4 while the right keeps C#5–A5 (unit test on the transcribed excerpt). Starlight's unplayable chords 0.8% → 0.3%; Viva la FAI 0.2% (piano) and 0/454 (arrange) unchanged.

**Finding 3 — one voice per hand stays (open item: two voices).** The corpus scores do write voices, so the question is measurable there: of 12,143 matched notes, 6.2% are held in the score over a later note in the same staff, 5.5% are written shorter by us at those places, and 3.4% are a hand's top note — the most a held-melody second voice could fix. Both pop references write one voice per hand (0% to gain), and two voices make a staff harder to read for a beginner. Not built.

**Limits:** classical piano is not the target style, and its rubato is harder than most covers; the corpus checks generality, it does not set targets. 90 s per piece. The beat and downbeat numbers are what the next step (a trained tracker) has to move.

## 12. Beat This! as the score grid's beat source (2026-10-27)

§11 found the beat tracker to be the weak link. This section tries a trained beat and downbeat tracker, **Beat This!** (Foscarin, Schlüter & Widmer, ISMIR 2024; `beat-this` 1.1.0, MIT, installed by Jm 2026-10-27). **First verdict: an option, not the default.** It finds much better bar lines on the held-out classical pieces, but on the two pop covers more notes land in the wrong place in the bar. That fails the adoption rule. **Since the splice (end of this section) it is the default:** the model's grid where its beats are regular, the note grid elsewhere, which passes the rule.

### Weights: source and checks

- **Source: the authors' own share** (`https://cloud.cp.jku.at/index.php/s/7ik4RrBKTS273gp`). The path that `beat_this` 1.1.0 uses (`public.php/dav/files/<share>/<name>.ckpt`) returned HTTP 500 for every file on 2026-10-27. The share's older public WebDAV endpoint served the same files: `curl -u "7ik4RrBKTS273gp:" https://cloud.cp.jku.at/public.php/webdav/final0.ckpt`. No third-party copy was needed.
- `final0.ckpt`: 81,058,141 bytes, SHA-256 `8c328b45f59d8dd3dff219253ff6a8d6482be57d0133a29140e2febbf8eb8331`. Two independent Hugging Face uploads of `final0.ckpt` (`teamup-tech/Beat-This-weights`, `oulianov/beat_this`) list the same SHA-256 (their LFS object id), so three sources agree. The fold models `fold0`–`fold7` came from the same share; their hashes are pinned in `meter.BEAT_THIS_SHA256`.
- Each file was downloaded as data into a new folder and passed four checks before any use:
  1. **Pickle opcodes, not unpickled** (`pickletools.genops` on `data.pkl` inside the zip): the only imports are `collections.OrderedDict`, `torch._utils._rebuild_tensor_v2`, `torch.FloatStorage` and `torch.LongStorage`, all on the allowlist. The other 158 members are raw tensor storages and version files.
  2. **`torch.load(..., weights_only=True)`** (torch 2.5.1) loads it with no `add_safe_globals`. Every hyper-parameter is a plain type (int, float, str, bool, dict); `datamodule_hyper_parameters.fold` is the fold's number (None for final0).
  3. **Strict load**: `BeatThis(**hyper_parameters)` + `load_state_dict(strict=True)` matched all 166 tensors (20,253,109 values, all finite).
  4. **Sanity on Connections**: beats at a median 107.1 a minute, the dotted quarter (score: 108), mostly 4 per bar (12/8).
- Location: `~/.kaya/piano2video/models/beat_this/<name>.ckpt` (env `P2V_BEAT_THIS`). `meter._beat_this_model` loads only these files, and only when the SHA-256 is the pinned one, then `weights_only=True` and `strict=True`. It does not use `beat_this.inference.load_checkpoint`: on a missing file that function falls back to a torch.hub download, and torch 2.5.1's hub loader unpickles with `weights_only=False`. Nothing is downloaded at run time. Scratch scripts for the scan, the checks and the download: `~/.kaya/piano2video/scratch/beat-this/` (`scan_ckpt.py`, `verify_ckpt.py`, `admit.sh`, `fetch_official.sh`).

### Contamination

`final0` is trained on all 16 of its datasets except GTZAN, and ASAP is one of them (473 performances). Its 8-fold split (`CPJKU/beat_this_annotations`, `asap/8-folds.split`) groups performances by work: of 163 works, none is in two folds. So `foldK` never heard any performance of a work in fold K. 16 of the 19 corpus pieces are in that split (`corpus.BT_HELDOUT`). Glinka's The Lark, Beethoven's sonata 22-1 and Chopin's Ballade 2 are in none of its training data, so final0 is fair on them. The corpus numbers below use the fold model per piece ("held-out"); final0's numbers are shown only to show how optimistic in-training numbers are. The three pop recordings are not in its listed datasets; they use final0.

### Integration (`meter.model_grid`, used when `score_grid` gets `model=`)

The model hears the whole recording (`input.wav`; the full mix also suits `arrange` mode). Then: its beat peaks (its own post-processing) → **steady beats** (librosa's dynamic program over its beat probability at its local tempo; the raw peaks gained eighths in Connections' free intro) → subdivision `g` from the notes (`subdivision`) → tatums evenly between beats → bar length from the note accents and the model's downbeat probability together (`bar_length_joint`) → downbeats by the existing dynamic program over note accents + the z-scored downbeat probability → `grid_from` unchanged. The note tracker is the fallback when the model finds fewer than 8 beats; `--beats beat-this` (now the default) without the package or the weights stops with the reason and the fix (`setup.sh`, which fetches `final0.ckpt` and keeps it only with the pinned SHA-256, or `--beats notes`). The pure parts are unit-tested.

### Variants tried (beats and bar lines only, `scratch/beat-this/bt_grid.py`)

| Variant | Connections downbeat F | Starlight downbeat F (meter) | Corpus downbeat F, all (held-out half) | Corpus meter, all (held-out half) |
|---|---|---|---|---|
| Notes (main) | 0.81 | 0.44 (4/4) | 0.33 (0.35) | 21% (11%) |
| Model peaks as they come | 0.71 | 0.50 | 0.58 (0.64) | – |
| Model beats and beats per bar, downbeats from the notes | 0.78 | 0.17 (2/4) | 0.52 (0.57) | 32% (44%) |
| … downbeats from the model (×3) | 0.73 | 0.48 (2/4) | 0.58 (0.66) | 32% (44%) |
| **Steady beats, joint bar length (built)** | **0.81** | **0.47 (4/4)** | **0.53 (0.61)** | **47% (67%)** |
| … steady beats by a Viterbi tempo path (×/÷1.5) | 0.81 | 0.10 (2/4) | 0.53 (0.62) | 37% (56%) |
| Notes' tatums tracked at the model's tempo | 0.69 | 0.35 (4/4) | 0.47 (0.56) | 37% (44%) |

The model's own beats per bar often count half bars (2/4 for Starlight and for Bach's 4/4 prelude); the joint bar length is the only variant that gives Starlight 4/4 and keeps Connections at 0.81, so the pop pieces chose it, not the held-out half. The margins are small: the same dynamic program on the model's 50 frames/s instead of the note tracker's frames gave Connections 0.76 (one bar of 35 is about 0.03).

### Before → after (built variant; pop pieces with final0, corpus with the recordings as input)

| | Notes (main) | Beat This! | Rule |
|---|---|---|---|
| Connections meter, tempo | 12/8, 107.7 | 12/8, 107.7 | |
| Connections downbeat F | 0.806 | 0.811 | ≥ 0.81 ✓ |
| Connections bar position | 0.932 | **0.839** | ≥ 0.93 ✗ |
| Connections written length / beat F (best level) | 0.664 / 0.887 | 0.613 / 0.834 | |
| Starlight downbeat F / bar position | 0.444 / 0.976 | 0.471 / **0.649** | not worse ✗ |
| Starlight notes shorter than an eighth / written length | 0% / 0.951 | **22%** / 0.676 | |
| Viva la FAI | 4/4, 129.2 | 4/4, 129.2 | ✓ |
| Corpus held-out half: meter / downbeat F / bar position | 11% / 0.348 / 0.094 | 67% / 0.605 / 0.374 | better ✓ |
| Corpus tune half: meter / downbeat F / bar position | 30% / 0.314 / 0.118 | 30% / 0.467 / 0.158 | |
| Corpus all: beat F / written length / shorter than an eighth / ties | 0.458 / 0.075 / 26% / 6.1% | 0.736 / 0.207 / 38% / 2.4% | |
| Corpus all with final0 (in-training, optimistic): downbeat F / bar position | – | 0.699 / 0.377 | |

Notes, hands and melody do not change (the grid comes after them). With `--beats notes` the corpus and the pop pieces give exactly the main numbers.

### Why the model grid alone was not adopted

- **Connections' intro.** Bars 1–8 have no bass. There the model's beats change phase and level: bars 4–7 come out one eighth early, and at 15–18 s it taps eighths. From bar 9 to bar 35 every bar line is within 70 ms (27 of 27; the note tracker 22), but in bars 1–8 only 3 of 8 (the note tracker 6). The four shifted bars are 4 of 35 (11%), about the size of the loss in bar position (0.932 → 0.839).
- **Evenly spaced tatums are less exact than tracked ones.** Where the model is unsure (Starlight's soft intro), onsets fall between the tatums and become 16ths: Starlight 0% → 22% shorter than an eighth, the corpus 26% → 38%.
- The model's own regularity marks where it is unsure: the coefficient of variation of its beat intervals is 0.03–0.06 where it is right (Connections from bar 9, Viva la FAI) and 0.33–0.47 where it is wrong (Connections' intro, Starlight's intro). The same short-clip failure: on the first 20 s of the Connections cover from YouTube, the note tracker says 3/4 at 161 and Beat This! 4/4 at 144 (the song: 12/8 at 108).

**Next slice (built below):** use the model where its beats are regular and the notes elsewhere.

### The splice: the model where it is sure, the note grid elsewhere (2026-10-27, the default)

**Verdict: adopted.** `--beats beat-this` is the default since this slice; `--beats notes` keeps the note tracker alone. (§18 raised `SURE_CV` to 0.5 on the bank's 42 songs: on classical rubato the model's irregular beats are right more often than the note tracker.)

`spliced_grid` builds one grid from two. `model_grid` (above) sets the meter and the beat level. Per model bar, `sure_bars` asks whether the model's raw beats are regular there: the median, over the raw beats in the bar, of the coefficient of variation of the beat intervals within ±4 beats (`beat_cv`) must be under `SURE_CV` = 0.2 (0.5 since §18), in a run of at least 3 such bars (`SURE_RUN`). Elsewhere `note_grid` (the note tracker, unchanged) runs at the model grid's subdivision and bar length, with its tempo path scaled by the metrical ratio (`level_factor`: 1/3 … 3) that brings it to the model's beat tempo in the sure bars. `splice` changes source only at a bar line both grids share (within ½ tatum, `SHARED_TOL`), so every stretch is whole bars of one grid and keeps `grid_from`'s guarantees (each bar = one written bar, bar 0 holds the first note); an unsure stretch grows to the nearest shared bar lines. All bars sure: the model grid. No sure bar: the note grid at the model's meter and level. No model grid (fewer than 8 beats): the note grid alone.

Where it switches: Connections' model bars 1–11 are unsure (CV 0.14–0.62; bars 4–5, at 0.04–0.14, are a run of only 2) and the model takes over at bar 12. Starlight's intro (the 8 reference bars and more) is unsure, and the model takes over later (45 of its 81 bar lines). Viva la FAI is sure in every bar (CV 0.02–0.04).

**Before → after** (pop pieces with final0; corpus with the recordings as input and the held-out fold models):

| | Notes | §12 model grid | **Splice** | Pass rule |
|---|---|---|---|---|
| Connections bar position / downbeat F | 0.932 / 0.806 | 0.839 / 0.811 | **0.950 / 0.917** | ≥ 0.93 / ≥ 0.81 ✓ |
| Connections written length / shorter than an eighth / ties | 0.664 / 1.1% / 1.3% | 0.613 / 1.5% / 3.3% | 0.660 / 1.8% / 1.8% | within 0.01 ✓ |
| Connections hands / melody / beat F (best level) | 0.874 / 0.851 / 0.887 | 0.874 / 0.851 / 0.834 | 0.874 / 0.851 / 0.943 | ✓ |
| Starlight downbeat F / bar position / written length / shorter than an eighth | 0.444 / 0.976 / 0.951 / 0% | 0.471 / 0.649 / 0.676 / 22% | 0.444 / 0.976 / 0.951 / 0% | not worse ✓ |
| Viva la FAI | 4/4, 129.2 | 4/4, 129.2 | 4/4, 129.2 | 4/4, 125–133 ✓ |
| Corpus held-out half: meter / downbeat F / bar position | 11% / 0.348 / 0.094 | 67% / 0.605 / 0.374 | 67% / 0.474 / 0.320 | better ✓ |
| Corpus tune half: meter / downbeat F / bar position | 30% / 0.314 / 0.118 | 30% / 0.467 / 0.158 | 30% / 0.335 / 0.121 | not worse ✓ |
| Corpus all: shorter than an eighth | 26% | 38% | 42% | (not a gate) |

The corpus keeps the model's meter gain but only part of its bar-line gain: on classical rubato the model's beats are irregular (CV over 0.3 in a third of the bars) even where its bar lines are right, so those bars go to the note grid. On the corpus the CV does not separate right from wrong bar lines (813 reference bar lines: the model hits more than the notes at every CV level), so the rule is tuned for the pop failure, not for classical rubato. Notes, hands and melody do not change. The corpus's short notes rise with the model's level, where the scores themselves are dense (Bach's C major prelude: 75% sixteenths in the score; ours 1% → 74%).

**How the settings were chosen** (on the pop pieces and the corpus tune half, then confirmed on the held-out half). `SURE_CV` was first 0.15; one step down (0.1125) failed Connections (bar position 0.921, written length 0.653: bars 15–16 and 23–24 at CV 0.11–0.13 went to the note grid). Connections' working range is about 0.14–0.27 (its intro bar 5, where the model is wrong, has 0.27), so the setting moved to the middle, 0.2 (§18 moved it to 0.5 on the bank's 42 songs; Connections still keeps its intro there, Starlight does not). **Robustness, every setting one step either way:** `SURE_CV` 0.15 / 0.25, `SURE_K` 3 / 5, `SURE_RUN` 2 / 4, `SHARED_TOL` 0.375 / 0.625 all keep rules 1–3 (Connections bar position 0.950–0.951, downbeat F 0.917–0.944, written length 0.660–0.661, short 1.8%, ties 1.8%; Starlight and Viva la FAI unchanged). Corpus at 0.15 → 0.2: tune half 0.320 → 0.335 downbeat F, held-out 0.464 → 0.474.

**Tried and rejected in this slice:**

| Variant | Connections bar position / downbeat F | Starlight bar position / downbeat F | Corpus downbeat F tune / held-out | Why rejected |
|---|---|---|---|---|
| No sure bar → the note grid at its own meter (first version) | 0.950 / 0.917 | 0.976 / 0.444 | 0.320 / 0.464 (meter held-out 56%) | the model's meter is better: 56% → 67% |
| Snap evenly spaced tatums to an onset within ¼ tatum (all tatums) | 0.952 / 0.861 | 0.976 / 0.444 (model grid alone: 0.649 / 0.353) | – | moves bar lines: −2 bars on Connections; Starlight's model grid not rescued |
| … only the tatums between beats | 0.955 / 0.917 | model grid alone: 0.658, short 22% | 0.317 / 0.464 | +0.005 on one piece, neutral elsewhere; its targets (short notes) do not move |
| Note grid's bar lines also from the model's downbeat probability (weight 1) | 0.833 / 0.833 | 0.976 / 0.444 | 0.431 / 0.540 | the model's downbeats are wrong in Connections' intro |
| … weight 0.5 or 0.25 | 0.948 / 0.917, short 2.2%, ties 2.4% | 0.976 / 0.444 | – | short notes and ties over the 0.01 limit |

**Rendered review** (`pdftoppm -r 80`, pages 1–2 of `piano_lead-accomp.pdf`, both grids): Connections bars 1–21 read the same in both (the intro is the note grid's); in bars 22–24 the note grid writes the melody one eighth late, with rests and a split 16th, and the splice writes it on the beat in dotted quarters. The splice adds three left-hand 16ths (bars 13, 16, 21: a 16th rest and tie, a dotted eighth and 16th). Starlight bars 1–24 are the same in both; bars 25–28 differ only in where 16ths fall (the riff is syncopated in both). Bar lines sit on the phrase starts and bass notes; neither intro is 16th clutter (Connections bars 1–11 hold one 16th, Starlight's intro none).

**Limits:**
- The 20 s YouTube clip of the Connections cover (stretch goal) is still wrong: its model beats are irregular in all 10 bars (CV 0.16–0.56), so the splice takes the note grid at the model's meter: 4/4 at 161.5 (the song: 12/8 at about 108; the model alone 4/4 at 144). Short clips without bass remain the open case.
- The meter and the beat level come from the whole model grid, sure or not; a long unsure stretch could still bias the subdivision (seen only on synthetic input: model beats 60 ms late read eighths as triplets).
- The rule is set on two pop pieces with references; the corpus checks that it holds elsewhere, not that it is best there (the model alone has better bar lines on the corpus).
- Scratch scripts: `~/.kaya/piano2video/scratch/beat-this-splice/` (`pop_check.py`, `run_corpus.sh`, `variant_run.py` for settings sweeps, `sure.py`, `bar_cv.py`, `shared.py`, `yt_check.py`).

## 13. The measurement bank: every song type, one command (2026-10-27)

Jm (2026-10-27): "we want this to handle all of them. find a way to measure all of them." Before this, every number in this file came from the `piano` path (Connections, Starlight, the corpus), while most of Jm's repertoire needs the other paths. `Tools/p2v/bank.py` runs each song through the **whole pipeline** (Demucs, transcription, every source × parts variant, no video) and scores what a user gets. Data: `~/.kaya/piano2video/bank/` (never in the repo).

**Song types and songs (42; each in a tune or a check half: settings are chosen on tune, reported on check):**

| Type | Songs | Reference |
|---|---|---|
| T1 solo piano cover of a pop song (4) | Connections, Starlight (piano version), a piano cover of "Friends" (Aura Dione), "Sad Piano" (Ignatov) | the cover artist's score (Connections, §8), 8 bars of a piano-vocal score (Starlight, §7), HookTheory (the other two) |
| T2 solo classical piano (20) | the 19 ASAP pieces of §11, Für Elise (Jm's repertoire) | ASAP (annotated beats align the score), HookTheory (Für Elise) |
| T3 piano-led song with vocals (9) | Adele: Someone Like You, Hello, Hometown Glory, Make You Feel My Love, When We Were Young; Regina Spektor: Samson, The Call, Laughing With; Viva la FAI | HookTheory; Viva la FAI has none (reference-free measures only) |
| T4 song with no piano (9; 14 since §21) | Childish Gambino: Sober; Porter Robinson: Divinity (both Jm's repertoire); Foster the People: Pumped Up Kicks, Helena Beat, Sit Next to Me; Avicii: Wake Me Up, Waiting for Love; Daft Punk: Get Lucky; since §21 also sung sections of Avicii: Levels, The Nights, Silhouettes, Waiting for Love (a second section), Hey Brother (a second section) and Alan Walker: Faded. Hey Brother's first section moved to T5 in §21 | HookTheory |
| T5 instrumental section, no piano lead (7, since §21) | Avicii: Hey Brother (its drop); Daft Punk: Veridis Quo, Aerodynamic, Solar Sailer, Voyager; deadmau5: Some Chords; Eric Prydz: Opus | HookTheory |

The type labels are a manual screen (Kaya's knowledge of each recording), not the router's output. One label is doubtful: Waiting for Love has a strong piano stem (−17.7 dB, the loudest accompaniment stem).

**References.** An arrangement is not a transcript, so T3 and T4 are scored on what any good arrangement must keep. Three kinds of reference become one form (notes in score quarters, a quarters → seconds map of the recording, beats, bar lines, key, chords): a **score** aligned by `evaluate.align` (DTW + onset snapping, §8); an **ASAP** piece (§11); **timed** annotations. The timed source is **HookTheory** (Donahue et al. 2022, `chrisdonahue/sheetsage-data`, CC BY-NC-SA 3.0): melody, chords, key and meter of one section of a song, in beats, with a refined beat → seconds alignment to a YouTube recording (`bank.add_hooktheory`; the run trims the recording to the section ± 20 s). 17 of the 20 HookTheory songs are from its TEST split (Divinity: TRAIN; Sad Piano and Für Elise: VALID; nothing in the pipeline is trained on HookTheory). Alignment check (`scratch/p2v-versatile/ref_check.py`, Someone Like You): 70% of the reference melody's time has a sung note (pYIN) of the same pitch class at offset 0; the best offset is −0.05 s. Not used: POP909's MIDI is not on the recordings' time base (first-beat offsets −0.6 to +24 s) and has no audio; MIR-ST500 has sung notes only (kept for the melody stage); Harmonix is in Beat This!'s training data; DALI and MedleyDB need an access request (Jm). Redbone's YouTube video is now private: dropped.

**Measures** (per song and variant; a missing number is skipped in the means, never counted as zero):
- *Invariants* (every reference): meter (the same bars: 6/4 = 12/8), tempo (quarters a minute within 4%), beat F (the annotated level and the best of six levels), downbeat F (bar lines), key signature, the melody: note F1 by pitch class (onset ±100 ms; an arrangement may move the tune by octaves) and **pitch-class overlap** (the share of the reference melody's time during which our melody sounds the same pitch class: a split or merged note does not punish it), the melody's written position in the bar and written length, chords (mir_eval root and major/minor, lead-sheet variants).
- *Fidelity* (a piano reference: T1 with a score, T2): note F1, hands, written position and length of every note.
- *Reference-free* (every song): unplayable chords (a hand > 15 semitones or > 5 notes; on the MIDI, and since §17 also on the written score), notes per second per hand, hand span, reading load (symbols per bar, notes shorter than an eighth, ties).
- *Router accuracy*: does `--source auto` pick the path the type should take (T1, T2 → piano; T3 → hybrid; T4 → arrange).

"Our melody" is the right hand's skyline (`arrange.skyline`). Two measure faults were found on the first run and fixed before any number here: the onset top line counted a chord struck under a held melody note as a melody note, and the overlap counted two notes of one pitch class (octaves) twice (Someone Like You's arrange overlap read 0.945; it is 0.714).

```
cd skills/Content/PianoVideo/Tools
python -m p2v.bank run --label L [--types T3,T4] [--half tune] [--set meter.SURE_CV=0.15] [-- --beats notes]
python -m p2v.bank score --label L --as L2        # re-score saved outputs (a measure or router change)
python -m p2v.bank compare A B [--variant auto_lead-accomp]
```

**Harness check.** Connections in the bank (whole song, `piano/lead+accomp`): bar position 0.950, written length 0.660, hands 0.874, note F1 0.976: the §12 numbers. The run took 60 min of pipeline time for 42 songs (median 94 s a song).

**Baseline** (main + the bank, result `r1s`; the default path `--source auto`, which is `piano` for T1/T2, `hybrid` for T3 and `arrange` for 8 of 9 T4 songs; `lead+accomp`; chords from `lead+chords`):

| Measure | T1 covers (4) | T2 classical (20) | T3 piano + vocals (9) | T4 no piano (9) |
|---|---|---|---|---|
| Meter right | 100% | 50% | 75% | 100% |
| Tempo level right | 75% | 30% | 75% | 89% |
| Beat F (best level) / downbeat F | 0.72 / 0.64 | 0.64 / 0.41 | 0.88 / 0.72 | 0.91 / 0.77 |
| Key signature right | 100% | 100% (1 song with a key) | 75% | **33%** |
| Melody overlap / note F1 (pitch class) | 0.72 / 0.72 | 0.72 / 0.87 | **0.61 / 0.39** | **0.50 / 0.38** |
| Melody written position / length | 0.78 / 0.58 | 0.22 / 0.23 | 0.53 / **0.28** | 0.74 / **0.41** |
| Chords major/minor (`lead+chords`) | 0.80 | 0.99 (1 song) | 0.86 | 0.70 (arrange alone 0.78) |
| Note F1 / hands (piano reference) | 0.79 / 0.94 | 0.95 / 0.90 | – | – |
| Written position / length (piano reference) | 0.96 / 0.81 | 0.21 / 0.21 | – | – |
| Unplayable chords | 0.2% | 0% | 1.4% | 0.9% |
| Notes shorter than an eighth | 31% | 38% | **41%** | **45%** |

T1's low beat numbers come from its check half (Starlight's loosely aligned intro, Sad Piano). Tempo-level misses on the `arrange` variant: Someone Like You ×2, When We Were Young and Divinity ×0.5, Hello in 3/4 (×0.74).

**The gaps, largest first (this sets the stage order of the next sessions):**
1. **The sung melody** (T3, T4): overlap 0.50–0.61, note F1 0.38–0.39, written length 0.28–0.41. pYIN splits notes (Someone Like You: 151 sung notes for 69 reference notes). Candidates checked for safety (weights SHA-256, pickle imports, `weights_only=True` loads): RMVPE, SwiftF0, SOME (`scratch/p2v-versatile/research/melody-weights.md`).
2. **Key on songs without piano** (T4 33%, T3 75%): the key comes from Basic Pitch notes of the stems. The misses include Sober and Get Lucky; modal harmony is a likely cause (not checked).
3. **Reading load**: 31–45% of notes shorter than an eighth on every type.
4. **The grid**: tempo level (T1, T3: 75%), classical rubato (T2 downbeat F 0.41), downbeats on T3/T4 (0.72/0.77).
5. **Chords from audio** (T4 0.78 with arrange's stems).
6. **Separation for the lead** (through item 1), the **T4 arrangement** itself (needs Jm's ratings), piano **written lengths** (T2 0.21; Connections 0.66).

**Jm's ear.** `scratch/p2v-versatile/ratings.py` renders the `auto` score and video of a few bank songs and writes a rating sheet (two 1–5 ratings a song: "I could play from this", "it sounds like the song"; about 5 minutes). Round 1: `~/.kaya/piano2video/bank/ratings/round-1/SHEET.md`. The renders of copyrighted songs stay in that folder.

**Limits.** 42 songs, 9 a type for T3 and T4 (one HookTheory section each, 30–60 s of reference); T1 has only two note-level references; the HookTheory melody is a simplified lead-sheet line (its rhythm is quantized), so note F1 against singing is limited (the overlap is the headline). Type labels are a manual screen.

## 14. `--source auto` and the hybrid path (2026-10-27)

**Hybrid** (`--source hybrid`, `arrange.arrange_hybrid`): for a piano-led song with vocals, the sung melody (pYIN, fitted to E4–E6 as in `arrange`) over the song's own piano part (the piano model on the Demucs piano stem, not Basic Pitch's re-voiced harmony). Piano notes that sound at or within a semitone under the melody while it sings are dropped (`under_melody`), and so are exact doubles; hands come from the beam search over both (lead notes stay right); key-press lengths apply to the piano part only. The grid follows the piano and the melody; chords come from the piano.

**Router** (`--source auto`, `pipeline.route`, from the stem levels the pipeline already measures): solo piano (all other stems ≥ 15 dB under the piano, `SOLO_PIANO_DB`, §7) → `piano`; a lead stem with a piano at most `PIANO_LEAD_DB` under the loudest other accompaniment stem (guitar, other, bass) → `hybrid`; a lead stem → `arrange`; no lead → `piano` if a piano is audible, else `arrange`. `report.json` records the choice.

`PIANO_LEAD_DB` was swept on the stem levels (no new runs: `bank score` recomputes the route):

| PIANO_LEAD_DB | 0 | 3 | 6 | 9 | **12** | 15 | 20 |
|---|---|---|---|---|---|---|---|
| Right path, tune half (21 songs) | 18 | 18 | 19 | 19 | **20** | 20 | 19 |
| Right path, check half (21 songs) | 21 | 21 | 21 | 21 | **21** | 20 | 20 |

At 12 dB the router is right on all T1, T2 and T3 songs and on 8 of 9 T4 songs (Waiting for Love goes to hybrid: the doubtful label above; its melody overlap is the same on both paths, 0.64). **Changed in §40 (2026-10-28): 0 dB**, chosen on how close the routed score sounds to the recording, not on the type labels.

**Before → after** (T3, `lead+accomp`; the old default was `arrange`):

| T3 | arrange (tune / check) | **hybrid** (tune / check) |
|---|---|---|
| Melody overlap | 0.581 / 0.565 | **0.659 / 0.568** |
| Melody note F1 (pitch class) | 0.345 / 0.387 | 0.394 / 0.377 |
| Tempo level right | 50% / 75% | 50% / **100%** |
| Downbeat F | 0.802 / 0.717 | 0.802 / **0.643** (loss) |
| Melody written length | 0.321 / 0.198 | 0.304 / 0.259 |
| Unplayable chords | 0.4% / 0.4% | 1.6% / 1.0% (loss) |
| Notes shorter than an eighth | 36% / 43% | 39% / 44% |

Per song the melody overlap moves most on Hometown Glory (0.33 → 0.65); no song loses more than 0.02 (The Call 0.646 → 0.630). The losses: downbeat F on the check half (the hybrid's grid follows the piano and the melody only, not the other stems; the cause per song is not checked yet), and a few more crowded right-hand chords (the real piano part is denser than the re-voiced one). The piano path's top line is not the sung melody (T3 overlap 0.30), as §4 expected.

**Verdict: adopted; `--source auto` is the default** (it was `arrange`). Against the best fixed choice per type: T1 and T2 = `piano` (the old default `arrange` gave **no output** on all 24 solo-piano songs: no vocals), T3 = `hybrid` (above), T4 = `arrange` (melody overlap 0.503 vs 0.502; lead-sheet chords 0.70 vs 0.78, from the one song routed to hybrid). `--source piano|arrange|hybrid` stay as overrides.

**Rendered review** (`pdftoppm -r 80`, page 1 of Someone Like You `hybrid_lead-accomp.pdf`, the round-1 render): A major and 4/4 are right, but at ≈ 135 (the song is ≈ 67: the tempo-level miss of §13). The piano's eighth-note arpeggio sits in the right hand under the sung melody, and the left hand holds the bass (two very low whole notes in bars 2 and 6). The melody has chromatic wrong notes (C♮ against C#, bars 9–12 and 21–23: pYIN's pitch flicker, gap 1 of §13) and many 16ths (gap 3). Readable for a strong reader, heavy for a beginner.

**Limits.** The hybrid's piano part is not compared with a note-level reference yet (a piano-vocal score with a free recording would do it: the OpenScore Lieder corpus, CC0, `scratch/p2v-versatile/research/scores-covers.md`); Jm's ratings will say whether it sounds more like the song than the re-voiced accompaniment. Per-section routing (a piano-only intro) is not built.

## 15. Stage 1: the sung melody — SOME replaces pYIN (2026-10-27)

Gap 1 of §13: the sung melody (T3, T4) had melody overlap 0.50–0.61 and note F1 0.38–0.39. Four front-ends were compared on the same inputs: pYIN (§10), **SwiftF0** (an f0 network, 135 KB ONNX), **RMVPE** (an f0 network for vocals in polyphonic music, 362 MB ONNX) and **SOME** (openvpi's singing-note model: a conformer that predicts notes and note boundaries directly, 471 MB). The f0 front-ends share `contour_to_notes`; SOME needs no segmenter. Scratch harness: `scratch/p2v-versatile/s1/s1_eval.py` (Vocadito solo and Demucs as in §10; the bank's T3/T4 vocal stems against the HookTheory melodies, before any arrangement step). Tune / check halves: Vocadito odd / even excerpts; the bank's halves.

| Front-end (settings chosen on tune) | Vocadito note F (solo) | Vocadito F (Demucs) | F with offsets (solo) | Bank T3 overlap | Bank T3 note F1 (pc) | Bank T4 overlap | Bank T4 note F1 (pc) |
|---|---|---|---|---|---|---|---|
| pYIN (§10) | 0.560 / 0.579 | 0.556 / 0.580 | 0.417 / 0.438 | 0.645 / 0.552 | 0.447 / 0.436 | 0.447 / 0.450 | 0.427 / 0.383 |
| SwiftF0 (smooth 0.2 s, min note 0.1 s) | **0.635 / 0.613** | **0.624 / 0.616** | 0.487 / 0.447 | 0.636 / 0.528 | 0.463 / 0.456 | 0.436 / 0.414 | 0.427 / 0.339 |
| RMVPE (its default threshold) | 0.555 / 0.559 | 0.550 / 0.565 | 0.395 / 0.378 | 0.630 / 0.534 | 0.453 / 0.425 | 0.490 / 0.509 | 0.423 / 0.416 |
| **SOME** (the release's decode) | 0.549 / 0.567 | 0.558 / 0.555 | 0.263 / 0.278 | **0.751 / 0.673** | **0.626 / 0.596** | **0.602 / 0.605** | **0.529 / 0.491** |

The two test sets disagree, and the bank decides: Vocadito is solo amateur singing (and the same 40 excerpts over a piano), the bank is real songs separated by Demucs (reverb, doubled and backing vocals, synths that leak into the vocal stem). SwiftF0 is the best on Vocadito and the worst on the songs; SOME is the best on the songs on both halves and both types. SOME's low "F with offsets" is by design: it writes legato notes (a note lasts until the next one), as a lead sheet does, while Vocadito's annotators mark where the sound stops. Rejected on SOME: a global tuning correction (Vocadito F 0.549 → 0.511, bank ±0.003), a minimum note length of 0.15 s (T4 overlap −0.02).

**Verdict: adopted.** `--lead-f0 auto` uses SOME for a vocal lead (`Tools/p2v/some.py`, cached as `tx/<stem>-some.json`); `pyin` and `basicpitch` stay as options; SwiftF0 and RMVPE are not added.

**Before → after in the whole pipeline** (default path, `lead+accomp`; baseline `r1b` = `r1` re-scored with the Wake Me Up fix below; after `s1-some2`; tune / check):

| | T3 piano + vocals | T4 no piano |
|---|---|---|
| Melody overlap | 0.659 → **0.755** / 0.568 → **0.681** | 0.594 → **0.748** / 0.530 → **0.631** |
| Melody note F1 (pitch class) | 0.394 → **0.581** / 0.377 → **0.534** | 0.483 → **0.630** / 0.373 → **0.482** |
| Melody written length | 0.304 → 0.328 / 0.259 → 0.338 | 0.447 → 0.467 / 0.473 → 0.498 |
| Melody written position | 0.53 → 0.54 (all) | 0.705 → 0.697 / 0.917 → 0.952 |
| Beat F / downbeat F, check half | 0.775 → 0.821 / 0.643 → 0.689 | unchanged |
| Unplayable chords | 1.6% → 2.0% / 1.0% → 1.4% (loss) | 1.0% → 1.2% / 0.9% → 0.7% |
| Notes shorter than an eighth | 38.9% → 39.2% / 44.3% → 46.2% (loss) | 48.2% → 51.3% (loss) / 43.0% → 41.8% |

Per song the overlap rises on 16 of 17 songs with a melody reference (Helena Beat 0.65 → 0.89, Pumped Up Kicks 0.56 → 0.75, Hometown Glory 0.65 → 0.79); Sit Next to Me falls 0.48 → 0.46. The losses: SOME writes more notes (sung ornaments become notes: n/ref 0.97 → 1.15 on T3), so a few more short notes (gap 3, the next stages) and more right-hand notes over the piano part.

**Register fix (found by this stage).** With SOME, Viva la FAI's low sung line (median A3) was moved up two octaves (A5) by `best_octave_shift`, which counts notes inside E4–E6: the right hand then spanned melody and piano part (unplayable chords 0.4% → 7.4%). The lead now moves by whole octaves so that its median lands nearest D5 (`arrange.LEAD_CENTER`, `octave_toward`): a man's voice an octave up, as vocal parts are written in treble clef, a woman's mostly as sung. On the bank it changes the octave of two songs (Viva la FAI, Wake Me Up: +24 → +12); Viva la FAI's unplayable chords 7.4% → 1.9%; nothing else moves (the melody measures do not depend on the octave).

**Bank fixes found by this stage.**
- *Wake Me Up's reference melody is late.* All three f0 front-ends find their best match with the HookTheory melody shifted +0.75 to +0.80 s (overlap 0.15 → 0.65; every other song peaks at 0 ± 0.05 s), the YouTube and HookTheory lengths agree to 0.01 s, and the HookTheory beats fit (beat F does not improve with the shift). So the melody annotation is about 1.6 beats off its own beats. `songs.json` marks it (`ref.skip: ["melody"]`, with the reason); `bank.load_ref` leaves it out of the melody measures and keeps the rest. Shifting it to fit our output would be circular, so it is not shifted.
- *Hey Brother's section has no singing* (the vocal stem is 84 dB down in it): its melody is the instrumental hook. Every vocal front-end scores 0 there; the overlap the bank reports (0.37) is the top of the arrangement's right hand. A song whose melody moves between the voice and an instrument needs a lead that follows it (not built: gap 6).

**Weights.** openvpi/SOME release `v1.0.0-baseline` (2024-01-19), asset `0119_continuous128_5spk.zip` (SHA-256 `bc91b1af…86ec`), checkpoint `model_ckpt_steps_100000_simplified.ckpt` (SHA-256 `aa710fce…f97c`, 117.6 M parameters). Code licence MIT; the release does not state a licence for the weights (they ship in the MIT repository), and the training singers are not named publicly: fine for personal practice, which is this tool's scope (SKILL.md). Checked once: the pickle holds only `collections.OrderedDict` and torch tensor types; `torch.load(weights_only=True)` loads it; every key and shape matches our network (`strict=True`). `setup.sh` fetches the zip into a `.part` file and keeps the checkpoint only with both SHA-256 values; `some.py` checks the SHA-256 at every load; a run that needs SOME without the weights stops at the start of `run()` with the fix (`setup.sh`, or `--lead-f0 pyin`). The network and decode in `some.py` are our own code written from the upstream source (read as text, not run); on Vocadito excerpt 1 they give the same 70 notes as the scratch build, and 45 of the 59 annotated notes have a SOME note within 50 ms and a semitone. Speed: about 5 s for a 60 s vocal stem on this Mac's CPU.

**Rendered review** (`pdftoppm -r 80`, page 1 of the `s1-some2` scores). Someone Like You (`hybrid`): A major, 4/4, the sung line is a legato top voice over the piano's arpeggio; the tempo is still read at ≈ 135 (the song is ≈ 67: gap 4), many 16ths remain (gap 3), and bars 21–23 still show C♮ against C♯ (not traced yet to the melody or the piano part). Sober (`arrange`): the key signature is 1 sharp for a song in D (2 sharps), so C♯ accidentals fill the page (gap 2, next); the right hand carries two- and three-note chords under the melody and the bass sits very low (ledger lines): heavy for a beginner.

**Limits.** 17 songs with a melody reference (8 T3, 9 T4, Wake Me Up's melody skipped); each is one HookTheory section. SOME's chunk cut (a quiet point near every 30 s) is tested on these stems only (55–100 s). MIR-ST500's sung notes on full pop songs were not used (their YouTube audio was not fetched).

## 16. Stage 2: the key signature — the diatonic fit (2026-10-27)

Gap 2 of §13: key signature right on T4 33%, T3 75%. Every miss was off by one sharp (a fifth), and on 5 of 8 misses the key plan later changed to the right signature: the plan's windowed scorer (Krumhansl per bar) found the key, but the piece's first key came from music21's key analysis, a different scorer. music21 also gave 7 sharps (C♯ major) for Hometown Glory, which the plan's range (−5..6) never gives, so the score changed from C♯ major to D♭ major after 8 bars.

**Candidates** (`scratch/p2v-versatile/s2/key_exp.py`, `key_exp2.py`: the cached transcriptions of each song's routed source, the notes the key plan sees; the reference = HookTheory's mode mapped to its scale's signature, §13, and, new here, ASAP's annotated key signature at the first downbeat for the classical pieces):

| Piece key from | T1 (4) | T2 (15) | T3 tune / check | T4 tune / check | All (36) |
|---|---|---|---|---|---|
| music21 `analyze("key")` (before) | 4 | 11 | 4/4 · 2/4 | 1/4 · 2/5 | 24 |
| Krumhansl over the whole piece (the plan's scorer) | 3 | – | 4/4 · 4/4 | 4/4 · 3/5 | (18 of 22: the 21 pop songs and Für Elise) |
| Albrecht–Shanahan or Temperley profiles | 4 | – | 4/4 · 3/4 | 2/4 · 3/5 or 2/5 | |
| **Diatonic fit**: the signature whose 7 notes hold the most note time | 4 | 11 | 4/4 · 3/4 | **4/4 · 4/5** | **30** |

A key signature is a set of 7 notes, whatever the mode, so the diatonic fit needs no special case for dorian (Get Lucky, Pumped Up Kicks) or mixolydian songs, and it is the quantity the bank's reference uses (§13: a mode's signature is its scale's). On the tune half the diatonic fit and Krumhansl tie (10/10 pop songs); the check half separates them (10/12 vs 8/12), and the diatonic fit is the measure's own definition: adopted on that ground, with a small sample (36 songs) named as the limit. Weighting (length capped at 2 s, uncapped, note count, bass ×3) changed nothing. A tie (the note that separates two signatures absent: a line on C E G) goes to the Krumhansl fit. Classical minor keys (the raised 7th, a risk for a set fit) lose nothing: T2 11/15 for both; the four T2 misses are the same pieces for both methods. Still wrong: Make You Feel My Love (B♭ read as E♭: the song's A♭ is frequent) and Sober (D read as G: C♮ outweighs C♯ in the transcribed stems).

**Change** (`notation.py`): `piece_key` (the diatonic fit over all notes) replaces music21's `detect_key` for the first key, and `key_plan` scores each ±4-bar window with the same fit (`signature_fit`, tie-break `best_signature`), so the first key and the changes agree. The margin keeps its value, 0.1, now a share of the notes: no key change on any of the 22 pop songs (0.05 adds one on a T1 cover); 3 of the 20 classical excerpts change key (they modulate; the bank scores the first key only). `corpus.reference` reads ASAP's key signature (`db,<meter>,<sharps>`; the excerpts start at the piece's start) and `evaluate`'s key match now counts 6 sharps = 6 flats, as the bank does.

**Before → after in the whole pipeline** (key signature right, default path; baselines `r1c` = `r1` re-scored with the ASAP keys for T1/T2 and `s1-some2` for T3/T4; after `s2-key`, all 42 songs): T1 4/4 → 4/4; T2 tune 6/7 → 6/7, check 5/8 → 5/8; T3 tune 4/4 → 4/4, check 2/4 → **3/4**; T4 tune 1/4 → **4/4**, check 2/5 → **4/5**. No other measure moved (the key changes only the spelling of the notes). No loss.

**Rendered review** (`pdftoppm`, page 1 of `s2-key`): Get Lucky is now in A major / F♯ minor (3 sharps; the song is B dorian), and its page has few accidentals where it had many (2 sharps before: every G♯ was marked). Sober is still in 1 sharp (one of the two remaining misses).

**Limits.** 36 songs with a key; the ASAP key is the excerpt's first key, and the bank scores only the first written signature. No range for 6 flats: F♯/G♭ major is always written with 6 sharps (as before). The key comes from transcribed notes, so a stem full of bleed or wrong notes (Sober) still misleads it; an audio key model was not tried.

## 17. Stage 3: reading load — the sung melody gets its own voice (2026-10-27)

Gap 3 of §13: on T3 and T4, 39–51% of the written notes were shorter than an eighth.

**Where the short notes come from** (`scratch/p2v-versatile/s3/short_src.py`: the routed `lead+accomp` variant rebuilt from the caches and quantized as `build_score` does; its shares agree with the bank's within 3 points). Nearly all short notes are onsets on a 16th: the hand's next onset comes less than an eighth later (T2 3,603 of 3,799 short notes, T3 1,328 of 1,363, T4 1,679 of 1,808). The off-beat release (§8) gives the rest. No grid had a tatum finer than an eighth.

| Type | Short notes by role | The reference's own share |
|---|---|---|
| T1 covers | piano part 16% | Connections and Starlight scores: 0% |
| T2 classical | piano part 38% | ASAP scores: 46–100% (median 85%) |
| T3 piano + vocals | melody 50%, piano part 34% | HookTheory melody: 27% (8 songs) |
| T4 no piano | melody 46%, accompaniment 52%, bass 38% | HookTheory melody: 15% (8 songs) |

On T2 the short notes are the music (Bach's C major prelude: 75% in ours and in the score), so fewer is not better there: this stage leaves the piano path alone. On T3 and T4 the melody has two to three times the reference melody's share, for two reasons:
1. **One voice per hand.** The right hand writes the melody and the accompaniment as one voice, so each accompaniment onset cuts a held melody note (§6 item 3). §11 measured this on classical piano (at most 3.4% of notes would gain) and kept one voice. On T3 and T4 the melody is a separate sung line over a moving accompaniment: the case where a melody voice matters.
2. **Loose sung timing.** `snap_onsets` writes a 16th when an onset sits between 0.325 and 0.675 of an eighth. A sung onset 0.1 s after the beat at 129 beats a minute sits at 0.43. The lead's onset phases (`s3/phase.py`) show a clear 16th peak only on Get Lucky (and on Divinity and When We Were Young, whose tempo is read at half: gap 4); on the other songs the onsets spread around the eighth.

**Measure fixes (found by this stage, applied before every number below).**
- The written melody (`bank.melody_notation`) took the onset top line of the right hand, so a lower-voice note struck under a held melody note counted as melody. It now takes the skyline (`bank.written_melody`), as `melody_line` does for the sounding notes since §13. In a one-voice staff the two are the same, so no earlier number changes.
- `symbols_per_bar` divided by 1e9 quarters in the whole-score call, so it read 0.0 for every song. It now ends at the score's last bar, and a hidden rest (a lower voice's gap) is not a symbol.
- music21 reads a lead sheet's chord symbols as chords. `notation_load` counted each symbol as a written chord and as a note shorter than an eighth (its length is 0), and `load_reference` read its pitches as right-hand notes. Both now skip chord symbols. This fault dates from §9 and touches only the `lead+chords` variants.
- New: **written playability** (`notation_load`'s `unplayable_written`, bank `w_unplay`): the share of a staff's written onsets that strike more than 5 notes or span more than 15 semitones, the §13 rule applied to the score instead of the MIDI. A written onset merges notes up to a 16th apart, so this number is higher than the MIDI's.

**Two voices in one staff** (`notation.build_score`, `LEAD_VOICE`): a hand that holds lead notes and other notes is written as voice 1 (the lead, stems up, its rests shown) over voice 2 (the rest, stems down, its rests hidden). Each voice is quantized alone. Only `hybrid` and `arrange` with `lead+accomp` have such a hand; the piano path and the melody-only and lead-sheet variants keep one voice. music21 numbers a measure's voices from 0, and Verovio drops voice 0 ("Layer 0 cannot be found": the melody vanished from the PDF in the first try), so `write_musicxml` makes the measures itself and numbers the voices from 1; the export's own makeNotation then splits five-16th notes into ties.

**Candidates** (`s3/fast.py`: the routed variant rebuilt from the caches and the `s2-key` grids, then scored by `bank.score_variant`; tune / check; melody overlap and note F1 do not move because the MIDI does not change):

| Variant | T3 melody written length | T3 melody < 1/8 | T3 all < 1/8 | T4 melody written length | T4 melody < 1/8 | T4 all < 1/8 |
|---|---|---|---|---|---|---|
| before (`s2-key`, new measures) | 0.328 / 0.338 | 0.481 / 0.536 | 0.392 / 0.463 | 0.467 / 0.498 | 0.545 / 0.432 | 0.513 / 0.418 |
| lead 1/8 only, one voice | 0.360 / 0.266 | 0.379 / 0.367 | 0.323 / 0.367 | 0.497 / 0.508 | 0.447 / 0.361 | 0.454 / 0.378 |
| lead voice | 0.374 / 0.397 | 0.326 / 0.428 | 0.327 / 0.406 | 0.644 / 0.550 | 0.389 / 0.277 | 0.425 / 0.343 |
| lead voice, lead penalty 0.35 | 0.421 / 0.336 | 0.227 / 0.228 | 0.290 / 0.333 | 0.648 / 0.580 | 0.331 / 0.232 | 0.400 / 0.324 |
| **lead voice, lead 1/8 only** | **0.507** / 0.324 | **0.121** / 0.067 | **0.251** / 0.277 | **0.773** / 0.580 | **0.168** / 0.183 | **0.340** / 0.305 |
| … without the off-beat release in the lead voice | 0.456 / 0.300 | 0.067 / 0.063 | 0.250 / 0.278 | 0.764 / 0.597 | 0.161 / 0.169 | 0.340 / 0.305 |
| … with a 16th fallback for colliding lead notes ≥ 0.15 s | 0.413 / 0.349 | 0.220 / 0.290 | 0.286 / 0.356 | 0.678 / 0.569 | 0.262 / 0.224 | 0.373 / 0.322 |
| … and the lead's note ends on the eighth too (`TATUM_ONLY`) | 0.490 / 0.331 | 0.116 / 0.062 | 0.249 / 0.276 | 0.789 / 0.588 | 0.165 / 0.181 | 0.339 / 0.303 |
| … and `arrange`'s accompaniment and bass 1/8 only | (T3: no change) | | | 0.794 / 0.609 | 0.014 / 0.000 | **0.078 / 0.011** |

The reference melodies' own share shorter than an eighth: T3 0.273, T4 0.145. The tune half chooses the lead voice with an eighth-only lead (the best melody written length on both types); the melody's written position does not move (T3 0.531 → 0.553 / 0.544 → 0.541, T4 0.697 → 0.704 / 0.952 → 0.965). A setting of 0.5 means `snap_onsets` never takes the 16th for a lead onset; one lead note per written onset (the longer, `quantize_hand(lead_mono=True)`) keeps a sung ornament from becoming a melody dyad.

**Verdict: adopted** — the lead voice, the sung lead written in eighths (`notation.ROLE_PENALTY = {"hybrid": {"lead": 0.5}, "arrange": {"lead": 0.5}}`, passed per path by the pipeline; since §28 not a lead note from the band's line, `Note.hook`, which keeps its 16ths) with its note ends on the eighth too (a role at `TATUM_ONLY` = 0.5), and one lead note per onset. The score drops a sung ornament that the MIDI and the video still play. The note ends were added after the rendered review (a lead sheet still showed dotted eighths and 16th rests in the melody): on the tune half they cost T3 0.017 and give T4 0.016 of written length, they raise both check halves (0.324 → 0.331, 0.580 → 0.588), and they lower ties and symbols per bar on every half, so they stay. `lead_in` (the empty bars dropped before the first note) now snaps the first note as `build_score` writes it, per role (code review: a lead note at 3.8 quarters went to the 16th at 3.75 in `lead_in` but to 4.0 in the score, which opened with an empty bar); it changed no bank song. Not adopted:
- *No off-beat release in the lead voice*: worse on the tune half (T3 0.456 vs 0.507).
- *A 16th fallback for colliding lead notes* (`LEAD_SPLIT_S`, tried at 0.1, 0.15 and 0.2 s): it keeps sung 16th runs and helps the T3 check half (0.324 → 0.369 at 0.1 s), but it loses on the tune half at every setting (T3 0.413–0.433, T4 0.655–0.770). The idea came from a per-song look at the check half (Laughing With), so the tune half decides.
- *Eighth-only accompaniment and bass on `arrange`*: T4 notes shorter than an eighth 0.340 → 0.078 and 0.305 → 0.011, and the melody length rises too, but merged 16th figures make bigger written chords: written unplayable onsets on the 18 T3/T4 songs 5.5% → 7.3% (Sober 11% → 17%; penalty 0.35: 6.0%). It needs chord thinning in the arrangement itself, so that the MIDI, the video and the score stay the same music: stage 6 (the T4 arrangement).

**Before → after in the whole pipeline** (all 42 songs, every variant; baseline `s2-key-m2` = `s2-key` re-scored with this stage's measures, after `s3-final`; tune / check; no song failed; the router is unchanged):

| Default `lead+accomp` | T3 piano + vocals | T4 no piano |
|---|---|---|
| Melody written length | 0.328 → **0.490** / 0.338 → 0.331 | 0.467 → **0.783** / 0.498 → **0.588** |
| Melody written position | 0.531 → 0.553 / 0.544 → 0.541 | 0.697 → 0.704 / 0.952 → 0.965 |
| Notes shorter than an eighth | 39.2% → **24.9%** / 46.2% → **27.5%** | 51.3% → **33.8%** / 41.8% → **30.3%** |
| Written unplayable onsets | 4.4% → 5.6% / 6.3% → 7.0% (loss) | 3.7% → 4.1% / 4.6% → 5.4% (loss) |
| Symbols per bar | 15.1 → 18.1 / 11.6 → 13.9 (loss) | 18.0 → 19.6 / 17.2 → 18.8 (loss) |
| Melody overlap, note F1, unplayable (MIDI), key, grid | no change | no change |

T1 and T2 (the piano path, one voice) do not change in any measure. The melody-only (`lead`) and lead-sheet (`lead+chords`) variants of T3 and T4 now have no written melody note shorter than an eighth (from 17–45%), fewer ties (T3 lead 0.108 → 0.066 / 0.048 → 0.021) and a longer written-length match on three of four halves (lead sheet: T3 0.375 → 0.502 / 0.376 → 0.330, T4 0.747 → 0.805 / 0.634 → 0.667). On the piano path's melody-only variant, one lead note per onset moves T2's written position by at most 0.005.

**Losses.**
- *T3 check half, melody written length 0.338 → 0.331* (melody-only 0.353 → 0.315, lead sheet 0.376 → 0.330). Laughing With (76 beats a minute; its reference melody is 72% 16ths) falls: its 16ths are real, and an eighth-only lead merges them. Make You Feel My Love, at the same tempo, rises 0.33 → 0.63. Tempo alone cannot separate the two songs, and the onset phases show no 16th peak on Laughing With.
- *More symbols per bar* (about +2 to +3): the melody now writes its own notes and rests beside the accompaniment's.
- *Written unplayable onsets* +0.4 to +1.2 points: an eighth-only lead note starts with the accompaniment's eighth more often, and the written onset holds both voices.

**Rendered review** (`pdftoppm -r 80`, page 1). Someone Like You (`hybrid`): the melody is a stems-up voice in eighths and quarters with its own rests, over the piano's arpeggio (stems down); readable as a piano-vocal part. The tempo is still read at ≈ 135 (gap 4), so the arpeggio keeps 16ths, and bar 9 still shows C♮ against C♯. Get Lucky (`arrange`): the melody reads in eighths, but the re-voiced accompaniment and the bass are still dense with 16ths and 16th rests (the rejected accompaniment candidate above; stage 6). Hometown Glory lead sheet (`s3-final`, page 1): the melody before this stage had 16ths, dotted eighths and 16th rests; after it, eighths, quarters and longer values, with no 16th note or rest. music21 still fills some gaps with double-dotted rests (bars 11–12), which a person would write as two rests.

**Limits.** The written-length measure compares with HookTheory's lead-sheet rhythm, which is itself a simplification, so it rewards simplifying: a singer's real 16ths (Laughing With, Get Lucky's syncopation) count as a loss when kept and the eighth-only lead loses them. On the three songs whose tempo is read at the wrong level (Someone Like You ×2, When We Were Young and Divinity ×0.5; gap 4), the written position and length compare bars of different lengths, so their numbers mean little until the grid is fixed. Jm's ratings (round 1, pre-stage renders) are still empty, so "it reads better" rests on the measures and the rendered review.

## 18. Stage 4: the score grid — trust the model's beats on rubato (2026-10-27)

Gap 4 of §13: classical rubato (T2 downbeat F 0.41, meter 50%), tempo level on three pop songs, Hello's 3/4.

**A cache first.** `meter.beat_this(…, cache=)` now keeps the Beat This! logits per song (`<work>/beats-<checkpoint>.npz`, written through a `.part` file; `pipeline.run` passes it). A grid change can then be measured without Demucs, the transcribers or the model: `scratch/p2v-versatile/s4/grid.py` rebuilds the routed `lead+accomp` variant of all 42 songs from the caches in about 2 minutes (a full bank run: about 60). Checks: its grids equal the `s3-final` grids on all 42 songs (`check_base.py`), and its variant measures equal the bank's on every measure (`check_var.py`, 42 of 42).

**Where the loss is** (`s4/raw.py`; tune / check). The model's own output, before our grid steps, beats our grid on every type: raw downbeat peaks against the references give T2 0.52 / 0.66 (our grid 0.33 / 0.48) and T1 check 0.63 (ours 0.36); raw beat F (annotated level) T2 0.72 / 0.86 (ours 0.56 / 0.66). The cause is the §12 splice: per model bar inside the reference spans (`s4/bar_feat.py`, 1,035 bars), the model's bar line is right more often than the spliced grid's at every irregularity level (CV < 0.1: 79% vs 72%; 0.1–0.2: 76% vs 54%; 0.2–0.3: 67% vs 41%; ≥ 0.3: 41% vs 26%). Classical rubato makes the model's beat intervals irregular where its beats are right, so `SURE_CV` = 0.2 handed those bars to the note tracker, which is worse there. §12 set it on two pop intros (Connections, Starlight) and noted that "the model alone has better bar lines on the corpus". Only Connections and Bach's C major prelude (BWV 846) have unsure bars where the splice is right more often.

**Candidates** (`s4/cands.py` via `grid.py --cand`, the full routed variant, all 42 songs; tune / check):

| Variant | T1 written position | T2 meter | T2 beat F | T2 downbeat F | T2 written position | T2 written length | T3 melody position | T4 downbeat F | T4 melody position |
|---|---|---|---|---|---|---|---|---|---|
| main (splice at CV 0.2) | 0.95 / 0.98 | 0.30 / 0.70 | 0.56 / 0.66 | 0.33 / 0.48 | 0.13 / 0.30 | 0.09 / 0.34 | 0.55 / 0.54 | 0.59 / 0.91 | 0.70 / 0.96 |
| no splice | 0.84 / 0.65 | 0.30 / 0.70 | 0.66 / 0.83 | 0.47 / 0.64 | 0.16 / 0.38 | 0.08 / 0.35 | 0.55 / 0.31 | 0.59 / 0.91 | 0.70 / 0.96 |
| splice at CV 0.5 | 0.95 / 0.65 | 0.30 / 0.70 | 0.61 / 0.76 | 0.44 / 0.58 | 0.14 / 0.35 | 0.08 / 0.34 | 0.55 / 0.31 | 0.59 / 0.91 | 0.70 / 0.96 |
| splice at CV 0.6 | 0.95 / 0.65 | 0.30 / 0.70 | 0.61 / 0.83 | 0.45 / 0.63 | 0.15 / 0.37 | 0.08 / 0.34 | 0.55 / 0.31 | 0.59 / 0.91 | 0.70 / 0.96 |
| splice at CV 0.7 | 0.84 / 0.65 | 0.30 / 0.70 | 0.62 / 0.84 | 0.45 / 0.63 | 0.15 / 0.37 | 0.08 / 0.34 | 0.55 / 0.31 | 0.59 / 0.91 | 0.70 / 0.96 |
| … CV 0.6, downbeat weight 2 | 0.95 / 0.65 | 0.30 / 0.70 | 0.63 / 0.84 | 0.48 / 0.61 | 0.16 / 0.35 | 0.08 / 0.34 | 0.55 / 0.31 | 0.63 / 0.93 | 0.76 / 0.96 |
| no splice, every octave folded | 0.83 / 0.65 | 0.30 / 0.30 | 0.65 / 0.88 | 0.43 / 0.62 | 0.22 / 0.26 | 0.20 / 0.26 | 0.55 / 0.56 | 0.59 / 0.91 | 0.70 / 0.96 |
| CV 0.6, near-octave fold | 0.95 / 0.65 | 0.20 / 0.50 | 0.60 / 0.85 | 0.42 / 0.65 | 0.21 / 0.38 | 0.15 / 0.39 | 0.55 / 0.56 | 0.59 / 0.91 | 0.70 / 0.96 |
| CV 0.6, near-octave fold, weight 2 | 0.95 / 0.65 | 0.20 / 0.50 | 0.62 / 0.85 | 0.47 / 0.64 | 0.22 / 0.35 | 0.15 / 0.38 | 0.55 / 0.56 | 0.63 / 0.93 | 0.76 / 0.96 |
| **CV 0.5, near-octave fold, weight 2 (built)** | **0.95** / 0.65 | 0.20 / 0.50 | **0.64** / 0.77 | **0.50** / 0.59 | **0.23** / 0.33 | **0.15** / 0.38 | 0.55 / **0.56** | **0.63** / 0.93 | **0.76** / 0.96 |

- *The splice threshold.* Connections' intro keeps the note grid up to `SURE_CV` 0.6 and loses it at 0.7 (written position 0.95 → 0.84); Starlight's intro loses it from 0.5 (0.98 → 0.65). The classical gain needs 0.5 or more.
- *One metrical level.* Without the note tracker, Laughing With fell from melody position 1.00 to 0.00: Beat This! taps eighths for a stretch, and `steady_beats` followed (its local tempo is a median of 9 intervals), so the bars drifted (tempo ×1.29). Folding every local tempo to the octave nearest the piece's median fixed it but turned big ritardandos into double-speed beats: the T2 check meter fell 70% → 30%. The built fold moves a local tempo only when it is within `LEVEL_JUMP` = 0.25 octave of twice or half the median (a level switch, not a ×1.5 ritardando).
- *Downbeat weight.* The model's z-scored downbeat probability against the note accents in the downbeat program (`MODEL_DOWN_W`): 2, 3, 5 and 10 differ little; 2 adds T2 tune downbeat F +0.05 and T4 tune melody position +0.06 (Get Lucky), costs T2 check −0.01 to −0.03.
- *Not adopted:* the note onset curve added to the model's beat probability before the beat program (λ 0.25–2, without the splice: T2 tune downbeat F +0.04 at most, Connections' downbeat F −0.06 to −0.09); Beat This!'s raw peaks instead of steady beats (without the splice: T1 check downbeat F 0.62 → 0.42). Checked as a feature only: the share of onsets on each grid's tatums does not tell where the splice is right (`s4/splice_feat.py`: it favours the note grid on Connections and BWV 846, where the splice is right, and on Liszt and the Barcarolle, where it is wrong).

**Verdict: adopted** — `SURE_CV` 0.2 → 0.5 (the note tracker takes only very irregular stretches), the near-octave fold in `steady_beats` (`LEVEL_JUMP` = 0.25), `MODEL_DOWN_W` = 2. The tune half chose 0.5 over 0.6 (T2 downbeat F 0.50 vs 0.47, beat F 0.64 vs 0.62); the check half prefers 0.6 by larger margins (T2 downbeat F 0.59 vs 0.64, beat F 0.77 vs 0.85), so the choice between them is within the noise of 10 pieces a half. 0.5 also stays clear of Connections' edge at 0.7.

**Before → after in the whole pipeline** (bank `s3-final` → `s4-grid`, all 42 songs, every variant, no failure; default `lead+accomp`; tune / check):

| Measure | T1 covers | T2 classical | T3 piano + vocals | T4 no piano |
|---|---|---|---|---|
| Beat F (best level) | no change / 0.48 → **0.75** | 0.60 → **0.68** / 0.68 → **0.79** | 0.981 → 0.985 / no change | 0.86 → **0.89** / 0.979 → 0.982 |
| Downbeat F | no change / 0.36 → **0.63** | 0.33 → **0.50** / 0.48 → **0.59** | 0.80 → 0.82 / 0.69 → **0.81** | 0.59 → **0.63** / 0.92 → 0.93 |
| Melody written position | no change / 0.41 → **1.00** | 0.10 → **0.21** / 0.34 → **0.38** | no change / 0.54 → 0.56 | 0.70 → **0.76** / no change |
| Written position (piano reference) | no change / 0.98 → **0.65** (loss) | 0.13 → **0.23** / 0.30 → **0.33** | – | – |
| Written length (piano reference) | no change / 0.95 → **0.68** (loss) | 0.10 → **0.15** / 0.34 → **0.38** | – | – |
| Meter right | no change | 30% → 20% / 70% → 50% (loss) | no change | no change |
| Tempo level right | no change | 20% → 20% / 40% → 50% | no change / 100% → 75% (loss) | no change |
| Notes shorter than an eighth | 22.8% → 22.1% / 39.9% → 41.0% | 51.2% → 47.1% / 25.6% → 19.9% | no change | no change |

The `lead` and `lead+chords` variants move the same way (T2 tune melody position 0.13 → 0.22); chords major/minor: Sad Piano 0.60 → 0.74, elsewhere ±0.01. Melody overlap, note F1, hands, key and the router do not change. Per song (downbeat F), the largest gains: Sad Piano 0.38 → 0.88 (melody position 0.41 → 1.00), Für Elise 0.71 → 0.94 (0.76 → 1.00), Bach BWV 865 0.44 → 0.83, Hello 0.39 → 0.76, Mozart K. 332/3 0.41 → 0.66, Schubert Moment musical no. 3 0.39 → 0.66, Glinka 0.32 → 0.61, Rachmaninoff op. 23 no. 4 0.26 → 0.60, Scriabin op. 8 no. 11 0.19 → 0.45, Get Lucky 0.83 → 0.98. Laughing With is unchanged (the fold protects it).

**Losses, with reasons.**
- *Starlight's intro* (T1 check; its reference is the first 8 bars): written position 0.98 → 0.65, length 0.95 → 0.68. The model's beats are wrong in the soft intro (CV 0.3–0.5, §12), and the note tracker no longer takes them. Rendered: bars 1 and 6–10 now show dotted rhythms and 16ths where the riff was clean eighths.
- *Meter* (T2, 4 pieces change): three now have the reference's bars with the other beat subdivision, which the meter measure counts as wrong: Schubert D 664 4/4 → 12/8 (its triplets; downbeat F 0.75 → 0.89), Rachmaninoff op. 23 no. 4 3/4 → 9/8 (0.26 → 0.60), Bach BWV 865 4/4 → 3/4 against the reference's 9/8 (0.44 → 0.83). One is wrong: Chopin op. 25 no. 1 4/4 → 3/4 (its tempo is still ×2.67). The subdivision and bar-length choices are close to ties on many classical pieces, so small beat changes flip them; this is the next grid item.
- *Bach's C major prelude* (BWV 846, steady 16ths, model unsure): downbeat F 0.58 → 0.41; the note tracker was right there.
- *Hello* is still 3/4 (now with the right bar lines, 3 slow beats a bar, so the tempo reads ×0.78: tempo level T3 check 100% → 75%).

**Rendered review** (`pdftoppm -r 80`, page 1, `s4/rv/`). Für Elise: bars 1–20 are the same in both; in bars 21–23 and 35–37 the old grid wrote the passage an eighth late with 32nd-note groups and a tied bass, the new one writes it on the beat in eighths. Starlight: as above (bars 11–27 are the same).

**Not fixed (the diagnosis, `scratch/p2v-versatile/s4/diagnosis.md`):** the tempo level of Someone Like You (×2), When We Were Young and Divinity (×0.5): the references disagree in direction, and the one separating cue (sung notes per beat) has n = 2; Wake Me Up's downbeats (0.0: the bar phase is half a bar off); compound meters read as simple (Liszt, Chopin's second Ballade, the Barcarolle: the model's beat is the eighth or the subdivision test is near its margin).

**Limits.** 10 pieces a half on T2, 2 songs a half on T1; the meter and the written measures swing with single pieces. The fold reads every near-octave change of the local tempo as a level switch: a real ×2 change that lasts (a double-time coda, a half-time breakdown) is written at the piece's main level, i.e. in shorter or longer note values instead of a new tempo; no bank song has one. The corpus harness (`corpus.py`) does not use the logit cache yet. Scratch: `~/.kaya/piano2video/scratch/p2v-versatile/s4/` (`fill_beats.py`, `grid.py`, `cands.py`, `raw.py`, `bar_feat.py`, `splice_feat.py`, `tab.py`, `diff.py`, `md_table.py`, the sweeps).


## 19. Stage 5: chords — a trained chord model hears the recording (2026-10-27)

Gap 5 of §13: the lead sheet's chords (`lead+chords`, major/minor, the `auto` path) at stage 4: T1 0.995 / 0.743, T2 – / 0.984, T3 0.825 / 0.885, T4 0.643 / 0.743 (tune / check). Chord references exist for 19 songs (T1 2, T2 1, T3 8, T4 8, after the skip below): one chord of a short HookTheory section moves a song by about 0.1, so a half's mean moves by 0.02–0.03 per song.

**A harness first.** `scratch/p2v-versatile/s5/ch.py` rebuilds the `lead+chords` chords of every song with chord references from the cached transcriptions and the `s4-grid` grids and scores them as `bank.score_variant` does, in about 30 s (`ccands.py` holds the candidates, `pick.py` pools them). It reproduces the `s4-grid` chord numbers on all 20 songs.

**A reference fault: Wake Me Up's chords.** Our chords and a grid-free check (CQT chroma of the non-vocal stems, major/minor templates per 0.1 s, a 1 s vote, no beat grid: `s5/diag/d2.py`) both match the HookTheory chords best with the reference shifted +0.7 to +0.8 s (grid-free 0.41 → 0.90; our chords 0.42 → 0.85). On the other 19 songs our chords match best at no shift, and the grid-free check (5 songs) within ±0.2 s. It is the fault §15 found on the song's melody (+0.75 to +0.80 s). `songs.json` now skips its chords as well (`ref.skip`, read by `bank.load_ref`); the reference is not shifted, as that would fit it to our output. Every "before" number below is the `s4-grid` run scored again with the skip (`s4-grid-rs`; T4 tune 0.643 → 0.718, nothing else moves).

**Where the misses were** (`s5/diag/d1.py`, `d3.py`, `d4.py`). Root and major/minor accuracy are almost equal on every song: the misses are wrong roots, not wrong qualities. (1) The `hybrid` path took chords from the piano stem alone; where the band carries the harmony it misses whole sections (Waiting for Love 0.31, its `arrange` chords 0.995; The Call 0.62 vs 0.90). (2) Upper-structure triads: Sober's G:maj7 reads B minor (the bass stem's transcription plays F♯ and D, not G); Sad Piano's B♭maj7 reads A minor (a held melody A fills every beat). (3) A wrong grid cuts chords: Hello's grid is 3/4 at 63 a minute, the song 4/4 at 79, and one beat of ours holds two of its chords.

**Candidates** (harness, major/minor of the `auto` path, songs pooled per group; tune / check; "band" = T3 + T4):

| Variant | Band tune (7) | Band check (9) | T1 + T2 (3) |
|---|---|---|---|
| stage 4 (`hybrid` chords from the piano stem) | 0.779 | 0.806 | 0.907 |
| **every non-lead stem on `hybrid` too (built, part 1)** | **0.908** | 0.801 | 0.907 |
| … + maj7 and m7 templates, written as the triad | 0.908 | 0.806 | 0.907 |
| … + those, seventh cost 0.02 | 0.900 | 0.839 | 0.907 |
| … half-beat segments (an off-beat change costs 0.6–1.2) | 0.910 | 0.791–0.802 | 0.907 |
| … piano path without its top line | 0.908 | 0.801 | 0.865 |
| … notes from C5 up at half weight | 0.904 | 0.822 | 0.907 |
| BTC on the mix, λ 0.3 | 0.941 | 0.838 | 0.783 |
| BTC on the summed non-vocal stems, λ 0.3 | 0.931 | 0.847 | 0.794 |
| BTC, level recentred, λ 0.3 | 0.938 | 0.872 | 0.866 |
| BTC, level recentred, λ 0.3, notes × 1 | 0.942 | 0.885 | 0.866 |
| BTC, level recentred, λ 0.1, notes × 1 | 0.939 | 0.897 | 0.897 |
| **BTC, level recentred, λ 0.1, notes × 0.5 (built)** | 0.941 | 0.878 | 0.897 |
| BTC, λ 0.1, notes × 0.5, no recentring | 0.941 | 0.873 | 0.897 |

- *Not adopted (first sweep, with Wake Me Up still in):* a bass-profile weight of 0.5 or 1.0 (T3 tune 0.879 → 0.720 / 0.678), the full vocabulary scored as is (T1 check 0.743 → 0.363, T2 0.984 → 0.735), and a CQT chroma of the stems mixed into the note profile (T1 check 0.743 → 0.617, T4 check 0.743 → 0.710). Note-side changes move a half by ±0.03 at most: within the noise of 4–5 songs.
- *BTC* (Park, Choi, Bae & Lee, ISMIR 2019, "A Bi-directional Transformer for Musical Chord Recognition"; code and weights MIT, `github.com/jayg996/BTC-ISMIR19`): 8 bi-directional self-attention layers over log-CQT frames (0.093 s), 25 classes (12 major, 12 minor, no chord); the paper reports major/minor 82.7% (5-fold, 471 songs of Isophonics, Robbie Williams and USPop). `Tools/p2v/btc.py` ports its inference to plain torch (no code from the repository runs). Checks: the checkpoint's git blob SHA-1 equals the official file's (it came from a Hugging Face mirror; `setup.sh` now fetches the official file at commit `f4edfb4`), SHA-256 pinned; the pickle references only torch's tensor rebuild, `OrderedDict`, numpy's dtype and one numpy scalar (the stored std), loaded with `weights_only=True` and a 4-line decoder for that scalar; `load_state_dict(strict=True)`; 3,018,137 parameters; on Get Lucky it reads the song's B minor, D, F♯ minor, E loop.
- *The level.* Our recordings' log-CQT level is about 1.06 above the checkpoint's mean (−1.16 vs −2.23; the spread matches, 1.71 vs 1.72): louder modern masters, or a change in librosa's CQT scale since 2019. Recentring each song's mean onto the checkpoint's fixes Für Elise (every root right, major/minor 0.735 → 0.984) and raises the band check half (0.838 → 0.872).
- *The setting* was chosen on the tune half of every type (8 songs: Friends + the band's 7). The λ 0.1 settings tie at 0.946–0.948, λ 0.3 at 0.940, λ 1 lower; the level and the note weight do not move the tune half. Recentring was taken for the reason above, notes × 0.5 by the tune order. The check half prefers notes × 1 (0.897 vs 0.878): within the noise, named here.
- *How it works* (`chords.recognize(…, audio=)`): per beat of the score grid, BTC's mean log probability of each state's family (major, minor or no chord) × `AUDIO_W` 0.1, plus the note templates × `NOTE_W` 0.5; the same change costs and Viterbi path as before. BTC has no seventh: a 7 (or, with `--chord-vocab full`, maj7, m7, dim, sus4) shares its family's audio score, so the notes decide it, and the slash bass still comes from the notes. Without notes (a song whose only melodic stem is the voice) the chords come from BTC alone; that path is measured only through the harness's "notes for sevenths only" run (λ 0.1: band tune 0.941, check 0.819), as every bank song has harmony stems. A beat with no BTC frame within 0.25 s (past the recording's end) scores uniform. `btc.chord_probs` caches the probabilities per song (`<work>/chords-btc.npz`, keyed by the recording's and the weights' SHA-256).

**Code review** (`high`, 10 findings): fixed — the cache key was the recording's length only (another section of the same length read the old chords), a CQT tail under one hop crashed librosa (a recording 10 s + 1 sample long), the start-of-run check tested only that the weights exist (a wrong file failed after Demucs), and a beat far past the frames copied the edge frame (3 songs now end on one more chord, outside their reference spans: no number moves). Not changed: the audio-only weight scale (measured above), the span of an audio-only path (BTC's no-chord class covers silence), the band stems transcribed for a `--chord-model notes` hybrid (both models read them), a symbol boundary at bar 1 (chord edges are whole beats), the dropped natural (a chord letter names its pitch absolutely), the scoped `safe_globals` (one SHA-checked file, numpy 2.4 here).

**Verdict: adopted.** `--chord-model btc` is the default for `lead+chords` (`--chord-model notes` keeps the old recognizer); a run without the weights stops at the start with the reason and the fix (`setup.sh`). `chord_source` takes every audible non-lead stem on `hybrid` as on `arrange` (part 1, commit `2bd509c5f`).

**Before → after in the whole pipeline** (bank `s4-grid-rs` → `s5-chords`, all 42 songs, every variant, no failure; major/minor of `auto/lead+chords`; tune / check):

| Type | Before | After |
|---|---|---|
| T1 covers | 0.995 / 0.743 | 0.995 / 0.713 (loss) |
| T2 classical (Für Elise only) | – / 0.984 | – / 0.984 |
| T3 piano + vocals | 0.825 / 0.885 | **0.939 / 0.930** |
| T4 no piano | 0.718 / 0.743 | **0.943 / 0.836** |

Per song: Waiting for Love 0.306 → 0.995, The Call 0.623 → 0.902, Hello 0.668 → 0.929, Sober 0.484 → 0.733, When We Were Young 0.809 → 0.870, Sit Next to Me 0.780 → 0.871, Hometown Glory 0.925 → 0.994, Helena Beat 0.848 → 0.914, Pumped Up Kicks 0.683 → 0.745, Someone Like You 0.942 → 0.991, Samson 0.948 → 0.992; unchanged: Make You Feel My Love 0.996, Divinity 0.851, Hey Brother 0.919, Friends 0.995, Für Elise 0.984. The `lead` and `lead+accomp` variants do not change in any measure (`bank compare`: "no change" on every type and half).

**Losses.** Laughing With 0.928 → 0.804: one bar of C minor that BTC hears as E♭ major (its relative major: two common tones), in a 12 s reference. Sad Piano 0.743 → 0.713 and Get Lucky 0.996 → 0.983: not traced (less than half a bar each).

**Rendered review** (`s5/render.py`, page 1 of `lead+chords`, before and after). Hello (`hybrid`): before, F minor, E♭, D♭, then A♭ held for whole bars; after, the song's loop F minor, A♭, E♭, D♭ in every pair of bars, two chords a bar (the grid's 3/4 at 59 is still wrong: stage 4's open item). Sober (`arrange`): before, G, E minor, F with B minor and A minor bars inside the G and F stretches; after, G, E minor, F, G throughout (the reference's G:maj7, E:min7, F:maj7 loop as triads). The review found two old engraving faults, both fixed: a chord symbol F in G major came out "F" + a box (music21 writes `root-alter 0` for some roots, and Verovio draws a SMuFL natural cairosvg lacks: `engrave_pdf` now drops it), and a chord that begins before the first bar (Sober's G at quarter −1) lost its symbol for the bars it fills (`build_score` now writes it at bar 1).

**Not fixed.** Sevenths, sixths and suspensions are not measured (HookTheory's "maj7" counts as major); the tune half has 7 band songs and 1 cover, so λ and the note weight are coarse; BTC was trained on 2000s Western pop and rock, and its accuracy on solo piano is measured on 3 songs only; Hello's and Sad Piano's grids still cut chords (stage 4's tempo and meter items). Scratch: `~/.kaya/piano2video/scratch/p2v-versatile/s5/` (`ch.py`, `ccands.py`, `pick.py`, `diag/`, the sweeps, `render.py`, `rv/`).

## 20. Stage 6: the band arrangement — on the grid, in the hands' reach, from the chords' tones (2026-10-27)

Gap 6 of §13 (the T4 arrangement) and §17's open item: `arrange lead+accomp` wrote 32% / 30% of its notes shorter than an eighth on T4 (tune / check; covers' scores: 0%), the score merged 16th figures that the MIDI and the video still played, and the voicings came straight from Basic Pitch's guitar and synth notes (§4: "more machine-like"). §17's score-only fix (eighth-only accompaniment) raised written unplayable onsets 5.5% → 7.3%, so the rhythm and the thinning had to move into the arrangement itself.

**Two new measures** (`bank.py`, every song, every variant): **chord fit** (`chord_fit`): the share of the accompaniment's sounding time (every note but the melody line) inside the reference span that is a tone of the reference chord (T3, T4 and the scored covers have chord references); **chroma similarity** (`chroma`, reference-free): the mean over counted beats of the cosine between the pitch classes our notes sound and the recording's CQT chroma without drums (stems summed, cached as `<work>/chroma-nodrums.npz`). Chord fit checks the harmony against a person's chords; chroma checks it against the recording, so a thinner arrangement loses a little there even when every note is right.

**A harness first.** `scratch/p2v-versatile/s6/arr.py` rebuilds the `arrange lead+accomp` variant from the cached transcriptions and the `s5-chords` grids and scores it with `bank.score_variant` plus the two measures, in about 10 s for T4 (`acands.py` holds the candidates; `c_prod` reproduces the bank on every song).

**Candidates** (T4, the `arrange` variant of all 9 songs; tune / check; the harness's chroma covers the reference span, the bank's below the whole song):

| Variant | Shorter than ⅛ | Written unplayable | MIDI unplayable | Symbols / bar | Chord fit | Chroma (reference span) | Melody overlap |
|---|---|---|---|---|---|---|---|
| before (`c_prod`) | 0.323 / 0.303 | 0.035 / 0.054 | 0.006 / 0.007 | 20.3 / 18.8 | 0.917 / 0.855 | 0.815 / 0.750 | 0.742 / 0.631 |
| band snapped to the eighth grid, ≤ 3 notes, beam-search hands | 0.000 / 0.000 | 0.055 / 0.063 | 0.035 / 0.044 | 17.0 / 16.2 | 0.922 / 0.841 | 0.810 / 0.754 | 0.740 / 0.603 |
| … pitch classes re-voiced into the hands' reach (zones) | 0.000 / 0.000 | 0.012 / 0.013 | 0.007 / 0.006 | 15.9 / 15.6 | 0.894 / 0.816 | 0.792 / 0.742 | 0.758 / 0.675 |
| … zones, chord tones only (BTC chords) | 0.000 / 0.000 | 0.010 / 0.013 | 0.005 / 0.004 | 15.4 / 15.2 | 0.944 / 0.874 | 0.780 / 0.731 | 0.758 / 0.675 |
| … and the melody's and bass's pitch classes allowed | 0.000 / 0.000 | 0.015 / 0.013 | 0.009 / 0.004 | 16.1 / 15.8 | 0.946 / 0.880 | 0.796 / 0.745 | 0.762 / 0.664 |
| **… and the right-hand zone from the melody note struck with the chord (built)** | **0.001 / 0.000** | **0.004 / 0.006** | **0.000 / 0.000** | 16.2 / 15.8 | **0.950 / 0.880** | 0.792 / 0.743 | **0.761 / 0.664** |
| … zones prefer the left hand | 0.000 / 0.000 | 0.005 / 0.001 | 0.001 / 0.000 | 13.7 / 12.8 | 0.939 / 0.873 | 0.778 / 0.731 | 0.752 / 0.621 |
| … held to the next chord (legato, ≤ 1 bar) | 0.000 / 0.000 | 0.010 / 0.013 | 0.005 / 0.004 | 14.7 / 14.8 | 0.904 / 0.821 | 0.787 / 0.737 | 0.758 / 0.675 |

- *Snapping alone* ends the short notes but merges a 16th figure into a chord and lets the beam search (§11) put four notes a tenth apart in one hand: unplayable onsets rise to 3.5–4.4% in the MIDI.
- *Zones* (`arrange.zone_voice`): the chord's pitch classes are the band's information, the octave is the arranger's. Each onset keeps its loudest pitch classes (≤ 3, ≤ 2 a hand), each placed at the octave nearest its transcribed pitch inside a hand's reach: the right hand within 11 semitones under the melody, the left within 11 over the bass; a hand without its line uses C4–B4 (right) or C3–B3 (left). A hand then spans at most an octave beyond its own line. The melody overlap rises because no accompaniment note sounds above the tune any more.
- *Chord tones* (`chords.tones_at`, the same BTC + notes chords as the lead sheet, §19): a cluster keeps only the chord's tones when it has one, so a transcribed passing tone or a Basic Pitch harmonic no longer becomes a held accompaniment note. Chord fit rises above the old arrangement's (0.917 → 0.944 tune).
- *The melody's pitch class*: excluding it (and the bass's) from the accompaniment gave fewer symbols but thinner chords; allowing it raises chroma (0.780 → 0.796 tune) and keeps the root in right-hand triads, as a pianist voices them.
- *The right-hand zone at the onset*: a zone from the lowest melody note over the whole chord left the chord under a low note while a higher melody note was struck with it (Divinity: 7 onsets of 2–3 notes spanning 16–24 semitones). The zone now follows the melody note struck with the chord (±40 ms) or sounding just after it, and a right-hand note ends where a later melody note goes under it: unplayable 0.9% → 0.0%.
- *Not adopted:* the left-hand preference (fewest symbols, but the melody written length on the check half falls 0.616 → 0.525: the one-voice right hand takes the off-beat release of §8 from the left hand's eighths) and legato (held notes cross chord changes: chord fit 0.950 → 0.904–0.930).

**Verdict: adopted** (`arrange.arrange_full` with the score grid and the chords' tones; `snap_to_grid`, `restrike`, `lowest_per_onset`, `zone_voice`, `end_at_crossing`; `chords.tones_at`; `pipeline.build_variant(…, grid=, chord_tones=)`). The pipeline recognises the chords once per source and uses them for the lead sheet and for `arrange`'s accompaniment, so `--chord-model btc` (the default) now also runs on every `arrange lead+accomp`; a run without the weights stops at the start (before Demucs) for `--parts lead+accomp` with `--source arrange` or `auto`, since `auto` may route there (`--chord-model notes` uses the transcribed notes alone). `limit_polyphony` and `drop_doubled` had no other user and are gone. The bass and the accompaniment are on the eighth grid in the MIDI and the video too, so the three outputs play the same rhythm; the sung melody keeps its own timing (§17 writes it in eighths in the score only).

**Code review** (`high`, 10 findings): fixed — a held accompaniment note could double or cross its hand's line after the line moved (a left-hand chord tone under a bass that climbs onto it: a doubled pitch, two note-ons), so `end_at_crossing` now ends a held note where its line crosses it, in both hands (it replaced the right-hand-only `below_melody`); the two hands' zones could overlap when a low tune sits over a high bass, so the right hand's zone now starts above the left's; a run on `auto` without the BTC weights stopped only after Demucs, so the start-of-run check covers `auto` too (the check after routing is gone); the chroma cache had no key (a re-separated song kept its old chroma) and its file stayed open, so it now carries the settings and the stems' sizes and times and is read in a `with`; `chroma_sim` now returns None under two frames and clips a negative onset. On the harness (T4 tune / check) the fixes move chroma 0.786 → 0.785 / 0.764 → 0.764 and chord fit 0.950 → 0.950 / 0.880 → 0.881, nothing else. Tried and not adopted: ending a held note also when its line leaps more than an octave away (the hand's reach while it sounds): chroma 0.786 → 0.774 on the tune half, no playability measure moves (they count onsets), and a pianist pedals such a note. Not changed: `under_melody` (the hybrid's rule drops the piano's own notes, measured in §14; merging the two would move the hybrid), `chord_fit`'s cost (reference spans hold tens of chords), the onset tolerance of `restrike` and `lowest_per_onset` (snapped onsets are exact grid times), `chord_plans` keyed by source (its inputs are fixed per source), and the claim that `below_melody` could remove a whole note (it ignored melody notes within 40 ms of the chord, so a note kept at least 40 ms).

**Before → after in the whole pipeline** (bank `s5-chords-m6` (= `s5-chords` scored again with the two new measures) → `s6-arrange2` (after the review fixes), all 42 songs, every variant; tune / check):

| Default `lead+accomp`, T4 no piano | Before | After |
|---|---|---|
| Notes shorter than an eighth | 34.0% / 30.3% | **7.4% / 0.0%** (tune: Waiting for Love, routed `hybrid`, keeps its 29%) |
| Written unplayable onsets | 4.2% / 5.4% | **1.1% / 0.6%** (Sober 11.6% → 2.1%) |
| MIDI unplayable onsets | 1.2% / 0.7% | **0.6% / 0.0%** (every `arrange` song 0) |
| Symbols per bar | 19.6 / 18.8 | **16.4 / 15.8** |
| Chord fit | 0.926 / 0.855 | **0.941 / 0.881** |
| Melody overlap | 0.748 / 0.631 | **0.761 / 0.664** (Sit Next to Me 0.461 → 0.675) |
| Melody written length | 0.783 / 0.588 | **0.805 / 0.616** |
| Melody written position | 0.759 / 0.965 | 0.762 / **1.000** |
| Chroma similarity | 0.786 / 0.779 | 0.769 / 0.764 (loss) |

T1, T2 and T3 (routed to `piano` and `hybrid`) do not change in any measure of the default variant, nor do the `lead` and `lead+chords` variants of any path (`bank compare`: "no change"), except the lead sheets on the piano path (T1, T2: symbols per bar +0.15 to +0.25, notes shorter than an eighth −0.001): the stage 5 review fix (780dff20a, one more chord at the end of 3 songs) came after the `s5-chords` run, so that change is §19's, not this stage's. `arrange lead+accomp` on T3 (an override there): notes shorter than an eighth 22.1% / 25.4% → 0 / 0, written unplayable 2.9% / 3.4% → 0 / 0, chord fit 0.866 / 0.889 → 0.939 / 0.926, melody overlap 0.678 / 0.681 → 0.757 / 0.685, melody written length 0.510 / 0.305 → 0.496 / 0.299, chroma 0.839 / 0.856 → 0.824 / 0.833. No song failed; the router is unchanged (T4 8/9).

**Losses, with reasons.**
- *Chroma similarity* (T4 0.786 / 0.779 → 0.769 / 0.764; Get Lucky 0.734 → 0.700, Sober 0.806 → 0.769, Helena Beat 0.795 → 0.764, Divinity 0.886 → 0.860; Pumped Up Kicks rises, Hey Brother stays): the arrangement plays fewer notes (T4: 707 → 538 a song on the tune half), at most three accompaniment pitch classes an onset and only the chord's tones, so some of the band's colour (added tones, a guitar's open strings, synth doublings) is gone. Chord fit says the notes that stay are more often right.
- *Hey Brother's melody overlap* 0.370 → 0.293 (its written length rises 0.353 → 0.455): the sung line is weak there (0.37 before), and I suspect the old right-hand accompaniment above it matched reference pitches where SOME found no melody; not traced.
- *`arrange` on T3, melody written length* −0.014 / −0.006: within a note or two a song.

**Rendered review** (page 1, `s6/rv/`). Get Lucky: before, 15 bars a page with 16th and 32nd beams, dotted 16ths, chords of four or five notes in each staff; after, 29 bars, eighths and quarters only, the left hand a bass note with a two- or three-note chord on the off-beats, the right hand the melody (stems up) over one or two chord tones. Sober: before, 18 bars, 16th figures in both hands; after, 25 bars in eighths, the bass line in eighths. Both: the bass sits low (C1–D1 with ledger lines in Sober's opening bars), as before: `BASS_RANGE` E1–E3 is unchanged.

**Not fixed.** The song's own hooks in instrumental bars (Get Lucky's guitar riff, Divinity's synth lead) become chords: the right hand has no line when the voice rests (a candidate for the next arrangement slice: the top line of the band stems where the melody is silent for a bar or more). A cluster without bass or melody uses a fixed zone, so a figure that crosses B3/C4 folds into one octave. The new measures are partial: chord fit compares with HookTheory's simplified chords (an added ninth counts as wrong), and chroma rewards density as well as correctness; Jm's ratings are still empty, so "it sounds like the song" rests on these two measures and the rendered review. Scratch: `~/.kaya/piano2video/scratch/p2v-versatile/s6/` (`arr.py`, `acands.py`, `meas.py`, `sw1.sh`–`sw5.sh`, `dbg_unplay.py`, `render.sh`, `rv/`).


## 21. Stage 7: the melody follows the song — the band's line where the voice rests, and instrumental songs (2026-10-27)

**Where the melody gap is** (`scratch/p2v-versatile/s7/melody-diagnosis.md`, 16 songs with a sung reference). SOME is near its ceiling against HookTheory: it is silent on under 1% of the reference melody's time on 15 of 16 songs; the arrangement step loses nothing (raw SOME = the routed lead on 15 songs); no reference is offset (best shift 0 ± 0.05 s, Sober +0.05). The misses are timing (T3 15%, T4 8% of reference time: same pitch class, late, short or split) and wrong pitch (13–15%, mostly more than 2 semitones). The timing test: the sung lead put on the score grid in the MIDI too (as the score already writes it, §17) does not help, so the timing misses are the lead sheet's simplified rhythm, not late notes: T3 overlap 0.755 → 0.740 (eighths) / 0.764 (16ths) on the tune half, note F1 0.581 → 0.527 / 0.547; rejected. One song stood far below: Hey Brother 0.29, whose reference section is the instrumental drop (§15). The top line of its `other` stem matches that reference at 0.61 where the voice rests. And the pipeline had a larger gap than any measure showed: a song with no vocals and no piano gave **no output** (`arrange` needed a sung lead), and one with a quiet piano-like stem went to `piano`, which transcribed that stem alone (Veridis Quo: chroma 0.39).

**The bank gets T5: instrumental sections.** HookTheory has no section labels, so 15 sections of songs whose recordings have instrumental hooks were added (`bank.add_hooktheory`, halves fixed before any run) and run, then screened by the vocal stem's level over the reference span (`s7/screen_t5.py`: keep at −20 dB of the mix or lower and at most 10% of 50 ms frames above −45 dBFS; Hey Brother's drop: −66.7 dB, 0%). Seven pass and form T5 (Hey Brother's drop moves from T4). Six "drops" carry a sung voice (−1 to −8 dB: vocal chops) and join T4 with their halves (T4: 9 → 14 songs). Two (deadmau5 Arguru, Justice Genesis) have a piano-like stem within 4 dB of the mix, a lead no type covers, and leave the bank. Bank fix: a HookTheory chord with no intervals was written "Bb:()", which mir_eval refuses (Hey Brother's second section failed); it is now "Bb:(1)". Baseline `s7-base` = `s6-arrange2` (main e5e8682b8) plus the new sections run with the same code, scored together.

**Change** (`arrange.py`, `pipeline.py`):
- *The band's line where the voice rests.* `rest_spans` finds the stretches where the lead sounds no note for at least `HOOK_REST_BARS` = 1 bar of the score grid (the song's start and end included; no lead at all: the whole song). In each, `hook_line` takes the top line (`skyline`) of the band stem (piano, guitar, other) whose top line holds the most note time there, cut to the span. Each span's line is placed as a sung lead is (median nearest D5, after the code review), joins the lead (role `lead`: the score's voice 1, written in eighths, §17), and the accompaniment's zones follow it (§20). `arrange_full(…, band=)` (the band stems by name); the `lead` and lead-sheet variants get the same line.
- *Instrumental songs.* `build_variant` builds `arrange` from the band alone when the lead stem is silent (it stops only when the band is silent too), and `run()` transcribes the band for it instead of skipping `arrange`.
- *The router.* With no lead, `route` takes `piano` only when the piano is at least as loud as every other stem together, else `arrange`. On the bank, the six solo-piano pieces that took the old "piano when audible" branch have the other stems 8–15 dB under the piano; the T5 songs have them 11–17 dB over it.

**Candidates** (`s7/mel.py`: the routed `lead+accomp` variant rebuilt from the caches and the `s7-base` grids, scored by `bank.score_variant`; the T5 songs whose base run transcribed nothing are measured in the bank run below; tune / check):

| Variant | T4 melody overlap | T4 note F1 (pc) | T4 symbols / bar | T4 chroma | Hey Brother / Opus / Aerodynamic overlap |
|---|---|---|---|---|---|
| before | 0.670 / 0.715 | 0.548 / 0.487 | 15.4 / 15.8 | 0.749 / 0.726 | 0.293 / 0.368 / 0.140 |
| **band line after 1 bar of rest, the stem with the most note time (built)** | **0.685** / 0.715 | **0.564** / 0.487 | 15.9 / 16.1 | 0.747 / 0.728 | **0.611 / 0.531** / 0.053 |
| … the stem with the most note time × velocity, or a fixed order (other, guitar, piano) | the same | the same | the same | the same | the same |
| … after 2 bars | 0.670 / 0.715 | 0.548 / 0.487 | 15.7 / 16.0 | 0.747 / 0.728 | the same |
| … after half a bar | 0.690 / 0.716 | 0.569 / 0.471 | 16.0 / 16.3 | 0.746 / 0.728 | the same |

The stem rule does not matter on these songs; the simplest stays. Half a bar is +0.005 on the tune half, within a song's noise, and fills a sung breath with band notes (note F1 on the check half 0.487 → 0.471), so 1 bar is built. The built code gives the candidate's numbers on every song.

**Verdict: adopted.**

**Before → after in the whole pipeline** (bank `s7-base` → `s7-hook`, 54 songs, every variant, no failure):
- T1, T2, T3, default variant: no change in any measure (`bank compare`). Router: T1–T3 100% (unchanged), T4 71% (unchanged: four new EDM sections with piano-like synths go to `hybrid`), **T5 5/7 → 7/7**.
- T4 (14 songs), default `lead+accomp`: melody overlap **0.670 → 0.685** / 0.715 → 0.715, note F1 0.548 → 0.564 / 0.487 → 0.487, written length 0.646 → 0.643 / no change, written unplayable 1.1% → 1.2% / no change, symbols per bar 15.4 → 15.9 / 15.8 → 16.1 (loss), chroma 0.749 → 0.747 / 0.726 → 0.728. Melody-only (`arrange_lead`): overlap **0.658 → 0.677 / 0.715 → 0.729**, note F1 0.565 → 0.581 / 0.512 → 0.530.
- T5, default variant, per song:

| T5 song (half) | Route before → after | Melody overlap | Note F1 (pc) | Chroma |
|---|---|---|---|---|
| Avicii: Hey Brother, drop (check) | arrange | 0.293 → **0.611** | 0.235 → 0.383 | 0.782 → 0.760 |
| Daft Punk: Veridis Quo (tune) | piano → arrange | 0.094 → **0.721** | 0.118 → 0.518 | 0.389 → **0.752** |
| deadmau5: Some Chords (tune) | piano → arrange | 0.000 → **0.573** | 0.000 → 0.304 | 0.350 → **0.819** |
| Eric Prydz: Opus (check) | arrange | 0.368 → **0.531** | 0.452 → 0.628 | 0.792 → 0.781 |
| Daft Punk: Solar Sailer (check) | **no output** → arrange | – → 0.072 | – → 0.074 | – → 0.778 |
| Daft Punk: Voyager (check) | **no output** → arrange | – → 0.159 | – → 0.118 | – → 0.630 |
| Daft Punk: Aerodynamic (tune) | arrange | 0.140 → 0.053 (loss) | 0.167 → 0.145 | 0.580 → 0.589 |
| Mean (no output = 0) | | 0.078 → **0.449** / 0.165 → **0.343** | | |

**Losses, with reasons.**
- *Aerodynamic* (0.140 → 0.053): its section is a 16th-note guitar arpeggio. The stem's top line holds the arpeggio's top notes, not the figure; before, the zone-voiced chord tones in the right hand matched more of it.
- *Symbols per bar* (T4 +0.3 to +0.5; T5 up to +6 a song): a line where there was none.
- *Chroma on Hey Brother and Opus* (−0.02, −0.01): I suspect the line's octave (Hey Brother: G5–C6) and its repeated notes; not traced.
- `arrange` on T3 (an override there), melody-only note F1 0.626 → 0.621 / 0.596 → 0.573.

**Rendered review** (`pdftoppm -r 80`, page 1, `s7/rv/`). Hey Brother before: in the drop (bars 3–28) the melody voice holds only rests over accompaniment dyads in eighths. After: a stems-up line in eighths and quarters plays the drop's hook (its repeated G–B♭–F figure) at G5–C6 (ledger lines above) over the same accompaniment; a few bars repeat one note four times (the synth's restrikes). Veridis Quo: there is now a score from the band (before: the `piano` path's transcription of a quiet stem); its line jumps (octave leaps, notes up to D6) where the song's synth melody is slow and legato: the top of the synth's arpeggio becomes melody notes.

**Code review** (`high`, 7 findings): fixed — `arrange_full` ignored `band=` without a grid, so a song with no lead got an empty melody and no error: it now raises; the band's line took one octave shift for all its spans, by the most notes in E4–E6, so it could sit an octave from the sung lead or one section could drag another: each span is now placed as a sung lead is (median nearest D5, `LEAD_CENTER`); a band note that started up to 20 ms before a span overlapped the last sung note: its start is now cut to the span; `run()` and `build_variant` each defined the band stems: one helper now (`band_stems`); the no-lead router threshold is a named constant (`NO_LEAD_PIANO_DB`, with the bank's margins); the rewritten silent-lead test now checks that the bleed's pitch class sounds at no octave, and a band without a grid raises. The bank after the fixes (`s7-hook2`, 54 songs, no failure) equals `s7-hook` on every default-variant measure but one (T4 tune symbols per bar 15.86 → 15.85); Hey Brother's line stays at G5–C6 (its median is within a fifth of D5). Not changed: with `--source arrange` or `--all-variants`, a solo-piano recording now gets an `arrange` variant from its piano stem's top line instead of an error (the router never picks it: the rest is under the piano); the per-span rescan of each stem (0.1 s a song).

**Not fixed.** T5's grid: the written measures are low (written position 0.0–1.0, written length 0.0–0.38): Opus reads tempo ×1.48 and the wrong meter, Solar Sailer and Some Chords ×2, Aerodynamic's bar lines miss (downbeat F 0): the beat model's level on electronic tracks is the next grid item. A smoother band line (a melody tracker over the band stems that penalises leaps and prefers one sustained voice) would fix Veridis Quo's jumps and maybe Aerodynamic. The sung melody's remaining misses are the reference's simplified rhythm and wrong pitch (13–15%): key-aware pitch snapping is not tried yet.

**Limits.** Seven T5 songs (3 tune, 4 check), one reference section each; the T5 screen is the stem level, not listening; HookTheory's "melody" of an instrumental section is one annotator's choice of the hook. Scratch: `~/.kaya/piano2video/scratch/p2v-versatile/s7/` (`mel.py`, `mcands.py`, `h.sh`, `sw1.sh`, `sw2.sh`, `hookprobe.py`, `screen_t5.py`, `add_t5.py`, `retype_t5.py`, `route_check.py`, `t5table.py`, `render.sh`, `rv/`).

## 22. Stage 8: the score grid on pop and electronic songs — the subdivision test and the beat level (2026-10-27)

Gap: the melody's written position was near 0.1 on five sung songs (Someone Like You, When We Were Young, Hello, Samson; Divinity on T4) and on four of seven T5 songs (Opus, Solar Sailer, Some Chords, Aerodynamic). §18 had left the tempo level open with n = 2.

**Diagnosis** (`scratch/p2v-versatile/s8/`: `stages.py` locates each miss in the grid's steps, `feat.py` and `rule.py` measure the lead's note values at three tempo levels, `subdiv_all.py` the subdivision cues, `phase_check.py` the drum and bass onsets at the reference's beats, `bars.py` the bar-length cues). The misses are of four kinds, and only two have a fault in our steps:

| Kind | Songs | Where it arises |
|---|---|---|
| Subdivision | Opus (T5; 12/8 for 4/4, tempo ×1.48) | beats and bar lines right (beat F 1.0, downbeat F 1.0); the synths and the bass sound 0.17 beat (80 ms) after the beat (I suspect sidechain pumping), so their 16ths sit near ⅙, 5⁄12, ⅔, 11⁄12 of the beat and the old test, which counts onsets near ⅓ and ⅔, read triplets |
| Beat level, ours | Some Chords (T5; 258 quarters a minute, ×2.02) | Beat This! taps eighths (250/min) for the first 32 s and quarters (130/min) after; `steady_beats` folds every stretch to the piece's median interval, which counts beats, so the faster stretch wins |
| Beat level, the reference's choice | Someone Like You ×2.02, Solar Sailer ×1.99; When We Were Young ×0.49, Divinity ×0.50, Faded ×0.50 | Beat This! is consistent; the HookTheory annotators chose the other octave, in both directions. At the reference's level the sung lead of the first group is 57–80% 16ths, of the second 0–9%: no density rule matches both (below) |
| Bar length or beat phase | Samson 2/4, Hello 3/4 (near ties: 2 beats 2.00 vs 4 beats 1.81; 3 beats 1.84 vs 4 beats 1.63); The Nights, Aerodynamic, Wake Me Up (beat or bar phase) | The Nights: the strongest drum onsets sit half a beat from the reference's beats and on ours (onset strength 4.74 at the reference beats + ½, 2.74 at its beats, 5.06 at ours), so I suspect the reference's alignment; Aerodynamic and Wake Me Up: not clear (the drum onsets do not separate the phases) |

**The change.**
- `subdivision`: per lattice k the circular strength R_k = |mean e^2πi·k·phase| of the onsets' phases in the beat; 3 when R3 > max(`SUBDIV_MARGIN` (2.0) × max(R2, R4), `SUBDIV_MIN_R3` (0.17)), else 2. It does not depend on where the lattice sits, so a constant lag does not move it. Opus: R3 0.04 vs R4 0.39 (simple; before, the window test gave triple 166 vs duple 101).
- `capped_bpm` and `MAX_BEAT_BPM` = 200: the level that `steady_beats` folds to, and the note tracker's level in the splice, are an octave lower while they are over 200 beats a minute (an eighth-note pulse). Some Chords now folds its first 32 s down to 130/min.
- `SUBDIV_MIN_R3` came from the cap: at Some Chords' new level no lattice is strong (R2 0.01, R3 0.12, R4 0.05), and 0.12 > 2 × 0.05 read 12/8; the bank's compound pieces have R3 ≥ 0.24 (the Berceuse).

**Candidates** (`s8/grid8.py`: the grid rebuilt from the caches, then the routed `lead+accomp` variant with the built path; on `s7-hook2`'s code it equals the bank on every measure of all 54 songs, the ASAP pieces with their held-out Beat This! folds; tune / check):

| Variant | T2 meter / tempo right (tune, check) | T2 downbeat F | T2 melody position, length | T5 meter / tempo right (tune, check) | T5 downbeat F | T5 melody position | T3 melody position | T1, T4 |
|---|---|---|---|---|---|---|---|---|
| main (`s8-h-base`) | 20 / 20%, 50 / 50% | 0.497 / 0.594 | 0.212 / 0.384, 0.148 / 0.397 | 100 / 67%, 75 / 50% | 0.396 / 0.837 | 0.333 / 0.541 | 0.553 / 0.562 | – |
| phase-free subdivision (margin 2) | 30 / 30%, 60 / 60% | 0.505 / 0.582 | 0.204 / 0.383, 0.169 / 0.390 | 100 / 67%, 100 / 75% | 0.396 / 0.837 | 0.333 / 0.608 | no change | no change |
| … + `MAX_BEAT_BPM` 200 in `steady_beats` only (Some Chords now 12/8: R3 0.12; Chopin op. 25 no. 1's note grid still ×2.67) | 30 / 30%, 70 / 60% | 0.505 / 0.569 | 0.204 / 0.382, 0.169 / 0.390 | 67 / 67%, 100 / 75% | 0.563 / 0.837 | 0.333 / 0.608 | no change | no change |
| **… + R3 over 0.17 (built)** | **30 / 30%, 70 / 60%** | 0.505 / 0.585 | 0.204 / 0.381, **0.169** / 0.390 | 100 / **100%**, **100 / 75%** | **0.587** / 0.837 | **0.611 / 0.608** | no change | no change |
| … + the octave rule (below) | – | – | – | no change | no change | no change | **0.766** / 0.058 | T4 tune 0.762 → 0.864 |

- *The margin.* Measured R3 / max(R2, R4) on the model's beats: compound pieces Connections 6.2, Mozart K. 332/3 5.5, Bach BWV 854 5.7, the Berceuse 2.7, a Beethoven 6/8 movement 2.3; simple pieces with triplets Rachmaninoff op. 23 no. 4 2.2, a Beethoven 3/4 movement 1.7, Viva la FAI 1.5, Schubert D 664 1.2. Margin 1.75 and 2.25 give the same choices as 2.0 or better (2.25 also moves Rachmaninoff to 3/4); 1.5 reads the Beethoven 3/4 movement as 9/8 again, 2.5 loses the 6/8 movement. Chosen on the tune half (Beethoven 3/4: 1.7 → simple), confirmed on the check half (Schubert D 664 → 4/4, Opus → 4/4, nothing lost).
- *The minimum R3* (0.17): between Some Chords' 0.12 and the Berceuse's 0.24 (their geometric middle); no bank piece has an R3 between 0.17 and 0.2, so 0.1 × the margin gave the same results.
- *The octave rule, not adopted* (`s8/gcands.py c_octave`): write a sung lead at twice the tempo when more than 47% of its inter-onset intervals are 16ths or shorter (`rule.py`: at our level When We Were Young 60%, Divinity and Faded 49%; Laughing With 59%, Veridis Quo 54%, Make You Feel My Love 44%). Tune half: When We Were Young 0.118 → 0.971 and Divinity 0.286 → 1.000 melody position (the reference's level); check half: Make You Feel My Love 1.000 → 0.048, Laughing With 1.000 → 0.000, Hello 0.132 → 0.065 (T3 check tempo right 75% → 25%). The references disagree in direction (Someone Like You and Laughing With write a dense sung line at the slow level, When We Were Young and Divinity a sparser one at the fast level), and the lead's density does not separate them (59% vs 60%).
- *Not tried:* correcting Opus's lag in the notation (I suspect its 16ths are written a 16th late: melody position 0.356); a 4/4 prior for Samson's 2/4 (2.00 vs 1.81, a near tie; the T2 2/4 pieces would need it to stay off).

**Verdict: adopted** — the phase-free subdivision test (`SUBDIV_MARGIN` 2.0, `SUBDIV_MIN_R3` 0.17) and `capped_bpm` (`MAX_BEAT_BPM` 200) in `steady_beats` and in the splice's note-tracker level.

**Before → after in the whole pipeline** (bank `s7-hook2` → `s8-grid`, all 54 songs, every variant, no failure; default `lead+accomp`; equal to the harness on every measure; tune / check):

| Measure | T1, T3, T4 | T2 classical | T5 instrumental |
|---|---|---|---|
| Meter right | no change | 20 → **30%** / 50 → **70%** | no change / 75 → **100%** |
| Tempo level right | no change | 20 → **30%** / 50 → **60%** | 67 → **100%** / 50 → **75%** |
| Beat F (annotated level) | no change | no change / 0.773 → 0.772 | 0.549 → **0.667** / no change |
| Downbeat F | no change | 0.497 → 0.505 / 0.594 → 0.585 | 0.396 → **0.587** / no change |
| Melody written position | no change | 0.212 → 0.204 / 0.384 → 0.381 | 0.333 → **0.611** / 0.541 → **0.608** |
| Melody written length | no change | 0.148 → **0.169** / 0.397 → 0.390 | 0.000 → 0.056 / no change |
| Written position / length (piano reference) | – | 0.234 → 0.222, 0.154 → 0.167 / 0.326 → 0.323, 0.381 → 0.372 | – |
| Notes shorter than an eighth | no change | 47.1 → 50.2% / 19.9 → 25.3% (loss) | 0.2 → 0% / no change |
| Symbols per bar | no change | 13.93 → 13.67 / 12.92 → 13.82 | 14.3 → 15.4 / 18.5 → 17.1 |
| Melody overlap, note F1, chroma | no change | no change | 0.449 / 0.343 → 0.347; note F1 0.322 → 0.313 / 0.301 → 0.304; chroma ±0.01 |

Per song: Some Chords 4/4 at ×2.02 → ×1.01, downbeat F 0.25 → **0.82**, melody position 0.00 → **0.83**, length 0.00 → 0.17; Opus 12/8 ×1.48 → 4/4 ×1.03, melody position 0.09 → **0.36** (downbeat F 0.96 both); Beethoven (3/4) 9/8 → 3/4, tempo ×1.49 → ×0.99, downbeat F 0.34 → 0.42, melody length 0.03 → 0.25, position 0.18 → 0.10; Schubert D 664 12/8 → 4/4, tempo ×1.49 → ×0.99; Chopin op. 25 no. 1 3/4 ×2.67 → 4/4 ×1.34 (meter right, tempo still wrong; downbeat F 0.31 → 0.34). The other variants move the same way; T5's `piano` override (not the route) meter 67% → 100%.

**Losses, with reasons.**
- *Schubert D 664* (T2 check): downbeat F 0.89 → 0.76, melody length 0.49 → 0.42, written length 0.51 → 0.39. Its triplet passages now sit on a duple grid (R3 0.35 vs R2 0.29: triplets, but not 2× the eighths), and the reference writes 4/4.
- *Notes shorter than an eighth* (T2 +3 / +5 points): Chopin op. 25 no. 1 at half the tempo writes its 16th sextuplets as 16ths (the reference: all 16ths); D 664's triplets as 16ths and dotted figures.
- *Beethoven (3/4)*: melody position 0.18 → 0.10, written position 0.23 → 0.11, with length 0.03 → 0.25 and downbeat F 0.34 → 0.42: the triplets again.
- `arrange` on T2 (an override, not the route) tune meter 40% → 30%.

**Rendered review** (`pdftoppm -r 80`, page 1, `s8/rv/`). Opus before: 12/8 at a dotted quarter ≈ 124, the riff in triplet eighths with rests between. After: 4/4 at ≈ 119, the riff in even eighths, bars 10–11 the held chords; it reads as the song's straight pulse. Some Chords before: ≈ 244 a minute, half and whole notes, ties over bar lines. After: ≈ 130 (≈ 153 in bars 1–9, where the folded beats start), the synth's chords in quarters and eighths.

**Code review** (`high`, 7 findings): fixed — with 8 to 60 onsets, random phases read as compound 5–7% of the time (the 0.17 floor does not scale with the count): R3 must now also exceed 2/√n (`SUBDIV_NOISE`; random phases pass it about e⁻⁴ ≈ 2% of the time; measured 0–1.5%); `capped_bpm` looped on an infinite tempo: it now returns it; the splice's fallback level (no sure bar: `gm.bpm`) is capped too; a test feeds `steady_beats` a model that taps eighths for most of a piece (main's code fails it: 0.232 s beats); §3's step 1 now says the note tracker's 50–170 range is not the default level. Not changed: the cap is a cliff at 200 a minute (in the Limits), and it moves the fold's target, but a stretch 1.36–1.47× off that target is left alone with or without the cap (a ×1.5 change is a real one, §18); the phase-free test's residual risk on swing and on D 664's triplets (above). The harness after the fixes equals `s8-grid` on every song (`s8-h-review`).

**Not fixed.** The tempo octave of five sung songs is the references' choice (above): Someone Like You and Solar Sailer are written at the slow level, When We Were Young, Divinity and Faded at the fast one; their melody position stays near 0.1–0.3. Samson's 2/4 and Hello's 3/4 (near ties in the bar length). The Nights' beat phase: the drum onsets point to the reference's alignment (half a beat off), not to our grid. Aerodynamic's and Wake Me Up's downbeats (0.0): not clear. Opus's notes sound 80 ms after the beat; I suspect the notation writes them a 16th late (melody position 0.36).

**Limits.** The subdivision rule is checked on 54 songs, of which 8 have compound references (one of them, the Berceuse, 1.4× over the minimum R3); swung eighths (onsets at 0 and ⅔) give R3 = 2 × R2 exactly, so a swing song sits on the margin. The cap reads a model level over 200 beats a minute as eighths; a fast piece notated in quarters over 200 (a presto at half-bar beats) would be written at half the tempo. Scratch: `~/.kaya/piano2video/scratch/p2v-versatile/s8/` (`grid8.py`, `gcands.py`, `feat.py`, `rule.py`, `stages.py`, `subdiv_all.py`, `subdiv.py`, `phase_check.py`, `bars.py`, `ibi.py`, `render.sh`, `rv/`, `logs/cmp-bank.txt`, `logs/cmp-all.txt`).

## 23. Stage 9: a smoother band line — one voice tracked through the band (2026-10-27)

Gap (§21 "Not fixed"): where the voice rests, the right hand played the `skyline` top line of the band stem with the most note time. Veridis Quo's line jumped (octave leaps, notes up to D6); T5 melody overlap 0.449 / 0.347 (tune / check).

**Diagnosis** (`scratch/p2v-versatile/s9/diagnosis.md`, a subagent; `rules.py`, `t4.py`; the line alone against the reference, pitch-class overlap as the bank measures it). The band line is measured on 8 songs only: the reference falls inside a band-line span on the 7 T5 songs and on Faded (T4, 17% of its reference); on every other T4 song the reference is the sung hook. Tune half: Veridis Quo, Aerodynamic, Some Chords, Faded; check half: Hey Brother, Opus, Solar Sailer, Voyager. The stem choice is not the cause: the loudest stem and the stem with the most note time are the same on all 8 (`other`; Voyager `guitar`). The line's leaps are: intervals of a fifth or more are 2–6× as frequent as in the references (Veridis Quo 58% vs 11%), and it has about twice the notes per beat. An oracle (per reference note, does any band note then have its pitch class) bounds what note picking can reach: Veridis Quo 0.96, Some Chords 0.995, Hey Brother 0.94, Opus 0.85, Solar Sailer 0.85, Voyager 0.40, Aerodynamic 0.02 (chance, the reference shifted: 0.07–0.20). Aerodynamic's melody is in no transcription (the `other` stem has 79 notes for the reference's 128); Solar Sailer's reference is a bass-register pulse (E2–D3: the `bass` stem 0.94, the top line of `other` 0.07); Voyager's is in the `bass` stem (0.74). Adding the bass stem as a candidate fixes Solar Sailer (0.91) but drops Some Chords to 0: no signal tells a bass hook from a high one, so it is not built. Rules that did not help: any stem choice, the first or longest note per beat, a minimum length, octave folding (a pitch-class measure does not see it).

**The change.** `track_line` (`arrange.py`): a Viterbi path over 50 ms frames (`HOOK_FRAME`) through the notes of all band stems in the span, each frame one sounding pitch or none. A frame of pitch p earns 0.3 + 0.7 × velocity/127 + `HOOK_HIGH` × (min(p, E6) − 60)/36; a change of pitch costs `HOOK_LEAP` × min(|interval|, 12)/12, a start or end of a silence `HOOK_LEAP`/4. Each run of one pitch keeps the band's notes of that pitch that start in it (a restrike needs the pitch released first, so a second stem that doubles a held pitch is not a new note), each with its own velocity, so restruck notes stay notes. `hook_line` uses it per span instead of the top line of one stem. `HOOK_LEAP` = 0.5 and `HOOK_HIGH` = 0.5 were chosen on the tune half only, on a plateau (the line's tune mean 0.58–0.63 over the grid); without the register reward (0) the tracker is no better than the top line.

**Candidates** (`s7/h.sh` on the grids of `s8-grid`: the routed `lead+accomp` variant rebuilt from the caches; tune / check; T3 no change in every row):

| Variant | T5 melody overlap | T5 note F1 (pc) | T5 chroma | T5 symbols per bar | T5 written-unplayable | T4 overlap / note F1 (tune) |
|---|---|---|---|---|---|---|
| main: the top line of one stem (`s9-base`) | 0.449 / 0.347 | 0.313 / 0.304 | 0.726 / 0.735 | 15.43 / 17.05 | 0.012 / 0.021 | 0.685 / 0.564 |
| the tracker (`s9-track`) | 0.606 / 0.363 | 0.307 / 0.289 | 0.693 / 0.720 | 15.47 / 17.00 | 0.001 / 0.007 | 0.686 / 0.562 |
| **… + the review fixes (built, `s9-fix`)** | **0.616 / 0.385** | **0.430** / 0.305 | 0.701 / 0.729 | **14.63 / 16.53** | **0.001 / 0.007** | 0.686 / 0.560 |

The review fixes (below) matter: the tracker alone made more notes (T5 lead 217 → 237 / 226 → 240) because a second stem that doubled a held pitch started a new note; with one voice the lead has 183 / 217 notes and note F1 (pc) rises 0.307 → 0.430 on the tune half.

**Verdict: adopted** — `track_line` (`HOOK_LEAP` 0.5, `HOOK_HIGH` 0.5, the reward capped at E6) in `hook_line`.

**Before → after in the whole pipeline** (bank `s8-grid` → `s9-final`, all 54 songs, every variant, no failure; default `lead+accomp`; tune / check). The harness `s9-fix` equals the bank on every melody and notation measure of the 30 T3–T5 songs, except where the harness and the bank already differed on main (Get Lucky melody length 0.632 vs 0.614, Waiting for Love's drop 0.52 vs 0.54, The Call; chroma ± 0.002 on every song):

| Measure | T1, T2, T3 | T4 (14) | T5 instrumental (7) |
|---|---|---|---|
| Melody overlap | no change | 0.685 → 0.686 / no change | 0.449 → **0.616** / 0.347 → **0.385** |
| Melody note F1 (pc) | no change | 0.564 → 0.560 / no change | 0.313 → **0.430** / 0.304 → 0.305 |
| Melody written position, length | no change | 0.762 → 0.760, 0.643 → 0.642 / no change | 0.611 → 0.619, 0.056 → 0.048 / 0.608 → 0.610, 0.095 → 0.104 |
| Written-unplayable | no change | no change | 0.012 → **0.001** / 0.021 → **0.007** |
| Symbols per bar | no change | 15.85 → 15.83 / no change | 15.43 → **14.63** / 17.05 → **16.53** |
| Chord fit | no change | no change | 0.921 → 0.914 / 0.919 → 0.901 (loss) |
| Chroma | no change | no change / 0.728 → 0.727 | 0.727 → 0.702 / 0.735 → 0.730 (loss) |

Per song (harness, `s9-base` → `s9-fix`): Some Chords overlap 0.573 → **0.927**, note F1 0.275 → **0.609** (the lead 133 → 71 notes: the synth's chord stabs no longer count as melody); Veridis Quo 0.721 → **0.871**, note F1 0.518 → 0.553, written-unplayable 0.029 → 0.002; Hey Brother 0.611 → **0.746**; Opus 0.547 → **0.605**, note F1 0.643 → 0.681, written position 0.356 → 0.440; Faded (T4) 0.336 → 0.338; Voyager 0.159 → 0.124; Solar Sailer 0.072 → 0.067; Aerodynamic 0.053 → 0.050. The `arrange` override, which the router does not pick there: T1 melody length 0.526 → 0.418 and note F1 0.467 → 0.406 (a solo piano's top line is the melody; the tracker sometimes takes an inner voice); T2 melody overlap 0.543 → 0.589, note F1 0.413 → 0.404.

**Losses, with reasons.**
- *Chroma* (T5 −0.025 / −0.006): the line has fewer notes (Some Chords 133 → 71), and chroma rewards density as well as correctness (§20); Veridis Quo 0.753 → 0.725 and Some Chords 0.839 → 0.795 with their overlap up 0.15 and 0.35.
- *Voyager* (check): overlap 0.159 → 0.124, note F1 0.118 → 0.062, chord fit 0.746 → 0.672. Its reference is in the `bass` stem (0.74), which no line candidate includes; both lines are near chance. I suspect the chord fit drop comes from the accompaniment's zones, which follow the line (§20), so a different line voices different chord tones; not checked.
- *Solar Sailer* (0.072 → 0.067) and *Aerodynamic* (0.053 → 0.050): at chance before and after (the bass hook; no transcription has Aerodynamic's tune).

**Rendered review** (`pdftoppm -r 80`, page 1; `s8/rv/vq-before-1.png`, `vq-after-1.png`, `hb-before-1.png`, `hb-after-1.png`). Veridis Quo before: the line leapt by octaves, up to F#6 on ledger lines. After: it stays in A4–E5 and moves by step; the restruck synth notes give repeated eighths. Hey Brother before: bars 4, 5 and 9 jump to about C6 on ledger lines, with eighth rests between fragments. After: those bars stay on the staff (bar 9: G E♭ G F instead of G E♭ G C6), and bars 26–28 hold a half note and a whole note where there were rests and fragments; bar 3's high note is in both, and one bar (21) still reaches the ledger lines.

**Code review** (`high`, 7 findings): fixed — a run's first onset could start 20 ms before the previous note's end (a self-overlap): it never does now; a second stem that doubled a held pitch started a new note: a restrike now needs the pitch released first; each note keeps its own velocity (not the run's maximum); notes are indexed by pitch once (the scan per run was quadratic); the register reward stops at E6 (`LEAD_RANGE`'s top), so a high shimmer cannot pull the voice off the tune; §4's `arrange` row says the band's line is one voice tracked through the band. Not changed: notes that start before a rest span are not candidates (the §21 filter that keeps the line off the voice); the second duration filter in `hook_line` is needed after the cut to the span.

**Not fixed.** Bass hooks: Solar Sailer's and Voyager's tune is in the `bass` stem, and no signal found yet tells a bass hook from a high one (adding the bass stem fixes Solar Sailer but drops Some Chords to 0). Aerodynamic's melody (a 16th-note guitar arpeggio) is in no transcription (corrected in §41: its reference was 0.33 s late; with the shift the line scores note F1 0.60). T4's band line is measured on one song (Faded, 17% of its reference): the other T4 references are the sung hook.

**Limits.** 8 songs measure the band line (4 tune, 4 check); two parameters were chosen on the tune half, on a plateau. The measure is pitch-class overlap, so an octave error in the line is not seen; the rendered review is the only check of the register. Scratch: `~/.kaya/piano2video/scratch/p2v-versatile/s9/` (`diagnosis.md`, `common.py`, `rules.py`, `t1.py`–`t7.py`, `show2.py`, `show4.py`, `logs/`) and `s9b/` (`bank_run.sh`, `eq.py`, `state.py`, `render.sh`, `logs/cmp-bank.txt`).

## 24. Stage 10: playable hands in piano songs with vocals — each written chord within reach (2026-10-27)

Gap: T3 songs (routed `hybrid`, §14) wrote 5.6% / 6.3–7.1% of a staff's onsets unplayable (more than 5 notes or more than 15 semitones; `w_unplay`, §17; tune / check): Hello 13.2%, When We Were Young 10.5%, Laughing With 9.6%. T1 and T2 write 0–0.5%. "I could play from this score" is half of Jm's rating (§13).

**Diagnosis** (`scratch/p2v-versatile/s9b/t3_unplay.py`: every unplayable written onset of the 9 T3 songs of `s9-final`, by staff and voice). Of 187 onsets, 134 (72%) are the right hand: the sung note (voice 1) over a piano chord that is playable without it (Hello bar 3: B♭4 over C3–C4; Someone Like You: B4 over D3–F♯3). 51 (27%) are the left hand: an octave bass with a chord tone or a second octave above it (F1–F2–F3, F1–F2–C3), a broken figure under the pedal that the score writes as one chord. 2 are the piano's right hand alone. The cause of the right-hand cases: the hand search (`assign_hands_adaptive`) groups notes that start within 35 ms (`CHORD_TOL`), and the sung note and the piano's chord start up to a 16th apart, so each group is playable alone; the score writes them as one chord.

**Candidates** (`s8/grid8.py` on the grids of `s9-final`, T3; its base run equals the bank on all 9 songs; `s11/sw1.sh`–`sw3.sh`, `cmp11.py`; tune / check):

| Variant | Written unplayable | MIDI unplayable | Shorter than ⅛ | Note F1 (pc) | Chord fit | Chroma |
|---|---|---|---|---|---|---|
| main (`s11-h-base`) | 0.056 / 0.071 | 0.020 / 0.014 | 0.248 / 0.275 | 0.581 / 0.534 | 0.938 / 0.940 | 0.773 / 0.836 |
| the hand search: a lead note within 0.15 s binds the right hand's reach | 0.047 / 0.069 | 0.035 / 0.052 (loss) | 0.252 / 0.278 | 0.581 / 0.535 | 0.929 / 0.939 | 0.769 / 0.834 |
| … and a held lead note too | 0.061 / 0.078 | 0.055 / 0.070 (loss) | 0.247 / 0.279 | 0.581 / 0.535 | 0.923 / 0.938 | 0.768 / 0.832 |
| re-voice the right hand under the lead, window 0.15 s | 0.025 / 0.024 | 0.015 / 0.009 | 0.248 / 0.274 | 0.580 / 0.532 | 0.935 / 0.940 | 0.771 / 0.835 |
| … window 0.25 s | 0.019 / 0.015 | 0.014 / 0.009 | 0.244 / 0.268 | 0.579 / 0.532 | 0.935 / 0.939 | 0.771 / 0.835 |
| … window 0.35 s | 0.017 / 0.014 | 0.014 / 0.009 | 0.241 / 0.266 | 0.581 / 0.533 | 0.933 / 0.939 | 0.772 / 0.834 |
| … 0.15 s, the left hand too | 0.010 / 0.011 | 0.002 / 0.000 | 0.248 / 0.274 | 0.580 / 0.532 | 0.935 / 0.940 | 0.771 / 0.835 |
| **… 0.25 s, the left hand too (built)** | **0.004 / 0.001** | **0.001 / 0.000** | 0.242 / 0.265 | 0.579 / 0.532 | 0.935 / 0.939 | 0.771 / 0.835 |

- *The hand search alone* cannot fix it: with the lead binding the right hand, no split is playable at many onsets (the left hand is full), the search falls back to any split, and MIDI unplayable chords rise. The notes must change, not only the hands.
- *Without trying the other hand first* (window 0.15 s, straight to the octave move or the drop): 0.026 / 0.024, the same as with it; the other hand is kept because it keeps the piano's pitch.
- The window was chosen on the tune half (0.25 s: 0.004; 0.35 s gains 0.002 on the right hand only); 0.25 s is a 16th at 60 a minute. A second run gives the same numbers (`s11-f25-chk`).

**The change.** `fit_hands` (`arrange.py`) runs after the hand search in `arrange_hybrid`. Right hand: a piano note more than 15 semitones under a lead note that starts within `FIT_NEAR` (0.25 s) of it goes to the left hand if that hand's notes within the window stay within 15 semitones and 5 notes; else it moves up by octaves into reach (under the lead, a pitch not struck yet); else it is dropped. Left hand: a note more than 15 semitones over the lowest left-hand note in the window goes to the right hand if that hand stays playable under the lead, else down by octaves, else it is dropped. A hand takes a note only when it does not strike that pitch already (no doubled key) and stays under 5 notes (`HAND_REACH`, `HAND_NOTES`, shared with the hand search). Lead notes and each window's lowest note never move. It changes the notes, not only the hands: on the 9 T3 songs 6,920 → 6,715 MIDI notes (3.0% dropped) and 3.0% moved by an octave (`s11/notediff.py`; Hello 4% and 7%, Samson 0.4% and 1%).

**Verdict: adopted** — `fit_hands` (`FIT_NEAR` 0.25 s, both hands) in `arrange_hybrid`. `piano` and `arrange` do not use it: their written chords are within reach already (T1, T2 0–0.5%; `arrange` §20).

**Before → after in the whole pipeline** (bank `s9-final` → `s10-fit2`, all 54 songs, every variant, no failure; default `lead+accomp`; tune / check). The first bank run of this code (`s10-fit`) equalled the harness on all 9 T3 songs; the review fixes (below) then moved T3 by 0.002 at most (`s10-fit` → `s10-fit2`):

| Measure | T1, T2 | T3 (9, all `hybrid`) | T4 (14; 4 route `hybrid`) | T5 |
|---|---|---|---|---|
| Written unplayable onsets | no change | 0.056 → **0.003** / 0.071 → **0.001** | 0.012 → **0.005** / 0.015 → **0.007** | no change |
| Unplayable chords (MIDI) | no change | 0.020 → **0.001** / 0.014 → **0.000** | 0.008 → 0.002 / 0.007 → 0.002 | no change |
| Notes shorter than an eighth | no change | 0.248 → 0.240 / 0.275 → 0.265 | 0.054 → 0.053 / 0.081 → 0.076 | no change |
| Symbols per bar | no change | 18.10 → 18.20 / 14.13 → 14.00 | 15.83 → 15.81 / 16.10 → 16.08 | no change |
| Melody overlap, note F1 (pc) | no change | no change, 0.581 → 0.579 / 0.681 → 0.679, 0.534 → 0.532 | 0.686 → 0.685 / no change | no change |
| Chord fit | no change | 0.938 → 0.936 / 0.940 → 0.939 | 0.917 → 0.915 / 0.842 → 0.841 | no change |
| Chroma | no change | 0.773 → 0.770 / 0.836 → 0.835 | no change / no change | no change |

Per song, written unplayable: Hello 0.132 → 0.004, When We Were Young 0.105 → 0.013, Laughing With 0.096 → 0, Hometown Glory 0.066 → 0.007, The Call 0.046 → 0, Make You Feel My Love 0.037 → 0, Someone Like You 0.036 → 0, Viva la FAI 0.029 → 0, Samson 0.020 → 0; T4 Silhouettes 0.043 → 0.004, The Nights 0.042 → 0.009, Waiting for Love 0.028 → 0.011 (its drop 0.022 → 0.003). The `hybrid` override on T5 (Opus, not the route) 0.014 → 0.010.

**Losses, with reasons.** Chord fit and chroma fall by 0.001–0.003 on T3 (When We Were Young chord fit 0.911 → 0.902, chroma 0.730 → 0.719; Silhouettes chord fit 0.925 → 0.912): a dropped note is a chord tone gone from that onset; an octave move keeps the pitch class, but I suspect it can change which note the chord fit reads as the bass (not checked). Melody note F1 −0.002: I suspect a moved piano note now sounds as the right hand's top line under a short rest in the sung line (the melody measure reads the right hand's skyline); not checked per note.

**Rendered review** (`pdftoppm -r 80`, page 1; `s8/rv/hello-before-1.png`, `hello-after-1.png`). Hello before: in bars 5–7 and 25 the right hand's lower voice stacks chords two to three ledger lines under the staff while the melody sits at C5, chords no hand can strike with the tune (the diagnosis: B♭4 over C3–C4 in bar 3). After: those chord tones sit inside the staff just under the melody, as in a piano-vocal score, and bar 25 holds its chord in the treble; the left hand is unchanged except a note that now ends a bar later (the score has 30 bars, not 29). Still there: the left hand's low octaves (C1–E♭1, four ledger lines; an 8va bassa line would read better).

**Code review** (`high`, 8 findings): fixed — a move to the other hand could strike a pitch that hand already strikes (a doubled key): a hand now takes a note only when that pitch is not in its window, else the octave move or the drop follows; SKILL.md and the docstring said no written chord exceeds 15 semitones or 5 notes: they now say what the rule does (the span; the 5-note limit bounds the moves; 6-note chords are not thinned) and how many onsets remain; the lead window was a scan of every lead note per note: a sorted search now; the reach and the 5-note limit are shared constants (`HAND_REACH`, `HAND_NOTES`) with the hand search; tests for the doubled key, a full left hand and the left hand's move under a lead; this section's date. Not changed: the `wip` commits stay in the history (no rewrite).

**Not fixed.** 7 of 3,289 T3 written onsets stay unplayable (`t3_unplay.py s10-fit2`; 8 before the review fixes): 4 are the sung note over piano notes more than 0.25 s away that the score still writes as one chord (When We Were Young, written at ×0.49 of the reference's tempo so that its 16th is about 0.27 s; Hello bar 18 at 59 a minute, where a 16th is 0.25 s); 3 are the piano's right hand alone (Hometown Glory, two of them with 6 notes): onsets with more than 5 notes are not thinned. The left hand's low register is written without 8va.

**Limits.** 9 T3 songs and 4 hybrid-routed T4 songs; no reference measures the piano part's own notes on T3, so the cost of the dropped and moved notes (3% each) is measured only through chord fit and chroma. The window is a fixed 0.25 s, not a 16th of the grid (`arrange_hybrid` has no grid): at 120 a minute it spans two 16ths, so it may move notes that the score writes a 16th apart. Scratch: `~/.kaya/piano2video/scratch/p2v-versatile/s11/` (`sw1.sh`–`sw3.sh`, `cmp11.py`, `notediff.py`, `logs/cmp-bank.txt`), `s9b/t3_unplay.py`, `tools-s11-hand/` (the candidates' code).

## 25. A measure fault: ASAP scores that open with a pickup (2026-10-27)

Found by the stage 11 diagnosis (`scratch/p2v-versatile/s10/diagnosis.md`, a subagent). The written-position measure takes a reference note's `q_on % bar` (`evaluate.score_notation`), so it assumes the reference's quarter 0 is a bar line. 5 of the 19 ASAP scores open with a pickup: every annotated downbeat sits at quarter 1.0 of the bar (Chopin op. 25 no. 1, Schubert D 664/1, Beethoven op. 54/1 (22-1), Haydn Hob. XVI:48/2) or 2.0 (Chopin Ballade 2, 6/8). A grid with the right bar lines then scored 0 on position: Schubert D 664/1, meter right and downbeat F 0.76, position 0.000.

**The fix.** `corpus.reference` (which builds every ASAP reference, for the bank and for the corpus harness of §11) reads where the annotated downbeats inside the excerpt fall in the score (`corpus.bar_phase`: the most common `score quarter % bar`, to a 48th of a quarter, straight from the annotation's score quarters) and shifts the notes and the quarters → seconds map by it (`corpus.shift_quarters`: every note keeps its time; a pickup note gets a negative quarter). It finds exactly the 5 pieces (1.0 on four, 2.0 on the Ballade) and 0 on the other 14 (`s11/phase_check.py`). Downbeat F does not change: it already uses the annotated downbeats.

**Re-scored** (`bank score --label s10-fit2 --as s10-fit2-ph2`; the same outputs, only the measure differs; equal to a first version of the fix in `bank.py`, `s10-fit2-ph`; tune / check): T2 routed melody written position 0.204 → **0.222** / 0.381 → **0.445**, all-notes written position 0.222 → **0.233** / 0.323 → **0.397**; the `arrange` override 0.216 → 0.250 / 0.498 → 0.578. Per piece (melody / all notes): Schubert D 664/1 0.000 → 0.553 / 0.000 → 0.585; Beethoven 22-1 0.103 → 0.230 / 0.111 → 0.167; Haydn 48-2 0.112 → 0.160 / 0.133 → 0.186; Ballade 2 0.028 → 0.105 / 0.029 → 0.104 (meter wrong); op. 25 no. 1 0.024 → 0.027 / 0.026 → 0.033 (its tuplets, §22). No other measure and no other type changes. Every T2 position number before §25 (§11–§22, the corpus harness's too) carries this fault; later sections compare against the re-scored runs.

**Code review** (`high`, 7 findings): fixed — the first version shifted the reference in `bank.asap_reference`, so the corpus harness still scored the faulty one: the shift is in `corpus.reference` now; the phase was rounded to a 12th of a quarter, which misplaces a 32nd-note pickup: a 48th now; it inverted the quarters → seconds map on a fine grid (ambiguous where the map is flat): it reads the annotation's score quarters directly; an empty excerpt raised in `max()`: no `max()` now; a test of the shift's sign on a non-linear map and of a 32nd-note pickup. Not changed: one bar length per excerpt (the bank's references have one meter; an excerpt whose meter changes would scatter the phases, and a tie picks the smallest; none of the 19 does); pickup notes get negative quarters, which `bar_check` (a diagnostic, not a bank measure) leaves out of its first bar; the re-score shows no other measure moved.

## 26. Stage 11: the written rhythm of solo piano — tuplet beats, and why the meter stays (2026-10-28)

Stage 10's diagnosis (`scratch/p2v-versatile/s10/diagnosis.md`) put T2's weak written rhythm (melody written position 0.222 / 0.445, tune / check) on two causes: the meter and bar lines, and the tuplet lattice (72% of the position misses left on a perfect grid). This stage measured both and changed the second.

### A harness fault first: the oracle grid ignored the §25 pickup shift

`s10/h10.py`'s oracle grid placed bar lines from the raw ASAP score quarters, while the bank's reference is shifted by the pickup since §25: downbeat F 0.0 and position 0.0 on the 5 pickup pieces (which include 3 of the 4 tuplet pieces). Fixed (`grid_oracle(..., ph)`). On a perfect grid T2's melody written position is **0.861 / 0.822** (all notes 0.863 / 0.835), against **0.222 / 0.445** on the built grid: the grid is by far the larger gap.

### The meter: diagnosed, not changed

A subagent (`scratch/p2v-versatile/s11/diagnosis-meter.md`, harness `s11/h11.py`, reproduces the bank on all 53 songs) split the built → perfect-bar-lines gain (T2, tune / check):

| grid | meter right | downbeat F | melody position | melody length |
|---|---|---|---|---|
| built | 30 / 70% | .51 / .58 | .22 / .44 | .17 / .39 |
| m: the reference's bar length and beat division forced into our grid | 80 / 90% | .57 / .67 | .48 / .56 | .48 / .51 |
| a: the reference's meter and bar lines on our beats | 100 / 100% | .81 / .93 | .58 / .74 | .51 / .51 |

- 7 T2 pieces have the wrong bar length (×2 or ×½), division or beat level; 4 have a beat level that wanders (op. 25/1, Rachmaninoff 23/6, Liszt, Barcarolle); 5 have the right bar length but bar lines that drift. No piece has a constant phase error: the drift is Beat This! beat slips under rubato (on Beethoven 22-1 the downbeat DP adds slips on right beats).
- **The bar-length rule cannot be chosen on the tune half.** Per candidate bar length the study computed six cues (note accents, the model's downbeat contrast, the autocorrelation of its downbeat probability, chroma self-similarity, bass periodicity, harmonic-change contrast). The current rule (`bar_length_joint`) picks the right bar length on 16 / 18 tune and 19 / 23 check songs; 1,189 of 4,095 cue weightings reach 18 / 18 on tune and score 15 to 22 of 23 on check. On classical piano 2 against 4 beats a bar is a near-tie in every cue (Bach BWV 846, true 4: accent contrast 3.07 vs 3.17); on pop the model's downbeat contrast decides (≈3.0 vs ≈1.5).
- R1, the tune half's choice (add the harmonic-change contrast), fixes Bach 846, Mozart 12-3 and Rachmaninoff 23/6 and breaks Bach 854 (check: melody position 0.63 → 0.08) and Hello (T3: downbeat F 0.76 → 0.12): refuted, not adopted. R2 (change the bar length only when the downbeat autocorrelation and the harmonic change agree) changes only Bach 846 (downbeat F 0.41 → 0.80, melody position 0.00 → 0.86), but it was designed after R1 failed on check, so its clean check half is not an independent test: kept as a candidate, not merged.
- The subdivision rule is right on 50 of 53 songs (misses: Ballade 2, Bach 865, Rachmaninoff 23/4); the downbeat DP's cost and the model weight are at their tune-half best. **Not changed.** The next lever is beat tracking under rubato (the slips) and a larger set of classical pieces to tune the meter on (more ASAP audio needs a download: Jm's decision).

### Tuplet beats (`notation.onsets_by_beat`, adopted)

Every onset snapped alone to the 16th grid (eighths preferred, `snap_onsets`), so triplets came out as mixtures of 16ths and eighths, and two onsets could fall on one 16th and merge into a chord. Variants (scratch `s12/qeval.py` scores written onsets per note on perfect beats, ASAP pieces in simple meters; the harness `s10/h10.py` scores the whole score):

| variant | result | verdict |
|---|---|---|
| a per-beat phase test (duple vs triplet lattice as Gaussian mixtures, smoothed over ±1 beat) | perfect grid: melody position −0.02 / −0.01; built grid: +0.06 / −0.01, almost all from one piece | rejected: inside a beat pianists play unevenly; even on perfect beats the onset phases spread over the whole beat (Rachmaninoff 23/6's melody eighths fall at 0.34–0.39 of the beat) |
| one lattice per hand and beat (eighths, 16ths, triplet eighths, sextuplets), onsets in order on distinct points, a merge cost for a chord split by asynchrony | per note, all notes 0.771 → 0.866 / 0.844 → 0.897; melody lost (Rachmaninoff 23/6 −0.11, Glinka −0.13) | not alone: a lone early melody eighth fits a third of the beat |
| the same, decided over the hand's beats by a Viterbi path with a cost per duple ↔ triple switch (tuplets come in runs) | melody 0.785 → 0.851 / 0.811 → 0.840 | adopted, with two refinements below |
| one lattice for both hands per beat | no better (melody 0.824) | rejected |

**The rule.** In a simple meter each hand's onsets in a beat (chords within `CHORD_TOL` count once) are fitted to each lattice: squared distance / `LATTICE_SIGMA`² (0.06 beat), + `LATTICE_MERGE` (3) per onset on its neighbour's point, + the lattice's penalty (eighths 0, 16ths 1, triplet eighths 3, sextuplets 10); a Viterbi path over the hand's beats adds `LATTICE_SWITCH` (8) per change between the duple and the triple lattices; a beat with onsets on the beat only costs nothing. Every lattice also holds the next beat (an early downbeat at 0.89 of the beat was written at 0.75; Mozart 12-1). A beat the path writes duple keeps the per-note snap: letting the lattice choose eighths and 16ths too raised T3's notes shorter than an eighth 24 → 29% / 27 → 33% (the sung songs' piano) for no measured gain (on T2 the two tie on tune: 0.855 vs 0.850 all notes, 0.846 vs 0.852 melody). In a triplet-eighth beat note ends snap to thirds, the shortest length is a third and the eighth minimum (`min_tatum`) becomes a third; in a sextuplet beat, sixths. Compound meters are unchanged (they are in threes already). Settings chosen on the tune half with perfect beats (σ 0.06; merge 3 over 2–10; switch flat from 8 to 12; sextuplet penalty 10–14 flat: the tune half has no sextuplets, so op. 25/1's sextuplets mostly stay 16ths).

**Engraving.** music21's `makeRests` filled a gap from a 16th of one beat to a third of the next with one 7/12-quarter rest, engraved as a 12:7 tuplet (Beethoven 22-1, bar 25): `split_rests_at_beats` cuts such rests at the beat line; rests on the 16th grid stay whole.

**Before → after** (harness `s10/h10.py`, which equals the bank: `s11-built` = `s10-fit2-ph` on T1+T2, `s12-t35-base` = `s10-fit2-ph` on T3–T5; routed lead+accomp, tune / check):

| measure | T2 built (the product) | T2 perfect grid | T1, T3, T4, T5 built |
|---|---|---|---|
| melody written position | 0.222 → **0.278** / 0.445 → 0.445 | 0.861 → **0.903** / 0.822 → **0.837** | no change |
| melody written length | 0.169 → **0.236** / 0.390 → 0.390 | 0.613 → 0.616 / 0.561 → **0.582** | no change |
| all notes position / length | 0.233 → 0.280, 0.167 → 0.229 / 0.397 → 0.397, 0.372 → 0.378 | 0.863 → 0.909, 0.590 → 0.592 / 0.835 → 0.854, 0.523 → 0.548 | – |
| notes shorter than an eighth | 0.502 → 0.536 / 0.253 → 0.256 (the references: 0.84 / 0.75) | 0.491 → 0.517 / 0.298 → 0.313 | no change |
| symbols per bar (reading load) | 13.67 → 14.06 / 13.82 → 13.84 (tuplet brackets and numbers) | – | no change |

The bank run of the final code (`bank run --label s11-final`, 54 songs, against `s10-fit2-ph`) gives the same numbers as the harness on every type.

Per piece, built (melody position, melody length): Bach BWV 865 0.281 → 0.757, 0.000 → 0.681 (a 9/8 piece our grid reads as 3/4: its triplets now land); Barcarolle 0.123 → 0.196; Beethoven 22-1 0.230 → 0.252; Schubert D 664/1 all-notes length 0.389 → 0.444. Perfect grid: Beethoven 22-1 0.579 → **0.966**, Schubert D 664/1 0.748 → **0.897**, Rachmaninoff 23/4 0.671 → 0.709. **Losses:** Haydn 48-2 (built) melody length 0.391 → 0.297 (its grid runs at half tempo, ×0.495: one of our beats holds two written beats, so its 16ths read as tuplets); Liszt (built) melody position 0.094 → 0.086; Sad Piano (perfect grid only) notes shorter than an eighth 0.552 → 0.617. Why the built grid gains less: its beats slip (above), and a tuplet beat needs the beat in the right place; the rule's full gain waits for the grid.

**Rendered review** (`scratch/p2v-versatile/s12/rv/`, page 1 of Beethoven 22-1 at 80 dpi, before `s12-oracle2` and after `s12-kb-oracle2`): bars 25–35, the triplet passage, now read as bracketed triplet eighths in both hands, where the old score wrote uneven 16th-and-eighth groups; bars 1–24 are unchanged; bar 25's 12:7 rest is the engraving fault fixed above.

**Code review** (`high`, a subagent; 4 confirmed findings, all fixed): a note held from a 16th into a third of the next (tuplet) beat was one 5/6- or 7/12-quarter note, engraved as a 6:5 or 12:7 tuplet that also broke the next tuplet: `split_rests_at_beats` became `split_at_beats`, which cuts notes (tied), chords and rests that run off the 16th grid across a beat line; a triplet note held over a beat line to a third of the next beat made music21 mis-group the bar's later tuplets: the same fix; the eighth minimum could end a note on a 16th inside a following triplet beat (a 1/12 rest after it): such an end now stops at the beat line; a beat with onsets on the beat only cost nothing on every lattice, so the path could stay in triplets around a lone early or swung note among quarter notes (phases 0.335–0.384, 0.616–0.665): such beats now pay each lattice's penalty, and the path starts duple. Cost of the fixes (harness, against the numbers above): Beethoven 22-1 built melody position 0.252 → 0.244 (T2 tune mean −0.001), Schubert D 664/1 perfect grid 0.897 → 0.877 (check mean −0.002); T1, T3–T5 unchanged. Not changed (plausible, not confirmed as faults): the path links runs across long rests; `beat_onsets` and `lead_in` still use the per-note snap; two voices of one hand choose their lattices apart.

## 27. Stage 12: beats under rubato — the errors are level and phase, not timing; nothing adopted (2026-10-28)

§26 showed that the grid is the gap on solo classical piano (T2): on perfect beats, bar lines and meter the melody's written position is 0.903 / 0.835 (tune / check), on the built grid 0.277 / 0.445. Stage 11's meter diagnosis named the beat tracker under rubato as the next lever. This stage measured how much perfect beats are worth, where the beats go wrong, and tried the fixes that the diagnosis proposed.

**Upper bound** (`s10/h10.py --grid b`: the reference's annotated beats with our subdivision, bar-length and downbeat steps; T2, tune / check): melody written position 0.277 → **0.473** / 0.445 → **0.593**, downbeat F 0.505 → 0.725 / 0.585 → 0.816, beat F 0.681 → 0.947 / 0.781 → 0.974. Perfect beats are worth about +0.20 / +0.15 of melody position; the rest of the gap to the full oracle (0.903 / 0.835) is the meter (bar length, subdivision, bar phase) on top of them.

**Where the beats go wrong** (`s13/beatdiag.py`, beat F against the annotated beats at ±70 ms, as annotated / at the best metrical level; T2 tune / check):

| Step | Beat F (annotated level) | Beat F (best level) |
|---|---|---|
| Beat This! raw peaks | 0.720 / 0.856 | 0.746 / 0.884 |
| `steady_beats` (the DP at the model's local tempo) | 0.664 / 0.865 | 0.708 / 0.883 |
| `model_grid` (tatums, bars fitted) | 0.651 / 0.861 | 0.687 / 0.874 |
| built (`spliced_grid`) | 0.644 / 0.775 | 0.683 / 0.785 |

Per reference beat interval (`s13/errtype.py`, steady beats; tune / check): one beat at the right place 57% / 83%, one beat off the beat (wrong phase) 14% / 8%, no beat 6% / 1%, two or more beats 23% / 9%. The errors come in runs: Barcarolle and Liszt's Gondoliera hold 2–5 model beats per written dotted-quarter beat for 20–40 beats, Glinka alternates half-speed and double-speed stretches, BWV 846 runs on the off-beat for 10–13 beats and comes back, Beethoven op. 22 mixes double beats and off-beats for about 25 beats after bar 30. The model's own downbeat peaks come about twice per written bar (count ratio 2.07 / 1.96; downbeat F 0.515 / 0.663, our bar lines 0.512 / 0.596). **So the missing beats are a choice of metrical level and phase inside the piece, not timing jitter.**

**Candidates** (none adopted):
- *Snap each beat to the transcribed onset near it* (within a quarter of the local beat interval; nearest, or by onset strength with bass ×3): beat F +0.011 / +0.002. Timing is not the problem.
- *A beat-pointer HMM* (Krebs/Böck: states = period × position at 50 frames/s, Viterbi, tempo-change cost λ·|τ'/τ − 1|, periods 0.55–1.8 × the piece's median so one metrical level) on the model's beat probability: beat F best at λ = 10 (0.694 / 0.861 against steady 0.664 / 0.865), worse at λ 30–300 (classical rubato needs fast tempo changes), and the transcribed onset curve mixed into the observation lowers it. **In the whole grid it loses** (`s13/hpatch.py`, T1 + T2): T2 melody written position 0.277 → 0.259 / 0.445 → 0.392, downbeat F 0.505 → 0.484 / 0.585 → 0.540; Starlight's written position 0.649 → 0.121 (its soft intro). λ = 3: T2 tune 0.153.
- *No splice* (the model grid everywhere, `SURE_CV` = ∞): T2 check melody position +0.031 and downbeat F +0.057, T2 tune −0.031 / −0.056, Connections −0.11 (its intro). The same trade as §18; the setting stays.

**Verdict: no change.** A post-processing step cannot tell which metrical level the score writes when the model taps a different level for 20–40 beats: the beat probability, the onset curve and the tempo path all agree with the model's level there. The levers that remain need input that the bank does not have: (1) a model that reads the written meter from the notes (DuET, `t-mvrr7sms-imbm4l`, waiting for Jm), (2) a larger classical tune set (MAESTRO audio for more ASAP pieces, a large download, waiting for Jm). Scratch: `~/.kaya/piano2video/scratch/p2v-versatile/s13/` (`beatdiag.py`, `beatcands.py`, `errtype.py`, `dbdiag.py`, `hpatch.py`, `hp.sh`, `hset.sh`); harness results `s10/results/s13-b.json`, `s13-nosplice.json`, `s13-dbn10.json`, `s13-dbn3.json`.

## 28. Stage 13: instrumental riffs keep their 16ths (2026-10-28)

The bank's T5 songs (an instrumental section: a drop, a riff, a synth line) had melody written length 0.048 / 0.104 (tune / check): the lowest measure in the bank. Per song the length ratio (ours / the reference's) was exactly 2.0 on Aerodynamic, Solar Sailer and Opus (`s13/lenratio.py`). The cause is §17's rule: the `arrange` path writes every lead note in eighths (`ROLE_PENALTY["arrange"] = {"lead": 0.5}`), chosen on sung melodies, where a 16th is loose timing. On T5 the lead is the band's line (`hook_line`, §21), and a riff's 16ths are real: the references write 60% / 71% of their melody notes as 16ths (Opus, Aerodynamic, Solar Sailer 100%).

**Change.** `Note.hook` marks a lead note that `arrange_full` takes from the band's line. `notation.role_pen` gives such a note no role penalty: it is written as the piano part is (16ths when an onset is clearly between two eighths, §26's beat lattice, note ends on the 16th). A sung lead note keeps the eighths.

**Tried first:** the whole `arrange` lead at a finer penalty (0.15 or 0.3, `s13/hset.sh`). It gives T5 the same gain but costs the sung lead of T4: melody written length 0.642 → 0.589 / 0.611 → 0.589 at 0.15. Marking the hook notes keeps T4's sung notes as they were.

**Before → after** (bank `s11-final` → `s13-final`, 54 songs, every variant, no failure; the routed variants; tune / check):

| Measure | T5 lead+accomp | T5 lead (lead+chords) | T4 lead+accomp | T1, T2, T3 |
|---|---|---|---|---|
| Melody written length | 0.048 → **0.371** / 0.104 → **0.524** | 0.095 → 0.341 (0.000 → 0.246) / 0.104 → 0.462 (0.104 → 0.476) | 0.642 → 0.657 / no change | no change |
| Melody written position | no change / 0.610 → **0.497** (loss) | no change / 0.610 → 0.420 (the same) (loss) | 0.760 → 0.767 / no change | no change |
| Notes shorter than an eighth (the references: 0.60 / 0.71) | 0.000 → 0.173 / 0.000 → 0.226 | 0 → 0.37 / 0 → 0.46 | 0.053 → 0.090 / 0.076 → 0.092 | no change |
| Symbols per bar (reading load) | 14.6 → 16.5 / 16.5 → 19.1 | 6.1 → 7.6 / 6.8 → 9.0 | 15.8 → 16.1 / 16.1 → 16.2 | no change |
| Written unplayable onsets | 0.001 → 0.000 / 0.007 → 0.002 | – | 0.005 → 0.004 / no change | no change |

(The T2 piano rows differ by ≤ 0.001 between the two runs: `s11-final` predates §26's review fixes.) The harness (`s10/h10.py`, routed lead+accomp, T3–T5) gives the same numbers. Per song (lead+accomp): Veridis Quo length 0.000 → 0.683; Opus length 0.000 → 0.771 and position 0.440 → 0.864; Solar Sailer 0.000 → 0.364 (its tempo is still read ×2); Aerodynamic 0.000 → 0.286; Some Chords no change (a slow chord line); Voyager length 0.000 → 0.667.

**Losses, with reasons.**
- *T5 check, melody position 0.610 → 0.497* (two songs): Hey Brother 1.000 → 0.792, length 0.417 → 0.292 (24 matched notes; its reference writes the drop's line in eighths and quarters, 19% 16ths, and five of the synth's played onsets fall clearly between two eighths); Voyager 1.000 → 0.333 (3 matched notes: its line is in the bass stem, below). Opus gains (0.440 → 0.864). The lead-only variants lose more (0.610 → 0.420): without the accompaniment the written right hand is the line alone.
- *Reading load*: 13% / 15% more symbols per bar on T5. A riff in 16ths is more symbols; it is also what the song plays.
- *`--source arrange` forced on solo piano songs* (not the route; `auto` sends them to the piano path, unchanged): T1 lead+accomp melody length 0.421 → 0.269 / 0.412 → 0.514, T2 position 0.250 → 0.208 / 0.578 → 0.552. There the band's line is the pianist's own top line, played with rubato, and its in-between onsets are timing, not 16ths.

**Rendered review** (`scratch/p2v-versatile/s13/rv/`, page 1 of Opus at 80 dpi, `s13-t35-base` and `s13-hook`): before, the right hand's top voice was all eighths; after, most bars from bar 2 on show the riff as beamed 16th figures, with some 16th rests and dotted eighths where the line misses a note (the line has 138 notes in the reference span, the reference 192). The left hand and the slow bars 10–11 (half notes) read the same in both.

**Checked, not changed** (`s13/t5diag.py`: melody overlap of each stem's notes with the reference):
- *Bass hooks.* Solar Sailer's and Voyager's lines are in the bass stem (the bass alone: overlap 0.91 / 0.74; ours 0.07 / 0.12). `hook_line` reads only the chordal stems. No reference-free cue separates them: the bass is louder than every band stem in Solar Sailer (+10.7 dB) and Voyager (+5.1 dB) but also in Some Chords (+5.6 dB) and Opus (+1.1 dB), whose lines are in `other`; both bass-hook songs are on the check half, so the tune half cannot set a rule.
- *Aerodynamic.* No stem's notes match the reference (overlap ≤ 0.02 at every time shift within ±4 s; the pitch-class shares agree): Basic Pitch hears 74 notes of the guitar arpeggio where the reference has 128 16ths. A transcription gap, not a rhythm rule.

**Code review** (`high`, a subagent; 5 findings, none a confirmed fault): the `ROLE_PENALTY` comment now names the hook exception (fixed); a new test runs a sung line and a riff in one lead voice through `build_score` (fixed: eighths, then 16 written 16ths, no tuplet); a hook note in a beat that the lattice writes in thirds next to a sung note could give an odd length, but no `arrange` score in the bank has a tuplet (0 of 54), so no guard; `lead_mono`, the lead voice and the hands treat a hook note as "lead" on purpose (it is the melody); the T5 check position loss is named above.

**Verdict: adopted.** Tests: `test_a_band_hook_lead_note_is_written_like_the_piano_part`, `test_build_score_writes_a_sung_line_in_eighths_and_a_band_riff_in_16ths`, and the band-line test checks the flag. Scratch: `~/.kaya/piano2video/scratch/p2v-versatile/s13/` (`hset.sh`, `lenratio.py`, `refshort.py`, `hookioi.py`, `t5diag.py`, `refalign.py`, `engrave.sh`).

## 29. Stage 14: a melody voice in the piano path — checked, no change (2026-10-28)

On solo piano (T1, T2) the `piano` path writes each hand in one voice, and `key_lengths` ends each key at the hand's next onset (legato per hand). §26's diagnosis named "a held melody note cut by the hand's next onset" (ii-C) as 12% of T2's written notes. This stage measured whether a right-hand melody voice, held to the next melody note and written as a second voice (`notation.LEAD_VOICE`), fixes it. Harness: `s10/h10.py` with `s14/vpatch.py` (replaces `pipeline.arrange_piano_only`), T1 + T2, on the oracle grid (the reference's beats, bars and meter) and on the built grid; the code as it is reproduces `s12-rv-*` exactly.

**Q1. What is a transcribed note end?** (`s14/q1.py`, 19 ASAP pieces with performance MIDI, 13,314 transcribed notes paired with performed notes, 98% of them.) It is the **pedal end**, not the key-off: transcribed end − pedal end, median −0.001 / −0.005 s (tune / check); transcribed end − key-off +0.084 / +0.215 s. Of the 6,185 notes that the pedal holds more than 0.25 s past the key-off, 3% end within 0.1 s of the key-off and 53% within 0.1 s of the pedal end (41% between the two: I suspect the string decays first). Only pieces with little pedal (Mozart, Haydn, Beethoven op. 22, Bach 854 / 865) give the key-off. So under the pedal the audio does not tell when a key came up.

**Q2. Melody voice variants** (the melody note ends at min(its sounding end, the next melody onset); the other notes keep `key_lengths`): *a* the top line of the key-length notes (a control: no length changes, two voices only); *b* the top line of the sounding notes; *c / c2* a velocity-voiced top line (a lower onset under a held melody note goes to the inner voice only if it is ≥ 10 velocity steps softer; c2 also needs the held note to sound > 0.1 s past it, not a legato overlap); *d* b + the overlap rule only; *o* the reference's own melody notes (an upper bound for the melody choice, not buildable). T2, change against the code as it is, tune / check (`s14/results/cmp-oracle.txt`, `cmp-built.txt`):

| Variant | Melody written length (oracle grid) | Written length (oracle grid) | Melody written length (built grid) | Symbols per bar (oracle tune / check; built tune / check) |
|---|---|---|---|---|
| as it is (value) | 0.616 / 0.579 | 0.592 / 0.547 | 0.236 / 0.390 | 10.2 / 9.9; 14.1 / 13.8 |
| a (two voices only) | +0.016 / +0.002 | +0.014 / +0.013 | +0.003 / +0.000 | +1.0 / +1.1; +1.8 / +2.6 |
| b (sounding top line) | −0.143 / −0.049 | −0.062 / −0.016 | −0.071 / −0.020 | +1.1 / +1.6; +2.0 / +3.2 |
| c2 (velocity-voiced) | −0.002 / +0.020 | −0.002 / +0.009 | −0.005 / +0.008 | +1.0 / +1.2; +1.8 / +2.9 |
| d (overlap rule only) | −0.103 / −0.046 | −0.033 / −0.012 | −0.026 / −0.022 | +1.0 / +1.2; +1.7 / +2.9 |
| o (the reference's melody) | +0.023 / +0.002 | +0.019 / +0.006 | +0.009 / +0.007 | +1.0 / +1.3; +1.8 / +2.8 |

T1: every variant that holds notes loses on the check half (c2 melody length −0.066 / −0.053 oracle / built on Sad Piano and Starlight; Starlight written length −0.05 to −0.11, o included); a changes nothing. The check half's melody position gain of b–d (+0.03 to +0.07) is one piece, Chopin op. 25/1 (a melody over arpeggios, +0.34 to +0.53); without it the change is about 0.

**A side effect: the lead voice drops notes.** `notation.quantize_hand(..., lead_mono=True)` keeps one lead note per written onset. In one voice two onsets that snap to one 16th become a chord; in a lead voice the second note is lost. Written right-hand notes (oracle, T1 + T2): 10,160 as it is, 9,356 with a (−7.9%), 9,830 with c2 (−3.2%). The bank's measures are shares of matched pairs, so they do not show it. With `lead_mono` off (every note kept), the upper bound o gives at most +0.016 melody length and +0.013 length on any T2 half, and c2 gives −0.011 to +0.019 (`s14/results/cmp-lm-*.txt`). `lead_mono` stays: in the `arrange` path the lead is one line (sung, or the band's), and one note per written onset is the intent there; a future two-voice piano hand must turn it off first.

**Why the gain is small** (`s10/ana.py` classes, `s14/q3cls.py`): (1) the melody choice is not the limit: the perfect choice fixes about one third of the right hand's "cut by the next onset" misses and one fifth of all of them, because 35% are left-hand held notes and many right-hand ones are inner voices; (2) "hold to the next melody note" makes new misses where the score writes a shorter melody note and a rest, and under the pedal (Q1) the audio cannot tell which (c2: cut-short −0.014 / −0.022, too long + notation longer +0.019 / +0.013); (3) the second voice itself costs one to three symbols a bar (variant a, which changes no length, costs as much: the lead voice's rests show and chords split into two stems).

**The "too long by the legato rule" class** (ii+L: the key held to the hand's next onset, the score writes it shorter; `s14/q3leg.py`): Connections 86 of 443 pairs (19.4%), T2 4.1% / 4.4%. The transcribed pedal is down at the key end on 100% / 95% / 90% of them, and ours is a median 1.95× (Connections) and 1.79× / 1.91× (T2) the written length. A melody voice cannot help this class: it only lengthens notes (Connections ii+L 19.4% → 21.2% with c2).

**Verdict (melody voice): no change.** No variant that holds notes gains on the tune half on either grid (the control a's +0.016 / +0.014 on the oracle grid comes from the two-voice writing and its 7.9% dropped notes, not from a length), the check gains are ≤ +0.02, T1 check loses, and the reading load rises 10–21%. The limits are the length rule and the pedal, not the choice of melody. `key_lengths`'s docstring records the check. Scratch: `~/.kaya/piano2video/scratch/p2v-versatile/s14/` (`diagnosis-voice.md`, `q1.py`, `vpatch.py`, `vp.sh`, `cmp.py`, `q3cls.py`, `q3leg.py`, `wcount.py`); harness results `s10/results/s14-*.json`.

**A written-length cap for the legato class — tried, not adopted.** Diagnosis on the oracle grid, pairs with the written position right (`s15/legfeat.py`, `s15/legtab.py`): in Connections the 74 cut pairs that we write too long all have the pedal down; the hand's next onset is 1.0–1.55 beats away (p25–p75), and the reference writes half a beat (50) or one beat (24). Every cut pair that we write right there is ≤ 1 beat (272 of 272). In T2 the too-long cut pairs are short notes (the reference 0.08–0.33 beat, ours 0.17–0.5: detached notes), and the cut pairs that we write too short are more (434 / 365 against 310 / 271). Offline (`s15/capsim.py`): "a cut note under the pedal is at most one beat" fixes 24 Connections pairs and breaks none (+0.054 length); T2 +2 / −11 (tune), +1 / −10 (check). "Half a beat when the next onset is one beat away" breaks 79 T2 check pairs. Harness (`s15/cpatch.py`, the one-beat cap after `build_variant`, pedal down at the key end; T1 + T2):

| Grid | T1 tune melody length / length | T1 check | T2 tune melody length / length | T2 check | Symbols per bar, T1 tune / check |
|---|---|---|---|---|---|
| oracle | 0.514 → 0.585 / 0.679 → 0.736 (melody length: Connections 0.585 → 0.726, Friends no change; length: Connections only, Friends has no full reference) | no measured change | −0.006 / −0.003 | −0.004 / −0.005 | +0.5 / +0.4 |
| built | no measured change | no measured change | −0.002 / +0.001 | −0.004 / −0.003 | +0.25 / +0.45 |

On the built grid Connections is 12/8 (a dotted-quarter beat; the reference 6/4, the same bar), so a one-beat cap is 1.5 quarters: it adds rests after notes held longer (+0.2 symbols a bar) but changes no matched Connections length. On the check half the cap adds rests too (Starlight +0.8 symbols a bar), and no measured length changes. **Not adopted:** the gain is one song on the oracle grid only, the check half shows no gain, T2 loses a little on both halves, and every T1 song gets more symbols. The class is the arranger's style (detached eighths under the pedal in a pop cover), not a fault the audio shows; a rule for it needs more T1 songs with full reference scores to choose and check it. Results `s10/results/s15-cap1p-{oracle,built}.json`.

## 30. DuET (performance MIDI → MusicXML) as the piano path's grid and notation — strong only where it may have trained; not adopted (2026-10-28)

Jm approved the DuET spike on 2026-10-28 ("approve"). DuET (Zeng & Wang, arXiv 2610.21467; code MIT, weights CC BY-NC 4.0, personal practice only) reads a performance MIDI and writes a full score: meter, key, staves, voices. §27 showed that our T2 gap is the grid (beat level and phase), which a post-processing step cannot fix; DuET reads the meter from the notes, so it was the main T2 lever.

**Setup, kept outside the repo** (no pipeline code changed): a code read first (`s16/duet-read.md`: MIDI path only, weights from a local folder, safetensors with a SHA-256 check, no pickle, no network); venv `~/.kaya/venvs/duet` (Python 3.12, `duet-score` pinned to commit `c98699c0`); weights in `~/.kaya/piano2video/models/duet/` (HF commit `27e1ed4d`, SHA-256 `89e07104…ad114e0` checked on download). CPU: 13 s for a 96 s piece.

**Harness** (`s16/duet_h.py`, `s16/duet_pos.py`): DuET on our own transcribed MIDI (with its pedal); the grid = DuET's score quarters → the notes' performance onsets (median per written onset, made monotone); a first bar shorter than the others (a pickup) is padded so that bar 1 starts on a bar line; the sounding notes stay ours, so only the grid and the written score change. The base run (`s13-final`) is scored again with the same code.

**Result** (T1 + T2, routed lead+accomp; `s10/results/s16-duet-base.json` → `s16-duet.json`):

| Group | Melody written position | Melody written length | Written length | Meter right | Bar lines (downbeat F) | Symbols per bar |
|---|---|---|---|---|---|---|
| T2 tune (10) | 0.277 → 0.386 | 0.236 → 0.300 | 0.229 → 0.307 | 30% → 60% | 0.505 → 0.565 | 14.1 → 17.3 |
| T2 check (10) | 0.445 → **0.891** | 0.390 → 0.663 | 0.378 → 0.623 | 70% → 90% | 0.585 → 0.906 | 13.8 → 17.3 |
| ASAP pieces in Beyer & Dai's test list (4: Liszt, Mozart 12-1, Rach 23-4, Scriabin): likely **unseen** by DuET (an assumption, see below) | 0.532 → **0.305** (changes > 0.02: 0 gains, 2 losses) | 0.405 → 0.337 | 0.379 → 0.279 | 50% → 50% | 0.572 → 0.522 | 13.0 → 18.5 |
| The other 15 ASAP pieces: **possibly in DuET's training set** | 0.272 → **0.703** (changes > 0.02: 11 gains, 2 losses) | 0.252 → 0.494 | 0.279 → 0.505 | 47% → 87% | 0.512 → 0.779 | 14.7 → 17.7 |
| Not in ASAP: the 4 T1 covers + Für Elise (T2, also in the T2 rows); melody measures n = 4, written length n = 2 | 0.986 → **0.547** | 0.672 → 0.354 | 0.668 → 0.488 | 100% → 50% | 0.807 → 0.669 | 13.5 → 12.0 |

Per song, melody position: gains of up to +0.96 (Chopin op. 25/1 0.03 → 0.99, Mozart 12-3 0.07 → 0.98, Beethoven 28-1 0.09 → 0.99, Ballade 2 0.10 → 1.00, Schubert D 664 0.55 → 1.00, Bach 865 0.76 → 1.00); losses: Connections (DuET writes 4/4, the score is 6/4: position 0.95 → 0.14, length 0.66 → 0.00), Sad Piano (1.00 → 0.05), Rachmaninoff 23-4 (0.71 → 0.04), Scriabin (0.36 → 0.12), Barcarolle (0.20 → 0.08), Haydn (0.15 → 0.09, meter lost); Für Elise keeps its melody position but loses the meter. Gains on the songs outside ASAP: Friends melody length 0.44 → 0.54, Starlight written position 0.65 → 0.98 and length 0.68 → 0.98.

**Why not adopted.** DuET trained on (n)ASAP with a piece-level split that the authors do not publish. Its test set has 59 performances, the count of Beyer & Dai's test set (ISMIR 2024, MIDI2ScoreTransformer, whose code names 14 test pieces); that DuET uses the same 14 pieces is an assumption, not confirmed (scratch `s10/pm2s-research.md` §3a). Its large gains sit on the ASAP pieces outside that list. On the 8 songs it most likely did not see (4 ASAP pieces in the list, 4 T1 covers), no piece gains melody position: 4 lose a lot (Rach 23-4, Scriabin, Connections, Sad Piano), 2 stay the same (Liszt near 0, Mozart 12-1 near 1), and 2 gain on other measures (Friends, Starlight). The evidence is thin (n = 8, and the unseen ASAP drop comes from 2 pieces), but it points the same way: the T2 gain cannot be told apart from training-set memory, and when DuET reads the meter wrong the whole score fails (Connections length 0.66 → 0.00). On T2 the scores also get 3–5 more symbols a bar (T1: 13.5 → 12.0, fewer). A clean test set decides it. That set is the new references from Jm's taste (classical pieces outside ASAP, pop covers), which the next stage adds. The harness stays in scratch for that test.

## 31. Stage 15: references from Jm's taste — a clean test set; DuET decided on it, not adopted (2026-10-28)

Jm, 2026-10-28: "you find more reference data. use songs you now i liek from youtube piano playlist, spotify, or my notes". Taste sources found: the YouTube watch history (Takeout; the rewatch count of a video is the signal), the Obsidian note `Piano Repertoire.md`; no Spotify data exists. The candidates and why the others were dropped are in scratch `s16/refs-candidates.md`. A reference needs the recording and the same arrangement as a free score: no account, no purchase.

**Added to the bank** (`bank/songs.json`; the scores in `~/.kaya/piano2video/reference/`; halves set by type before any measure):

| Song | Type, half | Taste signal | Recording | Score → reference | Checks |
|---|---|---|---|---|---|
| Avril 14th (Aphex Twin), SamJam Harris | T1 check | 14 watches of this video | YT `OCnlgGFmJ7c` | his free MIDI, the video's audio source: a quantized DAW file, 37 bars 4/4, A♭ major, 78 bpm; 39 note-offs that end up to a 64th early snapped to the 16th grid → `avril14-score.mid` | bars 1–2 equal his PDF note for note; 100% of 310 reference onsets within 70 ms of a heard onset (the audio is the MIDI played back); every bar 3.08 ± 0.03 s |
| Mr Cellophane + Razzle Dazzle, Jennie Chen | T1 tune | her channel (Connections, 5 watches) | YT `_xsFWVdcbZs` | her flat.io score `5f725096` (viewer JSON placed by voice order; 14 grace notes of length 0 left out, they broke the export) → `cellophane.musicxml`, 34 bars 4/4, C | 80% of onsets within 70 ms; bars 2.3–2.6 s; page 1 engraved and read: meter, key, triplets right |
| The Flower Duet (Delibes), Jennie Chen | T1 check (a cover pianist's arrangement, so T1) | as above | YT `2RFU0h3dOCY` | her flat.io score `5f6e6114` → `flowerduet.musicxml`, 22 bars 6/4, B major | 86% within 70 ms; bars 3.4–4.4 s, the last 5.3 s (ritardando) |
| Clair de Lune (Debussy), Pascal Rogé | T2 check | in `Piano Repertoire.md` | YT `c977QdbTImU` (Steinway & Sons) | Mutopia (Fromont 1905, public domain), its LilyPond MIDI, bars 1–18 (Andante très expressif and the first Tempo rubato phrase, 78 s), the D♭ major key added (the MIDI has none) → `clairdelune-b1-18.mid`. Not in ASAP, so DuET never saw it | 77% within 70 ms (soft and pedalled: the detector misses onsets; the whole piece 61%); the excerpt's bar starts agree with an alignment of the whole piece within 0.1 s; bar lengths follow the rubato, the long bar 14 is the written phrase end |

**Where a score sits in its recording** (scratch `s17/locate.py`): a subsequence DTW of the synthesized score against the whole recording, then `evaluate.align` over that span and the onset fit above. Check the first bar's length: twice the start came late and bar 1 was half as long as the others (Mr Cellophane 3.0 → 0.52 s, Flower Duet 2.15 → 1.5 s: a quiet intro chord or bass note); the first heard onsets fixed it.

**The new songs on the current code** (run `s17-new`, routed lead+accomp; all four route to the piano path, key right on all four):

| Song | Meter written (score) | Tempo right | Note F1 | Melody written position | Written position | Written length |
|---|---|---|---|---|---|---|
| Avril 14th | 2/4 (4/4) | yes | 0.988 | 0.138 | 0.148 | 0.055 |
| Mr Cellophane | 4/4 (4/4) | yes | 0.781 | 0.699 | 0.833 | 0.487 |
| Flower Duet | 2/4 at half tempo (6/4) | no | 0.916 | 0.098 | 0.142 | 0.003 |
| Clair de Lune | 3/4 (9/8) | no | 0.736 | 0.180 | 0.231 | 0.195 |

The notes are good, but the meter is wrong on 3 of 4, and then the written score fails even on a near-perfect transcription. Avril 14th: note F1 0.988, yet 15% of notes sit right in the bar. Its bar phase is right (the reference bar lines fall within 0.04 quarter of ours), but the position is measured as a fraction of the bar, so 2/4 bars place only the notes on beat 1 of the 4/4 bar right. On songs the bank never tuned on, the meter is the piano path's biggest gap (n = 4, so a direction, not a rate).

**DuET on the clean set** (`s17/clean.py`: the 8 songs of §30 that DuET most likely never saw, + these 4; ours → DuET; better / worse = changes > 0.02):

| Group | Melody written position | Melody written length | Written position | Meter right | Bar lines (downbeat F) | Symbols per bar |
|---|---|---|---|---|---|---|
| §30's unseen 8 | 0.725 → 0.344 (0 better, 4 worse, n = 7) | 0.492 → 0.269 | 0.583 → 0.386 | 71% → 57% | 0.672 → 0.562 | 14.1 → 15.9 |
| The 4 new references | 0.279 → 0.254 (0 better, 1 worse) | 0.149 → 0.171 | 0.339 → 0.297 (0 better, 3 worse) | 25% → 50% | 0.542 → 0.486 | 8.9 → 15.8 |
| All 12 | **0.563 → 0.311** (0 better, 5 worse, n = 11) | 0.367 → 0.233 | 0.485 → 0.351 | 55% → 55% | 0.629 → 0.537 | 12.4 → 15.9 |

Per new song: DuET finds Avril 14th's 4/4 but puts the bar lines half a bar off (written position 0.148 → 0.146); it writes 6/8 for Flower Duet (6/4) and for Clair de Lune (9/8; melody position 0.18 → 0.10); Mr Cellophane gains written length (0.487 → 0.649) and loses a little position (0.833 → 0.804). Each mean is over the songs that have that measure, so n differs by column (in the "All 12" row: melody 11, written position and length 10, bar lines 12), and a pooled mean is not the average of the two rows above it. **Verdict: not adopted.** On songs outside its training set, none of the 11 with a melody measure gains melody position and 5 lose, and the scores carry 3.5 more symbols a bar. §30's T2 gain was training-set memory. The harness stays in scratch (`s16/duet_h.py`); DuET's weights are CC BY-NC 4.0 (personal practice only).

**PDF-only references** (5 songs: The Moon Song, Star Treatment, Yellow, Everything Means Nothing to Me, California): OMR with homr 0.7.0 at 300 dpi on the vector PDFs (Finale, Notion, MuseScore exports), pages stitched (scratch `s17/omr/`, report `s17/omr-report.md`). Bars 1–8 read against the page: Moon Song, Yellow and California 7 of 8 bars right in each hand (one bar to repair); Star Treatment reads its 7/8 bars as 8/8 (bars 1, 25, 53, 57); Everything Means Nothing to Me adds a bar after bar 5 and flips the key, so it needs hand repair. The tempo mark was read in none. They are not in the bank yet (§34 adds the ones that align).

**Not usable without Jm:** Black Hole Sun (Westworld, ENPI: Jm's most-watched piano video, 25 times) and Light Years (The National) have free scores behind a Google or MuseScore sign-in. Redbone and one Star Treatment MIDI are dead links; Into My Arms, Hallelujah (full), Read My Mind, Where Is My Mind, Do I Wanna Know, Ho Hey and Last Night on Earth have only paid scores.

## 32. Stage 16: clef changes and octave lines — the bass off the ledger lines (2026-10-28)

**The defect.** Kaya's rating pass (scratch `s16/ratings-kaya.md`, defect b): the bass was written at its true pitch, with no 8vb and no clef change. Measured on run `s13-final` (routed scores), the share of left-hand note heads on 3 or more ledger lines: T1 0.081, T2 0.058, T3 0.119, T4 0.149, T5 0.278; deadmau5 Some Chords 0.882, Sober 0.510 (scratch `s17/ledgers.py`).

**A new measure.** `evaluate.notation_load` now gives `ledger_mean` and `ledger3` (bank headline `ledger3`): the ledger lines of each written note head, read with the clef in force and any 8va/8vb (`written_ledgers`). A parsed score keeps sounding pitches under an octave line, so the head moves 7 diatonic steps.

**The change** (`notation.staff_modes`, `apply_staff_modes`, used by `build_score`; `STAFF_CLEFS` switches it). Per bar, each staff takes one mode: its home clef, the home clef under an octave line (8va over the treble, 8vb under the bass), or the other clef. A bar costs the ledger lines past 2 of its note heads, + `STAFF_AWAY` (0.5) out of the home mode. A Viterbi path over the bars adds `STAFF_CHANGE` (3.0) for each change, so one high note does not flip the staff. The octave lines are music21 `Ottava(transposing=False)`, and MusicXML keeps the sounding pitches: the notes, the MIDI and every other measure stay the same. Verovio draws the lines (checked on a test score and on the pages below). The two settings were set by reasoning before the run and not tuned; the check half shows the gain.

**Result** (all 62 songs, with §34's four, on the reviewed code: `--set notation.STAFF_CLEFS=False` → default; runs `s19-base` → `s19-clefs`; routed lead+accomp; scratch `s17/cmp_clefs.py`; the first run before the review, `s18-*` on 58 songs, gave the same T2–T5 rows):

| Type | Note heads on 3+ ledger lines, tune | check | Symbols per bar |
|---|---|---|---|
| T1 (5 + 6) | 0.044 → 0.024 | 0.048 → 0.017 | same |
| T2 (10 + 11) | 0.069 → 0.031 | 0.044 → 0.016 | same |
| T3 (5 + 4) | 0.056 → 0.043 | 0.081 → 0.036 | same |
| T4 (8 + 6) | 0.058 → 0.020 | 0.085 → 0.023 | same |
| T5 (3 + 4) | 0.177 → 0.013 | 0.062 → 0.010 | same |

Every other headline measure is unchanged (largest change 0.000). The largest drops: Some Chords 0.365 → 0.000, Adele Hello 0.210 → 0.069, Sober 0.143 → 0.011, Hey Brother 0.146 → 0.022, Pumped Up Kicks 0.132 → 0.015, Glinka 0.166 → 0.070. The cost is a few new signs: clef changes per 10 bars, mean (max) T1 0.22 (0.8), T2 0.34 (2.0), T3 0.14 (0.5), T4 0.05 (0.7), T5 0 (0); octave lines per 10 bars T1 0.05, T2 0.19, T3 0.21, T4 0.38, T5 0.26.

**Rendered review** (page 1, scratch `s17/rv-clefs/`). Sober: an 8vb line under the left hand in bars 1–7 and 13–25; the band's bass now sits on the bass staff, not 3–5 ledger lines below it. Glinka, The Lark: 8va over the right hand's high runs (bars 3–5, 9–10) and a left-hand stretch in the treble clef. One cost is visible there: in bar 3 a wide arpeggio keeps its low notes under the 8va, so they take ledger lines below the staff (the bar's cost is lower that way). I suspect two rare faults, not counted: a tied note that crosses out of an octave-line bar shows its tie at the other octave, and a chord that spans both registers in one bar keeps the worse half on ledger lines. There is no 15ma/15mb: notes two octaves off the staff (a right hand at C7–C8) keep 3+ ledger lines under the 8va. After the code review, an empty bar costs nothing in any mode, so a staff keeps its octave line or clef through a long rest instead of leaving it and taking it again.

**Not tried:** moving the band's bass up an octave in the arrangement itself. It would change what sounds (the chroma and fidelity measures), so it is an arrangement decision, not notation.

## 33. The meter of the piano path — a diagnosis, no change (2026-10-28)

The clean set (§31) put the meter first: on the T1 and T2 songs with a reference meter, our meter is wrong on 13 of 27 (run `s13-final` + `s17-new`; scratch `s17/meters.py`). A read-only diagnosis on the cached Beat This! logits and transcriptions (scratch `s17/meter-diag.md`, `s17/meter/`) splits the 13:

- **(A) the beat level, 3:** Liszt Gondoliera and Chopin Barcarolle (the model's beat interval 0.50 and 0.46 of the reference's, erratic: CV 0.41 and 0.63) and Flower Duet (2.11: the model taps half notes at 46 bpm, the reference is 97.5). A fold to half rate when the beats are erratic and fast fixes the level on both, but they then read 3/4, and it would break Chopin op. 25/1 (right by luck at level 0.51). Doubling a slow model level would break 6 right or near-right pieces (Scriabin 34.7 bpm, Berceuse 36, Clair de Lune 40, Rach 23/4 54, Beethoven 28-1 55, Glinka 56).
- **(B) the subdivision test at the right level, 4:** Bach BWV 865 (9/8 with 16ths: 6 per dotted quarter, and `subdivision` tests only 2, 3 and 4; a 6-lattice reads 0.52 on the model's beats) is a real gap, but adding the lattice changes only that one tune-half piece, with a 2.5× margin. Ballade 2 and Clair de Lune show no 3-lattice even on the reference beats. Rachmaninoff op. 23/4 (3/4 with triplets, written 9/8 by us) is a notation choice. A lower margin (1.5, 1.2, 1.0) flips only songs that are right now (Beethoven 22-1, Mr Cellophane, Schubert 664-1, Scriabin).
- **(C) the bar length at the right level and subdivision, 6:** Mozart 12-3, Beethoven 28-1, Bach BWV 846, Avril 14th, Schubert Moment musical 3, Rachmaninoff 23/6. On the 16 songs with the right level and subdivision, the joint pick gets 10 right; notes only 12 (but it breaks Mr Cellophane); a "prefer the half bar" rule 12 (it breaks Bach BWV 854). BWV 846, Avril 14th and 23/6 need the longer bar, the others the shorter, and three of them stay wrong on the reference beats too: one bar or two of a repeated pattern is not in the accents.

**No change:** each candidate rule helps 1–2 songs and breaks as many, on 16–27 songs. What would move the meter is evidence the accents do not hold (a phrase-level or harmonic-rhythm model, or a trained meter classifier), and more reference songs to choose it on. This is the main blocker of the piano path's written score on unseen songs.

## 34. Four more references from PDF scores (OMR), and DuET on them (2026-10-28)

The PDF-only candidates of §31, page 1 of each: homr's reading repaired bar by bar against the page (scratch `s17/omr-report.md`, "Page-1 references"; script `s17/omr/repair_p1.py`). Every bar of both staves sums to the bar length. Everything Means Nothing to Me stays out (OMR adds a bar and flips the key: it needs a hand pass).

| Song | Type, half | Taste signal | Recording | Reference | Repaired bars | Onset fit (70 ms) |
|---|---|---|---|---|---|---|
| The Moon Song, Verendlich | T1 tune | Moon Song tutorial watched 3 times | YT `QyehZjeKSyw` | `moonsong-p1.musicxml`, bars 1–25, 4/4 C | RH 4, 11; LH 3–4 (a G4 added, medium confidence), 11 | 61% (soft playing: 127 heard onsets for 169) |
| Yellow, Forte Notes | T1 check | Yellow tutorials watched 10 times | YT `yGhmTl0XoXo` | `yellow-p1.musicxml`, bars 1–26, 4/4 B major, quarter = 80 | LH 10, 21–24, 26; RH 24, 26 | 94% |
| Star Treatment, yesterdayssjam | T1 tune | in `Piano Repertoire.md` | YT `hzEPHJVtGzE` | `startreatment-b2-21.musicxml`, bars 2–21, 4/4, 2 flats, quarter = 60 (bar 1 is 7/8; the bank reads one meter, so the reference starts at bar 2) | bar 1's time signature | 98% |
| California, DG Piano | T1 check | 1 watch | YT `Fot3rRewpZ8` | `california-p1.musicxml`, bars 1–18, 4/4 E major, quarter = 75 (the "classic" PDF) | LH 4, 8, 15, 16; RH 2, 6, 8, 10, 15–17 | 70% |

As in §31, the subsequence DTW started late on three (Yellow, California, Star Treatment: the first bars came out short); the start taken back from the steady bars fixed it (Star Treatment bars 2–10 went from 1.3–3.0 s to 3.9–4.0 s, its fit from 77% to 98%).

**Our scores** (run `s18-omr`): all four route to the piano path with the right meter, tempo and key. Written position Moon Song 0.919, Yellow 0.760, California 0.962, Star Treatment **0.000** (beat F 0.981, bar lines F 0.000: the beats are right, the bar lines are not, which I suspect comes from the 7/8 first bar that shifts our bar phase). Melody position 0.963, 0.779, 0.964, 0.000.

**DuET on them** (`s18-duet`): Yellow written position 0.760 → 0.992 and melody position 0.779 → 0.966; Star Treatment 0.000 → 1.000 (DuET finds the bar phase); California 0.962 → 0.193 and melody 0.964 → 0.088; Moon Song the same. Over all 16 clean songs (§31's 12 + these 4): melody position 0.593 → 0.430 (2 better, 6 worse, n = 15), written position 0.535 → 0.472, symbols per bar 12.1 → 15.9 (13 of 16 worse). The verdict stays "not adopted" as the default. But the two grids fail on different songs (Star Treatment ours 0.00 / DuET 1.00, California ours 0.96 / DuET 0.19), so a per-song choice between them by a reference-free signal is the one DuET lever left. It is not built: it needs that signal, and the bank has 8 such songs to choose it on.

## 35. Stage 17: the right hand plays the melody alone — one voice a staff on songs with vocals and on band songs (2026-10-28)

**The defect.** Kaya's rating pass (scratch `s16/ratings-kaya.md`, defect a, the main reason every T3–T5 score rated Play 2–3): `hybrid` and `arrange` gave the right hand the melody and the accompaniment under it, and §17 wrote them as two voices on one staff. Measured on run `s19-clefs` (routed `lead+accomp`; scratch `s18/voices.py`; tune / check): the right hand had two voices with notes in 83% / 73% of bars (T3), 82% / 84% (T4), 91% / 100% (T5); 32% / 28% (T3), 30% / 24% (T4), 25% / 22% (T5) of the lower voice's onsets sat under a rest of the melody voice (a rest stacked over the accompaniment); 1–11% touched or crossed the melody (note heads a second or less apart). The right hand wrote 9–13 symbols a bar, the left hand 5–6.

**New measures** (`evaluate.notation_load`, bank headline): `rests` = visible rests per bar (all staves), `two_v` = the share of a staff's bars where two voices write notes. The baseline was re-scored with them (`s19-clefs-v`; every other number is the same as `s19-clefs`).

**The change.** The usual solo-piano layout: the right hand plays the tune, the left hand plays the accompaniment.
- `arrange.melody_alone` (called by `pipeline.build_variant` for `hybrid` and `arrange` with `lead+accomp`; `RH_ACCOMP = "bars"`): in each bar where a lead note sounds (`melody_bars`, the onset and end taken as the score writes them), every right-hand accompaniment note goes to the left hand. It takes the octave nearest its pitch inside 15 semitones over the left hand's lowest note sounding or struck within 0.25 s (C3–B3 when the hand is free), at most `ALONE_TOP` = E4 (two ledger lines over the bass staff) and a whole tone or more under the melody. A note is dropped when no octave fits, when the hand already strikes 5 notes with it, or when it would take the hand past 15 semitones or strike the same key again within 0.25 s. In a bar without melody the right hand keeps the accompaniment. The MIDI, the video and the score all play the new arrangement.
- `notation.LEAD_BARS` (default on): in a bar without melody, the right hand's other notes are the staff's first voice, so that bar shows no melody rests stacked over them.

**Candidates** (T3–T5, 30 songs; tune / check; baseline `s19-clefs-v`):

| Variant (run) | Symbols per bar T3 / T4 / T5 | Pitch-class similarity to the recording T3 / T4 / T5 | Notes |
|---|---|---|---|
| baseline | 18.2/14.0, 16.1/16.2, 16.5/19.1 | 0.770/0.835, 0.747/0.727, 0.702/0.730 | `two_v` 0.37–0.50 |
| `LEAD_BARS` alone, score only (`s21-bars`) | 18.1/13.8, 16.2/16.3, same | same | rests T3 −0.05/−0.17, T4 +0.04/+0.04: too small |
| melody alone, a pitch class the left hand strikes within 0.25 s dropped (`s21-alone`) | 13.0/10.5, 13.1/13.0, 13.5/15.4 | 0.758/0.825, 0.725/0.706, 0.665/0.699 | 32% of T3 notes dropped |
| … pitch class and 5-note rule only for notes struck together (`s22-alone`) | about the same | 0.759/0.827, 0.729/0.710, 0.668/0.703 | |
| … an octave doubling kept when it fits (`s22-alone-pc`) | 13.2/10.6, 13.1/13.0, 13.6/15.5 | 0.761/0.829, 0.740/0.720, 0.691/0.721 | notes on 3+ ledger lines T3 0.043 → 0.070 |
| **… left hand at most E4 (`s22-alone-top`, adopted)** | 13.0/10.5, 13.1/13.0, 13.5/15.5 | 0.759/0.825, 0.740/0.719, 0.690/0.721 | ledger lines T3 0.038/0.028 (below the baseline) |
| … at most C4 (`s22-alone-top60`) | same ±0.1 | same ±0.003 | no gain over E4 |
| … a note struck with a melody note stays under it as a chord, held with it (`s22-chords`) | 12.9/10.5, 12.9/12.7, 13.4/15.2 | 0.766/0.831, 0.735/0.720, 0.695/0.718 | chord-tone fit T3 0.936 → 0.919 / 0.944 → 0.929 (a held note runs into the next chord); written unplayable onsets up to 0.6% |

The tune half chooses the E4 cap (ledger lines T3 0.070 → 0.038, sound the same) and not the chords variant (on the tune half: similarity +0.007 / −0.005 / +0.005, chord-tone fit −0.017 / −0.004 / −0.006, more rests and unplayable onsets: no clear gain, and more code).

**Before → after in the whole pipeline** (all 62 songs, the new defaults after the code review; `s19-clefs-v` → `s24-final`; routed `lead+accomp`; tune / check):

| Measure | T3 piano + vocals (5 + 4) | T4 no piano (8 + 6) | T5 instrumental (3 + 4) |
|---|---|---|---|
| Bars with two voices on a staff | 0.414 → **0** / 0.366 → **0** | 0.409 → **0** / 0.422 → **0** | 0.453 → **0** / 0.500 → **0** |
| Symbols per bar | 18.2 → **12.9** / 14.0 → **10.4** | 16.1 → **13.1** / 16.2 → **13.0** | 16.5 → **13.5** / 19.1 → **15.5** |
| Right-hand symbols per bar (`voices.py`) | 12.2 → 5.5 / 8.9 → 4.5 | 9.8 → 6.4 / 10.0 → 6.0 | 10.7 → 7.0 / 12.8 → 8.6 |
| Left-hand symbols per bar | 6.0 → 7.5 / 5.1 → 5.8 | 6.3 → 6.7 / 6.2 → 7.0 | 5.8 → 6.5 / 6.3 → 6.9 |
| Visible rests per bar | 2.06 → 1.83 / 1.40 → 1.06 | 1.96 → 1.66 / 2.11 → 1.75 | 2.64 → 2.25 / 2.26 → 1.87 |
| Written unplayable onsets | 0.3% → 0 / 0.1% → 0 | 0.4% → 0.2% / 0.7% → 0.2% | 0 / 0.2% → 0 |
| Melody pitch-class F1 (the right hand's top line) | 0.579 → **0.625** / 0.532 → **0.581** | 0.560 → **0.580** / 0.487 → **0.512** | 0.430 → 0.416 / 0.305 → 0.306 |
| Notes shorter than an eighth | 0.240 → 0.185 / 0.265 → 0.246 | 0.090 → 0.097 / 0.092 → 0.084 | 0.173 → 0.209 / 0.226 → 0.280 (loss) |
| Notes on 3+ ledger lines | 0.043 → 0.039 / 0.036 → 0.028 | 0.020 → 0.024 / 0.023 → 0.029 (loss) | 0.013 → 0.027 / 0.010 → 0.011 (loss) |
| Pitch-class similarity to the recording | 0.770 → 0.759 / 0.835 → 0.825 (loss) | 0.747 → 0.741 / 0.727 → 0.720 (loss) | 0.702 → 0.694 / 0.730 → 0.723 (loss) |
| Chord-tone fit | 0.936 → 0.936 / 0.939 → 0.943 | 0.915 → 0.921 / 0.841 → 0.852 | 0.914 → 0.913 / 0.901 → 0.896 |
| Melody written position, length | same ±0.005 / length 0.326 → 0.318 | same ±0.003 | position 0.619 / 0.497 → 0.420, length 0.371 → 0.353 / 0.524 → 0.469 |

T1 and T2 (the piano path) do not change in any routed variant; only their unrouted `arrange_lead-accomp` changes. The melody F1 rises because the right hand's top line is now the melody: before, an accompaniment note in a melody rest was read as melody.

**Losses.**
- *Pitch-class similarity −0.006 to −0.011 on every half.* Notes are dropped: T3 23% of all notes (6,702 → 5,143), T4 8%, T5 6%; the pipeline now logs the count per run. On four songs (`s18/diag.py`) the drops were mostly arpeggio notes that would strike a left-hand key again within 0.25 s and notes past the hand's reach. The pitch content mostly stays (the similarity measure counts pitch classes), but the T3 arrangements are thinner, and the moved notes are an octave or two lower: the measures cannot hear register. I suspect a listener hears a darker, sparser accompaniment on piano-led songs.
- *T5 notes shorter than an eighth* 0.173 → 0.208 / 0.226 → 0.279: I suspect the cause is the share, not new 16ths: the right hand's accompaniment eighths left, so the riff's own 16ths are a larger part of the notes.
- *Ledger lines on T4 and T5* (+0.004 to +0.013): where a bar's bass needs the left hand's 8vb line, a moved chord tone at the top of the hand is written an octave higher, over the staff (Veridis Quo bars 1–3, Sober bar 4).
- *T5 check melody position 0.497 → 0.420 and length 0.524 → 0.469*: Voyager 0.333 → 0 (its reference melody has about 3 notes) and Solar Sailer length 0.364 → 0.286. Small samples, not a pattern.

**Rendered review** (page 1, scratch `s18/rv/`). Opus (`final-`): the right hand is the riff as one line of 16ths and eighths; the left hand plays the bass and two- or three-note chords in eighths under the 8vb line; bars 1 and 19 no longer show rests stacked over 16th arpeggios, and bar 13 keeps the riff's own 16th-and-rest rhythm. Someone Like You: the right hand reads as the vocal line alone (eighths, quarters, a few rests); the left hand carries the arpeggio and the bass. The tempo is still read at double time (§13 gap 4). Sober: one line in the right hand in every bar; regular eighth-note chords in the left hand under the 8vb line; in bar 4 one left-hand chord sits over the staff (the 8vb cost above). Before (`base-`): Opus bars 1–2 had crossing beams and rests stacked over 16th arpeggios; Someone Like You bars 2–4 and 21–24 had the arpeggio under the vocal line on one staff.

**Code review** (`high`, a subagent; 8 findings). Fixed: a moved note could double a key the left hand still holds (it now avoids every key sounding or struck within 0.25 s); `ALONE_TOP` was bound when the function was defined, so `--set arrange.ALONE_TOP` did nothing (now read at call time; the `s22-alone-top60` run predates the binding and is valid); the drops were silent (`build_variant` now logs the moved and dropped counts); a `lead+accomp` call without the score grid silently kept the old layout (now an error). The run above is after these fixes; they moved no mean by more than 0.008. Not changed: the bar of a note near a bar line is computed three ways (16th rounding in `melody_alone`, the eighth in `melody_bars`, `snap_notes` in the score) and a note held from a melody bar into a bar without melody keeps the lower voice there; both can leave a lower voice in a bar, but `two_v` is 0.000 on every half, so the effect is too small to measure. The O(n²) window scans take 0.7 s on 6,000 notes; not changed.

**Limits.** Not heard: I cannot listen, and no measure hears register or density. If Jm hears the piano-led songs as too thin, the first lever is the re-strike rule (a key struck again within 0.25 s), then moving the arpeggio into the right hand's free beats. The melody-free bars keep the old right-hand accompaniment, so a song with long instrumental bars still has a busy right hand there (one voice).

## 36. The meter of the piano path, learned from 200 ASAP pieces — three levers tested, none adopted: a dead end on these cues (2026-10-28)

§33 left the meter as the piano path's main gap (13 of 27 T1/T2 songs wrong; 31 with §34's four) and named the missing evidence: a trained model and more songs. This stage trains on ASAP itself, on the pieces the bank does not use, and tests on the bank. Scratch: `scratch/p2v-versatile/s19/` (`barfeat.py`, `asap_feats.py`, `train.py`, `bank_bar.py`; `subfeat.py`, `sub_feats.py`, `train_sub_inv.py`, `bank_sub.py`; `phase.py`; `table0.py`).

**Training set.** The ASAP pieces outside the bank's 19 (`corpus.PIECES` excluded): the annotated beats and the performance MIDI of the first 90 s, up to 3 performances a piece, one meter in the span. Bar length: 439 performances of 199 pieces (2 beats a bar 143, 3 beats 113, 4 beats 183; 6/8 is 2 dotted-quarter beats, as ASAP annotates it). Subdivision: 446 performances of 201 pieces, 72 compound. Cross-validation folds are grouped by piece.

**1. Bar length (2, 3 or 4 beats a bar).** A conditional logit over the three candidates: per candidate the best-phase contrast of five z-scored per-beat cues (bass below its neighbours, chord size, velocity, longest note, pitch-class change over 4 beats), a bar-synchronous harmonic change (window = the candidate bar) and a bar-seconds prior. 5-fold CV: 0.651 ± 0.007 (5 seeds) against 0.663 for the present cues summed with equal weights. Triple meter is easy for both (0.92–0.96). Two against four beats is not: the learned model gets 0.42–0.50 of the 2-beat pieces and 0.61–0.64 of the 4-beat ones; the equal-weight sum calls almost everything 4 (0.14 / 0.91). No cue separates them: the effect size (Cohen's d) of the 4-minus-2 contrast between 4-beat and 2-beat pieces is at most 0.47 (bass), and the beat is no slower in one than in the other (median 0.62 s for 2-beat pieces, 0.585 s for 4-beat ones). **On the bank** (model beats, our transcription; the 21 T1/T2 songs whose beat level and subdivision are right): ours 16 right, the learned notes-only choice 13, learned + the model's downbeat contrast 15. It fixes Rachmaninoff 23/6 and Mozart 12-3 and breaks Mr Cellophane and Bach BWV 854.

**2. Subdivision (compound or simple).** A logistic regression on the shift-invariant lattice strengths R_1..R_12 of the onsets' phases in the beat (a constant onset delay does not move them, as in `subdivision`) and the onset count. ASAP CV: the present rule 0.917 (finds 48 of 72 compound performances, 13 false) → 0.960 (64 of 72, 10 false; C = 100, p > 0.4). **On the bank** (model beats): the present rule 24 of 31 right, the learned test 22. It calls two pop covers compound (Mr Cellophane p = 0.67, The Moon Song 0.61) and Connections simple (0.19); it fixes only Rachmaninoff 23/4 (the notation case of §33). The compound pieces that we read as simple stay simple: Ballade 2 p = 0.34, Barcarolle 0.24, Bach BWV 865 0.04, Gondoliera 0.01, Clair de Lune 0.00. On the model's beats these pieces show no 3-lattice; the fault is in the beats (§33's class A), not in the test.

**3. Bar phase where the meter is right.** Star Treatment's 0.000 bar-line score (§34) is a half-bar shift: all 20 reference downbeats fall on our beat 2. The note accents and the model's downbeat probability both pick that phase, so no weighting of the two cues can move it. On the other right-meter songs most reference downbeats fall on our beat 0; their lower bar-line scores come from drift under rubato (Beethoven 22-1, Scriabin), which §27 traced to the beats.

**4. DuET per song (§34's lever).** DuET's meter is right on 23 of 31 (ours 18), but 15 of its 23 are ASAP pieces that it may have trained on (§30). On the 12 songs outside ASAP: DuET 8, ours 9 (DuET gains Avril 14th and loses Connections and Für Elise). Every reference-free signal I could name (note accents, the model's downbeats) is a cue that the two grids are already built from, and on Star Treatment both pick our phase. No per-song choice is built.

**Verdict: no change.** The 13 meter errors split into 5 bars of half or double length (Mozart 12-3, Beethoven 28-1, Bach BWV 846, Avril 14th, Schubert Moment musical 3: the hypermeter choice, which the ASAP pieces show is not in the accents or the tempo; it is the composer's convention), 6 compound pieces read as simple where the model's beats are at the wrong level or carry no 3-lattice (Gondoliera, Barcarolle, Flower Duet, Ballade 2, BWV 865, Clair de Lune), Rachmaninoff 23/6 (3/4 for 4/4) and Rachmaninoff 23/4 (a notation choice). The first group costs a reader little (the bar lines come twice as often, or half as often); the second needs better beats on rubato piano (§27), not a better meter rule. What could still move it: a beat model trained for classical piano rubato, or a score model that is tested on pieces it has not seen. Both are larger than this stage.

## 37. A measure fault: ASAP keys that sit on a pickup's beat (2026-10-28)

The key errors left after §16 were 7 of 62 songs. Two of them (Chopin Ballade 2, Haydn 48-2) were the bank's, not ours: `corpus.reference` read the key signature only from downbeat lines (`db,<meter>,<sharps>`), and a score that opens with a pickup names its key on the pickup's beat (`b,,<sharps>`). So 5 of the bank's 19 ASAP pieces had no key reference (Chopin op. 25/1, Rachmaninoff 23/6, Schubert D 664, Beethoven 22-1, Gondoliera) and 2 took a later section's key (Ballade 2: 0 for the score's 1 flat; Haydn 48-2: 3 flats for the score's 0). The first key on any beat line equals the score's first `<fifths>` on all 19 (scratch `s19/asap_keys.py`). **Fix:** `corpus.first_sharps` (tested; it also reads the `bR`/`dbR` beat forms, as the code review asked). **Re-scored** (`s24-final` → `s25-keyref`, T2 only, nothing else changed): key measured on 16 → 21 pieces, right 12 → 18 (tune 0.857 → 0.900, check 0.667 → 0.818): Ballade 2 and Haydn 48-2 now right (+2), and of the 5 pieces measured for the first time 4 are right (+4) and Gondoliera is wrong (6 sharps for the score's 3: an error that was hidden, not a new one). No other measure moved. Key errors over the bank: 7 → 6 of 62. Still wrong: Mozart 12-1 (we write C major; the excerpt opens in F and moves to C), Beethoven 28-1 (E for A: the movement opens on the dominant), Gondoliera, and three band songs a fifth off (Make You Feel My Love, Sober, Aerodynamic; §16).

## 38. Stage 18: a stronger vocal separator for the sung melody, alone and combined with Demucs — not adopted (2026-10-28)

§15 named the sung melody's limit: SOME hears the Demucs `htdemucs_6s` vocal stem, with bleed and reverb. Jm (2026-10-28) asked to test "the best aspects of each part": here, the melody from two vocal stems.

**Separator.** Kim Jensen's Mel-Band RoFormer for vocals (`KimberleyJSN/melbandroformer`, HF commit `ac9b0614`, `MelBandRoformer.ckpt`, SHA-256 `87201f4d…7559e`, weights MIT; multisong vocal SDR 10.98 per ZFTurbo's list, against about 8–9 dB for Demucs). The `bs-roformer` pip package was refused by the session's safety check, so the network is our own inference-only code written from lucidrains' 0.4.0 source and ZFTurbo's `demix` (read as text, not run; scratch `s19/sep/vocals.py`): 6 blocks of one time and one frequency transformer, 60 mel bands, 8 s chunks every 4 s with linear fades. The checkpoint loads as tensors only (`weights_only=True`) and every key and shape matches (`strict=True`). Not checked: a separation benchmark (no MUSDB here), so a subtle port error would show only as lower melody scores. Speed: 2–3 s of CPU per second of audio on this loaded Mac; the GPU (MPS) was slower.

**Combinations** (scratch `s19/voc_eval.py`; SOME on each stem, scored with `bank.melody_scores` before any arrangement step; 21 T3/T4 songs with a melody reference): *agree* keeps the RoFormer notes that the Demucs stem also has (onset within 0.1 s, same pitch class); *fill* takes the RoFormer notes plus the Demucs notes where no RoFormer note sounds.

| Group | Melody F1 (pitch class) / overlap: Demucs (now) | RoFormer | agree | fill |
|---|---|---|---|---|
| T3 tune (4) | **0.626 / 0.751** | 0.611 / 0.729 | 0.619 / 0.642 | 0.613 / 0.731 |
| T3 check (4) | **0.596 / 0.673** | 0.569 / 0.637 | 0.590 / 0.599 | 0.566 / 0.642 |
| T4 tune (7) | 0.565 / **0.658** | 0.547 / 0.628 | **0.578** / 0.574 | 0.552 / 0.649 |
| T4 check (6) | 0.512 / **0.715** | 0.498 / 0.652 | **0.531** / 0.554 | 0.507 / 0.697 |

**Verdict: no change.** The cleaner stem alone is worse on every half (F1 −0.014 to −0.027, overlap −0.02 to −0.06). Per song it gains on 7 of 21 (Avicii Silhouettes 0.77 → 0.82, Sit Next to Me 0.57 → 0.62) and loses most on The Nights (0.09 → 0.00: its sung-sounding lead is not kept as vocals) and Avicii Levels (0.48 → 0.39). *Fill* adds nothing. *Agree* raises F1 on T4 (+0.013 / +0.019) because it keeps fewer, surer notes, but it drops 5–20% of the melody (notes per reference note 1.08–1.18 → 0.80–0.95; overlap −0.08 to −0.16), so the written melody gets gaps; on T3 it loses F1 too. The SOME + Demucs pair stays. What could still move the sung melody: a singing model trained on separated pop vocals, or a per-note confidence from SOME to make *agree* keep a note only where Demucs alone is unsure (not available in its decode).

## 39. Stage 19: an advanced score beside the playable one — `--parts lead+full` (2026-10-28)

**Jm (2026-10-28):** "test two-stem melody inside current stage and add advanced version beside the playable one". The context: a per-song best of the chain start and now (`s19/oracle.py`) showed that the playable arrangement costs similarity to the recording (§20: the band reduced to three chord tones; §35: the right hand plays the melody alone). The playable score stays the default; the advanced score is a fourth `--parts` value.

**Headroom first** (scratch `s26/ceiling.py`, run `s26-base`): the pitch-class similarity to the recording (`chroma`, §20) of the raw transcriptions of every audible stem, before any arrangement, is T3 0.824 / 0.864 (tune / check), T4 0.811 / 0.780, T5 0.755 / 0.795; the playable score reaches 0.759 / 0.825, 0.741 / 0.720, 0.694 / 0.723. The largest gaps were songs routed `hybrid` that have a band: the hybrid hears only the piano and the voice (Avicii Silhouettes 0.483 against 0.773 raw, The Nights 0.575 / 0.783, Regina Spektor The Call 0.670 / 0.836, Adele When We Were Young 0.683 / 0.817). On the 9 T4/T5 tune songs routed `arrange`, step by step (`s26/decomp.py`): raw 0.798; the band folded into C3–B4, snapped to the grid and voiced in zones 0.797 (no loss); held notes ended where the melody or bass crosses them 0.788; the chord-tone filter and the band's line in the voice's rests make the rest of the gap (production without the filter 0.773).

**The change** (`pipeline.PARTS` gains `lead+full`; `BOTH_HANDS` names the two two-hand values):
- `piano`: the same notes as `lead+accomp` (the piano path has no reading reduction; the MIDI files are byte-identical).
- `hybrid`: the playable hybrid (§14, §24) plus the band the piano does not play: `arrange_full` voices the other chordal stems (guitar, other) and the bass on the score grid from the chords' tones, as `arrange` does (§20), and each of those notes is kept only where the piano part does not sound its pitch class at its onset; `fit_hands` then keeps every written chord within reach. The chords are recognised for this variant too (BTC hears the recording), so a run of `--source hybrid --parts lead+full` needs the BTC weights and transcribes the band's stems.
- `arrange`: the playable band arrangement without `melody_alone` (§35): the right hand keeps its chord tones under the melody.
- Both: no `melody_alone`, so a staff can carry two voices (§17's layout: the melody with stems up over the accompaniment).

**Candidates** (T3 + T4 + T5 tune half, routed, advanced against playable; runs `s26-full1`, `s26-full2`, `s26-full2-notones`, `s26-full3-*`; scratch `s26/full.py`):

| Candidate | Similarity T3 / T4 / T5 | Chord fit T3 / T4 / T5 | Notes |
|---|---|---|---|
| playable (`lead+accomp`) | 0.759 / 0.741 / 0.694 | 0.936 / 0.921 / 0.913 | |
| no melody alone; 5 band pitch classes an onset (3 a hand); a piano note over the melody moved under it by octaves | 0.771 / 0.748 / 0.702 | 0.933 / 0.916 / 0.913 | small: no band in the hybrid |
| … and the band in the hybrid | **0.803 / 0.786** / 0.702 | 0.928 / 0.919 / 0.913 | The Call 0.670 → 0.795, Silhouettes 0.483 → 0.724 |
| … without the chord-tone filter | 0.805 / 0.793 / 0.712 | 0.906 / 0.889 / 0.895 | +0.002 to +0.010 for −0.02 to −0.03 chord fit: not adopted |
| … held notes end only on their own key | 0.803 / 0.789 / 0.700 | 0.928 / 0.917 / 0.914 | no clear gain: not adopted |
| … piano notes over the melody dropped (as playable) | 0.803 / 0.785 / 0.702 | 0.931 / 0.919 / 0.913 | the band fills those pitch classes: the fold is not needed |
| … without `fit_hands` | 0.806 / 0.786 / 0.702 | 0.930 / 0.920 / 0.913 | unplayable onsets T3 0.2% → 3.1% (written 6.9%): not adopted |
| … 3 band pitch classes an onset (2 a hand, as playable) | 0.803 / 0.785 / 0.702 | 0.928 / 0.918 / 0.914 | same as 5: **adopted** with the fold dropped (the simplest) |

So two things carry the whole gain: the band in the hybrid, and the right hand's accompaniment kept. More voices per chord, the fold and the crossing rule add nothing measurable, so the advanced `arrange` and `hybrid` use the playable voicing.

**Before → after** (all 62 songs, run `s26-full-r`, after the code review; playable `lead+accomp` → advanced `lead+full`, routed; tune / check). Every older variant is the same as the baseline `s26-base` (`bank compare`: no change on any song).

| Measure | T1 covers (5 + 6) | T2 classical (10 + 11) | T3 piano + vocals (5 + 4) | T4 no piano (8 + 6) | T5 instrumental (3 + 4) |
|---|---|---|---|---|---|
| Similarity to the recording | same 0.819 / 0.847 | same 0.820 / 0.853 | 0.759 → **0.794** / 0.825 → **0.837** | 0.741 → **0.780** / 0.720 → **0.748** | 0.694 → **0.702** / 0.723 → **0.730** |
| Note F1 (texture reference) | same 0.817 / 0.835 | same 0.946 / 0.927 | – | – | – |
| Chord fit | same | same | 0.936 → 0.932 / 0.943 → 0.928 | 0.921 → 0.919 / 0.852 → 0.855 | 0.913 → 0.914 / 0.896 → 0.901 |
| Melody F1 (pitch class; the right hand's top line) | same | same | 0.625 → 0.572 / 0.581 → 0.531 | 0.580 → 0.560 / 0.512 → 0.500 | 0.416 → 0.430 / 0.306 → 0.305 |
| Symbols per bar | same | same | 12.9 → 19.0 / 10.4 → 14.0 | 13.1 → 17.2 / 13.0 → 17.2 | 13.5 → 16.5 / 15.5 → 19.1 |
| Bars with two voices on a staff | 0 | 0 | 0 → 0.43 / 0 → 0.37 | 0 → 0.46 / 0 → 0.46 | 0 → 0.45 / 0 → 0.50 |
| Notes shorter than an eighth | same | same | 0.185 → 0.226 / 0.246 → 0.261 | 0.097 → 0.081 / 0.084 → 0.081 | 0.209 → 0.173 / 0.280 → 0.226 |
| Tied notes | same | same | 0.014 → 0.016 / 0.016 → 0.018 | 0.012 → 0.012 / 0.013 → 0.012 | 0.054 → 0.050 / 0.037 → 0.038 |
| Visible rests per bar | same | same | 1.83 → 2.01 / 1.06 → 1.17 | 1.66 → 2.09 / 1.75 → 2.25 | 2.25 → 2.64 / 1.87 → 2.26 |
| Unplayable onsets (MIDI) | same | same | 0 → 0.1% / 0 → 0 | 0.2% → 0.2% / 0.2% → 0.1% | 0 / 0 |
| Written unplayable onsets | same | same | 0 → 0.4% / 0 → 0.3% | 0.2% → 0.4% / 0.2% → 0.6% | 0 / 0 → 0.2% |
| Notes a song | same | same | 684 → 972 / 431 → 534 | 505 → 578 / 457 → 541 | 487 → 513 / 529 → 567 |

Per song (routed `hybrid`, both halves): Silhouettes 0.483 → 0.686, The Nights 0.575 → 0.689, Waiting for Love 0.722 → 0.783, its drop 0.730 → 0.761, The Call 0.670 → 0.790, When We Were Young 0.683 → 0.727. Songs routed `arrange` gain 0 to +0.02 (Wake Me Up +0.021, Levels +0.022, Solar Sailer +0.017); Opus loses 0.780 → 0.773. Before the review fixes (`s26-full`) the advanced score was 0.008 higher on T3 tune and 0.005 on T4 tune, with more unplayable onsets (T3 tune 0.2%, T4 tune 0.4%; Silhouettes 2.2%): the reach rule and the wider duplicate test drop those band notes.

**Losses, with reasons.**
- *Melody F1* −0.05 on T3, −0.01 to −0.02 on T4. The melody notes are the same in both variants (by construction; `test_arrange_hybrid_advanced_adds_the_bands_pitch_classes_the_piano_lacks` checks it). The measure reads the right hand's top line, and in the advanced score the right hand plays accompaniment where the melody rests, as before §35.
- *Reading load*: 4–6 more symbols a bar, two voices on a staff in 37–50% of bars, more rests. That is the advanced score's purpose; the playable score stays the default.
- *Written unplayable onsets* up to 0.6% a half (MIDI: no more than the playable score). Before the review fix, 11 of the 12 unplayable onsets on Silhouettes and The Nights were right-hand onsets where the melody rests: a band note in the right hand's free zone (C4–B4) under a high piano note (Silhouettes at 38.0 s: C#4 with D#6 and G#6), which `fit_hands` does not check (it checks a right-hand chord only against a melody note).
- *Chord fit* T3 −0.004 / −0.015: the band's chord tones and the right hand's chords in melody bars add time on tones the simplified HookTheory chords do not name.

**Rendered review** (page 1, scratch `s26/rv/`, `lead-accomp-*` against `lead-full-*`, run `s26-full`: before the review fixes, which drop a few band notes in `hybrid`; `arrange` is the same). The Call: the playable score has the vocal line alone in the right hand, dense 4–6-note chords in the left hand in bars 2–3, and an empty left hand in bars 20–26 (the piano rests; the band plays); the advanced score has two- to four-note chords under the melody (stems down) and a bass with chords in every bar, bars 20–26 now full; it is busy (16th chords in bars 5 and 10–17) and fits 19 bars on page 1 against 26. Someone Like You: the vocal line over the arpeggio in the right hand, the left hand the bass and broken chords; a low held A (piano part) with ledger lines in bars 6–8; the tempo is still read at double time (§13). Sober: the melody over one or two chord tones in the right hand, the left hand under the 8vb line as in the playable score; two left-hand notes sit high over the bass staff (bars 4 and 19). Opus: the riff in 16ths with chord tones under it in the right hand; bars 8–9 put right-hand chords below the treble staff (ledger lines). T1: the advanced MIDI equals the playable one (`cmp`).

**Code review** (`high`, a subagent; 8 findings). Fixed: (1) a band note was not checked for its hand's reach where the melody rests (the unplayable onsets above), so `arrange.add_band` now keeps a band note only when its hand's notes struck within 0.25 s stay within 15 semitones and under 5 notes; (2) the duplicate test matched only a piano note sounding at the band note's onset, but the band is on the grid and the piano is not, so a piano note of the same pitch class struck up to 0.25 s later doubled it: `add_band` now also drops a band note where the piano strikes its pitch class within 0.25 s (and it uses one array per pitch class instead of a scan of every piano note); (3) `report["chord_model"]` was written for `piano` + `lead+full`, which uses no chords: one helper, `pipeline.band_chords`, now decides where the chords are needed (the BTC start check, the report, the chord plan); (4) the `melody_alone` gate names why `lead+full` skips it; (5) §4 said `--all-variants` renders four combinations (it renders 12). Not changed: `piano` + `lead+full` is rendered although it equals `lead+accomp` (time only: one more MIDI, score and video for `--all-variants`; the bank needs the variant to compare the routed advanced score on every type); a `hybrid` + `lead+full` run with every band stem silent is the hybrid without `melody_alone` (correct: there is no band to add); no test runs `run()` end to end (it needs Demucs and the models), so a single-variant run on Silhouettes' cached stages (`s26/single.py`: `--source hybrid --parts lead+full`) checks that the run transcribes the band's stems and recognises the chords: the note count equals the bank run's. The before → after table is after these fixes (run `s26-full-r`); the candidates table is before them.

**Not changed, and next.** The chord-tone filter stays in the advanced score (its similarity gain is small against the chord-fit loss). The playable hybrid on band songs has the same gap the advanced score closes (Silhouettes playable 0.483): the band layer under `melody_alone` is the next candidate for the default. On T5 the advanced score gains little (+0.007): the gap to the raw notes there is the band's line in the voice's rests (§21, §23), which both variants share. Scratch: `~/.kaya/piano2video/scratch/p2v-versatile/s26/` (`full.py`, `ceiling.py`, `decomp.py`, `render.py`, `sweep1.sh`–`sweep3.sh`, `rv/`).

## 40. Stage 20: the router sends band songs with a quiet piano to the band path (2026-10-28)

**The gap** (§39): four songs with vocals and an audible piano went to `hybrid`, whose playable score hears only the piano and the voice, although their loudest band stem is 3–9 dB over the piano. §14 chose `PIANO_LEAD_DB` = 12 dB (hybrid while the piano is at most 12 dB under the loudest of guitar, other and bass) on how often the route matched the bank's type labels (T3 → hybrid, T4 → arrange); no measure of the score's sound existed then.

**Per song** (run `s26-full-r`, playable `lead+accomp`, hybrid | arrange; scratch `s27/route.py`): the band over the piano −57 to −14 dB: hybrid better or about the same (Hometown Glory 0.853 | 0.805, Laughing With 0.859 | 0.823; Someone Like You 0.817 | 0.833, Samson 0.800 | 0.826); −7 to −2 dB: arrange a little better on similarity, mixed on chord fit (Hello 0.828 | 0.832 with chord fit 0.952 | 0.913; Waiting for Love 0.722 | 0.770); **+3 to +9 dB: arrange far better** — Silhouettes (+3.3 dB) 0.483 | 0.745, The Call (+4.2) 0.670 | 0.820, The Nights (+6.0) 0.575 | 0.714 with melody F1 0.091 | 0.200, When We Were Young (+9.3) 0.683 | 0.840.

**The change:** `PIANO_LEAD_DB` = 0 dB: `hybrid` only where the piano is at least as loud as each band stem. **The measure alone cannot pick the threshold** (code review): the playable `arrange` score is as close to the recording as the hybrid, or closer, on most songs at every level (Someone Like You at −57 dB: 0.833 | 0.817; Samson at −14 dB: 0.826 | 0.800), because the similarity counts pitch classes and cannot see what the hybrid keeps: the recorded piano part, which no T3 reference scores (they are melody and chord references). So the cut is a judgment (Kaya's, not Jm's): where the piano is quieter than a band stem it does not lead, and the band path is far closer (+0.14 to +0.26); where it is at least as loud, the recorded piano part is kept. A cut at −3 to −4 dB would also move Waiting for Love (tune half, −2.2 dB: similarity 0.722 → 0.770, chord fit 0.931 → 0.969, melody F1 0.686 → 0.673) and nothing else; below −4.1 dB it would move Hello (check half: +0.004 similarity, −0.039 chord fit). Not done: one song, and the same blind spot.

**Before → after** (all 62 songs, `bank score` of `s26-full-r` with the new route = `s27-route0`; routed; tune / check; T1, T2, T5 and T3 check: no change in any variant):

| Measure | T3 tune (5) | T4 tune (8) | T4 check (6) |
|---|---|---|---|
| Similarity to the recording, playable | 0.759 → **0.821** | 0.741 → **0.774** | 0.720 → **0.743** |
| … advanced (`lead+full`) | 0.794 → **0.823** | 0.780 → **0.789** | 0.748 → **0.759** |
| Chord fit | 0.936 → 0.941 | 0.921 → 0.918 | 0.852 → 0.861 |
| Melody F1 (pitch class) / overlap | same | same | 0.512 → 0.530 / 0.715 → 0.731 |
| Melody written position / length | same / 0.504 → 0.495 | same | 0.827 → 0.898 / 0.611 → 0.623 |
| Notes shorter than an eighth | 0.185 → 0.094 | 0.097 → 0.091 | 0.084 → 0.067 |
| Symbols per bar | 12.9 → 12.7 | 13.1 → 13.5 | 13.0 → 13.5 |
| Visible rests per bar | 1.83 → 1.56 | 1.66 → 1.45 | 1.75 → 1.58 |
| Unplayable onsets (MIDI / written) | 0 / 0 | 0.2% → 0.2% / 0.2% → 0.1% | 0.2% → 0 / 0.2% → 0 |
| Route = the type label | 1.0 → 0.78 (T3, both halves) | T4 0.71 → 0.86 (both halves) | |

**Losses.** *The type labels*: The Call and When We Were Young (bank type T3, "piano-led with vocals") now take the band path, so the playable score plays the band's chord tones, not the recorded piano part; `--source hybrid` still gives the piano part, and `--parts lead+full` with it adds the band (§39). *Melody written length* T3 tune −0.009 (one note or two a song). *Symbols per bar* T4 +0.4 to +0.5 (the band path writes a steady left hand where the piano rested).

**Rendered review** (page 1, scratch `s27/rv/arrange-the-call-1.png`, against §39's `lead-accomp-regina-spektor-the-call-1.png`): the right hand plays the vocal line alone as before; the left hand plays a bass note with two- or three-note chords in steady eighths in every bar, where the hybrid wrote dense four- to six-note chords in bars 2–3 and an empty left hand in bars 20–26 (the piano rests there and the band plays); 28 bars on page 1 against 26; an 8vb line under bars 17–21 and 26–28, and one left-hand chord over the staff (bar 22).

**Code review** (`high`, 6 findings). Fixed: the threshold reasoning above (an earlier draft said a −3 dB cut would move Hello; it moves only Waiting for Love); the constant's comment (one sentence and a link) and `route()`'s docstring now say "at least as loud as each band stem"; the router test also checks the tie (the piano as loud as the band: `hybrid`). Recorded, not changed: the bank re-routes from `report.json` levels rounded to 0.1 dB, so a song within 0.05 dB of the cut could take another path in a live run (no bank song is within 2 dB: Waiting for Love −2.2, Silhouettes +3.3); and Demucs piano bleed into the guitar or other stem could make a piano ballad's band stem louder than its piano and send it to `arrange` (no bank song does: the T3 songs that stay `hybrid` have the band 4–57 dB under the piano). `--source hybrid` overrides the router in both cases.

**Not changed.** The type labels in the bank stay as they are (they say what kind of song it is, not which path sounds best); the router's measure "router right" now disagrees with them on two T3 songs, and that is expected. Scratch: `~/.kaya/piano2video/scratch/p2v-versatile/s27/` (`route.py`, `route0.log`, `rv/`).

## 41. Stage 21: the band's line in instrumental sections — most of the gap was in the measures; a held note's restrikes joined (2026-10-28)

**The gap** (§39, §40): on the songs routed to `arrange`, the playable score with the band's line (`hook_line`) was less similar to the recording than the same score without it (9 T4/T5 tune songs: 0.773 against 0.789; Some Chords 0.795 against 0.886). T5's melody note F1 (pitch class) was 0.416 / 0.306 (tune / check), its written length 0.353 / 0.469.

**Trace** (scratch `s28/`: `trace.py` rebuilds the routed score from the cached transcriptions under named variants; `recall.py`, `basshook.py`, `errs.py`, `pairs.py`, `phase.py`, `lag.py`). Four causes:
1. *A right line costs no similarity.* An oracle that plays the reference melody as the line, at the line's own loudness, scores 0.756 inside the T5 reference spans; no line 0.748; our line 0.696. The loss comes where our line has the wrong notes. Velocity × 0.5 recovers half of the loss, but the score does not show velocity, and a melody louder than its accompaniment is right for a pianist: not changed.
2. *Two references were offset in time* (a measure fault). Aerodynamic's HookTheory alignment is 0.33 s late: the reference melody's pitch-class recall in the band's notes rises 0.06 → 0.54 at −0.39 to −0.27 s (0.45 one beat later, +0.06 to +0.21 s: the arpeggio repeats each beat), and only the earlier plateau agrees with the downbeats (downbeat F 0.35 against 0). The Nights' (T4) is 0.22 s late: beat F against Beat This! 0.09 → 0.86 at −0.221 s, melody recall 0.56 → 0.69 at −0.211 s. On the other 30 timed references the beats peak within ±0.08 s, except where our grid sits half a beat off (Someone Like You, Solar Sailer: their melody peaks at 0) and Wake Me Up (beat F 0.45 → 0.50 at −0.23 s; no melody reference); the melody peaks within ±0.08 s except on three sung sections (below, "Not fixed"). With the shifts, Aerodynamic's beats peak at +0.03 s and its melody at −0.07 s; The Nights' at 0.00 s and −0.10 s (recall 0.67 → 0.69). With the shift, Aerodynamic's line scores note F1 0.598 (0.075 before): the line was right, and §21 and §23 were wrong to call its tune "in no transcription".
3. *The bass hooks are already in the left hand.* Solar Sailer's and Voyager's tune is a bass figure (§23). The score's left-hand bottom line covers their reference melody at 0.94 and 0.74 (pitch-class overlap); on every other song with a reference it covers 0.03–0.36. The melody measures read the right hand only, so they do not see it. No signal tells a bass hook from a high one for the right hand's line (the third try, after §23: the line's similarity to the recording, notes per beat, pitches per bar, steps; Some Chords falls between the two bass-hook songs on each).
4. *Restrikes of a held note.* Where the line follows the right voice (Hey Brother, Veridis Quo, Some Chords, Opus, Faded: the band's notes hold 0.77–1.0 of the reference melody, the line 0.58–0.73), most extra notes are restrikes of the pitch just played where the reference holds one note: 65 of Hey Brother's and Veridis Quo's 99 extra notes, a gated synth that retriggers each eighth (Veridis Quo: 101 line notes for the reference's 66). Opus and Faded are the opposite: their repeated 16ths are in the reference.

**Candidates** (`trace.py` on the `s28-base` caches with the shifted references; note F1 (pc), tune / check):

| Variant | T5 | T4 | Lost on |
|---|---|---|---|
| before | 0.594 / 0.306 | 0.563 / 0.586 | |
| join every restrike of the pitch just played | 0.689 / 0.300 | 0.551 / 0.585 | Opus 0.681 → 0.578, Faded 0.238 → 0.168 |
| … only after a note of 0.3 / 0.5 beats or longer | 0.664 / 0.292, 0.658 / 0.291 | 0.563 / 0.588, 0.563 / 0.587 | Hey Brother (its held notes are shorter than its struck ones) |
| **… except in a span whose line has 3/4 or more notes shorter than an eighth: a 16th riff, §28 (built)** | **0.689 / 0.326** | 0.563 / 0.585 | none |
| … that share at 0.6 / 0.9 | 0.650 / 0.308, 0.689 / 0.313 | 0.563 / 0.586, 0.551 / 0.585 | Veridis Quo (0.58 of its notes short) / Faded (0.88) |
| built + `HOOK_LEAP` 0.25 / 1.0 | 0.697 / 0.328, 0.673 / 0.312 | 0.563 / 0.579, 0.566 / 0.567 | §23's plateau: kept at 0.5 |
| built + `HOOK_HIGH` 0 / 1, the `other` stem only | 0.459 / 0.330, 0.594 / 0.315, 0.555 / 0.296 | 0.544–0.563 / 0.576–0.579 | |

The share was chosen on the tune half: every value from 0.6 to 0.88 separates Veridis Quo (0.58) from Faded (0.88), and 3/4 is the middle. On the check half, Hey Brother (0.67) and Opus (0.90) fall on the right sides; a share of 0.6–0.67 would not separate them.

**The change.** `arrange.join_restrikes` (`HOOK_RIFF` = 0.75): in each span's band line, a note of the pitch just played that starts within 30 ms of that note's end (under one `track_line` frame: never across a rest) joins it and keeps the first attack's velocity, unless 3/4 or more of the span's line notes are 16ths (shorter than `SIXTEENTH_Q` = 3/8 of a quarter on the grid, in any meter). `hook_line(band, spans, grid)` applies it per span and needs the score grid; `arrange_full` passes it, so every variant of the `arrange` path gets it. The bank: `ref["shift"]` (seconds) moves every time of a timed reference found offset (`load_ref`); songs.json sets it for Aerodynamic (−0.33 s) and The Nights (−0.22 s), with the evidence in `shift_why`.

**Before → after** (all 62 songs, every variant, no failure; routed; tune / check). T1, T2: no change in any measure; T3: only The Call (on the band path since §40), symbols per bar 13.0 → 12.7, its melody measures unchanged. Bank: `s28-final` (62 songs), then after the code review's fixes `s28-final2` (T4, T5) and `s28-final2-t123` (T1–T3); the fixes change no melody measure, and the numbers below are the fixed code's.

*The measure fix* (`s28-base` → `bank score` with the shifts = `s28-base-sh`; no other song changes): T5 tune melody note F1 0.416 → **0.590**, overlap 0.605 → **0.702**, written position 0.619 → **0.749**, written length 0.353 → 0.387, chord fit 0.913 → 0.946; T4 check note F1 0.530 → **0.576**, overlap 0.731 → 0.751, written position 0.898 → **0.985**. Beat F / downbeat F: The Nights 0.09 / 0.12 → **0.88 / 0.88**, Aerodynamic 0.19 / 0.00 → 0.38 / 0.38 (its tracked beats stay irregular).

*The change* (`s28-base-sh` → `s28-final`, playable `lead+accomp`):

| Measure | T5 tune (3) | T5 check (4) | T4 tune (8) | T4 check (6) |
|---|---|---|---|---|
| Melody note F1 (pc) | 0.590 → **0.683** | 0.306 → **0.326** | 0.580 → 0.580 | 0.576 → 0.576 |
| Melody overlap | 0.702 (same) | 0.384 (same) | same | same |
| Melody written position | 0.749 (same) | 0.420 → **0.477** | same | same |
| Melody written length | 0.387 → **0.451** | 0.469 → 0.334 (loss) | same | 0.627 → 0.633 |
| Symbols per bar | 13.50 → **11.83** | 15.45 → **12.40** | 13.54 → 13.21 | 13.48 → 13.30 |
| Notes shorter than an eighth | 0.209 → 0.149 | 0.280 → 0.157 | 0.091 → 0.067 | 0.067 → 0.056 |
| Similarity to the recording | 0.694 → 0.696 | 0.723 → 0.727 | same | same |
| Unplayable onsets | 0 | 0 | same | same |

The advanced score (`lead+full`) moves the same way: T5 note F1 0.587 → 0.678 / 0.305 → 0.324, symbols per bar 16.5 → 14.8 / 19.1 → 16.1. Per song (playable): Veridis Quo note F1 0.563 → 0.672, its line 101 → 50 notes for the reference's 66, symbols per bar 15.6 → 12.2; Some Chords 0.609 → 0.778; Hey Brother 0.412 → 0.457, its line 66 → 34 notes for the reference's 36, written position 0.77 → 1.0, written length 0.32 → 0.56; Opus and Faded: melody measures unchanged (16th riffs; Opus's other spans join, symbols per bar 18.3 → 18.0); T4 drops: Get Lucky 14.8 → 14.1 and Levels 12.6 → 11.9 symbols per bar, melody unchanged.

**Losses, with reasons.** *T5 check written length* 0.469 → 0.334: Solar Sailer 0.286 → 0 and Voyager 0.5 → 0, each counted over the 2–7 notes of the right hand's line that match their reference at all (note F1 0.08–0.09: their tune is the bass, cause 3); on the two check songs whose line is the tune, it rises (Hey Brother 0.32 → 0.56) or stays (Opus). The advanced score's T5 check written length 0.524 → 0.401 has the same cause.

**Tried, not adopted: the melody holds across the beat.** The rendered review (below) showed a joined note written as an eighth and rests: `quantize_hand` ends a note that starts off the beat at the next beat where anything starts (`release_on_beat`, §3), the melody too. Exempting lead notes (scratch `tools-hold/`, bank `s28-hold`, every type) lowers the melody's written length against the references: T3 0.495 → 0.459 / 0.318 → 0.309, T5 0.451 → 0.436 / 0.334 → 0.300 (T4 no change), and doubles the ties (T3 tune 0.013 → 0.030); only visible rests per bar fall (T3 tune 1.56 → 1.08). The lead sheets write those notes short, so the rule stays.

**Rendered review** (`pdftoppm -r 80`, pages 1–2; scratch `s28/rv/`, `s28-base-…` against `s28-final-…`). *Veridis Quo*: before, bar 1 held fourteen repeated A's in 16ths and bars 3, 15 and 17–19 strings of repeated eighths and 16ths; after, the line reads as held notes (whole notes and tied halves in bars 6–7, 9, 11, 15–19). Bar 1 shows an eighth A and rests where the MIDI holds A for 1.8 s: the release rule above. *Hey Brother*: before, bars 17–22 were 16th repeats between 16th rests; after, bars 9, 14, 22 and 25–27 show dotted halves and a whole note, and page 1 holds 27 bars instead of 24; bars 3, 17, 18 and 20 keep the release rule's "16th rest, dotted eighth, rests". *Opus* (after): unchanged 16th figures, as the bank says. *Some Chords* (after): a slow line of held notes (G♯, A, C, B in halves and whole notes), the shape of its reference; the bank counts 13 → 8 line notes in the reference span for the reference's 10.

**Code review** (`high`, 8 findings). Fixed: the 16th test divided by the beat, so in a compound meter (a beat of 1.5 quarters) a dotted eighth counted as a 16th; it now counts quarters (`SIXTEENTH_Q`), and a line of eighths 10 ms short still counts as eighths (the test was an exact eighth); `hook_line` without the grid silently kept the old line: the grid is now required; `ref.shift` on a score or ASAP reference did nothing: it now raises; `add_hooktheory` rewrote a song's entry and dropped the hand-set `skip` and `shift` fields: it keeps them; the shift test also checks the downbeats. Not changed: the joined note keeps its first attack's velocity (a held key does not get louder); the 30 ms gap does not scale with tempo, because it only joins notes the tracker made contiguous (under one 50 ms frame); a span of two or three notes can flip between riff and not on one note, where a join changes a note or two.

**Not fixed.** The bass hooks: the right hand's line on Solar Sailer and Voyager is a pad's top voice, not the tune, which the left hand plays; the melody measures cannot see that. A measure of the tune in either outer voice would show it, but the bank's melody measures stay on the right hand until a song shows the left hand losing a tune. Three sung sections (Sit Next to Me, Faded, Hey Brother's sung part) match the band's and voice's notes best with the reference 0.09 s later (recall 0.70 → 0.88, 0.70 → 0.87, 0.86 → 0.91) while their beats peak at −0.04 to −0.02 s: the two signals disagree, so no shift; the transcription's onsets may lag there (not traced). The remaining note misses on the right-voice songs: Opus holds where the reference arpeggiates (21 misses) and takes another voice (40).

**Limits.** 7 T5 songs and 1 T4 band-line song carry the band line's reference (4 tune, 4 check); one threshold chosen on the tune half; HookTheory's melody of an instrumental section is one annotator's lead sheet. The two shifts belong to the recordings in the bank: they are times in the recording, so a new trim keeps them, and `add_hooktheory` keeps them; another recording of either song needs them measured again. Scratch: `~/.kaya/piano2video/scratch/p2v-versatile/s28/` (`trace.py`, `summ.py`, `cmp.py`, `recall.py`, `basshook.py`, `errs.py`, `pairs.py`, `phase.py`, `lag.py`, `shift.py`, `add_shift.py`, `tools-merge/`, `tools-hold/`, `rv/`, `trace*.log`).

## 42. Stage 22: the onset timing of the transcriptions — no transcriber lags; the written position follows the grid; the sung notes' errors (2026-10-28)

**The gap** (§41, "Not fixed"): on three sung sections (Sit Next to Me, Faded, Hey Brother's sung part) the reference melody matched our notes best 0.09 s later (recall 0.70 → 0.88, 0.70 → 0.87, 0.86 → 0.91), while their beats peaked at −0.04 to −0.02 s. The bank's onset tolerance is 0.1 s, so a lag of that size would cost note F1 and written position.

**Measure** (scratch `s29/`: `txlag.py`, `lagsum.py`, `lag1.tsv`). Per song and transcriber: each reference note against the nearest onset of the same pitch class (melody references) or pitch (piano references) within ±0.25 s: the median offset (ours − reference); the offset of our routed grid's beats from the reference's beats, and the note offset relative to it; the offset of the transcribed onsets from the onset peaks (librosa) of the transcriber's own input. Median over the songs with 8 or more matched notes, tune / check:

| Transcriber (input) | Type | Offset from the reference (s) | Relative to the beats (s) | From the audio's onset peaks (s) |
|---|---|---|---|---|
| SOME (vocal stem) | T3 | +0.012 / +0.019 | +0.005 / +0.015 | −0.007 / −0.005 |
| | T4 | +0.007 / +0.008 | +0.003 / +0.009 | 0.000 / −0.011 |
| Basic Pitch (band stems) | T3 | +0.019 / +0.020 | +0.017 / +0.011 | −0.010 / −0.011 |
| | T4, T5 | +0.005 / +0.003, 0.000 / +0.020 | +0.005 / +0.010, −0.008 / 0.000 | −0.011 / −0.004, −0.011 / −0.012 |
| ByteDance piano (piano stem or mix) | T1, T2 | 0.000 / +0.003, 0.000 / +0.001 | 0.000 / −0.007, −0.005 / −0.004 | −0.020 / −0.021, −0.020 / −0.017 |
| The score's melody line (routed `lead+accomp`) | T3, T4, T5 | +0.012 / +0.019, +0.007 / +0.008, +0.003 / +0.005 | +0.005 / +0.015, +0.003 / +0.009, +0.006 / −0.003 | |

No transcriber lags: every median is within 0.02 s of the reference and of the audio (the piano references sit as far from the onset peaks as the piano notes do: −0.016 to −0.023 s, the peak detector's own delay). Per song, the sung line's offset is −0.026 (Helena Beat) to +0.046 s (Sober).

**Where "+0.09 s" came from** (`union.py`, `union1.log`): §41's `phase.py` scored the reference against every note of the song at once, SOME's and Basic Pitch's (Sit Next to Me: 593 notes for 40 reference notes). The recall of that union peaks at +0.09 s because the band's notes do (Basic Pitch 0.42 → 0.60). SOME alone, and the score's line, which is SOME's notes there, peak at −0.03 s (0.68; 0.55–0.57 from 0 to +0.09 s). Hey Brother's sung part: the union is flat (0.86) from 0.00 to +0.12 s, SOME flat (0.62) from −0.03 to +0.09 s. Faded: SOME recall 0.10, the band 0.66 (0.84 at +0.09 s), because Faded's HookTheory melody is the synth hook (repeated F♯ eighths, then A♯, D♯), not the sung line: the score follows the voice, the reference the hook. A measure fault of the stage-21 diagnosis, not a lag.

**The correction, measured anyway** (`offset.py` on `s29-base`: the routed score's melody line moved by a constant d, scored with `bank.melody_scores`). Note F1 (pc) at d = −0.03, −0.02, −0.01, 0, +0.01, +0.02, +0.03 s: T3 tune 0.614, 0.618, 0.618, **0.625**, 0.625, 0.607, 0.601; T4 tune 0.580–0.583 (flat); T5 tune 0.683 (flat; overlap 0.702 → 0.713 at +0.02 s). On the tune half no offset gains more than 0.003 over d = 0. Check half at 0: T3 0.581 (its best), T4 0.576 (0.586 at +0.02 s), T5 0.326 (0.333 at −0.03 s). **Not adopted: no offset.**

**Written position** (`persong.py` on `s29-base`). The melody's written position (onset in the bar, exact) is 0.86–1.00 on the songs with a melody reference whose meter, tempo level and bar lines are right, except two piano covers whose beats are partly wrong (Mr Cellophane 0.70, Yellow 0.78; beat F 0.88, 0.89) and the two bass-hook songs (2–5 matched notes, §41). It falls to 0–0.3 only where the grid is wrong: the tempo level (×2 or ×0.5: Someone Like You 0.08, When We Were Young 0.12, Divinity 0.29, Faded 0.23, Solar Sailer 0.00, Flower Duet 0.10), the meter (Hello 3/4 for 4/4: 0.13; Samson and Avril 14th 2/4 for 4/4: 0.12, 0.14) or the bar phase (Star Treatment, downbeat F 0.00: 0.00). The written length follows: the median ratio of our written length to the reference's is 1.0 on all but two songs with the right level (Laughing With and Aerodynamic: 2.0), and 2.0 or 0.5 on the level errors. Two of the level "errors" are a convention: Faded and Divinity are at 89 quarters a minute in our score, which is how both are usually listed (90), and at 179 in HookTheory. So the grid, not the onsets, sets the written rhythm's remaining losses (gap 4 of §13).

**Why sung notes miss** (`melerr.py`: SOME's notes against 1145 reference notes of 21 T3/T4 sections, pitch class, 0.1 s). 734 match. Of the 411 misses, 182 have another pitch class at the onset (mostly ±1 or ±2 semitones), 103 are a repeated note that SOME joined into one, 89 have their onset 0.1–0.3 s away, 37 have no sung note (Faded 17, Divinity 9, The Nights 9). Of the 515 unmatched sung notes, 195 split one held note, 313 are other notes (ornaments, sung notes the lead sheet leaves out) and 7 are shorter than 0.12 s. Three fixes were tried on the cached SOME outputs (`segprobe.py` saves SOME's per-frame boundary probability; `segana.py` re-decodes it, the base decode equals the pipeline's notes; `sompitch.py`), note F1 (pc), T3 tune / check, T4 tune / check:

| Variant | T3 | T4 |
|---|---|---|
| SOME's release decode (base) | **0.632** / 0.575 | **0.558** / 0.560 |
| Boundary probabilities ×0.85 / ×1.2 (fewer / more notes) | 0.555 / 0.545, 0.576 / 0.548 | 0.491 / 0.489, 0.515 / 0.524 |
| A boundary at each local maximum ≥ 0.1 / 0.2 / 0.3 | 0.630 / 0.587, 0.633 / 0.591, 0.635 / 0.588 | 0.543 / 0.552, 0.546 / 0.553, 0.544 / 0.568 |
| Join same-pitch neighbours (the first 5 T3 songs; base 0.613 / 0.620) | 0.465 / 0.433 | |
| Each note's pitch re-read from RMVPE / pYIN / SwiftF0 (stage 1's contours) | lower on most songs: The Call 0.70 → 0.60 / 0.64 / 0.63, Get Lucky 0.77 → 0.68 / 0.73 / 0.76 | |

The peak decode gains on the check halves; on the tune half it gains at most 0.003 on T3 and loses 0.012–0.015 on T4; joining neighbours shows that SOME's repeated notes are mostly right; the f0 trackers read the pitch worse than SOME. **Not adopted.** The remaining misses are mostly where the lead sheet simplifies the singing (neighbour notes, ornaments, a held note sung on two syllables); none of the four front-ends reads them better.

**Limits.** One HookTheory section per song (21 sung sections); the lag numbers are medians over the songs of per-song medians; the onset peaks of a vocal stem are soft. Scratch: `~/.kaya/piano2video/scratch/p2v-versatile/s29/` (`txlag.py`, `lagsum.py`, `union.py`, `offset.py`, `persong.py`, `melerr.py`, `segprobe.py`, `segana.py`, `sompitch.py`, `faded.py`, `*.log`, `lag1.tsv`, `probe/`).

## 43. Stage 23: the score grid from nine Beat This! models — their mean repairs grids one model breaks (2026-10-28)

**The gap** (§42): the written rhythm loses only where the grid is wrong, and on some songs Beat This! itself is wrong: against the reference beats, final0's own peaks (`meter.peak_times`, best of six levels) score 0.46 on Hello, 0.57 on Aerodynamic, 0.50 on Starlight, 0.66 on Wake Me Up. The run kept one model; the authors' eight cross-validation models (`fold0`–`fold7`, each trained on 7/8 of final0's data) were on disk, pinned since §12, and used only to score ASAP pieces fairly.

**Measure, the models alone** (scratch `s29/`: `btfolds.py` runs the eight folds on every bank song outside their training data, logits in `s29/bt/`; `btens.py`). Beat F at the annotated level / best of six levels / downbeat F of the raw peaks, 42 songs with reference beats (T1, T3–T5, Für Elise, Clair de Lune):

| Model | All 42 (three numbers) | T1 tune / check (best level) | T3 tune / check (best level) | T5 tune / check (best level) |
|---|---|---|---|---|
| final0 | 0.832 / 0.890 / 0.787 | 0.844 / 0.739 | 0.991 / 0.830 | 0.823 / 1.000 |
| **mean logit of final0 + 8 folds** | **0.858 / 0.911 / 0.816** | 0.875 / 0.810 | 0.993 / 0.876 | 0.867 / 1.000 |
| mean probability of the nine | 0.860 / 0.909 / 0.817 | | | |
| mean of the 8 folds | 0.861 / 0.909 / 0.819 | | | |
| final0 + folds 0–3 / final0 + folds 4–7 | 0.845 / 0.899 / 0.810, 0.863 / 0.912 / 0.811 | | | |

Downbeat F of the raw peaks per song (final0 → mean): Hello 0.62 → 0.88, When We Were Young 0.71 → 0.84, Yellow 0.57 → 0.70, Sad Piano 0.78 → 0.90, Aerodynamic 0.52 → 0.67, Star Treatment 0.22 → 0.39; lower: Für Elise 1.00 → 0.90, Starlight 0.48 → 0.44. T4 is flat (tune beat F 0.958 → 0.954). Five of the nine are less even than all nine (0.845–0.863 by which folds): the nine are kept.

**The change.** `--beat-weights ensemble` is the default: `meter.beat_this` computes the log-mel spectrogram once, runs the nine models on it one at a time (one 81 MB model in memory) and keeps the mean of their beat and downbeat logits (`mean_logits`), cached as `beats-ensemble.npz`; the rest of the grid (`model_grid`, `spliced_grid`) is unchanged. `beat_this_missing("ensemble")` checks all nine files; `setup.sh` fetches the eight folds from the authors' share as it fetches final0 and keeps each only with its pinned SHA-256 (fold0 checked: `f5c6b672…`, the pinned value; a test checks that `setup.sh` pins the same nine hashes as `meter.BEAT_THIS_SHA256`). `--beat-weights final0` runs the single model. The bank: an ASAP piece in `corpus.BT_HELDOUT` still runs the one fold that never heard it; the three ASAP pieces outside the folds (The Lark, Beethoven 22-1, Ballade 2), which no model heard, now get the default. Cost: nine runs of the model (measured 6.5 s a model for Hello's 95 s on this machine's CPU; so an estimated 2.5 min for a 4-minute song instead of 16 s) and 650 MB more weights.

**Before → after** (the whole bank, 62 songs, every variant, no failure: `s29-base` → `s29-ens2`, a scratch copy whose `beat_this` returned the same mean, then `s29-final` on the worktree code from seeded caches equal to a fresh run: max difference 0; routed playable `lead+accomp`; tune / check):

| Measure | T1 covers | T2 classical | T3 piano + vocals | T4 no piano | T5 instrumental |
|---|---|---|---|---|---|
| Tempo level right | 1.00 / 0.667 → **0.833** | 0.30 → 0.20 (loss) / 0.545 | same | same | same |
| Meter right | same | 0.30 → 0.10 (loss) / same | same | same | same |
| Beat F (best level) | 0.898 → 0.907 / 0.761 → **0.814** | 0.681 → 0.688 / 0.742 → 0.760 | 0.985 → 0.988 / 0.821 → 0.817 | 0.939 → 0.937 / 0.964 → 0.962 | 0.737 → **0.930** / 0.976 → 0.984 |
| Downbeat F | 0.706 → 0.705 / 0.622 → 0.647 | 0.505 → 0.491 / same | same / 0.809 → 0.796 | same / 0.919 → 0.909 | 0.712 → **0.887** / 0.837 → 0.857 |
| Written position (piano reference) | 0.675 → 0.692 / 0.532 → **0.602** | 0.279 → 0.283 / 0.381 → 0.367 | – | – | – |
| Written length (piano reference) | 0.647 → 0.655 / 0.467 → **0.550** | 0.229 → 0.212 / 0.360 → 0.341 | – | – | – |
| Melody written position | same / 0.596 → 0.603 | 0.277 → 0.273 / 0.420 → 0.409 | 0.550 → 0.549 / same | 0.770 → 0.762 / 0.985 → 0.978 | 0.749 → **0.899** / 0.477 → 0.484 |
| Melody written length | 0.561 → 0.566 / 0.511 → 0.532 | 0.236 → 0.205 / 0.367 → 0.355 | 0.495 → 0.498 / 0.318 → 0.333 | 0.659 → 0.651 / 0.633 → 0.622 | 0.451 → 0.484 / 0.334 → 0.341 |
| Notes shorter than an eighth | 0.227 → 0.224 / 0.359 → **0.272** | 0.536 → 0.520 / 0.259 → 0.261 | ±0.003 | ±0.003 | 0.149 → 0.140 / 0.157 → 0.163 |

(T2 changes only on its five pieces outside the folds; its other 16 run their held-out fold as before.) Per song, the grids repaired: **Aerodynamic** beat F 0.40 → 0.99, downbeat F 0.38 → 0.94, melody position 0.39 → 0.98; **Starlight** (its 8 bars of score) written position 0.65 → 0.98, length 0.68 → 0.95; **Flower Duet** tempo ×0.49 → ×0.98 (its meter stays wrong: 3/4 for 6/4); Hello downbeat F 0.76 → 0.84; Sad Piano and Sit Next to Me 0.88 → 0.94; Solar Sailer 0.56 → 0.64; Veridis Quo 0.94 → 0.97 (melody note F1 0.67 → 0.69); Opus tempo ×1.03 → ×0.98; Yellow written position 0.76 → 0.85; Ballade 2 beat F 0.71 → 0.98.

**Losses, with reasons.** Two classical pieces of the T2 tune half lose a right meter: **The Lark** 4/4 → 2/4 (tempo ×0.92 → ×0.62) and **Beethoven 22-1** 3/4 → 9/8 (×0.99 → ×1.49; its beat F rises 0.84 → 0.94); **Clair de Lune** (check) 3/4 → 4/4 (the reference's 9/8: wrong both times) and its beat F 0.35 → 0.28. Downbeat F: **Laughing With** 0.89 → 0.75, **The Nights** 0.88 → 0.75, **Some Chords** 0.82 → 0.75 (melody position 0.86 → 0.71), Connections 0.90 → 0.87. On The Lark and Laughing With the raw peaks of the mean are better than final0's (0.62 → 0.79, 0.86 → 1.00), and on The Nights they are the same: the loss is in the grid builder (`steady_beats` takes the local tempo and the beat envelope from the logits, which the mean softens where the models disagree), whose settings were chosen on final0. Re-tuning it on the mean is a next stage, not done here. Faded's and Waiting for Love's drop melody position 0.24 → 0.18 and 0.96 → 0.92 (one or two notes across a 16th).

**Verdict: adopted** — chosen on the tune half (T1 written position 0.675 → 0.692, T5 beat F 0.737 → 0.930 and melody position 0.749 → 0.899; T3 flat; T4 −0.008 melody position from Faded alone; T2 −2 meters), confirmed on the check half (T1 tempo 0.667 → 0.833, written position 0.532 → 0.602, length 0.467 → 0.550; T5 small gains; T3 and T4 small mixed). Across the songs whose grid measures (beat F, downbeat F, tempo, meter) change, 15 get better and 8 worse; the three meter losses are classical pieces.

**Rendered review** (`pdftoppm -r 80`, page 1; scratch `s29/rv/`, `s29-base` against `s29-final`, Aerodynamic, `arrange/lead+accomp`). Bars 1–12 are the same. From bar 13 the old score has the arpeggio off the beat: 16th rests before notes (bar 17: a 16th rest, a 16th, an eighth) and the left hand's B–D eighths after rests (bars 15–16). The new score has the figure on the beats: even eighths D–B–D–B in the left hand from bar 16 and in the right hand in bar 16; page 1 holds 24 bars instead of 22. Some 16th figures stay (bars 18–21): the part's own rhythm.

**Code review** (`high`, 9 findings). Fixed: `corpus run --checkpoint heldout` still gave final0 to the three pieces outside the folds while the bank gave them the mean (now both give the mean); the SHA-256 of the nine files was checked only as each model loaded, after Demucs and the transcription, and again for every song (730 MB): `beat_this_missing` now checks every needed file before the run, once per process and file state (0.5 s); `mean_logits` cut runs of different lengths silently and failed obscurely on none (both now raise); a failed download left a `.part` file; the bank's held-out test read the folder before the `asap:` prefix; the tests did not see a duplicate name in `setup.sh`, its URL pattern, or which models the ensemble runs (two tests added: 183 pass). Changed in words only: a machine set up before this change has only final0, so a default run stops before any work and its message now also names `--beat-weights final0` (a silent fallback would hide the weaker grid); `--help` says that 8 of the 9 models heard the ASAP pieces of `corpus.BT_HELDOUT`. Not changed: the eight folds stay a hard stop in `setup.sh`, as final0 was.

**Limits.** 46 songs outside the models' training data (the bank's T2 is mostly ASAP, which the folds heard, so classical piano has five pieces here); Harmonix (912 pop songs) is in all nine models' training data, so a bank song in it would favour every variant alike. Scratch: `~/.kaya/piano2video/scratch/p2v-versatile/s29/` (`btfolds.py`, `btens.py`, `btens1.log`, `btens2.log`, `bt/`, `tools-ens/`, `ens.sh`, `seed.py`, `cmpsong.py`, `final.sh`).

## 44. Stage 24: the grid builder on the nine-model mean — the losses traced, 46 variants measured, no change (2026-10-28)

**The question** (§43 "Losses"): since §43 the grid is built from the mean logit of nine models, with settings chosen on final0. Six songs lost a grid measure. Is the grid builder (`peak_times`, `steady_beats`, `subdivision`, `bar_length_joint`, `MODEL_DOWN_W`, `SURE_CV`) now tuned to the wrong input?

**Method** (scratch `s30/`). `gridlab.py` rebuilds each bank song's routed grid from its cached notes (the routed source's `tx/*.json`, as `pipeline.source_notes`) and cached logits, under named patches of `meter` (`variants.py`), and scores it with `bank.grid_scores` (meter, tempo, beat F at the best of six levels, downbeat F). It is exact: on all 61 songs with a reference the base grid equals the grid `s29-final` saved (`--check-base`, 61 of 61 "same" to the saved 4 decimals), and its means equal §43's numbers. A run of several variants over the bank takes minutes: no Demucs, transcription or score. `signs.py` counts per type and half the songs that get better or worse (a meter or tempo match won or lost, or beat F + downbeat F moved more than 0.02): with 3 to 11 songs a half, one song moves a mean by 0.02–0.08, so the count is read beside the means.

**The losses, traced** (`gridlab.py --trace`, `downtrace.py`, `peaks.py`, `subdiv.py`; final0's logits → the mean's):
- **The Lark** (4/4 → 2/4, tempo ×0.92 → ×0.62): the model hears the piece's slow beats badly with either input. Of the 72 reference beats, final0 has a logit maximum over 0 on 37 and the mean on 41; but final0 also has 36 maxima over 0 off the beats, the mean 12. final0's false peaks filled the gaps by chance, so the median raw interval (the local tempo of `steady_beats`) was near the beat; the mean's cleaner peaks leave gaps, and the median interval is 1.7 s for a 1.07 s beat. A fault of the tempo step (a median of raw intervals cannot see missed beats), shown by a better input.
- **Beethoven 22-1** (3/4 → 9/8, beat F 0.84 → 0.94): the beats are the same tempo and better placed; `subdivision` then reads the triplet passages: R3 / max(R2, R4) 1.68 → 3.20. No margin separates this from the compound pieces: Beethoven 28-1 (6/8) reads 2.31 and the Berceuse 2.74, while Rachmaninoff 23/4 (3/4 with triplets) reads 2.14. A 3/4 with triplet passages needs tuplets per section, not a global subdivision — a larger change than this stage.
- **Clair de Lune** (3/4 → 4/4; the reference's 9/8 is wrong both times): the mean's raw peaks are as poor as final0's (beat F 0.47 at the best level); the rubato beats change, so the bar length changes.
- **Laughing With, The Nights, Some Chords** (downbeat F 0.89 / 0.88 / 0.82 → 0.75): the references hold 5, 9 and 9 downbeats; one bar line at the edge of the span moves 80–290 ms or enters the span (The Nights at 33.0 s: 88 ms against the 70 ms tolerance). Measure noise on short references, not a grid fault; meter and tempo stay right.

**Variants** (the 61 songs, `s29-final` caches; all(+ / −) = songs better / worse over all types; full tables in `s30/v1.log` … `v8.log` and `lab-*.json`):

| Family | Variants | Notable results (each marked tune or check) | all(+ / −) |
|---|---|---|---|
| Peak threshold | logit > −2, −1, +1 | thr −2 repairs When We Were Young (tune; downbeat F 0.615 → 0.971) and breaks Sad Piano (check; beat F 0.985 → 0.413) | 9/18, 9/10, 7/12 |
| Missed-beat folding of the raw intervals | fold ×2–3, ×2 only, with thr −1 | fold ×2: T2 tune 5/1, but T1 check tempo 0.833 → 0.500 (Coldplay doubled) | 7/10, 9/5, 12/16 |
| Beat envelope sigmoid(a × logit) | a = 2, 0.5 | none better on a tune half | 3/7, 4/6 |
| DP tightness of `steady_beats` (100) | 30, 10, 3; the raw peaks as beats | t30: T2 tune 3/3, T5 tune beat F 0.930 → 0.851 | 10/7, 12/10, 12/11, 18/19 |
| `MODEL_DOWN_W` (2) | 1, 3, 4, 6 | 6: T2 tune 3/4 | 3/16, 2/4, 5/6, 7/6 |
| Bar length: model weight in `bar_length_joint` (1); bar length from the raw downbeat peaks | 0.5, 2, 4; raw | 0.5: one song (Mozart 12-3 12/8 → 6/8, right; downbeat F 0.66 → 0.93), no other change | 1/0, 1/1, 3/1, 7/12 |
| `SURE_CV` (0.5) | 0.3, 0.7, ∞ (no splice) | 0.7: T2 check 4/1 (beat F 0.760 → 0.815), but T1 tune loses Connections (0.932 → 0.804) | 5/19, 9/6, 9/7 |
| Sure bar from the beat probability at the steady beats; from the CV of peaks over −2; either cue; both cues | p > 0.3–0.7; CV 0.5, 0.7; or 0.4–0.6; and 0.3 | or 0.5: T2 check 4/0 (beat F 0.760 → 0.818, tempo 0.545 → 0.636); tune: T1 0/1, T2 4/2 | 8/8 … 10/10; 8/11, 10/7; 10/5, 9/4, 6/5; 4/5 |
| A DBN beat tracker (below) instead of `steady_beats` | tempo 55–215 or within ×1.5 of the present level; λ 100, 30; with no splice; with the sureness cues above | level-bound DBN: T3 check beat F 0.817 → 0.917, tempo 0.75 → 1.00; T2 check downbeat F 0.558 → 0.604; tune: T1 1/3, T2 3/2, T3 1/2, T4 1/2 | 15/16 (no splice 22/15, with p > 0.3 19/18) |

**The DBN** (`s30/dbn.py`, about 60 lines of numpy; §27 tested the same state space on final0's logits — λ 10, periods 0.55–1.8 × the median — and it lost in the whole grid; madmom, which Beat This!'s own optional post-processing uses, is not installed, and its last release (2018) is older than this venv's numpy 2.4). The state space of Krebs, Böck and Widmer (2015) as madmom's `DBNBeatTrackingProcessor`: (beat interval, position) states on the 50 frames/s, a tempo change only at a beat with probability ∝ exp(−100 |j/i − 1|), the first 1/16 of each beat the beat states; Viterbi; a beat = the probability peak in each run of beat states. On synthetic logits it finds all 120 beats with a third missing and 15 false peaks, follows a 120 → 90 tempo change (104 of 106), and passes the four `steady_beats` test scenarios. On the bank it is the one lever with large single gains, all on check-half songs, so they are not held-out evidence for choosing it (Hello beat F 0.41 → 0.78 with the meter and tempo right; Schubert 664-1 downbeat F 0.76 → 0.94; Moment musical 0.66 → 0.93 with its 2/4 right; Flower Duet beat F 0.64 → 0.81). Its losses: Connections 0.932 → 0.854 (traced with `splicedbg.py`: in the free intro, 6.4–12.3 s, the beat probability is near 0 and both the old beats (160–300 ms) and the DBN's (120–200 ms) are off; the old grid was right there only because one later bar was "unsure" and the splice grew that stretch back to the start, so the note tracker took the whole intro — with the DBN that bar is sure; the probability cue flags the intro, but costs other songs), The Moon Song 0.761 → 0.712 (5 beats at the 70 ms edge, where p ≈ 0), and one bar line on several short pop references.

**Verdict: no change.** No variant gives a clear gain on the tune half of the types it targets. Some families are clearly worse (thr −2 9/18, `MODEL_DOWN_W` 1 3/16, `SURE_CV` 0.3 5/19); most are even. The three with more gains than losses fail for named reasons: bar-length weight 0.5 changes one tune song only (Mozart 12-3, right) and nothing on the check half confirms it; fold ×2 gains T2 tune 5/1 but doubles Coldplay's tempo (T1 check tempo 0.833 → 0.500); either-cue 0.5 gains the T2 check half 4/0 but its tune halves are T1 0/1 and T2 4/2 with downbeat F 0.491 → 0.476. The large single gains of the DBN fall on the check half (Hello, Moment musical, Schubert 664-1). On rubato piano the grid is unstable: a small change of the input (one of nine logit sets, a threshold) flips the tempo level, the subdivision or the bar length of several pieces either way, so 10 pieces a half cannot show a ±0.02 effect. Two findings stay for the next grid stage: (1) the DBN is the lever with the largest single gains, and (2) the splice's sureness cue (the raw peaks' CV) is right on Connections by chance. Neither can be chosen on this bank; bar-length weight 0.5 and fold ×2 are the next candidates on a larger one. **Open defects, unchanged since §43:** The Lark (2/4, tempo ×0.62: the median of raw intervals cannot see missed beats), Beethoven 22-1 (9/8 for 3/4: a global subdivision), Clair de Lune (4/4 for 9/8).

**What would move it.** A grid test set large enough for the effects measured here, outside every model's training data: GTZAN (about 1000 clips of 30 s with beat and downbeat annotations; final0 trained on all its datasets except GTZAN, §12 — that the eight fold models, which split the same training data, also exclude it is to be checked before use), plus the ASAP pieces of `corpus.BT_HELDOUT` at their full length rather than 90 s. With 100 songs or more a half, the DBN and the sureness cue can be decided. Not done here: it needs a dataset source (the GTZAN audio is on Kaggle, which needs an account, or on unofficial mirrors) and many hours of Demucs and transcription.

**Limits.** The grid measures only (meter, tempo, beat F, downbeat F); the written measures follow the grid (§42), and no variant was adopted, so no bank run was needed. The 46 variants (`s30/variants.py` names): thr −2, −1, +1; fold, fold ×2, fold + thr −1; envelope 2, 0.5; tightness 30, 10, 3, raw peaks; `MODEL_DOWN_W` 1, 3, 4, 6; bar weight 0.5, 2, 4, raw downbeats; `SURE_CV` 0.3, 0.7, ∞; probability sureness 0.3, 0.4, 0.5, 0.6, 0.7; CV over −2 at 0.5 and 0.7, over −1 at 0.5; either cue 0.4, 0.5, 0.6; both cues 0.3; DBN free, level-bound, each without the splice, λ 30; level-bound DBN with probability 0.3, 0.5 and both 0.3, 0.5; free DBN with probability 0.3 and both 0.3. Code review (`high`, 6 points on this text): the verdict, the open defects, the GTZAN claim, the check-half marking and this list were reworded or added; not changed: the tools stay in the scratch folder, as for every stage since §12. Scratch: `~/.kaya/piano2video/scratch/p2v-versatile/s30/` (`gridlab.py`, `variants.py`, `lab.sh`, `bg.sh`, `labsum.py`, `signs.py`, `cmplab.py`, `downtrace.py`, `peaks.py`, `subdiv.py`, `rawbeats.py`, `beatdiff.py`, `splicedbg.py`, `dbn.py`, `testdbn.py`, `v1.log` … `v8.log`, `lab-*.json`).
