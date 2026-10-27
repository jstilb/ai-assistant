"""Sheet music: beat-quantize the arrangement, build a grand staff, export
MusicXML (editable in MuseScore/Sibelius/Dorico) and engrave a PDF via Verovio."""

from __future__ import annotations

import io
import re
from dataclasses import dataclass
from pathlib import Path

import numpy as np

from .arrange import Note
from .meter import Grid


@dataclass(frozen=True)
class QEvent:
    """A quantized chord (or single note) on one staff. Units: quarter notes."""
    offset: float
    dur: float
    pitches: tuple[int, ...]


def snap_onsets(q_pos, step: float, fine_penalty: float = 0.0) -> np.ndarray:
    """Onset positions (quarters) onto a grid of `step`, or of step/2 only when an onset sits
    clearly between two grid points: the half-step must be closer by `fine_penalty` steps."""
    p = np.asarray(q_pos, dtype=float) / step
    whole, half = np.round(p), np.floor(p) + 0.5
    return np.where(np.abs(p - half) + fine_penalty < np.abs(p - whole), half, whole) * step


def quantize_hand(notes: list[Note], sec_to_q, step: float = 0.25, fine_penalty: float | None = None,
                  beat_q: float | None = None, beat_onsets: set[float] | None = None,
                  min_len: float | None = None) -> list[QEvent]:
    """Snap onsets/durations to a `step`-quarter grid and turn the hand into a
    sequence of non-overlapping chords (a held note is cut at the next onset —
    readable notation beats perfect sustain fidelity for a learning score).

    With `fine_penalty`, onsets snap to a grid of 2 x step and use `step` only when clearly
    between (snap_onsets). With `beat_q` and `beat_onsets` (beat positions where any hand
    starts a note), a note that starts off the beat ends at the next beat when something starts
    there: the texture moved on, and the pedal, not the finger, holds it. With `min_len`, a
    note is written at least that long unless the hand's next note comes sooner: a short,
    detached chord reads as an eighth, not as a 16th and a dotted-eighth rest."""
    if not notes:
        return []
    q = step
    raw = sec_to_q([n.start for n in notes])
    starts = np.round(raw / q) * q if fine_penalty is None else snap_onsets(raw, 2 * q, fine_penalty)
    ends = np.round(sec_to_q([n.end for n in notes]) / q) * q
    groups: dict[float, list[tuple[int, float]]] = {}
    for n, s, e in zip(notes, starts, ends):
        s = max(float(s), 0.0)
        groups.setdefault(s, []).append((n.pitch, max(float(e) - s, q)))
    onsets = sorted(groups)
    events = []
    for i, s in enumerate(onsets):
        pitches = tuple(sorted({p for p, _ in groups[s]}))
        dur = max(d for _, d in groups[s])
        if min_len:
            dur = max(dur, min_len)
        if i + 1 < len(onsets):
            dur = min(dur, onsets[i + 1] - s)
        if beat_q and beat_onsets is not None and (s / beat_q) % 1.0 > 1e-6:
            nxt = float(np.ceil(s / beat_q - 1e-9) * beat_q)
            if round(nxt, 6) in beat_onsets:
                dur = min(dur, nxt - s)
        events.append(QEvent(offset=s, dur=dur, pitches=pitches))
    return events


def spell(midi: int, sharps: int):
    """Pitch spelled for the key: no explicit naturals, flats in flat keys, sharps in sharp keys.

    music21's midi default mixes the two (C# Eb F# G# Bb), so both directions need a flip."""
    from music21 import pitch
    p = pitch.Pitch(midi=midi)
    if p.accidental is not None and p.accidental.name == "natural":
        p.accidental = None
    if p.accidental is not None and p.accidental.name == "sharp" and sharps < 0:
        p = p.getEnharmonic()
    if p.accidental is not None and p.accidental.name == "flat" and sharps > 0:
        p = p.getEnharmonic()
    return p


def detect_key(notes: list[Note]):
    from music21 import note, stream
    s = stream.Stream()
    for n in notes:
        s.append(note.Note(n.pitch, quarterLength=max(0.25, min(n.dur * 2, 4.0))))
    return s.analyze("key")


def tempo_text(grid: Grid, bpm: float | None = None) -> str:
    """Text tempo mark for the counted beat (the glyphs in "q = 120" need a SMuFL text font cairosvg lacks)."""
    return f"≈ {round(bpm or grid.bpm)} bpm" + (" (dotted quarter)" if grid.beat_q == 1.5 else "")


