"""A score the user gives (`--score`, DESIGN.md §52): its beats, bar lines and meter placed on the recording.

Under rubato the audio and the transcribed notes cannot tell a long beat from two beats (§50, §51: a beat model
on the notes adds as many extra beats as it removes); the written score can. The score (MusicXML or MIDI, read
as the bank reads its references: `evaluate.load_reference`) is aligned to the transcribed notes: both are cut
into onset clusters (notes within CLUSTER_GAP of the first), a cluster pair costs the mean of 1 - cosine over
the 88 pitches and over the 12 pitch classes, and a subsequence DTW (librosa) finds the path, so a recording
that starts late in the score or stops early still fits. The path's pairs under MAX_COST give a
non-decreasing map score quarters -> seconds (pool-adjacent-violators), linear between its knots and past its
ends. The grid's knots are the score's eighths through that map, its meter and bar lines the score's.
On the ASAP grid set (§52, `s36/scorealign.py`): beat F 0.959 / 0.968 and bar-line F 0.960 / 0.968 (tune /
check) against 0.778 / 0.723 and 0.626 / 0.629 for the grid from the audio.

Limits: one meter (the one of the most full bars); a repeat the player skips (or adds) against the file breaks
the map there (MusicXML repeats are expanded as written; a MIDI file plays as it is); the side with fewer onset
clusters must fit whole inside the other (an improvised intro the score lacks is forced onto it).
"""
from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

import numpy as np

from .arrange import Note
from .evaluate import Reference, load_reference
from .meter import METERS, Grid, _bar0

SUFFIXES = (".mid", ".midi", ".musicxml", ".mxl", ".xml")
CLUSTER_GAP = 0.03  # seconds in the recording; in the score, notes at one onset (quarters) form a cluster
MAX_COST = 0.5      # a matched cluster pair: at least half of its pitch and pitch-class profile in common
MIN_MATCHED = 0.3   # the share of the recording's clusters matched: below it the score does not fit the recording
TATUM_Q = 0.5       # the grid's knots: every eighth of the score, as meter.grid_from writes them
END_Q = 4.0         # past the map's ends its slope over the last (first) 4 quarters: PAV can leave two knots ms apart
SAME = {"2/2": "4/4", "6/4": "12/8"}  # the same bars in a meter the grid writes (as bank.ref_hint)


class ScoreMismatch(ValueError):
    """The score does not fit the recording, or its meter cannot be written."""


@dataclass
class Fit:
    q: np.ndarray        # score quarters of the map's knots
    t: np.ndarray        # seconds of the recording at those quarters (strictly increasing)
    matched: float       # share of the recording's clusters matched under MAX_COST
    span: tuple[float, float]  # seconds of the recording the matched clusters cover

    def to_sec(self, q) -> np.ndarray:
        """Score quarters -> seconds: linear between the knots, and past the ends with the slope over the end's
        END_Q quarters (or the whole map when it is shorter)."""
        q = np.asarray(q, dtype=float)
        t = np.interp(q, self.q, self.t)
        i = min(max(int(np.searchsorted(self.q, self.q[0] + END_Q)), 1), len(self.q) - 1)
        j = max(min(int(np.searchsorted(self.q, self.q[-1] - END_Q, side="right")) - 1, len(self.q) - 2), 0)
        lo, hi = q < self.q[0], q > self.q[-1]
        t[lo] = self.t[0] + (q[lo] - self.q[0]) * (self.t[i] - self.t[0]) / (self.q[i] - self.q[0])
        t[hi] = self.t[-1] + (q[hi] - self.q[-1]) * (self.t[-1] - self.t[j]) / (self.q[-1] - self.q[j])
        return t


