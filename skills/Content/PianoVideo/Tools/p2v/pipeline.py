"""piano2video — song/audio -> stems -> MIDI -> sheet music -> Synthesia-style video.

Stages (each cached in the work dir; --force re-runs):
  1. ingest      ffmpeg -> 44.1 kHz stereo wav (optional --start/--duration trim)
  2. separate    Demucs htdemucs_6s -> vocals/drums/bass/guitar/piano/other
  3. transcribe  piano stem -> ByteDance high-res piano model; other stems -> Basic Pitch
  4. arrange     --source piano|arrange x --parts lead|lead+accomp|lead+full|lead+chords  (DESIGN.md §4, §39)
  5. outputs     <variant>.mid, <variant>.musicxml, <variant>.pdf, <variant>.mp4
"""

from __future__ import annotations

import argparse
import contextlib
import io
import json
import os
import re
import shutil
import subprocess
import sys
import time
from dataclasses import asdict
from pathlib import Path

import numpy as np

from . import arrange
from .arrange import Note, arrange_full, arrange_hybrid, arrange_piano_only, melody_alone
from .meter import Grid

STEMS = ("vocals", "drums", "bass", "guitar", "piano", "other")
HARMONY_STEMS = ("piano", "guitar", "other")
SILENT_DB = -30.0  # stems quieter than loudest-stem RMS minus this are ignored
# all other stems together this far below the piano = a solo-piano recording. Measured: Connections
# -33 dB and Starlight -24 dB (the mix transcribed better than the stem on both), Viva la FAI +6.6 dB
SOLO_PIANO_DB = -15.0
MODEL_DIR = Path(os.environ.get("P2V_MODEL_DIR", Path.home() / ".kaya/piano2video/models"))
PIANO_CKPT = MODEL_DIR / "note_F1=0.9677_pedal_F1=0.9186.pth"
PIANO_CKPT_URL = "https://zenodo.org/record/4034264/files/CRNN_note_F1%3D0.9677_pedal_F1%3D0.9186.pth?download=1"

SOURCES = ("piano", "arrange", "hybrid")
# --source auto: a piano with vocals is "piano-led" (the hybrid path) when the piano stem is at most this far
# under the loudest other accompaniment stem (guitar, other, bass); 0 = at least as loud as each (DESIGN.md §14, §40)
PIANO_LEAD_DB = 0.0
# --source auto with no lead: piano when every other stem together is at most this far over the piano
# stem, else arrange (the band's line). Bank (DESIGN.md §21): piano pieces with bleed -8 to -15 dB,
# instrumental tracks with a piano-like stem +11 to +17 dB; the run logs the value ("others vs piano")
NO_LEAD_PIANO_DB = 0.0
PARTS = ("lead", "lead+accomp", "lead+full", "lead+chords")
BOTH_HANDS = ("lead+accomp", "lead+full")  # a two-hand arrangement: the playable score and the advanced one (§39)


def band_chords(source: str, parts: str) -> bool:
    """The accompaniment is voiced from the recognised chords' tones: `arrange` with both hands (§20), and the band
    the advanced hybrid adds (§39)."""
    return (source == "arrange" and parts in BOTH_HANDS) or (source == "hybrid" and parts == "lead+full")


def log(msg: str):
    print(f"[p2v {time.strftime('%H:%M:%S')}] {msg}", file=sys.stderr, flush=True)


