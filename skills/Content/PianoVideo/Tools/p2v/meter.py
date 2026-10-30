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

With the recording at hand, the trained tracker Beat This! can replace level 1 (`model_grid`):
its beats set the beat level and positions, the tatums are spaced evenly between them, and its
downbeat probability is one more bar accent. Its beats come from a DBN over its beat probability
(`dbn_beats`). From §12 to §45 the note tracker took the stretches where the model's raw beats were
irregular (a splice); on 287 songs of the grid test sets that splice lost more bars than it saved,
and it is gone (DESIGN.md §46).
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path

import numpy as np

from .arrange import CHORD_TOL, Note

SR, HOP = 22050, 512
BASS_WEIGHT = 3.0  # onset-curve weight of notes below C3 (they mark strong beats)

# Beat This! (Foscarin, Schlüter & Widmer, ISMIR 2024; pip beat-this 1.1.0, MIT): the authors'
# checkpoints, checked once (pickle opcodes, weights_only, strict load: DESIGN.md §12) and pinned
# here. Never fetched at run time. final0 = trained on all its data except GTZAN; foldK = its 8-fold
# cross-validation models (corpus.BT_HELDOUT).
BEAT_THIS_DIR = Path(os.environ.get("P2V_BEAT_THIS", Path.home() / ".kaya/piano2video/models/beat_this"))
BEAT_THIS_SHA256 = {
    "final0": "8c328b45f59d8dd3dff219253ff6a8d6482be57d0133a29140e2febbf8eb8331",
    "fold0": "f5c6b6726179e20710e4be6a0fba4018f6cbc89f32f9c0dfd15072cb047578ad",
    "fold1": "617b5b9641cefa585c975c97ac4e7fb9c00165ec9827303e8a88fdbd5ff3b71f",
    "fold2": "cece4323bccc50738e415c91c204c93ca7021e42ab3a24da6a84dccaa7cc0d4c",
    "fold3": "849de186a21ed1cd41d0ac78dc412c61f5283dcafffa9dd32f390674c50792cf",
    "fold4": "0a17b1691edbae73a7fac35f6d26d5f8f9aa483b0e3aff5d891c74140f836c52",
    "fold5": "ea651e7a0d1a1b243ad3ff268969c8c3d4b7e6d06b1bfb451b020d40526275c2",
    "fold6": "07b32a484f2c99b676e7061650ea2cd2f9f889d87ea6c712782c5855742070b1",
    "fold7": "f26bed3c18c8f338a39b5a9524ffea7dce654e847ccf3d006e147fa7bf71d43f",
}
# "ensemble" (the default since §43): the mean logit of all nine models. On songs none of them trained on it
# breaks fewer grids than final0 alone (Aerodynamic's beat F 0.40 -> 0.99, Starlight's written position
# 0.65 -> 0.98). Not for pieces in their training data: 8 of the 9 heard every ASAP piece of BT_HELDOUT.
BEAT_THIS_ENSEMBLE = ("final0", *(f"fold{k}" for k in range(8)))
BT_FPS = 50  # Beat This! frames per second


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


SUBDIV_MARGIN = 2.0  # the triplet lattice must be this much stronger than the eighth or 16th lattice (§22)
# a weaker triplet lattice is no lattice: simple meter (Some Chords 0.12; the weakest compound piece, the
# Berceuse, 0.24; 0.17 is their geometric middle)
SUBDIV_MIN_R3 = 0.17
# ... and over this / sqrt(onsets): random phases give n R^2 ~ Exp(1), so P(R3 > 2 / sqrt(n)) = e^-4, about 2%
# (without it, 8 to 60 random onsets read as compound 5-7% of the time; code review of §22)
SUBDIV_NOISE = 2.0