def tempo_marks(grid: Grid, change: float = 0.10, hold: int = 4, gap: int = 8) -> list[tuple[float, float]]:
    """(score offset, counted beats per minute) for each tempo mark. Bar tempo comes from the grid,
    smoothed by a 5-bar running median; a new mark starts where the tempo has moved by `change`
    from the last mark for `hold` bars, at least `gap` bars after it. One mark for the whole
    piece hid that Starlight opens near 116 and settles near 97 (its single mark said 92)."""
    from scipy.ndimage import median_filter
    edges = np.arange(np.ceil(grid.q[0] / grid.bar_q), np.floor(grid.q[-1] / grid.bar_q) + 1) * grid.bar_q
    edges = edges[edges >= 0]
    if len(edges) < 2:
        return [(0.0, grid.bpm)]
    bpm = (grid.bar_q / grid.beat_q) * 60.0 / np.diff(grid.q_to_sec(edges))
    smooth = median_filter(bpm, size=min(5, len(bpm) | 1), mode="nearest")  # odd: an even window rounds up
    marks = [(float(edges[0]), float(np.median(bpm[:hold])))]
    last_bar = 0
    for b in range(len(smooth)):
        off = np.abs(np.log(smooth[b: b + hold] / marks[-1][1]))
        if b - last_bar >= gap and len(off) == hold and np.all(off >= np.log(1 + change)):
            marks.append((float(edges[b]), float(np.median(bpm[b: b + hold]))))
            last_bar = b
    return marks


KS_MAJOR = np.array([6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88])
KS_MINOR = np.array([6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17])


def signature_scores(hist: np.ndarray) -> dict[int, float]:
    """Krumhansl-Schmuckler fit of a pitch-class histogram, per key signature (sharps -5..6): the
    better of its major key and its relative minor."""
    out: dict[int, float] = {}
    if not np.any(hist) or np.ptp(hist) == 0:
        return out
    for tonic in range(12):
        for profile, major_pc in ((KS_MAJOR, tonic), (KS_MINOR, (tonic + 3) % 12)):
            r = float(np.corrcoef(hist, np.roll(profile, tonic))[0, 1])
            s = (major_pc * 7) % 12
            s = s - 12 if s > 6 else s
            out[s] = max(out.get(s, -1.0), r)
    return out


def key_plan(notes: list[Note], grid: Grid, sharps: int, window: int = 4, run: int = 8,
             margin: float = 0.1) -> list[tuple[float, int]]:
    """(score offset, sharps) for each key signature, starting with the piece's key. Each bar is
    scored over +-`window` bars (pitch classes weighted by length); the signature changes only
    where another one fits better by `margin` for `run` bars in a row, at the first of them —
    a passing chromatic stretch (Connections' 5 bars leaning to D major near the end) stays in
    the home key. Measured on Connections, Starlight and Viva la FAI: no changes."""
    if not notes:
        return [(0.0, sharps)]
    bars = np.floor(grid.sec_to_q([n.start for n in notes]) / grid.bar_q).astype(int)
    weight = np.array([min(n.end - n.start, 2.0) for n in notes])
    pcs = np.array([n.pitch % 12 for n in notes])
    plan, cur, streak, cand = [(0.0, sharps)], sharps, 0, None
    for b in range(max(0, int(bars.min())), int(bars.max()) + 1):
        m = (bars >= b - window + 1) & (bars <= b + window)
        sc = signature_scores(np.bincount(pcs[m], weights=weight[m], minlength=12)) if m.sum() >= 8 else {}
        best = max(sc, key=sc.get) if sc else cur
        if best != cur and sc.get(best, 0.0) - sc.get(cur, -1.0) >= margin:
            streak, cand = (streak + 1, cand) if best == cand else (1, best)
            if streak == run:
                cur = cand
                plan.append(((b - run + 1) * grid.bar_q, cur))
                streak, cand = 0, None
        else:
            streak, cand = 0, None
    return plan


def sharps_at(plan: list[tuple[float, int]], q: float) -> int:
    return next(s for off, s in reversed(plan) if off <= q + 1e-9)


def lead_in(notes: list[Note], grid: Grid, fine_penalty: float | None = 0.15) -> float:
    """Whole bars (in quarters) before the bar of these notes' first onset. The grid's bar 0 holds
    the source's first note, which a variant may not play (Connections' `piano/lead` opened with an
    empty bar: the first note is a left-hand F#3); the score drops those bars."""
    if not notes:
        return 0.0
    q = grid.sec_to_q([min(n.start for n in notes)])
    first = float(snap_onsets(q, grid.tatum_q, fine_penalty or 0.0)[0])
    return max(0.0, float(np.floor(first / grid.bar_q + 1e-9)) * grid.bar_q)


def _from(plan: list[tuple[float, float]], shift: float) -> list[tuple[float, float]]:
    """A (offset, value) plan seen from `shift` on: the value in force there moves to 0."""
    head = [(0.0, v) for off, v in plan if off <= shift + 1e-9][-1:]
    return head + [(off - shift, v) for off, v in plan if off > shift + 1e-9]


