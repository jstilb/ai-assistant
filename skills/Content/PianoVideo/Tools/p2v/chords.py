"""Chord recognition from transcribed notes, and the lead sheet built on it (DESIGN.md §4, §9).

Per beat of the score grid: a pitch-class profile (duration x velocity) and a bass profile (the
lowest sounding note), matched against chord templates, then a Viterbi path that lets the chord
change cheaply on a bar line, less cheaply on a half bar and dearly on any other beat.
Pure numpy; measured on POP909's piano arrangements (DESIGN.md §9).
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np

from .arrange import Note, sort_notes
from .meter import Grid

QUALITIES: dict[str, tuple[int, ...]] = {
    "maj": (0, 4, 7), "min": (0, 3, 7), "7": (0, 4, 7, 10), "maj7": (0, 4, 7, 11), "min7": (0, 3, 7, 10),
    "dim": (0, 3, 6), "sus4": (0, 5, 7),
}
BASIC = ("maj", "min", "7")  # a beginner's vocabulary: triads and the dominant seventh
FULL = tuple(QUALITIES)
KINDS = {"maj": "major", "min": "minor", "7": "dominant-seventh", "maj7": "major-seventh",
         "min7": "minor-seventh", "dim": "diminished", "sus4": "suspended-fourth"}
FPS = 20.0  # frames per second of the piano roll the profiles are summed from


@dataclass(frozen=True)
class Chord:
    start_q: float
    end_q: float
    root: int | None  # pitch class; None = no chord ("N")
    quality: str = "maj"
    bass: int | None = None  # pitch class of a slash bass, None = root position

    @property
    def harte(self) -> str:
        """Label in Harte syntax for mir_eval ("A:min", "N")."""
        if self.root is None:
            return "N"
        names = ("C", "C#", "D", "Eb", "E", "F", "F#", "G", "Ab", "A", "Bb", "B")
        return f"{names[self.root]}:{self.quality}"


def beat_features(notes: list[Note], edges: np.ndarray, fps: float = FPS) -> tuple[np.ndarray, np.ndarray]:
    """(chroma, bass), each (segments, 12), for the segments between consecutive `edges` (seconds).
    chroma: sounding time x velocity per pitch class. bass: frames in which that pitch class is the
    lowest sounding note."""
    k = len(edges) - 1
    chroma, bass = np.zeros((max(k, 0), 12)), np.zeros((max(k, 0), 12))
    if k <= 0 or not notes:
        return chroma, bass
    t0 = float(edges[0])
    n_fr = int(np.ceil((float(edges[-1]) - t0) * fps)) + 1
    roll = np.zeros((n_fr, 128))
    for n in notes:
        a, b = int(np.floor((n.start - t0) * fps)), int(np.ceil((n.end - t0) * fps))
        a, b = max(a, 0), min(b, n_fr)
        if b > a:
            roll[a:b, n.pitch] = np.maximum(roll[a:b, n.pitch], n.velocity / 127.0)
    seg = np.clip(np.searchsorted(edges, t0 + (np.arange(n_fr) + 0.5) / fps, side="right") - 1, 0, k - 1)
    pcs = np.arange(128) % 12
    for pc in range(12):
        np.add.at(chroma[:, pc], seg, roll[:, pcs == pc].sum(axis=1))
    on = roll > 0
    low = np.where(on.any(axis=1), on.argmax(axis=1), -1)
    np.add.at(bass, (seg[low >= 0], low[low >= 0] % 12), 1.0)
    return chroma, bass


def labels(vocab: tuple[str, ...]) -> list[tuple[int | None, str]]:
    """State list for the smoother: every root x quality, then "N"."""
    return [(r, q) for q in vocab for r in range(12)] + [(None, "N")]


def template_scores(chroma: np.ndarray, bass: np.ndarray, vocab: tuple[str, ...] = BASIC,
                    bass_weight: float = 0.2, no_chord: float = 0.25, extra_cost: float = 0.08) -> np.ndarray:
    """(segments, states) match scores: cosine of the beat's profile with each chord template, plus
    `bass_weight` x the share of the beat whose lowest note is the root, minus `extra_cost` per
    template tone beyond three (a seventh must earn its place). "N" scores `no_chord`; a silent
    beat scores 0 for every chord."""
    norm = np.linalg.norm(chroma, axis=1, keepdims=True)
    c = np.divide(chroma, norm, out=np.zeros_like(chroma), where=norm > 0)
    bsum = bass.sum(axis=1, keepdims=True)
    b = np.divide(bass, bsum, out=np.zeros_like(bass), where=bsum > 0)
    cols = []
    for q in vocab:
        tones = QUALITIES[q]
        t = np.zeros(12)
        t[list(tones)] = 1.0
        t /= np.linalg.norm(t)
        for r in range(12):
            cols.append(c @ np.roll(t, r) + bass_weight * b[:, r] - extra_cost * (len(tones) - 3))
    return np.column_stack(cols + [np.full(len(chroma), no_chord)])


def smooth(scores: np.ndarray, change_cost: np.ndarray) -> np.ndarray:
    """Viterbi path (state per segment) maximising summed scores minus `change_cost[k]` whenever the
    state changes at the start of segment k (change_cost[0] is unused)."""
    k, s = scores.shape
    if k == 0:
        return np.zeros(0, dtype=int)
    acc, back = scores[0].copy(), np.zeros((k, s), dtype=int)
    for i in range(1, k):
        best = int(acc.argmax())
        switch = acc[best] - change_cost[i]
        stay = acc >= switch
        back[i] = np.where(stay, np.arange(s), best)
        acc = np.where(stay, acc, switch) + scores[i]
    path = np.empty(k, dtype=int)
    path[-1] = int(acc.argmax())
    for i in range(k - 1, 0, -1):
        path[i - 1] = back[i, path[i]]
    return path


def beat_edges(grid: Grid, t0: float, t1: float) -> np.ndarray:
    """Score positions (quarters) of every counted beat covering [t0, t1] seconds."""
    q0, q1 = (float(x) for x in grid.sec_to_q([t0, t1]))
    return np.arange(np.floor(q0 / grid.beat_q), np.ceil(q1 / grid.beat_q) + 1) * grid.beat_q


def change_costs(edges_q: np.ndarray, grid: Grid, bar: float = 0.3, half: float = 0.3,
                 beat: float = 0.6) -> np.ndarray:
    """Cost of a chord change at each segment start: `bar` on a bar line, `half` on a half bar
    (when it falls on a beat), `beat` elsewhere. These and template_scores' weights were grid-searched
    on POP909 songs 001-454 (majmin 0.898; untuned 0.15/0.4/0.8, bass 0.3, extra 0.04: held-out
    0.912 -> 0.922). Sensitivity is small: the top 8 of 432 settings lie within 0.001."""
    def on(step: float) -> np.ndarray:
        r = np.mod(edges_q[:-1], step)
        return (r < 1e-6) | (step - r < 1e-6)
    half_q = grid.bar_q / 2
    halves = on(half_q) if abs(half_q / grid.beat_q - round(half_q / grid.beat_q)) < 1e-6 else np.zeros(len(edges_q) - 1, bool)
    return np.where(on(grid.bar_q), bar, np.where(halves, half, beat))


def recognize(notes: list[Note], grid: Grid, vocab: tuple[str, ...] = BASIC, slash: float = 0.6,
              costs: dict[str, float] | None = None, **score_kw) -> list[Chord]:
    """Chords over the notes' span, one per run of equal beats. A chord gets a slash bass when
    another of its tones is the lowest note for at least `slash` of its frames."""
    if not notes:
        return []
    ns = sort_notes(notes)
    eq = beat_edges(grid, ns[0].start, max(n.end for n in ns))
    chroma, bass = beat_features(ns, grid.q_to_sec(eq))
    states = labels(vocab)
    path = smooth(template_scores(chroma, bass, vocab, **score_kw), change_costs(eq, grid, **(costs or {})))
    out: list[Chord] = []
    i = 0
    while i < len(path):
        j = i
        while j + 1 < len(path) and path[j + 1] == path[i]:
            j += 1
        root, q = states[path[i]]
        b = None
        if root is not None:
            bs = bass[i:j + 1].sum(axis=0)
            lo = int(bs.argmax())
            if lo != root and (lo - root) % 12 in QUALITIES[q] and bs[lo] >= slash * max(bs.sum(), 1e-9):
                b = lo
        out.append(Chord(float(eq[i]), float(eq[j + 1]), root, q if root is not None else "N", b))
        i = j + 1
    return out


def voice(c: Chord, lo: int = 48) -> tuple[int, ...]:
    """Left-hand block chord: the bass (the root, or the slash bass) in C3-B3 and the other chord
    tones in close position above it, so the hand never spans more than an octave. A four-note
    chord drops its fifth (root, third, seventh: the usual left-hand shell)."""
    assert c.root is not None
    tones = QUALITIES[c.quality]
    tones = tuple(t for t in tones if t != 7) if len(tones) == 4 else tones
    b = c.root if c.bass is None else c.bass
    bass = lo + (b - lo) % 12
    return (bass, *sorted(bass + (c.root + t - bass) % 12 for t in tones if (c.root + t) % 12 != b))


def block_chords(chords: list[Chord], grid: Grid, velocity: int = 64) -> list[Note]:
    """The lead sheet's left hand: each chord's voicing held for its span, struck again at every
    bar line it crosses (a beginner counts bars, and a held chord reads as one whole note per bar)."""
    out: list[Note] = []
    for c in chords:
        if c.root is None:
            continue
        ps = voice(c)
        bars = np.arange(np.floor(c.start_q / grid.bar_q) + 1, np.ceil(c.end_q / grid.bar_q)) * grid.bar_q
        edges = [c.start_q, *(float(x) for x in bars if c.start_q < x < c.end_q), c.end_q]
        for a, b in zip(edges, edges[1:]):
            t0, t1 = (float(x) for x in grid.q_to_sec([a, b]))
            out += [Note(start=t0, end=t1, pitch=p, velocity=velocity, role="accomp", hand="L") for p in ps]
    return sort_notes(out)