def subdivision(beats: np.ndarray, onsets: np.ndarray, margin: float = SUBDIV_MARGIN) -> int:
    """3 when the onsets' phases in the beat follow a lattice of 3 per beat (compound meter), else 2.
    Per lattice k the circular strength R_k = |mean exp(2 pi i k phase)|: k = 3 triplets against
    k = 2 eighths and k = 4 sixteenths. It does not depend on where the lattice sits, so notes that
    sound a constant time after the beat do not move it (Opus: synth onsets 80 ms late; the old test
    at fixed 1/3 and 2/3 read its 16ths as triplets, 12/8). Triple must win by `margin`, because
    swung eighths lean to 2/3 and are usually written straight. Measured R3 vs max(R2, R4) on the
    model's beats: Connections 0.62 vs 0.10 (compound), the bank's compound pieces 2.3x or more,
    Viva la FAI 0.31 vs 0.21, Rachmaninoff op. 23 no. 4 (3/4 with triplets) 2.2x (DESIGN.md §22)."""
    from .arrange import beats_to_seconds_fn
    if len(beats) < 4 or len(onsets) < 8:
        return 2
    s2b, _ = beats_to_seconds_fn(beats)
    ph = 2 * np.pi * (s2b(onsets) % 1.0)
    r2, r3, r4 = (abs(np.mean(np.exp(1j * k * ph))) for k in (2, 3, 4))
    return 3 if r3 > max(margin * max(r2, r4), SUBDIV_MIN_R3, SUBDIV_NOISE / np.sqrt(len(onsets))) else 2


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


def _contrast(acc: np.ndarray, m: int) -> float:
    """Accent contrast of bars of m tatums at their best phase (downbeats minus the rest)."""
    idx = np.arange(len(acc))
    return max(acc[(idx - ph) % m == 0].mean() - acc[(idx - ph) % m != 0].mean() for ph in range(m))


def bar_length(acc: np.ndarray, g: int) -> int:
    """Tatums per bar among the standard meters (g=2: 2/4 3/4 4/4, g=3: 6/8 9/8 12/8): the one
    whose best phase gives the largest accent contrast (downbeats minus the rest)."""
    cands = [g * k for k in (2, 3, 4)]
    if len(acc) < 2 * max(cands) or not np.any(acc):  # no evidence: the common 4/4 (12/8), not 2/4
        return 4 * g
    return max(cands, key=lambda m: _contrast(acc, m))


def bar_length_joint(acc: np.ndarray, down_z: np.ndarray, g: int) -> int:
    """Tatums per bar from two cues: per candidate, the note accents' contrast and the model's
    downbeat contrast (z-scored probability), each divided by its largest |value| over the
    candidates, summed. The model's own beats per bar often counted half bars (Starlight 2/4;
    corpus meter right on 32%), the notes alone 21%; both together 47% (§12)."""
    cands = [g * k for k in (2, 3, 4)]
    if len(acc) < 2 * max(cands):
        return 4 * g
    cn = np.array([_contrast(acc, m) for m in cands])
    cm = np.array([_contrast(down_z, m) for m in cands])
    return cands[int(np.argmax(cn / (np.abs(cn).max() + 1e-9) + cm / (np.abs(cm).max() + 1e-9)))]


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


def phase_at(down: np.ndarray, tatums: np.ndarray, t: float, g: int, m: int) -> np.ndarray:
    """The downbeats moved so that a bar line falls on the beat nearest `t` (the user's `--downbeat`, §49): the run
    of regular bars (exactly m tatums) that holds that beat moves by one shift; past a bar of m +- slack (where the
    dynamic program re-phased, often a beat-tracking slip under rubato) the bars keep their own phase. A song whose
    bar lines are a constant half bar off is one run, so all of it moves. Moving every bar instead lost on ASAP
    (downbeat F -0.09, 2 better / 15 worse, tune): the phase at the user's bar line is not the phase elsewhere."""
    n = len(tatums)
    if len(down) == 0 or n == 0:
        return down
    x = float(np.interp(t, tatums, np.arange(n)))  # t as a tatum index
    j = int(np.argmin(np.abs(down - x)))
    lo, hi = j, j
    while lo > 0 and down[lo] - down[lo - 1] == m:
        lo -= 1
    while hi < len(down) - 1 and down[hi + 1] - down[hi] == m:
        hi += 1
    out = np.array(down, dtype=int)
    out[lo:hi + 1] += g * round((x - int(down[j])) / g)  # whole beats of the bars' own lattice (the note tracker's
    return np.unique(out[(out >= 0) & (out < n)])  # tatum 0 need not be a beat), at most half a bar from down[j]


