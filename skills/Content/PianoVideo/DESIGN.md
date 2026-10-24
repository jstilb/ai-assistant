# piano2video — Design

Song/audio file → isolated stems → piano arrangement → **MIDI + sheet music (MusicXML/PDF) + Synthesia-style falling-notes video**.

Status: thin end-to-end slice **built and verified** 2026-10-20 (task t-mvfkuj6y-3vvsui). The arrangement decision (§4) is **open for Jm**. Every option is implemented behind flags, so choosing one only changes a default.

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
  │ 3 transcribe  piano stem  → ByteDance high-res piano model (notes + velocity)
  │               other stems → Spotify Basic Pitch (instrument-agnostic, polyphonic)
  ▼               cached as tx/<stem>.json
raw notes
  │ 4 arrange     recipe chosen by --source × --parts  (§4)
  │               skyline melody · register fitting · chord thinning · de-doubling · hand split
  ▼
two-hand arrangement (seconds, performance timing)
  │ 5 outputs     <variant>.mid        performance MIDI, 2 tracks (Piano RH / Piano LH), tempo = detected bpm
  │               <variant>.musicxml   beat-quantized grand staff (librosa beats, 16th grid, key detected)
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
| Beat / tempo | **librosa beat_track** | madmom, BeatNet | It's already a dependency and is good enough to drive notation. Double-time reads (>160 bpm) are halved. |
| MIDI | **pretty_midi** | mido | Simple timing in seconds. |
| Notation | **music21 → MusicXML**, engraved by **Verovio** (+ cairosvg/pypdf → PDF) | MuseScore CLI, LilyPond | Everything installs from pip (cairo comes from Homebrew), so there's no GUI app to install. MusicXML opens in MuseScore for hand-editing. |
| Video | **Custom PIL renderer → ffmpeg** (in `render.py`) | MIDIVisualizer, SeeMusic, Synthesia (recorded), Neothesia | Headless, scriptable and dependency-free. It renders 73 s in about 6 s. MIDIVisualizer gives a fancier look but needs a GUI/GL context and manual config. The `.mid` output loads directly into any of those if Jm wants a prettier render. |
| Audio for video | Built-in additive synth | FluidSynth + soundfont | No soundfont dependency, and you hear exactly what was transcribed. `--audio-track original|mix` is also available. |

Environment gotchas (all handled in setup.sh / the code):
- Demucs on **MPS fails** (`Output channels > 65536`). The pipeline runs it on CPU, which takes about 30 s for a 73 s song on an M-series chip.
- Demucs needs **torchaudio < 2.9**, so torch and torchaudio are pinned to 2.5.1.
- Basic Pitch → resampy needs `pkg_resources`, so setuptools is pinned below 70.
- The `piano_transcription_inference` helper `load_audio` breaks on librosa 0.11 (we use `librosa.load` instead). Its checkpoint auto-download also fails, so `setup.sh` fetches it from zenodo (~165 MB, slow).
- cairosvg needs `DYLD_FALLBACK_LIBRARY_PATH=/opt/homebrew/lib`, which the wrapper sets.
- Verovio text glyphs (♩) don't render through cairosvg, so the tempo mark is text: "≈ 129 bpm".

## 3. Arrangement transforms (`Tools/p2v/arrange.py`, unit-tested)

- **skyline(top|bottom)**: reduces polyphony to one line. Near-simultaneous onsets (35 ms or less) count as a chord, and the extreme pitch wins. Inner voices under a held note are dropped. A new, more extreme note truncates the held one. Used for the vocal lead (Basic Pitch emits harmonics and doublings), the piano top line, and the bass line.
- **fit_register**: picks one octave shift for the whole line so its contour is kept, then folds outliers. Lead goes to E4–E6, accompaniment to C3–B4, bass to E1–E3.
- **limit_polyphony**: thins each chord to N notes (default 4). The top and bottom notes are always kept, then the loudest inner notes.
- **merge_same_pitch**: unions overlapping notes of the same pitch, which happens when guitar, piano and other stems all play the same chord.
- **drop_doubled**: removes accompaniment notes that double a sounding melody or bass note.
- **assign_hands**: lead → RH, bass → LH, accompaniment split at middle C.
- **Notation quantization**: beat-relative positions come from the detected beats (so tempo drift is absorbed). Notes snap to a 16th grid, and each hand becomes a chord sequence where a held note is cut at the next onset (readable over literal). The key is detected (Krumhansl via music21) and pitches are spelled for it.

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

A third shape worth considering, not built: a **lead-sheet mode** (melody plus chord symbols, with LH block chords on the beat). It's the most beginner-friendly and matches the "(lead)" tags. It needs chord recognition (e.g. from the harmony notes per beat). This is the natural next slice if Jm wants simpler accompaniment than the transcribed voicings.

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

1. Time signature is assumed 4/4, and beat tracking can sit off by half a beat on syncopated material. A downbeat tracker (madmom/BeatNet) would fix both.
2. The vocal melody inherits Basic Pitch's octave and vibrato artefacts. A CREPE/RMVPE f0 front-end would give a cleaner lead.
3. Notation cuts sustains at the next onset and doesn't separate voices within a hand. For performance-ready scores, hand-edit the MusicXML in MuseScore.
4. Lead-sheet / chord-symbol mode (see §4).
5. The video is a flat 2D style. It could add particle effects or a sheet strip, or MIDIVisualizer could be used on the `.mid`.
6. A YouTube URL as input could go through `kaya-cli yt` (yt-dlp) before ingest. Respect copyright: only for personal practice.