def clusters(onsets: np.ndarray, pitches: np.ndarray, gap: float) -> tuple[np.ndarray, np.ndarray]:
    """Onset clusters (each starts at a note more than `gap` after the previous note): their first onset, and a
    (k, 100) profile: note counts over the 88 keys, then over the 12 pitch classes."""
    o = np.argsort(onsets, kind="stable")
    on, p = np.asarray(onsets, dtype=float)[o], np.asarray(pitches, dtype=int)[o]
    starts = np.r_[0, np.flatnonzero(np.diff(on) > gap) + 1]
    lab = np.repeat(np.arange(len(starts)), np.diff(np.r_[starts, len(on)]))
    v = np.zeros((len(starts), 100))
    np.add.at(v, (lab, np.clip(p - 21, 0, 87)), 1.0)
    np.add.at(v, (lab, 88 + p % 12), 1.0)
    return on[starts], v


def pair_cost(a: np.ndarray, b: np.ndarray) -> np.ndarray:
    """(n, m): the mean of 1 - cosine over the keys and over the pitch classes of each cluster pair."""
    def cos(x, y):
        x = x / (np.linalg.norm(x, axis=1, keepdims=True) + 1e-9)
        y = y / (np.linalg.norm(y, axis=1, keepdims=True) + 1e-9)
        return x @ y.T
    return 0.5 * (1.0 - cos(a[:, :88], b[:, :88])) + 0.5 * (1.0 - cos(a[:, 88:], b[:, 88:]))


def pav(y: np.ndarray, w: np.ndarray | None = None) -> np.ndarray:
    """The non-decreasing sequence nearest to `y` in weighted least squares (pool adjacent violators)."""
    w = np.ones(len(y)) if w is None else np.asarray(w, dtype=float)
    vals, wts, cnt = [], [], []
    for yi, wi in zip(np.asarray(y, dtype=float), w):
        vals.append(yi)
        wts.append(wi)
        cnt.append(1)
        while len(vals) > 1 and vals[-2] > vals[-1]:
            v1, w1, c1 = vals.pop(), wts.pop(), cnt.pop()
            vals[-1] = (vals[-1] * wts[-1] + v1 * w1) / (wts[-1] + w1)
            wts[-1] += w1
            cnt[-1] += c1
    return np.repeat(vals, cnt)


def align(notes: list[Note], ref: Reference) -> Fit:
    """The map score quarters -> seconds of the recording, from the transcribed `notes`."""
    import librosa
    if not notes or not ref.notes:
        raise ScoreMismatch("no notes to align (the recording's or the score's)")
    tp, vp = clusters(np.array([n.start for n in notes]), np.array([n.pitch for n in notes]), CLUSTER_GAP)
    qs, vs = clusters(np.array([n.q_on for n in ref.notes]), np.array([n.pitch for n in ref.notes]), 1e-6)
    C = pair_cost(vp, vs)
    if len(tp) <= len(qs):  # librosa's subsequence query must be the shorter sequence
        _, wp = librosa.sequence.dtw(C=C, subseq=True, backtrack=True)
    else:
        _, wp = librosa.sequence.dtw(C=C.T, subseq=True, backtrack=True)
        wp = wp[:, ::-1]
    wp = wp[::-1]
    ok = C[wp[:, 0], wp[:, 1]] < MAX_COST
    matched = len(np.unique(wp[ok, 0])) / len(tp)
    if matched < MIN_MATCHED or ok.sum() < 4:
        raise ScoreMismatch(f"the score fits {matched:.0%} of the recording's note onsets (under {MIN_MATCHED:.0%}): "
                            "another piece, another arrangement, or another recording")
    q, t = qs[wp[ok, 1]], tp[wp[ok, 0]]
    uq = np.unique(q)
    ut = pav(np.array([np.median(t[q == u]) for u in uq]), np.array([np.sum(q == u) for u in uq], dtype=float))
    keep = np.r_[True, np.diff(ut) > 1e-3]  # one knot per time: a pooled run keeps its first quarter
    if keep.sum() < 2:
        raise ScoreMismatch("the score's notes matched one moment of the recording only")
    return Fit(uq[keep], ut[keep], round(float(matched), 3), (float(t.min()), float(t.max())))