METERS = {(2, 4): "2/4", (2, 6): "3/4", (2, 8): "4/4", (3, 6): "6/8", (3, 9): "9/8", (3, 12): "12/8"}


@dataclass(frozen=True)
class Hint:
    """What the user knows of the song's notation (`--meter`, `--bpm`; DESIGN.md §48): the meter (a METERS value)
    and the tempo in beats a minute, the beat as the meter counts it (a quarter in 2/4, 3/4, 4/4; a dotted quarter
    in 6/8, 9/8, 12/8). The written tempo level and the bar length are the composer's convention, which the audio
    cues do not hold (§36, §48); a printed score or a song listing states both. `downbeat` (`--downbeat`, §49): the
    time in seconds of one bar line, which sets the bar phase; the cues pick the wrong half bar together (§49)."""
    meter: str | None = None
    bpm: float | None = None
    downbeat: float | None = None

    def __post_init__(self):
        if self.meter is not None and self.meter not in METERS.values():
            raise ValueError(f"meter {self.meter!r}: use one of {', '.join(METERS.values())}")
        if self.bpm is not None and not 10.0 <= self.bpm <= 400.0:
            raise ValueError(f"bpm {self.bpm}: beats a minute, 10-400")
        if self.downbeat is not None and not self.downbeat >= 0.0:
            raise ValueError(f"downbeat {self.downbeat}: seconds from the start of the input, 0 or more")

    def gm(self) -> tuple[int, int] | None:
        """(tatums a beat, tatums a bar) of the meter, or None."""
        return next((k for k, v in METERS.items() if v == self.meter), None)


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
    beat_q = g * tatum_q
    bpm = 60.0 / (float(np.median(np.diff(tatums))) * g) if n > 1 else 120.0
    return Grid(t=t, q=_bar0(t, q, first_note, tatum_q, bar_q), meter=METERS[(g, m)], bar_q=bar_q,
                tatum_q=tatum_q, beat_q=beat_q, bpm=bpm)


def _bar0(t: np.ndarray, q: np.ndarray, first_note: float, tatum_q: float, bar_q: float) -> np.ndarray:
    """q shifted by whole bars so the bar holding the first note is bar 0."""
    q_first = float(_extrap(first_note, t, q))
    return q - np.floor((q_first + tatum_q / 2) / bar_q) * bar_q  # half a tatum early still counts as on time


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


def onset_strength(on: np.ndarray, tatums: np.ndarray) -> np.ndarray:
    """Chords/onsets starting at each tatum (within 0.3 of a tatum)."""
    pos = np.interp(on, tatums, np.arange(len(tatums), dtype=float))
    idx = np.round(pos).astype(int)
    strength = np.zeros(len(tatums))
    np.add.at(strength, idx[np.abs(pos - idx) < 0.3], 1.0)
    return strength


def score_grid(notes: list[Note], wav: Path | None = None, duration: float | None = None,
               model: ModelBeats | None = None, hint: Hint | None = None) -> Grid:
    """Seconds -> score quarters for these notes (levels in the module docstring). With `model`
    (Beat This! on the recording) the model's grid, everywhere it has one (`model_grid`, §46).
    A `hint` sets the meter and the bar phase (both grids) and the beat tempo (the model's grid only)."""
    if model is not None and (gm := model_grid(notes, model, hint)) is not None:
        return gm
    if model is not None and hint is not None and hint.bpm:
        import warnings
        warnings.warn("--bpm not used: the beat model found too few beats, and the note tracker keeps its own "
                      "level (--meter is used; DESIGN.md §48)")
    return note_grid(notes, wav, duration, hint)