def slugify(s: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", s.lower()).strip("-") or "song"


def is_url(s: str) -> bool:
    return re.match(r"https?://", s) is not None


YT_DLP = shutil.which("yt-dlp") or "/opt/homebrew/bin/yt-dlp"


def fetch_url(url: str, cache: Path, force: bool = False) -> tuple[Path, str]:
    """Audio of a web video (yt-dlp) -> (file, video title). Cached under `cache`/<url hash>/ so
    re-runs and other --name values reuse it; --force downloads again. Downloaded files are data:
    only ffmpeg reads them."""
    import hashlib
    d = cache / hashlib.sha1(url.encode()).hexdigest()[:12]
    if force and d.exists():
        shutil.rmtree(d)
    info = d / "source.info.json"
    found = [p for p in d.glob("source.*") if not p.name.endswith((".json", ".part"))] if info.exists() else []
    if not found:
        d.mkdir(parents=True, exist_ok=True)
        log(f"downloading audio of {url} with yt-dlp…")
        r = subprocess.run([YT_DLP, "--no-playlist", "-f", "bestaudio/best", "--write-info-json",
                            "--no-progress", "-o", str(d / "source.%(ext)s"), url],
                           capture_output=True, text=True)
        if r.returncode != 0:
            shutil.rmtree(d, ignore_errors=True)
            raise SystemExit(f"yt-dlp failed ({r.returncode}) for {url}:\n{r.stderr.strip()}")
        found = [p for p in d.glob("source.*") if not p.name.endswith((".json", ".part"))]
        if not found or not info.exists():
            raise SystemExit(f"yt-dlp exited 0 but wrote no audio/info in {d}:\n{r.stderr.strip()}")
    return found[0], str(json.loads(info.read_text()).get("title") or "song")


# ----------------------------------------------------------------- stages -- #

def ingest(src: Path, work: Path, start: float | None, duration: float | None) -> Path:
    out = work / "input.wav"
    if out.exists():
        return out
    cmd = ["ffmpeg", "-v", "error", "-y"]
    if start:
        cmd += ["-ss", str(start)]
    cmd += ["-i", str(src)]
    if duration:
        cmd += ["-t", str(duration)]
    cmd += ["-ar", "44100", "-ac", "2", str(out)]
    subprocess.run(cmd, check=True)
    return out


def separate(wav: Path, work: Path) -> dict[str, Path]:
    stem_dir = work / "stems"
    stems = {s: stem_dir / f"{s}.wav" for s in STEMS}
    if all(p.exists() for p in stems.values()):
        return stems
    log("separating stems with Demucs htdemucs_6s (CPU; MPS lacks a needed conv op)…")
    tmp = work / "_demucs"
    subprocess.run([sys.executable, "-m", "demucs", "-n", "htdemucs_6s", "-d", "cpu",
                    "-o", str(tmp), str(wav)], check=True,
                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    stem_dir.mkdir(exist_ok=True)
    for s in STEMS:
        shutil.move(str(tmp / "htdemucs_6s" / wav.stem / f"{s}.wav"), stems[s])
    shutil.rmtree(tmp, ignore_errors=True)
    return stems


def stem_levels(stems: dict[str, Path]) -> dict[str, float]:
    import soundfile as sf
    out = {}
    for s, p in stems.items():
        a, _ = sf.read(p, dtype="float32")
        rms = float(np.sqrt(np.mean(a ** 2))) + 1e-9
        out[s] = 20 * np.log10(rms)
    return out


def active_stems(levels: dict[str, float]) -> set[str]:
    top = max(levels.values())
    return {s for s, db in levels.items() if db >= top + SILENT_DB}


def others_below_piano_db(levels: dict[str, float]) -> float:
    """Summed power of every non-piano stem relative to the piano stem (dB; very negative = solo piano)."""
    others = sum(10 ** (db / 10) for s, db in levels.items() if s != "piano")
    return 10 * np.log10(others + 1e-12) - levels["piano"]


def piano_input(choice: str, levels: dict[str, float]) -> str:
    """'mix' or 'stem': where the piano model should listen. On a solo-piano recording Demucs
    can only add artefacts (on Starlight its stem gave 165 notes the mix didn't), so auto picks
    the mix when everything else is at least SOLO_PIANO_DB below the piano."""
    if choice != "auto":
        return choice
    return "mix" if others_below_piano_db(levels) <= SOLO_PIANO_DB else "stem"


def route(levels: dict[str, float], lead_stem: str = "vocals") -> str:
    """--source auto: the path for this song from its stem levels (DESIGN.md §4, §14). A solo-piano
    recording -> piano; a piano that leads the accompaniment under a lead (vocal) stem, at least as loud as
    each band stem (PIANO_LEAD_DB, §40) -> hybrid (the real piano part under the sung melody); any other song
    with a lead -> arrange; no lead -> piano
    when the piano is at least as loud as every other stem together (a piano piece with Demucs bleed:
    the bank's are 8-15 dB over the rest), else arrange, whose melody is then the band's top line
    (an instrumental track: the bank's T5 have the rest 11-17 dB over a piano stem, DESIGN.md §21)."""
    active = active_stems(levels)
    if "piano" in active and others_below_piano_db(levels) <= SOLO_PIANO_DB:
        return "piano"
    if lead_stem in active:
        rest = [db for s, db in levels.items() if s not in ("piano", lead_stem, "drums")]
        if lead_stem != "piano" and "piano" in active and levels["piano"] >= max(rest, default=-200.0) - PIANO_LEAD_DB:
            return "hybrid"
        return "arrange"
    return "piano" if "piano" in active and others_below_piano_db(levels) <= NO_LEAD_PIANO_DB else "arrange"


def band_stems(active: set[str], lead_stem: str) -> list[str]:
    """The stems `arrange` takes its chords and, where the lead rests, its line from (DESIGN.md §21)."""
    return [s for s in HARMONY_STEMS if s in active and s != lead_stem]


def _notes_from_json(p: Path) -> list[Note]:
    return [Note(**d) for d in json.loads(p.read_text())]


def _notes_to_json(notes: list[Note], p: Path):
    p.write_text(json.dumps([asdict(n) for n in notes]))


def transcribe_piano(stem: Path, cache: Path) -> list[Note]:
    """ByteDance high-resolution piano transcription (Kong et al. 2021) — far
    more accurate than general models on actual piano audio."""
    if cache.exists():
        return _notes_from_json(cache)
    import librosa
    from piano_transcription_inference import PianoTranscription, sample_rate
    if not PIANO_CKPT.exists():
        log(f"downloading piano model (~165 MB) to {PIANO_CKPT}…")
        PIANO_CKPT.parent.mkdir(parents=True, exist_ok=True)
        subprocess.run(["curl", "-sSL", "-o", str(PIANO_CKPT), PIANO_CKPT_URL], check=True)
    log(f"transcribing {stem.name} with the piano model…")
    audio, _ = librosa.load(str(stem), sr=sample_rate, mono=True)
    with contextlib.redirect_stdout(io.StringIO()):
        t = PianoTranscription(device="cpu", checkpoint_path=str(PIANO_CKPT))
        res = t.transcribe(audio, str(cache.with_suffix(".mid")))
    notes = [Note(start=float(e["onset_time"]), end=float(e["offset_time"]),
                  pitch=int(e["midi_note"]), velocity=int(e["velocity"]))
             for e in res["est_note_events"]]
    _notes_to_json(notes, cache)
    return notes


def transcribe_general(stem: Path, cache: Path, melodic: bool = False) -> list[Note]:
    """Spotify Basic Pitch — instrument-agnostic polyphonic transcription."""
    if cache.exists():
        return _notes_from_json(cache)
    from basic_pitch.inference import predict
    log(f"transcribing {stem.name} with Basic Pitch…")
    with contextlib.redirect_stdout(io.StringIO()):
        _, _, events = predict(
            str(stem),
            onset_threshold=0.6 if melodic else 0.5,
            frame_threshold=0.35 if melodic else 0.3,
            minimum_note_length=100 if melodic else 70,
        )
    notes = [Note(start=float(s), end=float(e), pitch=int(p), velocity=int(round(a * 127)))
             for s, e, p, a, *_ in events]
    _notes_to_json(notes, cache)
    return notes


def transcribe_f0(stem: Path, cache: Path) -> list[Note]:
    """Monophonic lead from the pYIN f0 contour (melody.py): one note per sung note, no octave or
    vibrato splits. Measured on Vocadito (DESIGN.md §10): note F 0.570 vs 0.532 for Basic Pitch + skyline."""
    if cache.exists():
        return _notes_from_json(cache)
    import librosa
    from .melody import SR, contour_to_notes, f0_contour, voiced_midi
    log(f"tracking the {stem.stem} melody with pYIN…")
    t, midi, prob, db = f0_contour(librosa.load(str(stem), sr=SR, mono=True)[0])
    notes = contour_to_notes(t, voiced_midi(midi, prob, db))
    _notes_to_json(notes, cache)
    return notes


def transcribe_some(stem: Path, cache: Path) -> list[Note]:
    """Sung notes from SOME, a singing-note model (some.py). On the bank's sung melodies (T3/T4 vocal
    stems) melody overlap 0.60-0.75 vs pYIN's 0.45-0.65 (DESIGN.md §15)."""
    if cache.exists():
        return _notes_from_json(cache)
    from .some import transcribe
    log(f"transcribing the {stem.stem} melody with SOME…")
    notes = transcribe(stem)
    _notes_to_json(notes, cache)
    return notes


def some_check(args) -> None:
    """Stop when the lead needs SOME and its weights are missing, with the reason and the fix."""
    from .some import some_missing
    why = some_missing() if lead_f0(args.lead_f0, args.lead_stem) == "some" else None
    if why:
        raise SystemExit(f"--lead-f0 {args.lead_f0}: the sung melody needs SOME: {why}. Fix: run "
                         f"{Path(__file__).parent.parent / 'setup.sh'}, or use --lead-f0 pyin")


def lead_f0(choice: str, lead_stem: str) -> str:
    """'some', 'pyin' or 'basicpitch'. auto: SOME for a vocal lead (it is a singing model), else Basic Pitch."""
    return choice if choice != "auto" else ("some" if lead_stem == "vocals" else "basicpitch")


# ---------------------------------------------------------------- outputs -- #

def pedal_from_midi(path: Path) -> list:
    """Sustain-pedal (CC64) events from the piano model's own MIDI output, if it exists."""
    import pretty_midi
    if not path.exists():
        return []
    return [c for i in pretty_midi.PrettyMIDI(str(path)).instruments for c in i.control_changes if c.number == 64]


MIDI_PPQ = 960
KEY_NAMES = {-6: "Gb", -5: "Db", -4: "Ab", -3: "Eb", -2: "Bb", -1: "F", 0: "C", 1: "G", 2: "D", 3: "A", 4: "E",
             5: "B", 6: "F#"}


def write_midi(notes: list[Note], grid: Grid, path: Path, pedal: list | None = None,
               keys: list[tuple[float, int]] | None = None):
    """Score-time MIDI: ticks count the score's quarters, so a DAW or MuseScore shows the bars,
    meter and keys of the PDF, and a tempo map from the grid (one event per tempo change) keeps
    playback time equal to the recording's. MIDI time 0 must be audio time 0; when that falls
    inside a bar, the file opens with a pickup bar (n/16, n/8 or n/4). Key-press lengths per hand;
    the transcribed sustain pedal goes on both tracks so playback still rings."""
    import mido
    from .meter import _extrap
    q0 = round(float(grid.sec_to_q(0.0)) * 4) / 4  # score position of time 0, on a 16th
    keep = (grid.q > q0 + 1e-6) & (grid.t > 1e-3)
    mt, mq = np.r_[0.0, grid.t[keep]], np.r_[q0, grid.q[keep]]  # the file's own seconds -> quarters knots

    def tick(t: float) -> int:
        return max(0, int(round((float(_extrap(t, mt, mq)) - q0) * MIDI_PPQ)))

    conductor: list[tuple[int, int, mido.MetaMessage]] = []
    last = None
    for i in range(len(mt) - 1):  # every change: merging "nearly equal" tempi drifts 10+ ms over gradual rubato
        us = int(round((mt[i + 1] - mt[i]) / (mq[i + 1] - mq[i]) * 1e6))
        if us != last:
            conductor.append((int(round((mq[i] - q0) * MIDI_PPQ)), 0, mido.MetaMessage("set_tempo", tempo=us)))
            last = us
    num, den = (int(x) for x in grid.meter.split("/"))
    first_bar = float(np.ceil(q0 / grid.bar_q - 1e-9) * grid.bar_q)
    pickup16 = int(round((first_bar - q0) * 4))
    if pickup16:
        n, d = next((pickup16 // f, 16 // f) for f in (4, 2, 1) if pickup16 % f == 0)
        conductor.append((0, 1, mido.MetaMessage("time_signature", numerator=n, denominator=d)))
    conductor.append((int(round((first_bar - q0) * MIDI_PPQ)), 1,
                      mido.MetaMessage("time_signature", numerator=num, denominator=den)))
    for off, sharps in keys or []:
        conductor.append((max(0, int(round((off - q0) * MIDI_PPQ))), 2,
                          mido.MetaMessage("key_signature", key=KEY_NAMES[int(np.clip(sharps, -6, 6))])))

    def track(name: str, events: list[tuple[int, int, mido.Message]]) -> mido.MidiTrack:
        tr = mido.MidiTrack([mido.MetaMessage("track_name", name=name)])
        now = 0
        for t, _, msg in sorted(events, key=lambda e: (e[0], e[1])):
            tr.append(msg.copy(time=t - now))
            now = t
        return tr

    mid = mido.MidiFile(ticks_per_beat=MIDI_PPQ)
    mid.tracks.append(track("Conductor", conductor))
    for hand, name in (("R", "Piano RH"), ("L", "Piano LH")):
        ev: list[tuple[int, int, mido.Message]] = []
        for n in notes:
            if n.hand != hand:
                continue
            on = tick(n.start)
            off = max(on + 1, tick(n.end))
            vel = int(np.clip(n.velocity, 1, 127))
            ev.append((on, 2, mido.Message("note_on", note=n.pitch, velocity=vel)))
            ev.append((off, 0, mido.Message("note_off", note=n.pitch, velocity=0)))  # offs before ons
        ev += [(tick(c.time), 1, mido.Message("control_change", control=64, value=int(c.value))) for c in pedal or []]
        mid.tracks.append(track(name, ev))
    mid.save(str(path))


def source_notes(source: str, tx: dict[str, list[Note]], active: set[str], lead_stem: str) -> list[Note]:
    """The transcriptions a source is built from — and the only ones its beat grid may follow
    (Demucs bleed in a silent stem once steered the beats of a solo-piano score)."""
    if source == "piano":
        return tx.get("piano", [])
    if source == "hybrid":
        return [n for s in ("piano", lead_stem) if s in tx for n in tx[s]]
    stems = dict.fromkeys((lead_stem, *HARMONY_STEMS, "bass"))  # ordered, a lead stem from HARMONY_STEMS once
    return [n for s in stems if s in active and s in tx for n in tx[s]]


def chord_source(source: str, tx: dict[str, list[Note]], active: set[str], lead_stem: str) -> list[Note]:
    """The notes chords are recognised from: a solo piano's whole transcription; otherwise every
    audible stem but the melody's: piano, guitar, other and bass. A hybrid's piano alone misses the
    chords the band carries (DESIGN.md §19: Waiting for Love 0.31 -> 0.995 major/minor)."""
    if source == "piano":
        return tx.get("piano", [])
    return [n for s in (*HARMONY_STEMS, "bass") if s != lead_stem and s in active and s in tx for n in tx[s]]


def sung_center(lead_stem: str) -> int | None:
    """A sung lead is placed by its median (arrange.LEAD_CENTER); an instrument's by the most notes in range."""
    from .arrange import LEAD_CENTER
    return LEAD_CENTER if lead_stem == "vocals" else None


def build_variant(source: str, parts: str, tx: dict[str, list[Note]], active: set[str],
                  lead_stem: str, grid: Grid | None = None, chord_tones=None) -> list[Note]:
    """`grid` and `chord_tones` (chords.tones_at): the `arrange` accompaniment is built on the score
    grid from the chords' tones (DESIGN.md §20)."""
    if source == "piano":
        if "piano" not in active:
            raise SystemExit("source=piano but Demucs found no audible piano stem — use --source arrange")
        return arrange_piano_only(tx["piano"], parts)
    if source == "hybrid":
        if "piano" not in active or lead_stem not in active or lead_stem == "piano":
            raise SystemExit(f"source=hybrid needs an audible piano and another audible lead stem (not '{lead_stem}')")
        harmony, bass = [], []
        if parts == "lead+full":  # the advanced score adds the band's parts the piano does not play (§39)
            harmony = [n for s in band_stems(active, lead_stem) if s != "piano" for n in tx.get(s, [])]
            bass = tx.get("bass", []) if "bass" in active else []
        notes = arrange_hybrid(tx[lead_stem], tx["piano"], parts, lead_center=sung_center(lead_stem),
                               harmony=harmony, bass=bass, grid=grid, chord_tones=chord_tones)
    else:
        band = {s: tx.get(s, []) for s in band_stems(active, lead_stem)}  # --parts lead: run() transcribes them all
        if lead_stem not in active and not band:
            raise SystemExit(f"source=arrange but the lead stem '{lead_stem}' and every band stem are silent — "
                             "pick another --lead-stem or use --source piano")
        harmony = [n for ns in band.values() for n in ns]
        bass = tx.get("bass", []) if "bass" in active else []
        lead = tx[lead_stem] if lead_stem in active else []  # no lead: the band's top line throughout (§21)
        notes = arrange_full(lead, harmony, bass, parts, grid=grid, chord_tones=chord_tones,
                             lead_center=sung_center(lead_stem), band=band)
    # only the playable score: lead+full keeps the right hand's accompaniment (§39); RH_ACCOMP is read at call time
    if arrange.RH_ACCOMP != "bars" or parts != "lead+accomp":
        return notes
    if grid is None:
        raise ValueError("build_variant: the right hand's melody bars (§35) need the score grid")
    out = melody_alone(notes, grid)  # the right hand plays the melody alone where it sounds (§35)
    rh = lambda ns: sum(n.hand == "R" and n.role != "lead" for n in ns)  # noqa: E731
    dropped = len(notes) - len(out)
    log(f"[{source}] melody alone: {rh(notes) - rh(out) - dropped} right-hand accompaniment notes to the left hand, "
        f"{dropped} dropped (no room in its reach)")
    return out


def title_lookup(args, song: str, src: Path, model, score_g, hint):
    """The song's meter and tempo by its title (DESIGN.md §54): with the model grid, unless the user gave `--meter`,
    `--bpm` or `--score`, or `--no-lookup`. -> (the hint to use: the listing's when it confirms the recording's level,
    keeping `--downbeat`; else `hint` unchanged, and what to report: None when the lookup did not run)."""
    if model is None or score_g is not None or args.no_lookup or args.meter is not None or args.bpm is not None:
        return hint, None
    from .lookup import audio_bpm, lookup_hint, video_channel
    title, channel = args.title or song, video_channel(src) if is_url(args.audio) else ""
    lk, found = lookup_hint(title, channel, lambda: audio_bpm(model), args.downbeat)
    if "error" in found:
        log(f"WARNING: no tempo lookup: {found['error']} (DESIGN.md §54); the grid comes from the audio")
    elif found["match"] is None:
        log(f"no song listing for {title!r}: the meter and tempo come from the audio (--meter / --bpm set them)")
    elif lk is None:
        log(f"HookTheory lists {found['match']} at {found['meter']}, {found['bpm']:g} beats/min: not this "
            f"recording's tempo ({found['audio_bpm']:g}), not used (--meter / --bpm set them)")
    else:
        log(f"tempo from HookTheory: {found['match']}, {lk.meter} at {lk.bpm:g} beats/min (the recording "
            f"{found['audio_bpm']:g}; DESIGN.md §54; --no-lookup turns it off)")
        return lk, found
    return hint, found


def run(args) -> dict:
    from .meter import beat_this_missing
    if args.audio_track == "none":
        args.audio_track = None
    if getattr(args, "score", None) and any(v is not None for v in (args.meter, args.bpm, args.downbeat)):
        raise SystemExit("--score sets the meter, the tempo and the bar lines: drop --meter, --bpm and --downbeat")
    if args.bpm is not None and args.meter is None:  # the beat --bpm counts depends on the meter (§48)
        raise SystemExit("--bpm needs --meter: a quarter in 2/4, 3/4, 4/4, a dotted quarter in 6/8, 9/8, 12/8")
    why = beat_this_missing(args.beat_weights) if args.beats == "beat-this" else None
    if why:  # before the download, Demucs and the transcription, not after them
        raise SystemExit(f"--beats beat-this (the default): {why}. Fix: run {Path(__file__).parent.parent / 'setup.sh'}, "
                         "or --beat-weights final0 (one model: the eight fold files are missing), or --beats notes (the note tracker alone)")
    if args.chord_model == "btc" and (args.parts == "lead+chords" or args.all_variants  # auto may route to arrange
                                      or band_chords(args.source, args.parts)
                                      or (args.source == "auto" and args.parts in BOTH_HANDS)):
        from .btc import btc_missing
        if why := btc_missing():
            raise SystemExit(f"--chord-model btc (the default): {why}. Fix: run {Path(__file__).parent.parent / 'setup.sh'}, "
                             "or use --chord-model notes (the transcribed notes alone)")
    if args.source in ("arrange", "hybrid") or args.all_variants:  # sure to need the lead: say so before Demucs
        some_check(args)
    out = Path(args.out).expanduser().resolve()
    if is_url(args.audio):
        src, song = fetch_url(args.audio, out / "downloads", args.force)
    else:
        src = Path(args.audio).expanduser().resolve()
        song = src.stem
    name = args.name or slugify(song)
    work = out / name
    if args.force and work.exists():
        shutil.rmtree(work)
    work.mkdir(parents=True, exist_ok=True)
    (work / "tx").mkdir(exist_ok=True)

    wav = ingest(src, work, args.start, args.duration)
    if args.downbeat is not None:  # past the end it would sit on the last beat: say so before separation
        import soundfile as sf
        if args.downbeat >= (length := sf.info(str(wav)).duration):
            raise SystemExit(f"--downbeat {args.downbeat:g}: the input (after --start) is {length:.1f} s long")
    stems = separate(wav, work)
    levels = stem_levels(stems)
    active = active_stems(levels)
    log("stem levels (dBFS): " + ", ".join(f"{s}={levels[s]:.1f}{'' if s in active else ' (silent)'}"
                                           for s in STEMS))

    source = route(levels, args.lead_stem) if args.source == "auto" else args.source
    if args.source == "auto":
        log(f"--source auto: {source} (others vs piano {others_below_piano_db(levels):.1f} dB)")
    variants = [(s, p) for s in SOURCES for p in PARTS] if args.all_variants else [(source, args.parts)]
    band_active = bool(band_stems(active, args.lead_stem))  # arrange's line without a lead (§21)
    need = set()
    for s, p in variants:  # a variant whose stem is silent is skipped below: don't transcribe Demucs bleed
        if s == "piano" and "piano" in active:
            need.add("piano")
        elif s == "hybrid" and "piano" in active and args.lead_stem in active and args.lead_stem != "piano":
            need |= {"piano", args.lead_stem}
            if p in ("lead+chords", "lead+full"):  # chord_source hears the band too; lead+full plays it (§39)
                need |= {x for x in (*HARMONY_STEMS, "bass") if x in active and x != args.lead_stem}
        elif s == "arrange" and (args.lead_stem in active or band_active):
            # the other stems too, even for a melody-only score: the beat grid needs the whole texture
            # (Viva la FAI's grid from the sung line alone read 108 beats a minute; the song is at 129)
            need |= ({args.lead_stem} & active) | {x for x in (*HARMONY_STEMS, "bass") if x in active}
    tx: dict[str, list[Note]] = {}
    pedal: list = []
    for s in sorted(need):
        cache = work / "tx" / f"{s}.json"
        if s == "piano":
            if piano_input(args.piano_input, levels) == "mix":
                log(f"other stems are {others_below_piano_db(levels):.1f} dB under the piano — "
                    "transcribing the original mix, not the Demucs stem")
                cache = work / "tx" / "piano-mix.json"
                tx[s] = transcribe_piano(wav, cache)
            else:
                tx[s] = transcribe_piano(stems[s], cache)
            pedal = pedal_from_midi(cache.with_suffix(".mid"))  # the model writes its MIDI next to the cache
        elif s == args.lead_stem and lead_f0(args.lead_f0, s) == "some":
            if not (work / "tx" / f"{s}-some.json").exists():
                some_check(args)  # --source auto: known to need SOME only once routed
            tx[s] = transcribe_some(stems[s], work / "tx" / f"{s}-some.json")
        elif s == args.lead_stem and lead_f0(args.lead_f0, s) == "pyin":
            tx[s] = transcribe_f0(stems[s], work / "tx" / f"{s}-f0.json")
        else:
            tx[s] = transcribe_general(stems[s], cache, melodic=(s == args.lead_stem))

    import soundfile as sf
    duration = sf.info(str(wav)).duration

    from .meter import Hint, beat_this, level_from_hint, score_grid
    given = {k: v for k, v in {"meter": args.meter, "bpm": args.bpm, "downbeat": args.downbeat}.items() if v is not None}
    hint = Hint(**given) if given else None
    if hint:
        log(f"score grid hint: meter {hint.meter or '-'}, {hint.bpm or '-'} beats/min, a bar line at "
            f"{'-' if hint.downbeat is None else f'{hint.downbeat:g} s'} (DESIGN.md §48, §49)")
        if hint.bpm and args.beats == "notes":
            log("WARNING: --bpm is not used with --beats notes (the note tracker keeps its own level); --meter is")
    from .notation import ROLE_PENALTY, build_score, engrave_pdf, key_plan, lead_in, piece_key, write_musicxml
    from .render import Renderer, synthesize

    score_g, score_info = None, None
    if getattr(args, "score", None):  # one grid for every source: the score is placed on the recording's time
        from .scorefile import ScoreMismatch, score_file_grid
        heard = [n for s in active if s != "drums" for n in tx.get(s, [])]
        try:
            score_g, score_info = score_file_grid(heard, args.score)
            score_info["file"] = str(args.score)
            log(f"score {args.score.name}: {score_info['written_meter']} written {score_g.meter}, "
                f"{score_info['matched']:.0%} of the note onsets matched (DESIGN.md §52)")
        except ScoreMismatch as e:  # the audio's grid, said loudly: the user expects the score's bars
            score_info = {"file": str(args.score), "error": str(e)}
            log(f"WARNING: --score {args.score.name} not used: {e}. The grid comes from the audio")
    model, beats_from = None, "notes"
    if score_g is not None:  # the score's beats: the audio's tracker is not needed
        beats_from = "score"
    elif args.beats == "beat-this":  # the trained tracker hears the whole recording (DESIGN.md §12)
        log("tracking beats and downbeats with Beat This!…")
        model = beat_this(wav, args.beat_weights, cache=work / f"beats-{args.beat_weights}.npz")
        beats_from = f"beat-this {args.beat_weights}"
    hint, found = title_lookup(args, song, src, model, score_g, hint)
    report = {"input": args.audio if is_url(args.audio) else str(src), "work_dir": str(work), "bpm": None,
              "duration_s": round(duration, 2), "stem_db": {k: round(v, 1) for k, v in levels.items()},
              "piano_input": piano_input(args.piano_input, levels) if "piano" in need else None,
              "lead_f0": lead_f0(args.lead_f0, args.lead_stem) if args.lead_stem in need else None,
              "beats": beats_from, "lead_stem": args.lead_stem, "route": route(levels, args.lead_stem),
              "hint": given or None, "lookup": found, "grids": {}, "variants": {}}
    if score_info is not None:
        report["score"] = score_info
    grids, key_plans, chord_plans, chord_audio = {}, {}, {}, None
    if any(p == "lead+chords" or band_chords(s, p) for s, p in variants):
        report["chord_model"] = args.chord_model
    for source, parts in variants:
        tag = f"{source}_{parts.replace('+', '-')}"
        if source in ("piano", "hybrid") and "piano" not in active:
            log(f"skip {tag}: no audible piano stem")
            continue
        if source == "hybrid" and (args.lead_stem not in active or args.lead_stem == "piano"):
            log(f"skip {tag}: lead stem '{args.lead_stem}' is silent or is the piano")
            continue
        if source == "arrange" and args.lead_stem not in active and not band_active:
            log(f"skip {tag}: lead stem '{args.lead_stem}' and the band are silent (try --lead-stem or --source piano)")
            continue
        if source not in grids:
            src_notes = source_notes(source, tx, active, args.lead_stem)
            grids[source] = grid = score_g if score_g is not None else score_grid(src_notes, wav, model=model, hint=hint)
            # keys from everything the source plays: a melody line alone is too thin to judge
            # (Starlight's right-hand line read 4 -> 5 -> 4 sharps; the full texture stays in E)
            key_plans[source] = key_plan(src_notes, grid, piece_key(src_notes)) if src_notes else [(0.0, 0)]
            report["grids"][source] = grid.to_json()
            report["bpm"] = report["bpm"] or round(grid.bpm, 1)
            log(f"[{source}] meter {grid.meter}, ≈ {grid.bpm:.0f} beats/min, "
                f"{int(np.ceil(grid.sec_to_q(duration) / grid.bar_q))} bars in {duration:.1f}s, "
                f"key signature(s) {[s for _, s in key_plans[source]]}")
        grid, keys = grids[source], key_plans[source]
        band = band_chords(source, parts)
        if (parts == "lead+chords" or band) and source not in chord_plans:
            from .chords import BASIC, FULL, recognize
            if args.chord_model == "btc" and chord_audio is None:  # once a song: it hears the recording
                from .btc import chord_probs
                log("recognising chords with BTC…")
                chord_audio = chord_probs(wav, cache=work / "chords-btc.npz")
            chord_plans[source] = recognize(chord_source(source, tx, active, args.lead_stem), grid,
                                            FULL if args.chord_vocab == "full" else BASIC,
                                            audio=chord_audio if args.chord_model == "btc" else None)
        tones = None
        if band:
            from .chords import tones_at
            tones = tones_at(chord_plans[source], grid)
        notes = build_variant(source, "lead" if parts == "lead+chords" else parts, tx, active, args.lead_stem,
                              grid=grid, chord_tones=tones)
        chords = None
        if parts == "lead+chords":  # lead sheet: the melody, chord symbols, LH block chords (DESIGN.md §9)
            from .arrange import sort_notes
            from .chords import block_chords
            chords = chord_plans[source]
            notes = sort_notes(notes + block_chords(chords, grid))
            log(f"[{tag}] {sum(c.root is not None for c in chords)} chords: "
                + " ".join(c.harte for c in chords[:16]) + (" …" if len(chords) > 16 else ""))
        log(f"[{tag}] {len(notes)} notes (RH {sum(n.hand == 'R' for n in notes)}, "
            f"LH {sum(n.hand == 'L' for n in notes)})")
        known = level_from_hint(grid, hint)  # the grid is at the user's tempo: SUNG_SNAP writes the sung lead (§53)
        shift = lead_in(notes, grid, role_penalty=ROLE_PENALTY.get(source), level_known=known)
        midi = work / f"{tag}.mid"
        write_midi(notes, grid, midi, pedal if source in ("piano", "hybrid") and not chords else None, keys)

        title = f"{args.title or song} — {source} / {parts}"
        score = build_score(notes, grid, title, keys=keys, chords=chords, role_penalty=ROLE_PENALTY.get(source),
                            level_known=known)
        xml = write_musicxml(score, work / f"{tag}.musicxml")
        pages = None if args.no_pdf else engrave_pdf(xml, work / f"{tag}.pdf")

        audio_path = None
        if args.audio_track in ("synth", "mix"):
            synth = synthesize(notes, duration)
            if args.audio_track == "mix":
                orig, _ = sf.read(str(wav), dtype="float32")
                synth = 0.6 * synth + 0.4 * orig.mean(axis=1)[: len(synth)]
            audio_path = work / f"{tag}.audio.wav"
            sf.write(str(audio_path), synth, 44100)
        elif args.audio_track == "original":
            audio_path = wav
        video = work / f"{tag}.mp4"
        if not args.no_video:
            log(f"[{tag}] rendering video…")
            w, h = (int(x) for x in args.size.split("x"))
            Renderer(notes, w, h, args.fps, title=title, grid=grid, lead_in=shift, keys=keys,
                     note_names=args.note_names).render(video, duration, audio_path)
        report["variants"][tag] = {
            "notes": len(notes), "meter": grid.meter, "key_signatures": [s for _, s in keys],
            "score_offset_q": shift,  # score position = grid position - this
            "chords": [[round(c.start_q, 3), c.harte] for c in chords] if chords else None,
            "midi": str(midi), "musicxml": str(xml),
            "pdf": None if args.no_pdf else str(work / f"{tag}.pdf"), "pdf_pages": pages,
            "video": None if args.no_video else str(video),
        }
    (work / "report.json").write_text(json.dumps(report, indent=2))
    return report


def _hint_bpm(s: str) -> float:
    """--bpm at parse time, so a bad value stops the run before separation and transcription."""
    v = float(s)
    if not 10.0 <= v <= 400.0:
        raise argparse.ArgumentTypeError(f"{s}: beats a minute, 10-400")
    return v


def _hint_downbeat(s: str) -> float:
    """--downbeat at parse time (seconds, 0 or more)."""
    v = float(s)
    if not v >= 0.0:
        raise argparse.ArgumentTypeError(f"{s}: seconds from the start of the input, 0 or more")
    return v


def _score_file(s: str) -> Path:
    """--score at parse time: a MIDI or MusicXML file that exists."""
    from .scorefile import SUFFIXES
    p = Path(s).expanduser().resolve()
    if p.suffix.lower() not in SUFFIXES or not p.is_file():
        raise argparse.ArgumentTypeError(f"{s}: a score file ({', '.join(SUFFIXES)}) that exists")
    return p


def build_parser() -> argparse.ArgumentParser:
    ap = argparse.ArgumentParser(prog="piano2video", description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("audio", help="any ffmpeg-readable audio/video file, or an http(s) video URL (yt-dlp)")
    ap.add_argument("--out", default=str(Path.home() / ".kaya/piano2video/out"))
    ap.add_argument("--name", help="work-dir name (default: slug of the file name or video title)")
    ap.add_argument("--title", help="title shown in the video and on the score, and looked up for the meter and "
                                    "tempo (\"Artist - Song\"; default: the video title or file name; DESIGN.md §54)")
    ap.add_argument("--source", choices=("auto", *SOURCES), default="auto",
                    help="auto (default) = choose from the stem levels (route: solo piano -> piano, piano-led "
                         "with vocals -> hybrid, else arrange); piano = transcribe only the song's piano part; "
                         "arrange = re-voice lead/harmony/bass stems for piano; hybrid = the sung melody over "
                         "the song's own piano part. DESIGN.md §4, §14")
    ap.add_argument("--parts", choices=PARTS, default="lead+accomp",
                    help="lead = melody only (RH); lead+accomp = both hands, playable (PROVISIONAL default); lead+full = both hands, "
                         "advanced: the fuller accompaniment the playable score thins (DESIGN.md §39); lead+chords = "
                         "lead sheet (melody, chord symbols, LH block chords)")
    ap.add_argument("--chord-vocab", choices=("basic", "full"), default="basic",
                    help="lead+chords and arrange's accompaniment: basic = major, minor, dominant 7th; "
                         "full adds maj7, m7, dim, sus4")
    ap.add_argument("--chord-model", choices=("btc", "notes"), default="btc",
                    help="lead+chords and arrange's accompaniment: btc (default) = the trained chord model on the "
                         "recording, with the transcribed notes for sevenths and slash basses; notes = the transcribed "
                         "notes alone (DESIGN.md §19, §20)")
    ap.add_argument("--all-variants", action="store_true",
                    help="render every source x parts combination (for comparing / deciding)")
    ap.add_argument("--lead-stem", choices=STEMS, default="vocals",
                    help="stem that carries the melody in --source arrange (default vocals)")
    ap.add_argument("--lead-f0", choices=("auto", "some", "pyin", "basicpitch"), default="auto",
                    help="how the lead stem becomes notes in --source arrange/hybrid: some = the SOME singing-note "
                         "model, pyin = monophonic f0 contour, basicpitch = Basic Pitch + skyline "
                         "(auto: some for vocals, else basicpitch)")
    ap.add_argument("--piano-input", choices=("auto", "mix", "stem"), default="auto",
                    help="what the piano model hears: the original mix or the Demucs piano stem "
                         "(auto: the mix when the recording is solo piano)")
    ap.add_argument("--beats", choices=("notes", "beat-this"), default="beat-this",
                    help="score grid: beat-this (default) = the trained beat/downbeat tracker on the recording, "
                         "its beats steadied by a DBN (the note tracker only where it finds too few beats, §46); "
                         "notes = from the transcribed notes alone (DESIGN.md §12)")
    from .meter import BEAT_THIS_SHA256
    ap.add_argument("--beat-weights", default="ensemble", choices=["ensemble", *sorted(BEAT_THIS_SHA256)],
                    help="Beat This! weights: ensemble (default) = the mean of final0 and its 8 fold models "
                         "(DESIGN.md §43); final0 alone; fold0-fold7 are its cross-validation models. 8 of the 9 heard the "
                         "ASAP pieces of corpus.BT_HELDOUT: score those with their held-out fold, not the default")
    from .meter import METERS
    ap.add_argument("--meter", choices=list(METERS.values()),
                    help="the song's written meter, if you know it (a printed score, a song listing): sets the bar "
                         "length and simple or compound time. The audio cannot tell 2/4 from 4/4 (DESIGN.md §36, §48)")
    ap.add_argument("--bpm", type=_hint_bpm,
                    help="the song's written tempo in beats a minute, the beat as --meter counts it (a quarter in "
                         "2/4, 3/4, 4/4; a dotted quarter in 6/8, 9/8, 12/8): sets the note values, so eighths are "
                         "not written as quarters or 16ths (DESIGN.md §48)")
    ap.add_argument("--downbeat", type=_hint_downbeat,
                    help="the time in seconds of one bar line (beat 1 of a bar), from the start of the input after "
                         "--start, best where the beat is steady (a verse or chorus, not a free intro): the run of "
                         "regular bars around it moves so that a bar line falls on the beat nearest it; bars past a "
                         "beat slip keep their phase. The audio often puts the bars half a bar off (DESIGN.md §49)")
    ap.add_argument("--score", type=_score_file,
                    help="the piece's score, if you have it (MIDI or MusicXML; a PDF through OMR): aligned to the "
                         "transcribed notes, it sets the meter, the tempo and every beat and bar line, through the "
                         "player's rubato (DESIGN.md §52). The notes and the video stay the recording's. Replaces "
                         "--meter, --bpm and --downbeat")
    ap.add_argument("--no-lookup", action="store_true",
                    help="do not look the song up by its title (or --title) in the local HookTheory index for its "
                         "meter and tempo; without --meter / --bpm / --score the lookup sets them when it finds the "
                         "artist and the song and the recording's beat tempo agrees (DESIGN.md §54)")
    ap.add_argument("--audio-track", choices=("synth", "original", "mix", "none"), default="synth",
                    help="video soundtrack: synth = the transcription itself (default)")
    ap.add_argument("--start", type=float, help="trim: start offset (s)")
    ap.add_argument("--duration", type=float, help="trim: length (s)")
    ap.add_argument("--fps", type=int, default=30)
    ap.add_argument("--size", default="1280x720")
    ap.add_argument("--no-video", action="store_true")
    ap.add_argument("--no-pdf", action="store_true", help="skip the engraved PDF (MusicXML only)")
    ap.add_argument("--note-names", action="store_true", help="letter names (spelled for the key) on falling notes")
    ap.add_argument("--force", action="store_true", help="discard cached stages for this song")
    return ap


def main(argv=None):
    args = build_parser().parse_args(argv)
    report = run(args)
    # the grid knots stay in report.json; the terminal gets meter and tempo
    shown = {**report, "grids": {s: {k: g[k] for k in ("meter", "bpm")} for s, g in report["grids"].items()}}
    print(json.dumps(shown, indent=2))


if __name__ == "__main__":
    main()