def writable_meter(meter: str | None) -> tuple[str, int, int]:
    """The score's meter as the grid writes it, with (tatums a beat, tatums a bar)."""
    m = SAME.get(meter or "", meter)
    gm = next((k for k, v in METERS.items() if v == m), None)
    if gm is None:
        raise ScoreMismatch(f"the score's meter {meter or '(none)'} is not one the score writer knows "
                            f"({', '.join(METERS.values())}, and 2/2, 6/4)")
    return m, gm[0], gm[1]


def score_bars(path: Path) -> list[tuple[float, float, str | None]]:
    """The score's bars as (start, length in quarters, meter; None for a bar shorter than its meter's, a pickup),
    in the quarters `evaluate.load_reference` gives the notes (MusicXML repeats expanded). In MIDI the bars of
    each time signature from its start to the next one (ASAP's MIDI scores write a pickup, a cadenza or a
    fermata bar as a time signature of its own: 1/16, 65/4 ...)."""
    if path.suffix.lower() in (".mid", ".midi"):
        import pretty_midi
        pm = pretty_midi.PrettyMIDI(str(path))
        end = pm.time_to_tick(pm.get_end_time()) / pm.resolution
        ts = pm.time_signature_changes
        qs = [pm.time_to_tick(x.time) / pm.resolution for x in ts]
        out = []
        for i, (q, x) in enumerate(zip(qs, ts)):
            stop, bar = (qs[i + 1] if i + 1 < len(qs) else end), x.numerator * 4.0 / x.denominator
            while q < stop - 1e-6:
                n = min(bar, stop - q)
                out.append((q, n, f"{x.numerator}/{x.denominator}" if n > bar - 1e-6 else None))
                q += n
        return out
    from music21 import converter
    s = converter.parse(str(path))
    try:
        s = s.expandRepeats()
    except Exception:  # noqa: BLE001 — as evaluate.load_reference: the score as written
        pass
    part = s.parts[0] if s.parts else s
    out, cur = [], None
    for mz in part.getElementsByClass("Measure"):
        cur = mz.timeSignature.ratioString if mz.timeSignature is not None else cur
        n = float(mz.duration.quarterLength)
        out.append((float(mz.offset), n, cur if cur and n > float(mz.barDuration.quarterLength) - 1e-6 else None))
    return out


def main_meter(bars: list[tuple[float, float, str | None]]) -> str | None:
    """The meter of the most quarters of full bars."""
    total: dict[str, float] = {}
    for _, n, m in bars:
        if m is not None:
            total[m] = total.get(m, 0.0) + n
    return max(total, key=lambda m: total[m]) if total else None


def written_q(bars: list[tuple[float, float, str | None]], bar_q: float) -> tuple[np.ndarray, np.ndarray]:
    """Knots of the map score quarters -> written quarters, in which every bar line of the score falls on a whole
    bar of `bar_q`: a bar of bar_q, or up to a tatum longer, is written as one bar (a fermata or cadenza bar of
    4.06 quarters in 4/4), and a run of other bars as the nearest whole number of bars, at least one (an intro
    of three 2/4 bars and two 1/4 bars in 4/4 is 2 bars, as written; a bar of 3.5 quarters before a repeat and
    the eighth pickup after it are one bar). Before the first bar of bar_q length (a pickup) the quarters are
    kept; that bar line is written quarter 0."""
    near = [bar_q - 1e-3 <= n <= bar_q + TATUM_Q + 1e-6 for _, n, _ in bars]
    if not any(near):
        raise ScoreMismatch("the score has no bar of its meter's length")
    i0 = near.index(True)
    s0 = bars[i0][0]
    sq, wq = [bars[0][0], s0], [bars[0][0] - s0, 0.0]
    i, w = i0, 0.0
    while i < len(bars):
        if near[i]:
            j = i + 1
        else:
            j = i
            while j < len(bars) and not near[j]:
                j += 1
        end = bars[j - 1][0] + bars[j - 1][1]
        w += bar_q if near[i] else max(1, round((end - bars[i][0]) / bar_q)) * bar_q
        sq.append(end)
        wq.append(w)
        i = j
    sq, wq = np.array(sq), np.array(wq)
    keep = np.r_[True, np.diff(sq) > 1e-9]
    return sq[keep], wq[keep]


