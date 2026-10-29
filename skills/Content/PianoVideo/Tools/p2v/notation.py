"""Sheet music: beat-quantize the arrangement, build a grand staff, export
MusicXML (editable in MuseScore/Sibelius/Dorico) and engrave a PDF via Verovio."""

from __future__ import annotations

import io
import re
from dataclasses import dataclass
from pathlib import Path

import numpy as np

from .arrange import Note, melody_bars, sort_notes
from .meter import Grid

# Onset snapping per path and note role (DESIGN.md §17). The pipeline passes ROLE_PENALTY[source] to
# build_score: a role named there snaps with its own fine_penalty instead of build_score's. 0.5 = the
# tatum only: a sung lead's onsets scatter around the beat (loose timing, SOME's ornaments), and an
# eighth-only lead matched the reference melodies' written lengths best on the bank's tune half.
# Not for a lead note from the band's line (`Note.hook`, §28): `role_pen` gives it no role penalty, so
# a riff keeps its 16ths (and the beat lattice) as the piano part does; it is still "lead" everywhere else.
ROLE_PENALTY: dict[str, dict[str, float]] = {"hybrid": {"lead": 0.5}, "arrange": {"lead": 0.5}}
TATUM_ONLY = 0.5  # a role penalty this high never takes the 16th: such a role's note ends snap to the tatum too
# LEAD_VOICE: a hand that holds lead notes and other notes is written in two voices, the lead (stems
# up) over the rest (stems down), so the accompaniment's onsets do not cut a held melody note.
LEAD_VOICE = True
# LEAD_BARS: with LEAD_VOICE, a bar without melody writes the hand's other notes as the lead voice, so its bar shows
# no rests stacked over the accompaniment (DESIGN.md §35)
LEAD_BARS = True


@dataclass(frozen=True)
class QEvent:
    """A quantized chord (or single note) on one staff. Units: quarter notes."""
    offset: float
    dur: float
    pitches: tuple[int, ...]


# Written onsets by beat (DESIGN.md §26). In a simple meter, each hand's onsets in one beat (chords within
# CHORD_TOL count once) go onto ONE lattice of that beat: eighths, 16ths, triplet eighths or sextuplets, in
# order and on distinct points (two onsets on one point would merge into one chord, so a beat with five or six
# notes cannot be 16ths). Cost of a lattice: squared distances / LATTICE_SIGMA^2 (beats), + LATTICE_MERGE for
# each onset that does share the previous one's point (a melody note played before its chord), + the
# lattice's penalty. One beat alone is weak evidence (a melody eighth played early at a third of the beat
# reads as a triplet), and tuplets come in runs, so the hand's beats are decided together: a Viterbi path over
# its beats, LATTICE_SWITCH for each change between the duple and the triple lattices; a beat with onsets on
# the beat only costs nothing. Every lattice also holds the next beat (1.0: a downbeat played early). A beat
# the path writes duple keeps the per-note snap (snap_notes: its eighth bias reads better on sung songs'
# piano), so only tuplet beats change. Chosen on the bank's tune half with perfect beats (s12/qeval.py).
LATTICE_SIGMA = 0.06
LATTICE_MERGE = 3.0
LATTICE_SWITCH = 8.0
LATTICES: tuple[tuple[tuple[float, ...], float], ...] = (
    ((0.0, 0.5), 0.0),                       # eighths
    ((0.0, 0.25, 0.5, 0.75), 1.0),           # 16ths
    ((0.0, 1 / 3, 2 / 3), 3.0),              # triplet eighths
    (tuple(k / 6 for k in range(6)), 10.0),  # sextuplets
)
BY_BEAT = True  # read at call time: bank --set sweeps it


