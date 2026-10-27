"""Meter: where the bars and beats of a performance are, as a map from seconds to score position.

A piano performance has no bar lines, and its beat tracker output is not a score grid: on
Connections (6/4 written, felt in dotted quarters) librosa's tracker flipped between dotted-
quarter and half-note beats from bar to bar, and the score put eighths at 1/3 of a beat on a
16th grid. So the grid is built in levels, each from the transcribed notes:

  1. beats     one metrical level for the whole piece (tempo path through the tempogram)
  2. tatum     the fastest regular pulse (usually the eighth): beats split in 2 (simple meter)
               or 3 (compound), tracked on its own
  3. bars      bar length in tatums (2/4 3/4 4/4 or 6/8 9/8 12/8) from where bass notes, harmony
               changes and long notes fall, then downbeats by dynamic programming (a bar may run
               a tatum or two long or short where the tatum tracker slipped in rubato)

Each bar is then fitted onto exactly one written bar (the slipped tatum dropped or added where
no note starts), so a tracking slip stays inside its bar and onsets stay on the grid.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

import numpy as np

from .arrange import CHORD_TOL, Note

SR, HOP = 22050, 512
BASS_WEIGHT = 3.0  # onset-curve weight of notes below C3 (they mark strong beats)


@dataclass(frozen=True)
class Grid:
    """Seconds <-> score quarter offsets (knots `t`/`q`, linear between, extrapolated outside)."""
    t: np.ndarray
    q: np.ndarray
    meter: str        # time signature, e.g. "12/8"
    bar_q: float      # quarters per bar
    tatum_q: float    # quarters per tatum (0.5 = eighth)
    beat_q: float     # quarters per counted beat (1.5 in compound meter)
    bpm: float        # counted beats per minute (median)

    def sec_to_q(self, t):
        return _extrap(t, self.t, self.q)

    def q_to_sec(self, q):
        return _extrap(q, self.q, self.t)

    def to_json(self) -> dict:
        return {"t": [round(float(x), 4) for x in self.t], "q": [round(float(x), 4) for x in self.q],
                "meter": self.meter, "bar_q": self.bar_q, "tatum_q": self.tatum_q, "beat_q": self.beat_q,
                "bpm": round(self.bpm, 1)}


def _extrap(x, xp, fp):
    x = np.asarray(x, dtype=float)
    lo = (fp[1] - fp[0]) / (xp[1] - xp[0])
    hi = (fp[-1] - fp[-2]) / (xp[-1] - xp[-2])
    return np.where(x < xp[0], fp[0] + (x - xp[0]) * lo,
                    np.where(x > xp[-1], fp[-1] + (x - xp[-1]) * hi, np.interp(x, xp, fp)))


# ------------------------------------------------------------------ beats -- #

def note_envelope(notes: list[Note], n_frames: int) -> np.ndarray:
    """Onset curve from transcribed notes (bass notes x BASS_WEIGHT: they mark strong beats). On
    pedalled piano note onsets are cleaner than the audio's."""
    env = np.zeros(n_frames)
    if notes:
        idx = np.clip((np.array([n.start for n in notes]) * SR / HOP).astype(int), 0, n_frames - 1)
        np.add.at(env, idx, [n.velocity / 127 * (BASS_WEIGHT if n.pitch < 48 else 1.0) for n in notes])
    return np.convolve(env, np.hanning(5), mode="same")


