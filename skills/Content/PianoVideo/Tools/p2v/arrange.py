"""Pure note transforms: turn raw transcriptions into a two-hand piano arrangement.

Everything here operates on plain `Note` lists (times in seconds) and has no ML
or I/O dependencies, so it is fully unit-tested in __tests__/test_arrange.py.
"""

from __future__ import annotations

from dataclasses import dataclass, replace
from typing import Iterable, Literal

import numpy as np

PIANO_LO, PIANO_HI = 21, 108  # A0 .. C8

Role = Literal["lead", "accomp", "bass"]
Hand = Literal["R", "L"]

# Registers (MIDI pitch, inclusive lo / exclusive hi) used when arranging
# non-piano stems onto the keyboard.
LEAD_RANGE = (64, 89)    # E4 .. E6  — right-hand melody
ACCOMP_RANGE = (48, 72)  # C3 .. B4  — chord voicings under the melody
BASS_RANGE = (28, 53)    # E1 .. E3  — left-hand bass line

CHORD_TOL = 0.035  # seconds — onsets closer than this count as one chord


@dataclass(frozen=True)
class Note:
    start: float
    end: float
    pitch: int
    velocity: int = 80
    role: Role = "accomp"
    hand: Hand | None = None

    @property
    def dur(self) -> float:
        return self.end - self.start


def sort_notes(notes: Iterable[Note]) -> list[Note]:
    return sorted(notes, key=lambda n: (n.start, n.pitch))


def drop_short(notes: Iterable[Note], min_dur: float) -> list[Note]:
    return [n for n in notes if n.dur >= min_dur]


def with_role(notes: Iterable[Note], role: Role) -> list[Note]:
    return [replace(n, role=role) for n in notes]


def clamp_to_piano(notes: Iterable[Note]) -> list[Note]:
    """Octave-fold anything outside the 88 keys back onto the keyboard."""
    out = []
    for n in notes:
        p = n.pitch
        while p < PIANO_LO:
            p += 12
        while p > PIANO_HI:
            p -= 12
        out.append(replace(n, pitch=p))
    return out


def skyline(notes: Iterable[Note], top: bool = True, tol: float = CHORD_TOL) -> list[Note]:
    """Reduce polyphony to a single line (highest voice if top, else lowest).

    A note survives unless a more extreme note is already sounding at its onset
    (and started more than `tol` earlier — near-simultaneous onsets are a chord,
    where the extreme pitch wins). A surviving note truncates the previous line
    note so the result is strictly monophonic.
    """
    better = (lambda a, b: a > b) if top else (lambda a, b: a < b)
    line: list[Note] = []
    for n in sort_notes(notes):
        if not line:
            line.append(n)
            continue
        last = line[-1]
        sounding = last.end > n.start
        if sounding and abs(n.start - last.start) <= tol:
            if better(n.pitch, last.pitch):
                line[-1] = n
            continue
        if sounding and not better(n.pitch, last.pitch) and n.pitch != last.pitch:
            continue  # inner voice under a held line note
        if sounding:
            line[-1] = replace(last, end=n.start)
        line.append(n)
    return [n for n in line if n.dur > 0]