def build_score(notes: list[Note], grid: Grid, title: str, fine_penalty: float | None = 0.15,
                release_on_beat: bool = True, min_tatum: bool = True,
                keys: list[tuple[float, int]] | None = None, chords: list | None = None):
    """Grand staff on the grid. Onsets snap to the tatum (eighth) unless clearly between two
    (`fine_penalty`), and an off-beat note ends at a beat where anything starts (`release_on_beat`).
    On Connections (Starlight's intro unchanged) the two together took written-length agreement
    0.57 -> 0.67, notes shorter than an eighth 4.0% -> 2.3% and tied notes 8.2% -> 1.4%.
    With `min_tatum` a note is written at least a tatum long when the hand has time: no change on
    either reference, and Viva la FAI's detached chords went from 54% to 39% shorter than an
    eighth (its loosely timed off-beats keep the rest). Score offsets are the grid's minus
    `lead_in` (whole empty bars before the first note). `chords` (chords.Chord, grid quarters) are
    written as chord symbols above the treble staff, spelled for the key in force."""
    from music21 import chord, clef, harmony, key, layout, meter, metadata, note, stream, tempo

    step = grid.tatum_q / 2
    shift = lead_in(notes, grid, fine_penalty)
    sec_to_q = lambda t: grid.sec_to_q(t) - shift  # noqa: E731
    beat_onsets = None
    if release_on_beat and notes:
        raw = sec_to_q([n.start for n in notes])
        pos = np.round(raw / step) * step if fine_penalty is None else snap_onsets(raw, grid.tatum_q, fine_penalty)
        beat_onsets = {round(float(p), 6) for p in pos if (p / grid.beat_q) % 1.0 < 1e-6}
    keys = _from(keys or key_plan(notes, grid, detect_key(notes).sharps if notes else 0), shift)
    score = stream.Score()
    score.insert(0, metadata.Metadata(title=title, composer="transcribed by Kaya piano2video"))
    parts = []
    for hand, cl in (("R", clef.TrebleClef()), ("L", clef.BassClef())):
        p = stream.PartStaff()
        p.partName = "Piano RH" if hand == "R" else "Piano LH"
        p.insert(0, cl)
        for off, sharps in keys:
            p.insert(off, key.KeySignature(int(sharps)))
        p.insert(0, meter.TimeSignature(grid.meter))
        if hand == "R":
            unit = note.Note(type="quarter", dots=1 if grid.beat_q == 1.5 else 0)
            for off, bpm in _from(tempo_marks(grid), shift):
                mm = tempo.MetronomeMark(text=tempo_text(grid, bpm), number=round(bpm), referent=unit)
                mm.numberImplicit = True
                p.insert(off, mm)
            from .chords import KINDS
            for c in chords or []:
                off = c.start_q - shift
                if c.root is not None and off >= -1e-6:
                    sh = sharps_at(keys, max(off, 0.0))
                    bass = None if c.bass is None else spell(48 + c.bass, sh)
                    p.insert(max(off, 0.0), harmony.ChordSymbol(root=spell(60 + c.root, sh), kind=KINDS[c.quality],
                                                                bass=bass))
        for ev in quantize_hand([n for n in notes if n.hand == hand], sec_to_q, step, fine_penalty,
                                grid.beat_q, beat_onsets, grid.tatum_q if min_tatum else None):
            ps = [spell(m, sharps_at(keys, ev.offset)) for m in ev.pitches]
            el = note.Note(ps[0]) if len(ps) == 1 else chord.Chord(ps)
            el.quarterLength = ev.dur
            p.insert(ev.offset, el)
        parts.append(p)
    # visible rests in every gap, up to the end of the last bar: left to the exporter, music21
    # fills gaps with hidden rests and the PDF shows blank space a beginner can't count
    end = float(np.ceil(max(p.highestTime for p in parts) / grid.bar_q - 1e-9) * grid.bar_q)
    for p in parts:
        p.makeRests(refStreamOrTimeRange=[0.0, end], fillGaps=True, inPlace=True, hideRests=False)
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
        # chord-symbol accidentals are SMuFL glyphs cairosvg can't draw (B-flat came out "B" + a box)
        svg = re.sub(r'<tspan font-family="Leipzig" font-size="\d+px">([\uea64\uea66])</tspan>',
                     lambda m: '<tspan font-size="405px">' + ("b" if m[1] == "\uea64" else "#") + "</tspan>",
                     tk.renderToSVG(i))
        cairosvg.svg2pdf(bytestring=svg.encode(), write_to=buf)
        buf.seek(0)
        writer.append(buf)
    with open(pdf, "wb") as f:
        writer.write(f)
    return n
