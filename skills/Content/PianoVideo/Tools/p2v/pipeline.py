"""piano2video — song/audio -> stems -> MIDI -> sheet music -> Synthesia-style video.

Stages (each cached in the work dir; --force re-runs):
  1. ingest      ffmpeg -> 44.1 kHz stereo wav (optional --start/--duration trim)
  2. separate    Demucs htdemucs_6s -> vocals/drums/bass/guitar/piano/other
  3. transcribe  piano stem -> ByteDance high-res piano model; other stems -> Basic Pitch
  4. arrange     --source piano|arrange x --parts lead|lead+accomp|lead+chords  (DESIGN.md §4)
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

from .arrange import Note, arrange_full, arrange_piano_only
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

SOURCES = ("piano", "arrange")
PARTS = ("lead", "lead+accomp", "lead+chords")


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


def lead_f0(choice: str, lead_stem: str) -> str:
    """'pyin' or 'basicpitch'. auto: pYIN for a vocal lead (measured on singing only), else Basic Pitch."""
    return choice if choice != "auto" else ("pyin" if lead_stem == "vocals" else "basicpitch")


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
    stems = dict.fromkeys((lead_stem, *HARMONY_STEMS, "bass"))  # ordered, a lead stem from HARMONY_STEMS once
    return [n for s in stems if s in active and s in tx for n in tx[s]]


def chord_source(source: str, tx: dict[str, list[Note]], active: set[str], lead_stem: str) -> list[Note]:
    """The notes chords are recognised from: the whole piano transcription, or the arrangement's
    harmony and bass stems (not the melody)."""
    if source == "piano":
        return tx.get("piano", [])
    return [n for s in (*HARMONY_STEMS, "bass") if s != lead_stem and s in active and s in tx for n in tx[s]]


def build_variant(source: str, parts: str, tx: dict[str, list[Note]], active: set[str],
                  lead_stem: str) -> list[Note]:
    if source == "piano":
        if "piano" not in active:
            raise SystemExit("source=piano but Demucs found no audible piano stem — use --source arrange")
        return arrange_piano_only(tx["piano"], parts)
    if lead_stem not in active:
        raise SystemExit(f"source=arrange but the lead stem '{lead_stem}' is silent — "
                         "pick another --lead-stem or use --source piano")
    harmony = [n for s in HARMONY_STEMS if s in active and s != lead_stem for n in tx.get(s, [])]  # --parts lead: untranscribed
    bass = tx.get("bass", []) if "bass" in active else []
    return arrange_full(tx[lead_stem], harmony, bass, parts)


def run(args) -> dict:
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
    stems = separate(wav, work)
    levels = stem_levels(stems)
    active = active_stems(levels)
    log("stem levels (dBFS): " + ", ".join(f"{s}={levels[s]:.1f}{'' if s in active else ' (silent)'}"
                                           for s in STEMS))

    variants = [(s, p) for s in SOURCES for p in PARTS] if args.all_variants else [(args.source, args.parts)]
    need = set()
    for s, p in variants:  # a variant whose stem is silent is skipped below: don't transcribe Demucs bleed
        if s == "piano" and "piano" in active:
            need.add("piano")
        elif s == "arrange" and args.lead_stem in active:
            # the other stems too, even for a melody-only score: the beat grid needs the whole texture
            # (Viva la FAI's grid from the sung line alone read 108 beats a minute; the song is at 129)
            need |= {args.lead_stem} | {x for x in (*HARMONY_STEMS, "bass") if x in active}
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
        elif s == args.lead_stem and lead_f0(args.lead_f0, s) == "pyin":
            tx[s] = transcribe_f0(stems[s], work / "tx" / f"{s}-f0.json")
        else:
            tx[s] = transcribe_general(stems[s], cache, melodic=(s == args.lead_stem))

    import soundfile as sf
    duration = sf.info(str(wav)).duration

    from .meter import score_grid
    from .notation import build_score, detect_key, engrave_pdf, key_plan, lead_in, write_musicxml
    from .render import Renderer, synthesize

    report = {"input": args.audio if is_url(args.audio) else str(src), "work_dir": str(work), "bpm": None,
              "duration_s": round(duration, 2), "stem_db": {k: round(v, 1) for k, v in levels.items()},
              "piano_input": piano_input(args.piano_input, levels) if "piano" in need else None,
              "lead_f0": lead_f0(args.lead_f0, args.lead_stem) if args.lead_stem in need else None,
              "grids": {}, "variants": {}}
    grids, key_plans = {}, {}
    for source, parts in variants:
        tag = f"{source}_{parts.replace('+', '-')}"
        if source == "piano" and "piano" not in active:
            log(f"skip {tag}: no audible piano stem")
            continue
        if source == "arrange" and args.lead_stem not in active:
            log(f"skip {tag}: lead stem '{args.lead_stem}' is silent (try --lead-stem or --source piano)")
            continue
        if source not in grids:
            src_notes = source_notes(source, tx, active, args.lead_stem)
            grids[source] = grid = score_grid(src_notes, wav)
            # keys from everything the source plays: a melody line alone is too thin to judge
            # (Starlight's right-hand line read 4 -> 5 -> 4 sharps; the full texture stays in E)
            key_plans[source] = key_plan(src_notes, grid, detect_key(src_notes).sharps) if src_notes else [(0.0, 0)]
            report["grids"][source] = grid.to_json()
            report["bpm"] = report["bpm"] or round(grid.bpm, 1)
            log(f"[{source}] meter {grid.meter}, ≈ {grid.bpm:.0f} beats/min, "
                f"{int(np.ceil(grid.sec_to_q(duration) / grid.bar_q))} bars in {duration:.1f}s, "
                f"key signature(s) {[s for _, s in key_plans[source]]}")
        grid, keys = grids[source], key_plans[source]
        notes = build_variant(source, "lead" if parts == "lead+chords" else parts, tx, active, args.lead_stem)
        chords = None
        if parts == "lead+chords":  # lead sheet: the melody, chord symbols, LH block chords (DESIGN.md §9)
            from .arrange import sort_notes
            from .chords import BASIC, FULL, block_chords, recognize
            chords = recognize(chord_source(source, tx, active, args.lead_stem), grid,
                               FULL if args.chord_vocab == "full" else BASIC)
            notes = sort_notes(notes + block_chords(chords, grid))
            log(f"[{tag}] {sum(c.root is not None for c in chords)} chords: "
                + " ".join(c.harte for c in chords[:16]) + (" …" if len(chords) > 16 else ""))
        log(f"[{tag}] {len(notes)} notes (RH {sum(n.hand == 'R' for n in notes)}, "
            f"LH {sum(n.hand == 'L' for n in notes)})")
        shift = lead_in(notes, grid)
        midi = work / f"{tag}.mid"
        write_midi(notes, grid, midi, pedal if source == "piano" and not chords else None, keys)

        title = f"{args.title or song} — {source} / {parts}"
        score = build_score(notes, grid, title, keys=keys, chords=chords)
        xml = write_musicxml(score, work / f"{tag}.musicxml")
        pages = engrave_pdf(xml, work / f"{tag}.pdf")

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
            "pdf": str(work / f"{tag}.pdf"), "pdf_pages": pages,
            "video": None if args.no_video else str(video),
        }
    (work / "report.json").write_text(json.dumps(report, indent=2))
    return report


def main(argv=None):
    ap = argparse.ArgumentParser(prog="piano2video", description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("audio", help="any ffmpeg-readable audio/video file, or an http(s) video URL (yt-dlp)")
    ap.add_argument("--out", default=str(Path.home() / ".kaya/piano2video/out"))
    ap.add_argument("--name", help="work-dir name (default: slug of the file name or video title)")
    ap.add_argument("--title", help="title shown in the video and on the score")
    ap.add_argument("--source", choices=SOURCES, default="arrange",
                    help="piano = transcribe only the song's piano part; arrange = re-voice "
                         "lead/harmony/bass stems for piano. PROVISIONAL default — DESIGN.md §4")
    ap.add_argument("--parts", choices=PARTS, default="lead+accomp",
                    help="lead = melody only (RH); lead+accomp = both hands; lead+chords = lead sheet "
                         "(melody, chord symbols, LH block chords). PROVISIONAL default")
    ap.add_argument("--chord-vocab", choices=("basic", "full"), default="basic",
                    help="lead+chords: basic = major, minor, dominant 7th; full adds maj7, m7, dim, sus4")
    ap.add_argument("--all-variants", action="store_true",
                    help="render every source x parts combination (for comparing / deciding)")
    ap.add_argument("--lead-stem", choices=STEMS, default="vocals",
                    help="stem that carries the melody in --source arrange (default vocals)")
    ap.add_argument("--lead-f0", choices=("auto", "pyin", "basicpitch"), default="auto",
                    help="how the lead stem becomes notes in --source arrange: pyin = monophonic f0 "
                         "contour, basicpitch = Basic Pitch + skyline (auto: pyin for vocals)")
    ap.add_argument("--piano-input", choices=("auto", "mix", "stem"), default="auto",
                    help="what the piano model hears: the original mix or the Demucs piano stem "
                         "(auto: the mix when the recording is solo piano)")
    ap.add_argument("--audio-track", choices=("synth", "original", "mix", "none"), default="synth",
                    help="video soundtrack: synth = the transcription itself (default)")
    ap.add_argument("--start", type=float, help="trim: start offset (s)")
    ap.add_argument("--duration", type=float, help="trim: length (s)")
    ap.add_argument("--fps", type=int, default=30)
    ap.add_argument("--size", default="1280x720")
    ap.add_argument("--no-video", action="store_true")
    ap.add_argument("--note-names", action="store_true", help="letter names (spelled for the key) on falling notes")
    ap.add_argument("--force", action="store_true", help="discard cached stages for this song")
    args = ap.parse_args(argv)
    if args.audio_track == "none":
        args.audio_track = None
    report = run(args)
    # the grid knots stay in report.json; the terminal gets meter and tempo
    shown = {**report, "grids": {s: {k: g[k] for k in ("meter", "bpm")} for s, g in report["grids"].items()}}
    print(json.dumps(shown, indent=2))


if __name__ == "__main__":
    main()