def tempo_path(env: np.ndarray, sigma: float = 0.02, lo: float = 50.0, hi: float = 170.0,
               step: int = 4) -> np.ndarray:
    """Local tempo (bpm per frame) that stays on one metrical level: the Viterbi path through the
    tempogram (librosa's 120 bpm log-normal prior), paying for every change in log tempo. A
    frame-wise argmax + median filter jumped between dotted-quarter and half-note beats on
    Connections (15% of bars got 3 beats); sigma 0.02 octave per 0.1 s keeps one level there
    and still follows Starlight's 115 -> 92 bpm and a synthetic 120 -> 90 change (0.01 doesn't)."""
    import librosa
    tg = librosa.feature.tempogram(onset_envelope=env, sr=SR, hop_length=HOP, win_length=384)
    bpms = librosa.tempo_frequencies(tg.shape[0], sr=SR, hop_length=HOP)
    keep = (bpms >= lo) & (bpms <= hi)
    tg, bpms = np.maximum(tg[keep][:, ::step], 0.0), bpms[keep]
    lb = np.log2(bpms)
    p = (tg + 1e-6) * np.exp(-0.5 * ((lb - np.log2(120.0)) / 1.0) ** 2)[:, None]
    p /= p.sum(axis=0, keepdims=True)
    trans = np.exp(-0.5 * ((lb[:, None] - lb[None, :]) / sigma) ** 2)
    trans /= trans.sum(axis=1, keepdims=True)
    path = bpms[librosa.sequence.viterbi(p, trans)]
    return np.repeat(path, step)[: len(env)]


def onset_clusters(notes: list[Note]) -> np.ndarray:
    """Distinct onset times (notes within CHORD_TOL are one chord)."""
    out: list[float] = []
    for t in sorted(n.start for n in notes):
        if not out or t - out[-1] > CHORD_TOL:
            out.append(t)
    return np.array(out)


def subdivision(beats: np.ndarray, onsets: np.ndarray, margin: float = 1.5) -> int:
    """3 when off-beat onsets sit at 1/3 and 2/3 of the beat (compound meter), else 2. Onsets near
    1/2 (and 1/4, 3/4 at half weight) count for 2. Triple must win by `margin`, because swung
    eighths also lean to 2/3 and are usually written straight. Measured: Connections 560 vs 124
    (compound), Starlight 17 vs 358 (simple), Viva la FAI 180 vs 137 (too close: simple)."""
    from .arrange import beats_to_seconds_fn
    if len(beats) < 4 or len(onsets) < 8:
        return 2
    s2b, _ = beats_to_seconds_fn(beats)
    f = s2b(onsets) % 1.0
    off = f[np.abs((f + 0.5) % 1.0 - 0.5) > 0.1]

    def near(c, s=0.04):
        d = np.abs((off - c + 0.5) % 1.0 - 0.5)
        return np.exp(-0.5 * (d / s) ** 2).sum()

    duple = near(0.5) + 0.5 * (near(0.25) + near(0.75))
    triple = near(1 / 3) + near(2 / 3)
    return 3 if triple > margin * duple else 2


def track_tatums(env: np.ndarray, beat_bpm: np.ndarray, g: int) -> np.ndarray:
    """Tatum times: the beat tracker run again at g x the local beat tempo, from the first note to
    the last (`trim=False`). Where rubato makes it slip a tatum, fit_bar repairs the bar. (A guide
    from the local onset spacing followed rubato better on Connections but jumped to the wrong
    subdivision on Viva la FAI's mixed rhythms: 161 instead of 129 beats a minute.)"""
    import librosa
    _, tat = librosa.beat.beat_track(onset_envelope=env, sr=SR, hop_length=HOP, bpm=np.resize(beat_bpm, len(env)) * g,
                                     units="time", trim=False)
    return np.asarray(tat, dtype=float)


# ------------------------------------------------------------------- bars -- #