def fit_lattice(f: np.ndarray, pts, sigma: float | None = None, merge: float | None = None) -> tuple[float, np.ndarray]:
    """Sorted beat phases f onto the sorted lattice points `pts`, keeping their order: (cost, point per phase).
    Cost = squared distance / sigma^2, + `merge` for each phase on the same point as the phase before it."""
    sigma = LATTICE_SIGMA if sigma is None else sigma
    merge = LATTICE_MERGE if merge is None else merge
    pts = np.asarray(pts, dtype=float)
    k, m = len(f), len(pts)
    c = (np.asarray(f, dtype=float)[:, None] - pts[None, :]) ** 2 / sigma ** 2
    best = np.full((k, m), np.inf)
    arg = np.zeros((k, m), dtype=int)
    best[0] = c[0]
    for i in range(1, k):
        prev = best[i - 1]
        lower = np.r_[np.inf, np.minimum.accumulate(prev)[:-1]]  # the best earlier point
        lower_arg = np.r_[0, [int(np.argmin(prev[:j])) for j in range(1, m)]]
        same = prev + merge
        take = same < lower
        best[i] = c[i] + np.where(take, same, lower)
        arg[i] = np.where(take, np.arange(m), lower_arg)
    j = int(np.argmin(best[k - 1]))
    cost, out = float(best[k - 1, j]), np.zeros(k)
    for i in range(k - 1, -1, -1):
        out[i] = pts[j]
        j = int(arg[i, j])
    return cost, out


def onsets_by_beat(q_pos, starts, beat_q: float, keep=None) -> tuple[np.ndarray, dict[int, int]]:
    """One hand's written onsets (quarters) by beat (LATTICES), and per beat index the chosen lattice's
    points per beat. An onset belongs to the beat it is in, or to the next one within a 12th of it. With
    `keep` (written onsets, one per note), a beat on a duple lattice keeps those: only tuplet beats change."""
    from .arrange import CHORD_TOL
    q, t = np.asarray(q_pos, dtype=float), np.asarray(starts, dtype=float)
    out = np.zeros(len(q))
    sizes: dict[int, int] = {}
    groups: list[list[int]] = []
    for i in np.argsort(t, kind="stable"):
        if groups and t[i] - t[groups[-1][0]] <= CHORD_TOL:
            groups[-1].append(int(i))
        else:
            groups.append([int(i)])
    if not groups:
        return out, sizes
    gp = np.array([np.mean(q[g]) for g in groups]) / beat_q
    beat = np.floor(gp + 1 / 12).astype(int)
    beats = np.unique(beat)
    phases = []
    cost = np.zeros((len(beats), len(LATTICES)))
    for r, b in enumerate(beats):
        sel = np.flatnonzero(beat == b)
        sel = sel[np.argsort(gp[sel], kind="stable")]
        f = gp[sel] - b
        phases.append((sel, f))
        if np.any(np.abs(f) > LATTICE_SIGMA):
            cost[r] = [fit_lattice(f, (*pts, 1.0))[0] + pen for pts, pen in LATTICES]
        else:  # onsets on the beat only: no evidence, but a tuplet lattice still costs its penalty
            cost[r] = [pen for _, pen in LATTICES]
    triple = np.array([len(pts) % 3 == 0 for pts, _ in LATTICES])
    switch = np.where(triple[:, None] != triple[None, :], LATTICE_SWITCH, 0.0)
    total, back = cost[0] + np.where(triple, LATTICE_SWITCH, 0.0), []  # the path starts duple
    for r in range(1, len(beats)):
        step = total[:, None] + switch
        back.append(step.argmin(axis=0))
        total = step.min(axis=0) + cost[r]
    path = [int(total.argmin())]
    for arg in reversed(back):
        path.append(int(arg[path[-1]]))
    for (sel, f), b, k in zip(phases, beats, path[::-1]):
        pts = LATTICES[k][0]
        _, pos = fit_lattice(f, (*pts, 1.0))  # 1.0: the next beat, played early
        sizes[int(b)] = len(pts) if np.any(np.abs(f) > LATTICE_SIGMA) else 2  # onsets on the beat only: no tuplet there
        for s, x in zip(sel, pos):
            out[groups[s]] = (b + x) * beat_q if keep is None or sizes[int(b)] % 3 == 0 else np.asarray(keep)[groups[s]]
    return out, sizes