def fit_grid(notes: list[Note], ref: Reference, bars: list[tuple[float, float, str | None]] | None = None,
             fit: Fit | None = None) -> tuple[Grid, dict]:
    """The grid of the recording from the score: knots at every eighth and every bar line of the score through
    `align`'s map (`fit`, aligned here when not given), written in quarters where the score's bar lines (`bars`,
    `score_bars`; regular bars of the meter from 0 without them) fall on whole bars (`written_q`), and shifted so
    that the bar holding the first note is bar 0 (as `meter.grid_from`)."""
    meter, g, m = writable_meter(ref.meter)
    fit = fit if fit is not None else align(notes, ref)
    bar_q = m * TATUM_Q
    lo = np.floor(min(n.q_on for n in ref.notes) / TATUM_Q) * TATUM_Q
    hi = np.ceil(max(n.q_off for n in ref.notes) / TATUM_Q) * TATUM_Q
    if not bars:
        bars = [(float(b), bar_q, meter) for b in np.arange(0.0, hi + 1e-9, bar_q)]
    sq, wq = written_q(bars, bar_q)
    q = np.unique(np.r_[np.arange(lo, hi + 1e-9, TATUM_Q), sq[(sq >= lo) & (sq <= hi)]])
    t = fit.to_sec(q)
    q = np.interp(q, sq, wq) + np.where(q < sq[0], q - sq[0], 0.0) + np.where(q > sq[-1], q - sq[-1], 0.0)
    beat_q = g * TATUM_Q
    # the tempo where the score met the recording: past it the map only runs on (a trimmed recording, page 1)
    tb = np.interp(np.arange(q[0], q[-1], beat_q), q, t) if q[-1] - q[0] > beat_q else np.zeros(0)
    d = np.diff(tb[(tb >= fit.span[0]) & (tb <= fit.span[1])])
    d = d if np.any(d > 0) else np.diff(tb)  # under two beats matched: the whole map's tempo
    if not np.any(d > 0):
        raise ScoreMismatch("the score is shorter than a beat")
    bpm = 60.0 / float(np.median(d[d > 0]))
    first = min(n.start for n in notes)
    grid = Grid(t=t, q=_bar0(t, q, first, TATUM_Q, bar_q), meter=meter, bar_q=bar_q, tatum_q=TATUM_Q,
                beat_q=beat_q, bpm=bpm)
    return grid, {"meter": meter, "written_meter": ref.meter, "matched": fit.matched,
                  "span_s": [round(fit.span[0], 2), round(fit.span[1], 2)], "knots": int(len(fit.q))}


def score_file_grid(notes: list[Note], path: Path) -> tuple[Grid, dict]:
    from dataclasses import replace
    path = Path(path)
    bars = score_bars(path)
    ref = load_reference(path)
    if main_meter(bars) is None and ref.meter is None:
        raise ScoreMismatch("the score has no time signature")
    fit = align(notes, ref)
    # the meter of the bars the recording matched: a file of a whole sonata, or of a prelude and its fugue, holds
    # other meters in the movements the recording does not play (§55)
    inside = [b for b in bars if b[0] + b[1] > fit.q[0] and b[0] < fit.q[-1]]
    meter = main_meter(inside) or main_meter(bars) or ref.meter
    return fit_grid(notes, replace(ref, meter=meter), bars, fit)
