"""Sung melody -> one note line: pYIN f0 contour -> notes (DESIGN.md §10).

`contour_to_notes` is pure (numpy only, unit-tested); `f0_contour` runs librosa.pyin on a stem.
"""

from __future__ import annotations

import numpy as np

from .arrange import Note

SR, HOP = 22050, 256  # pYIN frames: 11.6 ms


def _median(x: np.ndarray, w: int) -> np.ndarray:
    """Running median over w frames (odd), NaN-aware, edges shrink."""
    h = w // 2
    return np.array([np.nanmedian(x[max(0, i - h):i + h + 1]) for i in range(len(x))])


def contour_to_notes(t: np.ndarray, midi: np.ndarray, *, smooth: float = 0.12, min_note: float = 0.12,
                     bridge: float = 0.035, octave_win: float = 0.5) -> list[Note]:
    """Segment a monophonic f0 contour (MIDI floats, NaN = unvoiced) into notes.

    1. unvoiced gaps <= `bridge` s are bridged (pYIN drops single frames inside a note); longer gaps end a note
    2. octave blips: a frame more than 9 semitones off the voiced run's running median (`octave_win` s)
       moves by whole octaves toward it
    3. the contour is median-smoothed (`smooth` s) and rounded; runs of one pitch shorter than `min_note`
       (vibrato swings, glides between notes) join the neighbour nearest in pitch, then equal neighbours merge
    4. a note's pitch is the median of its raw frames, rounded
    """
    t, midi = np.asarray(t, float), np.asarray(midi, float)
    if len(t) < 2:
        return []
    hop = float(np.median(np.diff(t)))
    frames = lambda s: max(1, int(round(s / hop)))  # noqa: E731
    voiced = ~np.isnan(midi)
    idx = np.flatnonzero(voiced)
    if not len(idx):
        return []
    # voiced runs, bridging short gaps
    runs, s = [], idx[0]
    for a, b in zip(idx, idx[1:]):
        if b - a - 1 > frames(bridge):
            runs.append((s, a + 1))
            s = b
    runs.append((s, idx[-1] + 1))

    notes: list[Note] = []
    for r0, r1 in runs:
        seg = midi[r0:r1].copy()
        if np.isnan(seg).all():
            continue
        ref = _median(seg, 2 * (frames(octave_win) // 2) + 1)
        off = seg - ref
        bad = np.abs(off) > 9
        seg[bad] -= 12 * np.round(off[bad] / 12)
        q = np.round(_median(seg, 2 * (frames(smooth) // 2) + 1))
        # run-length segments [start, end) of equal rounded pitch
        cuts = [0] + [i for i in range(1, len(q)) if q[i] != q[i - 1] and not (np.isnan(q[i]) and np.isnan(q[i - 1]))]
        segs = [[a, b] for a, b in zip(cuts, cuts[1:] + [len(q)])]
        pitch = lambda g: float(np.nanmedian(seg[g[0]:g[1]])) if not np.isnan(seg[g[0]:g[1]]).all() else np.nan  # noqa: E731
        while len(segs) > 1:  # absorb the shortest too-short segment into its nearest-pitch neighbour
            lens = [b - a for a, b in segs]
            i = int(np.argmin(lens))
            if lens[i] >= frames(min_note):
                break
            p = pitch(segs[i])
            nb = [j for j in (i - 1, i + 1) if 0 <= j < len(segs)]
            j = min(nb, key=lambda j: abs(pitch(segs[j]) - p) if not np.isnan(p) else 0)
            lo, hi = min(i, j), max(i, j)
            segs[lo:hi + 1] = [[segs[lo][0], segs[hi][1]]]
        merged: list[list[int]] = []
        for g in segs:  # neighbours that round to the same pitch are one note
            if merged and np.round(pitch(merged[-1])) == np.round(pitch(g)):
                merged[-1][1] = g[1]
            else:
                merged.append(g)
        for a, b in merged:
            p = pitch([a, b])
            if np.isnan(p) or (b - a) < frames(min_note):
                continue
            notes.append(Note(start=float(t[r0 + a]), end=float(t[r0 + b - 1] + hop), pitch=int(round(p)),
                              velocity=80, role="lead"))
    return notes


def f0_contour(audio: np.ndarray, sr: int = SR) -> tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray]:
    """librosa.pyin over C2..C6 -> frame times, best-guess MIDI pitch per frame, voiced probability,
    frame level (dB below the loudest frame)."""
    import librosa
    f0, _, prob = librosa.pyin(audio, fmin=librosa.note_to_hz("C2"), fmax=librosa.note_to_hz("C6"),
                               sr=sr, frame_length=2048, hop_length=HOP, fill_na=None)
    rms = librosa.feature.rms(y=audio, frame_length=2048, hop_length=HOP)[0][: len(f0)]
    db = 20 * np.log10(rms / (rms.max() + 1e-12) + 1e-12)
    return librosa.times_like(f0, sr=sr, hop_length=HOP), librosa.hz_to_midi(f0), prob, db


def voiced_midi(midi: np.ndarray, prob: np.ndarray, db: np.ndarray, p_min: float = 0.02,
                db_min: float = -30.0) -> np.ndarray:
    """The contour with NaN where pYIN found no pitch or the frame is quiet (breaths, room, Demucs bleed).
    pYIN's voiced probability sits at its 0.01 floor on frames with no pitch candidate: on Vocadito 75% of
    unvoiced frames have exactly that and 96% of voiced frames have more, so `p_min` just above the floor
    is the voicing test. pYIN's own HMM voiced flag passed 49% of unvoiced frames (notes ran through
    breaths); p_min 0.5 lost a third of the sung notes (recall 0.30)."""
    return np.where((prob >= p_min) & (db >= db_min), midi, np.nan)