def note_grid(notes: list[Note], wav: Path | None = None, duration: float | None = None,
              hint: Hint | None = None) -> Grid:
    """The note tracker's grid. A hint's meter and downbeat are used; its tempo is not (the tracker's level is its own)."""
    env, local, beats = track_beats(notes, wav, duration)
    on = onset_clusters(notes)
    fixed = hint.gm() if hint else None
    g = fixed[0] if fixed else subdivision(beats, on)
    tatums = track_tatums(env, local, g)
    def phase(d: np.ndarray, m: int) -> np.ndarray:
        return phase_at(d, tatums, hint.downbeat, g, m) if hint and hint.downbeat is not None else d

    if len(tatums) < 4 * g:  # too little music to find bars: even 4/4 (or 12/8) from the first tatum
        tatums = tatums if len(tatums) >= 2 else np.array([0.0, 60.0 / (120.0 * g)])
        m = fixed[1] if fixed else 4 * g
        return grid_from(tatums, phase(np.array([0]), m), g, m, tatums[0])
    acc = bar_accents(notes, tatums, g)
    m = fixed[1] if fixed else bar_length(acc, g)
    return grid_from(tatums, phase(downbeats(acc, m), m), g, m, float(on[0]) if len(on) else 0.0,
                     onset_strength(on, tatums))


# ------------------------------------------------------------ Beat This! -- #

@dataclass(frozen=True)
class ModelBeats:
    """Beat This! frame logits for one recording, BT_FPS frames per second."""
    beat: np.ndarray
    downbeat: np.ndarray


def beat_this_missing(checkpoint: str = "ensemble") -> str | None:
    """Why Beat This! can't run here (None when it can): the package or the pinned weights."""
    import importlib.util
    if importlib.util.find_spec("beat_this") is None:
        return "package beat-this not installed"
    for name in BEAT_THIS_ENSEMBLE if checkpoint == "ensemble" else (checkpoint,):
        if not (BEAT_THIS_DIR / f"{name}.ckpt").exists():
            return f"no weights at {BEAT_THIS_DIR / f'{name}.ckpt'} (DESIGN.md §12, §43)"
        if (why := _bad_weights(name)) is not None:  # before Demucs and the transcription, not after them
            return why
    return None


_BT_VERIFIED: set[tuple[str, int, int]] = set()  # (path, size, mtime_ns) whose SHA-256 was the pinned one


def _bad_weights(checkpoint: str) -> str | None:
    """Why the checkpoint file is not the verified one (None when it is). Hashed once per process and
    file state: the nine-model default would otherwise read 730 MB twice for every song."""
    import hashlib
    path = BEAT_THIS_DIR / f"{checkpoint}.ckpt"
    st = path.stat()
    key = (str(path), st.st_size, st.st_mtime_ns)
    if key in _BT_VERIFIED:
        return None
    digest = hashlib.sha256(path.read_bytes()).hexdigest()
    if digest != BEAT_THIS_SHA256.get(checkpoint):
        return f"{path}: SHA-256 {digest} is not the verified one (DESIGN.md §12)"
    _BT_VERIFIED.add(key)
    return None


def mean_logits(runs: list[ModelBeats]) -> ModelBeats:
    """The models' mean beat and downbeat logits, frame by frame (over the frames all of them have: the
    runs share one spectrogram, so their lengths may differ by a frame at most)."""
    if not runs:
        raise ValueError("mean_logits: no model runs")
    lens = [len(r.beat) for r in runs] + [len(r.downbeat) for r in runs]
    if max(lens) - min(lens) > 1:
        raise ValueError(f"mean_logits: the runs' frame counts differ: {sorted(set(lens))}")
    n = min(lens)
    return ModelBeats(np.mean([r.beat[:n] for r in runs], axis=0), np.mean([r.downbeat[:n] for r in runs], axis=0))