def role_pen(n: Note, role_penalty: dict[str, float] | None) -> float | None:
    """The note's own snap penalty from `role_penalty`, or None (the score's): a role not named there,
    or a lead note from the band's line (`Note.hook`). A riff's 16ths are real, a singer's are loose
    timing: T5 melody written length 0.05 -> 0.37 / 0.10 -> 0.52 (tune / check, DESIGN.md §28)."""
    return None if n.hook else (role_penalty or {}).get(n.role)


def snap_onsets(q_pos, step: float, fine_penalty: float = 0.0) -> np.ndarray:
    """Onset positions (quarters) onto a grid of `step`, or of step/2 only when an onset sits
    clearly between two grid points: the half-step must be closer by `fine_penalty` steps."""
    p = np.asarray(q_pos, dtype=float) / step
    whole, half = np.round(p), np.floor(p) + 0.5
    return np.where(np.abs(p - half) + fine_penalty < np.abs(p - whole), half, whole) * step


def snap_notes(notes: list[Note], sec_to_q, tatum: float, fine_penalty: float | None = None,
               role_penalty: dict[str, float] | None = None) -> np.ndarray:
    """Written onsets (quarters) of `notes`: on a grid of tatum/2, or of the tatum unless clearly
    between two (`fine_penalty`, per role through `role_penalty`; snap_onsets)."""
    raw = np.asarray(sec_to_q([n.start for n in notes]), dtype=float)
    pen = [fine_penalty if (p := role_pen(n, role_penalty)) is None else p for n in notes]
    fine = np.round(raw / (tatum / 2)) * (tatum / 2)
    if all(p is None for p in pen):
        return fine
    return np.where([p is None for p in pen], fine, snap_onsets(raw, tatum, np.array([p or 0.0 for p in pen])))