def best_octave_shift(notes: list[Note], lo: int, hi: int) -> int:
    """Single octave transposition (in semitones) that puts the most notes in [lo, hi)."""
    if not notes:
        return 0
    pitches = np.array([n.pitch for n in notes])
    best, best_score = 0, -1
    for k in range(-4, 5):
        shifted = pitches + 12 * k
        score = int(((shifted >= lo) & (shifted < hi)).sum())
        # prefer the smallest shift on ties
        if score > best_score or (score == best_score and abs(k) < abs(best) // 12):
            best, best_score = 12 * k, score
    return best


def fit_register(notes: Iterable[Note], lo: int, hi: int, keep_contour: bool = True) -> list[Note]:
    """Move a part into a register.

    keep_contour: first shift the whole line by one octave amount (melodies keep
    their shape), then octave-fold only the stragglers.
    """
    notes = list(notes)
    shift = best_octave_shift(notes, lo, hi) if keep_contour else 0
    out = []
    for n in notes:
        p = n.pitch + shift
        while p < lo:
            p += 12
        while p >= hi:
            p -= 12
        out.append(replace(n, pitch=p))
    return out


def limit_polyphony(notes: Iterable[Note], max_notes: int, tol: float = CHORD_TOL) -> list[Note]:
    """Thin dense chords: per onset cluster keep the `max_notes` loudest
    (always keeping the cluster's top and bottom pitch so the voicing's shape survives)."""
    out: list[Note] = []
    cluster: list[Note] = []

    def flush():
        if not cluster:
            return
        uniq = {}
        for n in cluster:  # collapse duplicate pitches, keep loudest
            if n.pitch not in uniq or n.velocity > uniq[n.pitch].velocity:
                uniq[n.pitch] = n
        c = sorted(uniq.values(), key=lambda n: n.pitch)
        if len(c) > max_notes:
            keep = {c[0].pitch, c[-1].pitch} if max_notes >= 2 else {c[-1].pitch}
            for n in sorted(c[1:-1], key=lambda n: -n.velocity):
                if len(keep) >= max_notes:
                    break
                keep.add(n.pitch)
            c = [n for n in c if n.pitch in keep]
        out.extend(c)
        cluster.clear()

    for n in sort_notes(notes):
        if cluster and n.start - cluster[0].start > tol:
            flush()
        cluster.append(n)
    flush()
    return out


def merge_same_pitch(notes: Iterable[Note], gap: float = 0.0) -> list[Note]:
    """Merge overlapping (or gap-adjacent) notes of the same pitch — needed when
    several stems are transcribed into one accompaniment part."""
    by_pitch: dict[int, list[Note]] = {}
    for n in sort_notes(notes):
        lst = by_pitch.setdefault(n.pitch, [])
        if lst and n.start <= lst[-1].end + gap:
            prev = lst[-1]
            lst[-1] = replace(prev, end=max(prev.end, n.end), velocity=max(prev.velocity, n.velocity))
        else:
            lst.append(n)
    return sort_notes(x for lst in by_pitch.values() for x in lst)


def drop_doubled(accomp: Iterable[Note], lead: list[Note]) -> list[Note]:
    """Remove accompaniment notes that double a sounding lead note (same pitch)."""
    out = []
    for a in accomp:
        clash = any(l.pitch == a.pitch and l.start < a.end and a.start < l.end for l in lead)
        if not clash:
            out.append(a)
    return out


def assign_hands(notes: Iterable[Note], split: int = 60) -> list[Note]:
    """Lead -> right hand, bass -> left hand, everything else split at `split` (default middle C)."""
    out = []
    for n in notes:
        if n.role == "lead":
            h: Hand = "R"
        elif n.role == "bass":
            h = "L"
        else:
            h = "R" if n.pitch >= split else "L"
        out.append(replace(n, hand=h))
    return sort_notes(out)


def scale_velocity(notes: Iterable[Note], factor: float) -> list[Note]:
    return [replace(n, velocity=int(np.clip(round(n.velocity * factor), 1, 127))) for n in notes]


# --------------------------------------------------------------------------- #
# Arrangement recipes — one per (source, parts) choice. See DESIGN.md §4.
# --------------------------------------------------------------------------- #

def arrange_piano_only(piano: list[Note], parts: str, split: int = 60) -> list[Note]:
    """source=piano: the song already has a piano part; transcribe it as-is."""
    notes = clamp_to_piano(drop_short(piano, 0.03))
    if parts == "lead":
        mel = skyline(notes, top=True)
        return assign_hands(with_role(drop_short(mel, 0.06), "lead"))
    return assign_hands(with_role(notes, "accomp"), split=split)


def arrange_full(
    lead: list[Note],
    harmony: list[Note],
    bass: list[Note],
    parts: str,
    max_chord: int = 4,
) -> list[Note]:
    """source=arrange: re-voice the song's core components for two hands.

    lead    — melody stem (usually vocals) -> monophonic RH line
    harmony — chordal stems (piano/guitar/other) -> thinned voicings, C3..B4
    bass    — bass stem -> monophonic LH line
    """
    mel = skyline(drop_short(lead, 0.08), top=True)
    mel = with_role(fit_register(drop_short(mel, 0.08), *LEAD_RANGE), "lead")
    if parts == "lead":
        return assign_hands(mel)

    bl = skyline(drop_short(bass, 0.08), top=False)
    bl = with_role(fit_register(bl, *BASS_RANGE), "bass")

    hm = merge_same_pitch(fit_register(drop_short(harmony, 0.06), *ACCOMP_RANGE, keep_contour=False))
    hm = limit_polyphony(hm, max_chord)
    hm = drop_doubled(hm, mel)
    # and any that double a sounding bass note
    hm = [n for n in hm if not any(b.pitch == n.pitch and b.start < n.end and n.start < b.end for b in bl)]
    hm = with_role(scale_velocity(hm, 0.75), "accomp")
    return assign_hands(mel + hm + bl)


def beats_to_seconds_fn(beat_times: np.ndarray):
    """Return (sec->beat, beat->sec) maps through detected beats, linearly
    extrapolated past both ends so every note gets a beat position."""
    bt = np.asarray(beat_times, dtype=float)
    if len(bt) < 2:
        bt = np.array([0.0, 0.5])
    period_lo = bt[1] - bt[0]
    period_hi = bt[-1] - bt[-2]
    idx = np.arange(len(bt), dtype=float)

    def sec_to_beat(t):
        t = np.asarray(t, dtype=float)
        b = np.interp(t, bt, idx)
        b = np.where(t < bt[0], (t - bt[0]) / period_lo, b)
        b = np.where(t > bt[-1], idx[-1] + (t - bt[-1]) / period_hi, b)
        return b

    def beat_to_sec(b):
        b = np.asarray(b, dtype=float)
        s = np.interp(b, idx, bt)
        s = np.where(b < 0, bt[0] + b * period_lo, s)
        s = np.where(b > idx[-1], bt[-1] + (b - idx[-1]) * period_hi, s)
        return s

    return sec_to_beat, beat_to_sec