_BT_MODELS: dict = {}


def _beat_this_model(checkpoint: str):
    """The checkpoint as a plain torch module: SHA-256 must be the pinned one, tensors only
    (weights_only), every key and shape matching (strict)."""
    if checkpoint not in _BT_MODELS:
        path = BEAT_THIS_DIR / f"{checkpoint}.ckpt"
        if (why := _bad_weights(checkpoint)) is not None:
            raise RuntimeError(why)
        import inspect
        import torch
        from beat_this.model.beat_tracker import BeatThis
        ck = torch.load(path, map_location="cpu", weights_only=True)
        hp = {k: v for k, v in ck["hyper_parameters"].items() if k in inspect.signature(BeatThis).parameters}
        model = BeatThis(**hp)
        model.load_state_dict({k.removeprefix("model."): v for k, v in ck["state_dict"].items()}, strict=True)
        _BT_MODELS[checkpoint] = model.eval()
    return _BT_MODELS[checkpoint]


def beat_this(wav: Path, checkpoint: str = "ensemble", cache: Path | None = None) -> ModelBeats:
    """Beat and downbeat logits of the recording (its own log-mel front end, 30 s chunks); "ensemble"
    runs the nine models on one spectrogram, one model in memory at a time, and keeps their mean
    (`mean_logits`, DESIGN.md §43). With `cache` (an .npz in the song's work dir) they are read from it
    when it exists and written to it when not, so grid changes can be measured without the model (§18)."""
    if cache is not None and (mb := _logits_cached(cache, wav)) is not None:
        return mb
    import librosa
    import torch
    from beat_this.inference import split_predict_aggregate
    from beat_this.preprocessing import LogMelSpect
    y, _ = librosa.load(str(wav), sr=SR, mono=True)
    spect = LogMelSpect()(torch.from_numpy(y))
    names = BEAT_THIS_ENSEMBLE if checkpoint == "ensemble" else (checkpoint,)
    runs = []
    with torch.inference_mode():
        for name in names:
            p = split_predict_aggregate(spect, chunk_size=1500, border_size=6, overlap_mode="keep_first",
                                        model=_beat_this_model(name))
            runs.append(ModelBeats(p["beat"].float().numpy(), p["downbeat"].float().numpy()))
            if len(names) > 1:
                _BT_MODELS.pop(name, None)  # nine 81 MB models: keep one in memory at a time
    mb = mean_logits(runs)
    if cache is not None:
        _cache_logits(cache, mb)
    return mb


def _logits_cached(cache: Path, wav: Path) -> ModelBeats | None:
    """The cached logits, or None when there is no cache or its length does not fit the
    recording's (the wav was ingested again: the cache is stale). The model gives one frame per
    1/BT_FPS s plus one."""
    if not cache.exists():
        return None
    import soundfile as sf
    with np.load(cache, allow_pickle=False) as z:
        mb = ModelBeats(z["beat"], z["downbeat"])
    return mb if abs(len(mb.beat) - sf.info(str(wav)).duration * BT_FPS) <= 2 else None


def _cache_logits(cache: Path, mb: ModelBeats) -> None:
    """Write the logits through a temporary file of this process (np.savez keeps an .npz suffix),
    so a reader never sees a half-written cache."""
    part = cache.with_name(f"{cache.stem}.{os.getpid()}.part.npz")
    np.savez(part, beat=mb.beat, downbeat=mb.downbeat)
    os.replace(part, cache)


def _prob(logit: np.ndarray) -> np.ndarray:
    return 1.0 / (1.0 + np.exp(-np.clip(logit, -50, 50)))