def quantize_hand(notes: list[Note], sec_to_q, step: float = 0.25, fine_penalty: float | None = None,
                  beat_q: float | None = None, beat_onsets: set[float] | None = None,
                  min_len: float | None = None, role_penalty: dict[str, float] | None = None,
                  lead_mono: bool = False) -> list[QEvent]:
    """Snap onsets/durations to a `step`-quarter grid and turn the hand into a
    sequence of non-overlapping chords (a held note is cut at the next onset —
    readable notation beats perfect sustain fidelity for a learning score).

    With `fine_penalty`, onsets snap to a grid of 2 x step and use `step` only when clearly
    between (snap_onsets). With `beat_q` and `beat_onsets` (beat positions where any hand
    starts a note), a note that starts off the beat ends at the next beat when something starts
    there: the texture moved on, and the pedal, not the finger, holds it. With `min_len`, a
    note is written at least that long unless the hand's next note comes sooner: a short,
    detached chord reads as an eighth, not as a 16th and a dotted-eighth rest. `role_penalty`
    (role -> fine_penalty) snaps those roles' onsets with their own penalty; with `lead_mono`, two
    lead notes on one written onset keep only the longer (in seconds). In a simple meter (`beat_q`
    = 4 steps) the onsets of notes without a role penalty are written by beat (`onsets_by_beat`); in a
    beat written in thirds (sixths), ends snap to thirds (sixths) of the beat, the shortest length is a third
    (a sixth) and `min_len` becomes a third of the beat."""
    if not notes:
        return []
    q = step
    starts = snap_notes(notes, sec_to_q, 2 * q, fine_penalty, role_penalty)
    coarse = np.array([(role_pen(n, role_penalty) or 0.0) >= TATUM_ONLY for n in notes])
    raw_end = np.asarray(sec_to_q([n.end for n in notes]), dtype=float)
    ends = np.where(coarse, np.round(raw_end / (2 * q)) * 2 * q, np.round(raw_end / q) * q)
    tuplet: dict[int, int] = {}  # beat index -> 3 or 6: the beats written in thirds or sixths
    by_beat = [i for i, n in enumerate(notes) if role_pen(n, role_penalty) is None]
    if BY_BEAT and beat_q and abs(beat_q - 4 * q) < 1e-9 and by_beat:
        starts = np.asarray(starts, dtype=float).copy()
        w, sizes = onsets_by_beat(sec_to_q([notes[i].start for i in by_beat]), [notes[i].start for i in by_beat], beat_q,
                                  starts[by_beat])
        starts[by_beat] = w
        tuplet = {b: k for b, k in sizes.items() if k % 3 == 0}
        for i in by_beat:
            if k := tuplet.get(int(np.floor(raw_end[i] / beat_q + 1 / 12)), 0):
                ends[i] = np.round(raw_end[i] / (beat_q / k)) * (beat_q / k)
    in_tuplet = lambda s: tuplet.get(int(np.floor(s / beat_q + 1 / 12)), 0) if tuplet else 0  # noqa: E731
    shortest = lambda s: beat_q / in_tuplet(s) if in_tuplet(s) else q  # noqa: E731
    if lead_mono:
        best: dict[float, int] = {}
        for i, (n, s) in enumerate(zip(notes, starts)):
            k = round(max(float(s), 0.0), 6)
            if n.role == "lead" and (k not in best or n.dur > notes[best[k]].dur):
                best[k] = i
        keep = [n.role != "lead" or best[round(max(float(s), 0.0), 6)] == i for i, (n, s) in enumerate(zip(notes, starts))]
        notes, starts, ends = [n for n, k in zip(notes, keep) if k], starts[keep], ends[keep]
    groups: dict[float, list[tuple[int, float]]] = {}
    for n, s, e in zip(notes, starts, ends):
        s = max(float(s), 0.0)
        groups.setdefault(s, []).append((n.pitch, max(float(e) - s, shortest(s))))
    onsets = sorted(groups)
    events = []
    for i, s in enumerate(onsets):
        pitches = tuple(sorted({p for p, _ in groups[s]}))
        dur = max(d for _, d in groups[s])
        if min_len:
            dur = max(dur, beat_q / 3 if in_tuplet(s) else min_len)
        if k := in_tuplet(s + dur):  # a minimum length can end on a 16th inside a tuplet beat: end at its beat line
            e, b = s + dur, int(np.floor((s + dur) / beat_q + 1 / 12))
            if abs(e * k / beat_q - round(e * k / beat_q)) > 1e-6 and b * beat_q > s + 1e-9:
                dur = b * beat_q - s
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
KEY_MARGIN = 0.1  # key_plan: how much better (share of the notes inside the signature) another one must fit


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


MAJOR_SET = np.array([1, 0, 1, 0, 1, 1, 0, 1, 0, 1, 0, 1], dtype=float)  # the 7 notes of a major scale


def signature_fit(hist: np.ndarray) -> dict[int, float]:
    """Share of a pitch-class histogram inside each key signature's 7 notes (sharps -5..6). A key
    signature is a set of notes, whatever the mode: dorian or mixolydian songs need no special case
    (bank, 22 songs with a reference key: 20 right vs 18 for the Krumhansl fit, 14 for music21's; DESIGN.md §16)."""
    tot = float(np.sum(hist))
    if tot <= 0:
        return {}
    out = {}
    for tonic in range(12):
        s = (tonic * 7) % 12
        out[s - 12 if s > 6 else s] = float(np.dot(hist, np.roll(MAJOR_SET, tonic))) / tot
    return out


def _weights(notes: list[Note]) -> tuple[np.ndarray, np.ndarray]:
    return np.array([n.pitch % 12 for n in notes]), np.array([min(n.end - n.start, 2.0) for n in notes])