def bar_accents(notes: list[Note], tatums: np.ndarray, g: int, harm_beats: int = 4) -> np.ndarray:
    """Per tatum, how much it looks like a downbeat (sum of z-scores):
    bass  — its lowest onset sits below the lowest onsets of the surrounding +-12 tatums
    harm  — the pitch classes of the next `harm_beats` beats differ from the previous ones'.
            One beat is too short: inside a riff every beat differs, so Starlight's bar lines
            moved to the riff's last note (bar lines hit 22% -> 44% with 4 beats) and
            Connections came out in 6/8 (12/8 with 4 beats)
    long  — a long note starts there (log of the longest sounding duration)"""
    n = len(tatums)
    if not notes or n < 2 * g + 1:
        return np.zeros(n)
    t2c = lambda t: np.interp(t, tatums, np.arange(n, dtype=float))  # noqa: E731
    on = np.array([x.start for x in notes])
    pos = t2c(on)
    ci = np.round(pos).astype(int)
    near = (np.abs(pos - ci) < 0.3) & (on >= tatums[0] - 0.05) & (on <= tatums[-1] + 0.05)
    pitch = np.array([x.pitch for x in notes])
    vel = np.array([x.velocity for x in notes]) / 127.0
    dur = np.array([x.end - x.start for x in notes])
    low = np.full(n, np.nan)
    longest = np.zeros(n)
    for c in np.unique(ci[near]):
        m = near & (ci == c)
        low[c], longest[c] = pitch[m].min(), dur[m].max()
    bass = np.zeros(n)
    for c in np.flatnonzero(~np.isnan(low)):
        bass[c] = max(0.0, float(np.nanmedian(low[max(0, c - 12): c + 13])) - low[c])
    pc = np.zeros((n + 1, 12))
    np.add.at(pc, (ci[near] + 1, pitch[near] % 12), vel[near])
    cs = np.cumsum(pc, axis=0)  # cs[c] = pitch-class weight of tatums < c
    harm = np.zeros(n)
    w = g * harm_beats
    for c in range(w, n - w):
        a, b = cs[c + w] - cs[c], cs[c] - cs[c - w]
        harm[c] = 1.0 - float(a @ b) / (np.linalg.norm(a) * np.linalg.norm(b) + 1e-9)
    z = lambda x: (x - x.mean()) / (x.std() + 1e-9)  # noqa: E731
    return z(bass) + z(harm) + z(np.log1p(longest))


def bar_length(acc: np.ndarray, g: int) -> int:
    """Tatums per bar among the standard meters (g=2: 2/4 3/4 4/4, g=3: 6/8 9/8 12/8): the one
    whose best phase gives the largest accent contrast (downbeats minus the rest)."""
    idx = np.arange(len(acc))

    def contrast(m: int) -> float:
        return max(acc[(idx - ph) % m == 0].mean() - acc[(idx - ph) % m != 0].mean() for ph in range(m))
    cands = [g * k for k in (2, 3, 4)]
    if len(acc) < 2 * max(cands) or not np.any(acc):  # no evidence: the common 4/4 (12/8), not 2/4
        return 4 * g
    return max(cands, key=contrast)


def downbeats(acc: np.ndarray, m: int, slack: int = 2, cost: float = 1.5) -> np.ndarray:
    """Downbeat tatum indices by dynamic programming: maximise the accents on downbeats, bars of
    m +- slack tatums, each tatum off costing `cost` (in z-score units; Connections' bar lines hit
    69% at 1.0, 81% from 1.5 to 3.0; Starlight's intro the same at all). The first downbeat may
    come anywhere in the first bar (a pickup)."""
    n = len(acc)
    score = acc.astype(float).copy()
    back = np.full(n, -1)
    for c in range(n):
        best, arg = (0.0 if c < m + slack else -1e6), -1
        for length in range(m - slack, m + slack + 1):
            p = c - length
            if p >= 0 and score[p] - cost * abs(length - m) > best:
                best, arg = score[p] - cost * abs(length - m), p
        score[c] += best
        back[c] = arg
    lo = max(0, n - m - slack)
    c = int(np.argmax(score[lo:])) + lo
    out = []
    while c >= 0:
        out.append(c)
        c = int(back[c])
    return np.array(out[::-1], dtype=int)


METERS = {(2, 4): "2/4", (2, 6): "3/4", (2, 8): "4/4", (3, 6): "6/8", (3, 9): "9/8", (3, 12): "12/8"}


def fit_bar(times: np.ndarray, strength: np.ndarray, m: int) -> np.ndarray:
    """Exactly m tatum times for one bar (first = downbeat) from the L tracked ones: a tracking slip
    adds or loses a tatum, and stretching the bar evenly would push every onset off the grid. Extra
    tatums are dropped where the fewest notes start (never the downbeat); missing ones are added
    in the middle of the widest gaps (`times` ends with the next downbeat, which is not returned)."""
    keep = list(range(len(times) - 1))
    while len(keep) > m:
        drop = min(keep[1:], key=lambda i: (strength[i], times[i + 1] - times[i - 1]))
        keep.remove(drop)
    t = [float(times[i]) for i in keep] + [float(times[-1])]
    while len(t) - 1 < m:
        j = int(np.argmax(np.diff(t)))
        t.insert(j + 1, (t[j] + t[j + 1]) / 2)
    return np.array(t[:-1])