def peak_times(logit: np.ndarray) -> np.ndarray:
    """Beat This!'s own post-processing: frames over p = 0.5 that are the largest within +-70 ms
    (a run of adjacent ones counts once), in seconds."""
    from scipy.ndimage import maximum_filter1d
    k = np.flatnonzero((logit == maximum_filter1d(logit, 7)) & (logit > 0))
    return k[np.r_[True, np.diff(k) > 1]] / BT_FPS if len(k) else np.zeros(0)


# beats a minute: a faster median model level is an eighth-note pulse, and the piece's level is the octave
# below (Some Chords: Beat This! taps 250/min for its first 32 s, quarters at 130/min after; §22)
MAX_BEAT_BPM = 200.0


def capped_bpm(bpm: float) -> float:
    """The beat tempo, an octave lower while it is over MAX_BEAT_BPM (an eighth-note pulse)."""
    while np.isfinite(bpm) and bpm > MAX_BEAT_BPM:
        bpm /= 2.0
    return bpm


DBN_RANGE = 1.5  # the DBN's tempo range: within x1.5 of the piece's level (the capped median raw interval)
# with the user's tempo (a Hint, §48): x1.2, so the level a third away (40 against 60 beats a minute in 6/8) is out
HINT_RANGE = 1.2


def steady_beats(beat_logit: np.ndarray, beats: np.ndarray, bpm: float | None = None) -> np.ndarray:
    """One beat per model beat period: a DBN (`dbn_beats`) over the beat probability, its tempo kept
    within DBN_RANGE of the piece's level (`capped_bpm` of the median raw interval: an eighth-note
    pulse is folded to quarters). It bridges missed beats and skips stray peaks at a steady period
    and follows a tempo change at the beats. Until §46 librosa's dynamic program at the model's local
    tempo (the median of 9 raw intervals, which a run of missed beats doubles: The Lark, §44); on the
    grid test sets the DBN gave beat F +0.010 over it (§46). A free DBN (55-215 beats a minute)
    switched levels: tempo 2 better, 7 worse on ASAP. `bpm` (the user's hint, §48) replaces the level."""
    if len(beats) < 2:  # no interval, no level (model_grid needs 8 raw peaks)
        return np.asarray(beats, dtype=float)
    b0, r = (bpm, HINT_RANGE) if bpm else (capped_bpm(60.0 / float(np.median(np.diff(beats)))), DBN_RANGE)
    return dbn_beats(_prob(beat_logit), BT_FPS, b0 / r, b0 * r)