def best_signature(hist: np.ndarray) -> int | None:
    """The signature with the best diatonic fit; a tie (both F and F# absent) goes to the Krumhansl fit."""
    fit = signature_fit(hist)
    if not fit:
        return None
    top = max(round(v, 9) for v in fit.values())
    tied = [s for s, v in fit.items() if round(v, 9) == top]
    if len(tied) == 1:
        return tied[0]
    ks = signature_scores(hist)
    return max(tied, key=lambda s: ks.get(s, -1.0))


def piece_key(notes: list[Note]) -> int:
    """The piece's key signature (sharps) from all its notes, weighted by length (at most 2 s)."""
    if not notes:
        return 0
    pcs, w = _weights(notes)
    best = best_signature(np.bincount(pcs, weights=w, minlength=12))
    return 0 if best is None else best


def key_plan(notes: list[Note], grid: Grid, sharps: int, window: int = 4, run: int = 8,
             margin: float = KEY_MARGIN) -> list[tuple[float, int]]:
    """(score offset, sharps) for each key signature, starting with the piece's key. Each bar is
    scored over +-`window` bars (pitch classes weighted by length, `signature_fit`, the scorer of
    `piece_key`); the signature changes only where another one fits better by `margin` for `run`
    bars in a row, at the first of them — a passing chromatic stretch (Connections' 5 bars leaning
    to D major near the end) stays in the home key. Margin 0.1 (a share of the notes): no key change
    on any of the 22 pop songs of the bank (Connections, Starlight and Viva la FAI included); 0.05
    adds one on a T1 cover (DESIGN.md §16)."""
    if not notes:
        return [(0.0, sharps)]
    bars = np.floor(grid.sec_to_q([n.start for n in notes]) / grid.bar_q).astype(int)
    pcs, weight = _weights(notes)
    plan, cur, streak, cand = [(0.0, sharps)], sharps, 0, None
    for b in range(max(0, int(bars.min())), int(bars.max()) + 1):
        m = (bars >= b - window + 1) & (bars <= b + window)
        hist = np.bincount(pcs[m], weights=weight[m], minlength=12) if m.sum() >= 8 else None
        sc = signature_fit(hist) if hist is not None else {}
        best = best_signature(hist) if sc else cur
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


def lead_in(notes: list[Note], grid: Grid, fine_penalty: float | None = 0.15,
            role_penalty: dict[str, float] | None = None) -> float:
    """Whole bars (in quarters) before the bar of these notes' first onset. The grid's bar 0 holds
    the source's first note, which a variant may not play (Connections' `piano/lead` opened with an
    empty bar: the first note is a left-hand F#3); the score drops those bars."""
    if not notes:
        return 0.0
    first = float(np.min(snap_notes(notes, grid.sec_to_q, grid.tatum_q, fine_penalty, role_penalty)))  # as written
    return max(0.0, float(np.floor(first / grid.bar_q + 1e-9)) * grid.bar_q)


def _from(plan: list[tuple[float, float]], shift: float) -> list[tuple[float, float]]:
    """A (offset, value) plan seen from `shift` on: the value in force there moves to 0."""
    head = [(0.0, v) for off, v in plan if off <= shift + 1e-9][-1:]
    return head + [(off - shift, v) for off, v in plan if off > shift + 1e-9]


# Clefs and octave lines (DESIGN.md §32). A note head on 3 or more ledger lines is hard to read: the bank's
# band bass sat there (deadmau5 Some Chords: 88% of the left hand's heads, Sober 51%). Per bar, each staff
# takes one of its modes: its home clef, the home clef under an octave line (8va over the treble, 8vb under
# the bass), or the other clef. A bar costs the ledger lines past 2 of its note heads, + STAFF_AWAY out of
# the home mode; a Viterbi path over the bars adds STAFF_CHANGE for each change of mode, so a staff does not
# flip for one high note. Mode = (clef, diatonic steps written minus sounding).
STAFF_MODES = {"R": (("treble", 0), ("treble", -7), ("bass", 0)), "L": (("bass", 0), ("bass", 7), ("treble", 0))}
STAFF_AWAY = 0.5
STAFF_CHANGE = 3.0
STAFF_CLEFS = True  # read at call time: bank --set sweeps it
LOWEST_LINE = {"treble": 31, "bass": 19}  # music21 diatonic note numbers: E4, G2


