"""piano2video — song/audio -> stems -> MIDI -> sheet music -> Synthesia-style video.

Stages (each cached in the work dir; --force re-runs):
  1. ingest      ffmpeg -> 44.1 kHz stereo wav (optional --start/--duration trim)
  2. separate    Demucs htdemucs_6s -> vocals/drums/bass/guitar/piano/other
  3. transcribe  piano stem -> ByteDance high-res piano model; other stems -> Basic Pitch
  4. arrange     --source piano|arrange x --parts lead|lead+accomp  (DESIGN.md §4)
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

STEMS = ("vocals", "drums", "bass", "guitar", "piano", "other")
HARMONY_STEMS = ("piano", "guitar", "other")
SILENT_DB = -30.0  # stems quieter than loudest-stem RMS minus this are ignored
MODEL_DIR = Path(os.environ.get("P2V_MODEL_DIR", Path.home() / ".kaya/piano2video/models"))
PIANO_CKPT = MODEL_DIR / "note_F1=0.9677_pedal_F1=0.9186.pth"
PIANO_CKPT_URL = "https://zenodo.org/record/4034264/files/CRNN_note_F1%3D0.9677_pedal_F1%3D0.9186.pth?download=1"

SOURCES = ("piano", "arrange")
PARTS = ("lead", "lead+accomp")


def log(msg: str):
    print(f"[p2v {time.strftime('%H:%M:%S')}] {msg}", file=sys.stderr, flush=True)


def slugify(s: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", s.lower()).strip("-") or "song"


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


def detect_beats(wav: Path) -> tuple[float, np.ndarray]:
    import librosa
    y, sr = librosa.load(str(wav), sr=22050, mono=True)
    tempo, beats = librosa.beat.beat_track(y=y, sr=sr, units="time")
    bpm = float(np.atleast_1d(tempo)[0])
    # a 200+ bpm read on a ballad is almost always double-time; halve into a readable range
    while bpm > 160 and len(beats) > 4:
        bpm /= 2
        beats = beats[::2]
    return bpm, np.asarray(beats)


# ---------------------------------------------------------------- outputs -- #

def write_midi(notes: list[Note], bpm: float, path: Path):
    import pretty_midi
    pm = pretty_midi.PrettyMIDI(initial_tempo=bpm)
    for hand, name in (("R", "Piano RH"), ("L", "Piano LH")):
        inst = pretty_midi.Instrument(program=0, name=name)
        inst.notes = [pretty_midi.Note(velocity=n.velocity, pitch=n.pitch, start=n.start, end=n.end)
                      for n in notes if n.hand == hand]
        pm.instruments.append(inst)
    pm.write(str(path))


def build_variant(source: str, parts: str, tx: dict[str, list[Note]], active: set[str],
                  lead_stem: str) -> list[Note]:
    if source == "piano":
        if "piano" not in active:
            raise SystemExit("source=piano but Demucs found no audible piano stem — use --source arrange")
        return arrange_piano_only(tx["piano"], parts)
    harmony = [n for s in HARMONY_STEMS if s in active and s != lead_stem for n in tx[s]]
    bass = tx["bass"] if "bass" in active else []
    return arrange_full(tx[lead_stem], harmony, bass, parts)


def run(args) -> dict:
    src = Path(args.audio).expanduser().resolve()
    name = args.name or slugify(src.stem)
    work = Path(args.out).expanduser().resolve() / name
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
    for s, p in variants:
        if s == "piano":
            need.add("piano")
        else:
            need.add(args.lead_stem)
            if p != "lead":
                need |= {x for x in (*HARMONY_STEMS, "bass") if x in active}
    tx: dict[str, list[Note]] = {}
    for s in sorted(need):
        cache = work / "tx" / f"{s}.json"
        tx[s] = (transcribe_piano(stems[s], cache) if s == "piano"
                 else transcribe_general(stems[s], cache, melodic=(s == args.lead_stem)))

    bpm, beats = detect_beats(wav)
    import soundfile as sf
    duration = sf.info(str(wav)).duration
    log(f"tempo ≈ {bpm:.0f} bpm, {len(beats)} beats, {duration:.1f}s")

    from .notation import build_score, engrave_pdf, write_musicxml
    from .render import Renderer, synthesize

    report = {"input": str(src), "work_dir": str(work), "bpm": round(bpm, 1),
              "duration_s": round(duration, 2), "stem_db": {k: round(v, 1) for k, v in levels.items()},
              "variants": {}}
    for source, parts in variants:
        tag = f"{source}_{parts.replace('+', '-')}"
        if source == "piano" and "piano" not in active:
            log(f"skip {tag}: no audible piano stem")
            continue
        notes = build_variant(source, parts, tx, active, args.lead_stem)
        log(f"[{tag}] {len(notes)} notes (RH {sum(n.hand == 'R' for n in notes)}, "
            f"LH {sum(n.hand == 'L' for n in notes)})")
        midi = work / f"{tag}.mid"
        write_midi(notes, bpm, midi)

        title = f"{args.title or src.stem} — {source} / {parts}"
        score = build_score(notes, beats, bpm, title)
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
            Renderer(notes, w, h, args.fps, title=title).render(video, duration, audio_path)
        report["variants"][tag] = {
            "notes": len(notes), "midi": str(midi), "musicxml": str(xml),
            "pdf": str(work / f"{tag}.pdf"), "pdf_pages": pages,
            "video": None if args.no_video else str(video),
        }
    (work / "report.json").write_text(json.dumps(report, indent=2))
    return report


def main(argv=None):
    ap = argparse.ArgumentParser(prog="piano2video", description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("audio", help="any ffmpeg-readable audio/video file")
    ap.add_argument("--out", default=str(Path.home() / ".kaya/piano2video/out"))
    ap.add_argument("--name", help="work-dir name (default: slug of the file name)")
    ap.add_argument("--title", help="title shown in the video and on the score")
    ap.add_argument("--source", choices=SOURCES, default="arrange",
                    help="piano = transcribe only the song's piano part; arrange = re-voice "
                         "lead/harmony/bass stems for piano. PROVISIONAL default — DESIGN.md §4")
    ap.add_argument("--parts", choices=PARTS, default="lead+accomp",
                    help="lead = melody only (RH); lead+accomp = both hands. PROVISIONAL default")
    ap.add_argument("--all-variants", action="store_true",
                    help="render all 4 source x parts combinations (for comparing / deciding)")
    ap.add_argument("--lead-stem", choices=STEMS, default="vocals",
                    help="stem that carries the melody in --source arrange (default vocals)")
    ap.add_argument("--audio-track", choices=("synth", "original", "mix", "none"), default="synth",
                    help="video soundtrack: synth = the transcription itself (default)")
    ap.add_argument("--start", type=float, help="trim: start offset (s)")
    ap.add_argument("--duration", type=float, help="trim: length (s)")
    ap.add_argument("--fps", type=int, default=30)
    ap.add_argument("--size", default="1280x720")
    ap.add_argument("--no-video", action="store_true")
    ap.add_argument("--force", action="store_true", help="discard cached stages for this song")
    args = ap.parse_args(argv)
    if args.audio_track == "none":
        args.audio_track = None
    report = run(args)
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
