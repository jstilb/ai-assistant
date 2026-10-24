"""Sheet music: beat-quantize the arrangement, build a grand staff, export
MusicXML (editable in MuseScore/Sibelius/Dorico) and engrave a PDF via Verovio."""

from __future__ import annotations

import io
from dataclasses import dataclass
from pathlib import Path

import numpy as np

from .arrange import Note, beats_to_seconds_fn


@dataclass(frozen=True)
class QEvent:
    """A quantized chord (or single note) on one staff. Units: quarter notes."""
    offset: float
    dur: float
    pitches: tuple[int, ...]


def quantize_hand(notes: list[Note], sec_to_beat, grid: int = 4) -> list[QEvent]:
    """Snap onsets/durations to a 1/grid-beat grid and turn the hand into a
    sequence of non-overlapping chords (a held note is cut at the next onset —
    readable notation beats perfect sustain fidelity for a learning score)."""
    if not notes:
        return []
    q = 1.0 / grid
    starts = np.round(sec_to_beat([n.start for n in notes]) / q) * q
    ends = np.round(sec_to_beat([n.end for n in notes]) / q) * q
    groups: dict[float, list[tuple[int, float]]] = {}
    for n, s, e in zip(notes, starts, ends):
        s = max(float(s), 0.0)
        groups.setdefault(s, []).append((n.pitch, max(float(e) - s, q)))
    onsets = sorted(groups)
    events = []
    for i, s in enumerate(onsets):
        pitches = tuple(sorted({p for p, _ in groups[s]}))
        dur = max(d for _, d in groups[s])
        if i + 1 < len(onsets):
            dur = min(dur, onsets[i + 1] - s)
        events.append(QEvent(offset=s, dur=dur, pitches=pitches))
    return events


def spell(midi: int, sharps: int):
    """Pitch spelled for the key: no explicit naturals, flats in flat keys."""
    from music21 import pitch
    p = pitch.Pitch(midi=midi)
    if p.accidental is not None and p.accidental.name == "natural":
        p.accidental = None
    if p.accidental is not None and p.accidental.name == "sharp" and sharps < 0:
        p = p.getEnharmonic()
    return p


def detect_key(notes: list[Note]):
    from music21 import note, stream
    s = stream.Stream()
    for n in notes:
        s.append(note.Note(n.pitch, quarterLength=max(0.25, min(n.dur * 2, 4.0))))
    return s.analyze("key")


def build_score(notes: list[Note], beat_times: np.ndarray, bpm: float, title: str, grid: int = 4):
    from music21 import chord, clef, key, layout, meter, metadata, note, stream, tempo

    sec_to_beat, _ = beats_to_seconds_fn(beat_times)
    # put the first note on beat 0 so the score doesn't open with bars of rest
    if notes:
        first = float(np.floor(sec_to_beat(min(n.start for n in notes))))
        shift = lambda t: sec_to_beat(t) - first  # noqa: E731
    else:
        shift = sec_to_beat

    k = detect_key(notes) if notes else key.Key("C")
    score = stream.Score()
    score.insert(0, metadata.Metadata(title=title, composer="transcribed by Kaya piano2video"))
    parts = []
    for hand, cl in (("R", clef.TrebleClef()), ("L", clef.BassClef())):
        p = stream.PartStaff()
        p.partName = "Piano RH" if hand == "R" else "Piano LH"
        p.insert(0, cl)
        p.insert(0, key.KeySignature(k.sharps))
        p.insert(0, meter.TimeSignature("4/4"))
        if hand == "R":
            # text-only mark: the note glyph in "q = 120" needs a SMuFL text font cairosvg lacks
            mm = tempo.MetronomeMark(text=f"≈ {round(bpm)} bpm", number=round(bpm))
            mm.numberImplicit = True
            p.insert(0, mm)
        for ev in quantize_hand([n for n in notes if n.hand == hand], shift, grid):
            ps = [spell(m, k.sharps) for m in ev.pitches]
            el = note.Note(ps[0]) if len(ps) == 1 else chord.Chord(ps)
            el.quarterLength = ev.dur
            p.insert(ev.offset, el)
        parts.append(p)
    for p in parts:
        score.insert(0, p)
    score.insert(0, layout.StaffGroup(parts, name="Piano", symbol="brace"))
    return score


def write_musicxml(score, path: Path) -> Path:
    # makeNotation: measures, rests, ties across barlines, beaming
    score.write("musicxml", fp=str(path), makeNotation=True)
    return path


def engrave_pdf(musicxml: Path, pdf: Path) -> int:
    """Render MusicXML -> multi-page PDF with Verovio (SVG) + cairosvg. Returns page count."""
    import cairosvg
    import verovio
    from pypdf import PdfWriter

    tk = verovio.toolkit()
    tk.setOptions({
        "pageWidth": 2100, "pageHeight": 2970,  # A4 at 10x
        "scale": 45, "adjustPageHeight": False,
        "breaks": "auto", "footer": "none",
    })
    if not tk.loadFile(str(musicxml)):
        raise RuntimeError(f"verovio could not load {musicxml}")
    writer = PdfWriter()
    n = tk.getPageCount()
    for i in range(1, n + 1):
        buf = io.BytesIO()
        cairosvg.svg2pdf(bytestring=tk.renderToSVG(i).encode(), write_to=buf)
        buf.seek(0)
        writer.append(buf)
    with open(pdf, "wb") as f:
        writer.write(f)
    return n