def ledger_lines(dnn: int, lowest_line: int) -> int:
    """Ledger lines a note head needs on a five-line staff whose lowest line is `lowest_line`
    (music21 diatonic note numbers: E4 = 31 is the treble clef's lowest line, G2 = 19 the bass clef's)."""
    top = lowest_line + 8
    if dnn > top + 1:
        return (dnn - top) // 2
    if dnn < lowest_line - 1:
        return (lowest_line - dnn) // 2
    return 0


def staff_modes(bars: list[list[int]], hand: str, away: float | None = None, change: float | None = None) -> list[int]:
    """One mode (an index into STAFF_MODES[hand]) per bar; `bars` holds each bar's written note heads as
    diatonic note numbers (music21 `Pitch.diatonicNoteNum` of the spelled pitch). An empty bar costs nothing
    in any mode, so a staff keeps its mode through a rest."""
    away = STAFF_AWAY if away is None else away
    change = STAFF_CHANGE if change is None else change
    modes = STAFF_MODES[hand]
    if not bars:
        return []
    cost = np.array([[sum(max(0, ledger_lines(d + sh, LOWEST_LINE[c]) - 2) for d in b) + (away if k and b else 0.0)
                      for k, (c, sh) in enumerate(modes)] for b in bars])
    n, m = cost.shape
    acc, back = cost[0].copy(), np.zeros((n, m), dtype=int)
    acc[1:] += change  # the staff starts in its home mode: leaving it at bar 1 is a change too
    for i in range(1, n):
        step = acc[:, None] + change * (1 - np.eye(m))  # [from, to]
        back[i] = np.argmin(step, axis=0)
        acc = step[back[i], np.arange(m)] + cost[i]
    path = [int(np.argmin(acc))]
    for i in range(n - 1, 0, -1):
        path.append(int(back[i][path[-1]]))
    return path[::-1]


def apply_staff_modes(part, placed: list, hand: str, bar_q: float) -> list[int]:
    """Clef changes and octave lines on one staff, from `staff_modes` over its bars; `placed` = the
    staff's (offset, note or chord) at sounding pitch (the octave lines keep it: transposing=False)."""
    from itertools import groupby

    from music21 import clef, spanner
    bar_of = lambda off: int(off / bar_q + 1e-9)  # noqa: E731
    placed = sorted(placed, key=lambda t: t[0])
    bars: list[list[int]] = [[] for _ in range(bar_of(placed[-1][0]) + 1)]
    for off, el in placed:
        bars[bar_of(off)].extend(p.diatonicNoteNum for p in el.pitches)
    path = staff_modes(bars, hand)
    modes = STAFF_MODES[hand]
    cur = modes[0][0]
    for b, k in enumerate(path):
        if modes[k][0] != cur:
            cur = modes[k][0]
            if b == 0:
                for old in [c for c in part.getElementsByClass(clef.Clef) if c.offset == 0]:
                    part.remove(old)
            part.insert(b * bar_q, clef.TrebleClef() if cur == "treble" else clef.BassClef())
    for k, run in groupby(range(len(path)), key=lambda b: path[b]):
        shift = modes[k][1]
        span = set(run)
        els = [el for off, el in placed if bar_of(off) in span]
        if shift and els:
            part.insert(0, spanner.Ottava(*els, type="8va" if shift < 0 else "8vb", transposing=False))
    return path