def grid_from(tatums: np.ndarray, down: np.ndarray, g: int, m: int, first_note: float,
              strength: np.ndarray | None = None) -> Grid:
    """Score positions: every bar (downbeat to downbeat) is exactly one written bar of m tatums
    (fit_bar, by `strength` = notes starting at each tatum; evenly stretched without it); before
    the first and after the last downbeat tatums count on evenly. The bar holding the first note
    becomes bar 0, so a pickup sits at the end of bar 0 and leading silence is dropped."""
    tatum_q = 0.5
    bar_q = m * tatum_q
    n = len(tatums)
    strength = np.zeros(n) if strength is None else strength
    d0, dl = int(down[0]), int(down[-1])
    ts = [tatums[:d0]]
    qs = [-(d0 - np.arange(d0, dtype=float)) * tatum_q]
    for b, (a, z) in enumerate(zip(down[:-1], down[1:])):
        if strength.any():
            t_bar = fit_bar(tatums[a: z + 1], strength[a: z + 1], m)
        else:  # no onset information: stretch evenly
            t_bar = np.interp(np.arange(m) * (z - a) / m, np.arange(z - a + 1), tatums[a: z + 1])
        ts.append(t_bar)
        qs.append(b * bar_q + np.arange(m) * tatum_q)
    ts.append(tatums[dl:])
    qs.append((len(down) - 1) * bar_q + np.arange(n - dl) * tatum_q)
    t, q = np.concatenate(ts), np.concatenate(qs)
    q_first = float(_extrap(first_note, t, q))
    q -= np.floor((q_first + tatum_q / 2) / bar_q) * bar_q  # half a tatum early still counts as on time
    beat_q = g * tatum_q
    bpm = 60.0 / (float(np.median(np.diff(tatums))) * g) if n > 1 else 120.0
    return Grid(t=t, q=q, meter=METERS[(g, m)], bar_q=bar_q, tatum_q=tatum_q, beat_q=beat_q, bpm=bpm)


def track_beats(notes: list[Note], wav: Path | None, duration: float | None = None):
    """(local bpm per frame, beat times) on one metrical level, from the notes' onset curve
    (the audio's own onset curve when there are no notes)."""
    import librosa
    if wav is not None:
        y, _ = librosa.load(str(wav), sr=SR, mono=True)
        n_frames = int(np.ceil(len(y) / HOP)) + 1
    else:
        y, n_frames = None, int(np.ceil((duration or max(n.end for n in notes) + 1) * SR / HOP)) + 1
    env = note_envelope(notes, n_frames) if notes else librosa.onset.onset_strength(y=y, sr=SR, hop_length=HOP)
    local = tempo_path(env)
    _, beats = librosa.beat.beat_track(onset_envelope=env, sr=SR, hop_length=HOP, bpm=local, units="time")
    return env, local, np.asarray(beats, dtype=float)


def score_grid(notes: list[Note], wav: Path | None = None, duration: float | None = None) -> Grid:
    """Seconds -> score quarters for these notes (levels in the module docstring)."""
    env, local, beats = track_beats(notes, wav, duration)
    on = onset_clusters(notes)
    g = subdivision(beats, on)
    tatums = track_tatums(env, local, g)
    if len(tatums) < 4 * g:  # too little music to find bars: even 4/4 (or 12/8) from the first tatum
        tatums = tatums if len(tatums) >= 2 else np.array([0.0, 60.0 / (120.0 * g)])
        return grid_from(tatums, np.array([0]), g, 4 * g, tatums[0])
    acc = bar_accents(notes, tatums, g)
    m = bar_length(acc, g)
    pos = np.interp(on, tatums, np.arange(len(tatums), dtype=float))
    idx = np.round(pos).astype(int)
    strength = np.zeros(len(tatums))
    np.add.at(strength, idx[np.abs(pos - idx) < 0.3], 1.0)  # chords/onsets starting at each tatum
    return grid_from(tatums, downbeats(acc, m), g, m, float(on[0]) if len(on) else 0.0, strength)