def dbn_beats(act: np.ndarray, fps: float, min_bpm: float, max_bpm: float, lam: float = 100.0,
              obs_lam: float = 16.0) -> np.ndarray:
    """Beats from a beat probability curve by the DBN of Krebs, Böck and Widmer (2015), as madmom's
    DBNBeatTrackingProcessor (which Beat This!'s optional post-processing uses; madmom itself is
    unmaintained and does not install with this numpy). States: (beat interval i in frames, position
    p in 0..i-1); p advances one a frame; at a beat's end the interval may change to j with
    probability ∝ exp(-lam |j/i - 1|). The first 1/obs_lam of each beat are beat states (P = act),
    the rest P = (1 - act) / (obs_lam - 1). Viterbi; a beat = the probability peak in each run of
    beat states on the path."""
    if len(act) == 0:
        return np.zeros(0)
    act = np.clip(np.asarray(act, dtype=float), 1e-6, 1 - 1e-6)
    lo, hi = int(np.floor(60.0 * fps / max_bpm)), int(np.ceil(60.0 * fps / min_bpm))
    ivs = np.arange(max(lo, 2), hi + 1)
    n = len(ivs)
    off = np.r_[0, np.cumsum(ivs)[:-1]]  # the first state of each interval
    n_states = int(ivs.sum())
    beat_state = np.concatenate([np.arange(i) / i for i in ivs]) < 1.0 / obs_lam
    last = off + ivs - 1  # the last position of each interval
    tp = np.exp(-lam * np.abs(ivs[None, :] / ivs[:, None] - 1.0))  # from i (row) to j (column)
    tp[tp < 1e-16] = 0.0
    tp /= tp.sum(axis=1, keepdims=True)
    with np.errstate(divide="ignore"):
        ltp = np.log(tp)
    n_frames = len(act)
    lb, lnb = np.log(act), np.log((1 - act) / (obs_lam - 1))
    score = np.where(beat_state, lb[0], lnb[0]) - np.log(n_states)
    back = np.empty((n_frames, n), dtype=np.int32)  # per frame: the interval each first state came from
    adv = np.ones(n_states, dtype=bool)
    adv[off] = False  # a first state comes from a beat's end, every other state from p - 1
    prev = np.arange(n_states) - 1
    for t in range(1, n_frames):
        new = np.empty(n_states)
        new[adv] = score[prev[adv]]
        cand = score[last][:, None] + ltp
        k = np.argmax(cand, axis=0)
        new[off] = cand[k, np.arange(n)]
        back[t] = k
        score = new + np.where(beat_state, lb[t], lnb[t])
    path = np.empty(n_frames, dtype=np.int64)
    s = int(np.argmax(score))
    state_iv = np.repeat(np.arange(n), ivs)
    for t in range(n_frames - 1, -1, -1):
        path[t] = s
        if t == 0:
            break
        j = state_iv[s]
        s = int(last[back[t, j]]) if s == off[j] else s - 1
    on = beat_state[path].astype(int)
    edges = np.flatnonzero(np.diff(on)) + 1
    edges = np.r_[[0] if on[0] else [], edges, [n_frames] if on[-1] else []].astype(int)
    return np.array([int(np.argmax(act[a:b])) + a for a, b in edges.reshape(-1, 2)], dtype=float) / fps


def at_tatums(prob: np.ndarray, tatums: np.ndarray, width: int = 2) -> np.ndarray:
    """Largest frame value within +-width frames (+-40 ms) of each tatum."""
    idx = np.clip(np.round(tatums * BT_FPS).astype(int), 0, len(prob) - 1)
    return np.array([prob[max(0, i - width): i + width + 1].max() for i in idx])


MODEL_DOWN_W = 2.0  # weight of the model's z-scored downbeat probability against the note accents (§18)


def model_grid(notes: list[Note], mb: ModelBeats, hint: Hint | None = None) -> Grid | None:
    """The score grid with Beat This!: steady model beats -> subdivision from the notes -> tatums
    evenly between beats -> bar length (`bar_length_joint`) -> downbeats by the same dynamic
    program over note accents + MODEL_DOWN_W x the model's z-scored downbeat probability ->
    `grid_from`. None when the model found too few beats (the note tracker takes over). A hint's
    tempo sets the beat level, its meter the subdivision and the bar length, its downbeat the bar phase."""
    raw = peak_times(mb.beat)
    if len(raw) < 8:
        return None
    beats = steady_beats(mb.beat, raw, hint.bpm if hint else None)
    if len(beats) < 4:
        return None
    on = onset_clusters(notes)
    fixed = hint.gm() if hint else None
    g = fixed[0] if fixed else subdivision(beats, on)
    tatums = np.interp(np.arange(0, len(beats) - 1 + 1e-9, 1 / g), np.arange(len(beats)), beats)
    acc = bar_accents(notes, tatums, g)
    p = at_tatums(_prob(mb.downbeat), tatums)
    down_z = (p - p.mean()) / (p.std() + 1e-9)
    m = fixed[1] if fixed else bar_length_joint(acc, down_z, g)
    down = downbeats(acc + MODEL_DOWN_W * down_z, m)
    if hint and hint.downbeat is not None:
        down = phase_at(down, tatums, hint.downbeat, g, m)
    return grid_from(tatums, down, g, m, float(on[0]) if len(on) else float(beats[0]), onset_strength(on, tatums))