def build_score(notes: list[Note], grid: Grid, title: str, fine_penalty: float | None = 0.15,
                release_on_beat: bool = True, min_tatum: bool = True,
                keys: list[tuple[float, int]] | None = None, chords: list | None = None,
                role_penalty: dict[str, float] | None = None):
    """Grand staff on the grid. Onsets snap to the tatum (eighth) unless clearly between two
    (`fine_penalty`), and an off-beat note ends at a beat where anything starts (`release_on_beat`).
    On Connections (Starlight's intro unchanged) the two together took written-length agreement
    0.57 -> 0.67, notes shorter than an eighth 4.0% -> 2.3% and tied notes 8.2% -> 1.4%.
    With `min_tatum` a note is written at least a tatum long when the hand has time: no change on
    either reference, and Viva la FAI's detached chords went from 54% to 39% shorter than an
    eighth (its loosely timed off-beats keep the rest). Score offsets are the grid's minus
    `lead_in` (whole empty bars before the first note). `chords` (chords.Chord, grid quarters) are
    written as chord symbols above the treble staff, spelled for the key in force. `role_penalty`
    (role -> fine_penalty, the pipeline's ROLE_PENALTY[source]) snaps those roles their own way; two
    lead notes on one written onset keep the longer; with LEAD_VOICE a hand with lead and other notes
    gets two voices (DESIGN.md §17)."""
    from music21 import chord, clef, harmony, key, layout, meter, metadata, note, stream, tempo

    step = grid.tatum_q / 2
    lead_voice = LEAD_VOICE  # read at call time: bank --set sweeps it
    shift = lead_in(notes, grid, fine_penalty, role_penalty)
    sec_to_q = lambda t: grid.sec_to_q(t) - shift  # noqa: E731
    beat_onsets = None
    if release_on_beat and notes:
        pos = snap_notes(notes, sec_to_q, grid.tatum_q, fine_penalty, role_penalty)
        beat_onsets = {round(float(p), 6) for p in pos if (p / grid.beat_q) % 1.0 < 1e-6}
    keys = _from(keys or key_plan(notes, grid, piece_key(notes)), shift)
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
                if c.root is not None and c.end_q - shift > 1e-6:  # one still sounding at the first bar: its symbol there (§19)
                    sh = sharps_at(keys, max(off, 0.0))
                    bass = None if c.bass is None else spell(48 + c.bass, sh)
                    p.insert(max(off, 0.0), harmony.ChordSymbol(root=spell(60 + c.root, sh), kind=KINDS[c.quality],
                                                                bass=bass))
        hn = [n for n in notes if n.hand == hand]
        lead = [n for n in hn if n.role == "lead"]
        voices, bars = [hn], None
        if lead_voice and 0 < len(lead) < len(hn):
            rest = [n for n in hn if n.role != "lead"]
            if LEAD_BARS:  # read at call time: in a bar without melody the rest of the hand is the lead voice (§35)
                bars = melody_bars(lead, grid)
                at = [int(np.floor((q + shift) / grid.bar_q + 1e-9)) in bars
                      for q in snap_notes(rest, sec_to_q, grid.tatum_q, fine_penalty, role_penalty)]
                lead = sort_notes(lead + [n for n, b in zip(rest, at) if not b])
                rest = [n for n, b in zip(rest, at) if b]
            voices = [lead, rest] if rest else [lead]
        placed = []
        for k, vn in enumerate(voices):
            two = len(voices) > 1
            target = stream.Voice() if two else p
            for ev in quantize_hand(vn, sec_to_q, step, fine_penalty, grid.beat_q, beat_onsets,
                                    grid.tatum_q if min_tatum else None, role_penalty, lead_mono=True):
                ps = [spell(m, sharps_at(keys, ev.offset)) for m in ev.pitches]
                el = note.Note(ps[0]) if len(ps) == 1 else chord.Chord(ps)
                el.quarterLength = ev.dur
                if two and (bars is None or int(np.floor((ev.offset + shift) / grid.bar_q + 1e-9)) in bars):
                    el.stemDirection = "up" if k == 0 else "down"
                target.insert(ev.offset, el)
                placed.append((ev.offset, el))
            if two:
                target.id = str(k + 1)
                p.insert(0, target)
        if STAFF_CLEFS and placed:  # read at call time: bank --set sweeps it
            apply_staff_modes(p, placed, hand, grid.bar_q)
        parts.append(p)
    # visible rests in every gap, up to the end of the last bar: left to the exporter, music21
    # fills gaps with hidden rests and the PDF shows blank space a beginner can't count. Two voices:
    # the lead voice's rests show, the lower voice's are hidden (the lead voice already counts the bar)
    end = float(np.ceil(max(p.highestTime for p in parts) / grid.bar_q - 1e-9) * grid.bar_q)
    for p in parts:
        for k, v in enumerate(list(p.voices) or [p]):
            v.makeRests(refStreamOrTimeRange=[0.0, end], fillGaps=True, inPlace=True, hideRests=k > 0)
            split_at_beats(v, grid.beat_q)
        score.insert(0, p)
    score.insert(0, layout.StaffGroup(parts, name="Piano", symbol="brace"))
    return score


def split_at_beats(v, beat_q: float) -> None:
    """A note, chord or rest that starts or ends off the 16th grid (a tuplet point) and runs across a beat
    line is cut at the beat lines next to its ends, notes tied: one 7/12- or 5/6-quarter element was engraved
    as a 12:7 or 6:5 tuplet (makeRests filled such gaps; a note held from a 16th into a triplet beat made
    one, and it broke the tuplets after it). Elements on the 16th grid stay whole."""
    off16 = lambda x: abs(x * 4 - round(x * 4)) > 1e-6  # noqa: E731
    for el in list(v.notesAndRests):
        a, b = float(el.offset), float(el.offset + el.quarterLength)
        cuts = []
        if off16(a):
            cuts.append(float(np.ceil(a / beat_q + 1e-6) * beat_q))
        if off16(b):
            cuts.append(float(np.floor(b / beat_q - 1e-6) * beat_q))
        cuts = sorted({c for c in cuts if a + 1e-6 < c < b - 1e-6})
        if not cuts:
            continue
        v.remove(el)
        for c in cuts:
            left, el = el.splitAtQuarterLength(c - a)
            v.insert(a, left)
            a = c
        v.insert(a, el)


def write_musicxml(score, path: Path) -> Path:
    # makeNotation: measures, rests, ties across barlines, beaming
    if not any(p.hasVoices() for p in score.parts):
        score.write("musicxml", fp=str(path), makeNotation=True)
        return path
    # two voices: music21 numbers a measure's voices from 0, and Verovio drops voice 0 ("Layer 0
    # cannot be found": the lead voice vanished from the PDF), so make the measures here and number
    # the voices from 1; the export's makeNotation then keeps them (it splits 5-16th notes into ties)
    from music21 import stream
    s = score.makeNotation()
    for p in s.parts:
        for m in p.getElementsByClass(stream.Measure):
            for i, v in enumerate(m.voices):
                v.id = str(i + 1)
    s.write("musicxml", fp=str(path), makeNotation=True)
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
        # chord-symbol accidentals are SMuFL glyphs cairosvg can't draw (B-flat came out "B" + a box); a
        # natural (music21 writes root-alter 0 for some roots, e.g. F in G major: "F" + a box) is dropped,
        # since `spell` writes every root as the key spells it (\u00a719)
        svg = re.sub(r'<tspan font-family="Leipzig" font-size="\d+px">([\uea64\uea65\uea66])</tspan>',
                     lambda m: "" if m[1] == "\uea65" else
                     '<tspan font-size="405px">' + ("b" if m[1] == "\uea64" else "#") + "</tspan>",
                     tk.renderToSVG(i))
        cairosvg.svg2pdf(bytestring=svg.encode(), write_to=buf)
        buf.seek(0)
        writer.append(buf)
    with open(pdf, "wb") as f:
        writer.write(f)
    return n
