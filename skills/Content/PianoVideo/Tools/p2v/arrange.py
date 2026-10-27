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
    end: float  # key release
    pitch: int
    velocity: int = 80
    role: Role = "accomp"
    hand: Hand | None = None
    sound_end: float | None = None  # when the note stops sounding (pedal), if later than `end`

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


def local_splits(notes: list[Note], window: float = 1.5, center: float = 60.0, bias: float = 2.0,
                 stick: float = 2.0, one_hand_gap: float = 7.0, one_hand_span: float = 12.0, reach: float = 15.0,
                 lo: float = 43.0, hi: float = 79.0, smooth: int = 2, span_cost: float = 1.0) -> np.ndarray:
    """Per-note hand split pitch, following the texture instead of a fixed middle C.

    For each note, take every pitch sounding within +-`window` s (about a bar, so a figure's own
    leaps — E3 up to D#4 — are seen with the rest of the figure) and score each split point:
    the gap it falls in (semitones between the nearest pitches below and above) minus `bias`
    per octave away from `center`. Gaps whose midpoint lies outside [lo, hi] are ignored, so a
    left-hand octave (A1-A2) can't pull the split under the bass. Putting everything in one
    hand scores like a gap of `one_hand_gap`; it is allowed when the pitches fit in one hand
    (span <= `one_hand_span`) or all sit in that hand's register (RH >= G3, LH <= C4), so a
    lone melody or bass line isn't cut in two. A split that leaves either hand a chord (notes
    starting together) wider than `reach` semitones is impossible to play and is skipped —
    onsets stay reliable when pedalled note lengths don't. Each semitone that a hand's share of the
    window spans beyond an octave costs `span_cost`: the widest gap alone gave Connections' left
    hand a tenth-wide arpeggio (F#3 to A4) where the pianist splits it F#3-F#4 | G#4-E5 (hand
    agreement 0.76 -> 0.85; Starlight unchanged at 1.00 up to 2.0, drops at 3.0). Moving away from
    the previous note's split costs `stick` per octave (a figure stays in its hand when the other
    hand rests), and a running median over +-`smooth` notes stops hands flickering.
    Re-measured on Connections, Starlight and Viva la FAI (2026-10-26): moving window, reach,
    bias, stick or one_hand_span one step either way improves no piece's hand agreement.
    """
    if not notes:
        return np.zeros(0)
    starts = np.array([n.start for n in notes])
    ends = np.array([n.end for n in notes])
    pitches = np.array([n.pitch for n in notes], dtype=float)
    raw = np.empty(len(notes))
    prev: float | None = None
    for i in np.argsort(starts, kind="stable"):
        t = starts[i]
        chord = pitches[np.abs(starts - t) <= CHORD_TOL]
        ps = np.unique(pitches[(starts <= t + window) & (ends >= t - window)])
        cands = [((a + b) / 2, b - a) for a, b in zip(ps[:-1], ps[1:]) if lo <= (a + b) / 2 <= hi]
        compact = ps[-1] - ps[0] <= one_hand_span
        if compact or ps[0] >= 55:  # all right hand
            cands.append((float(np.clip(ps[0] - 0.5, lo, hi)), one_hand_gap))
        if compact or ps[-1] <= 60:  # all left hand
            cands.append((float(np.clip(ps[-1] + 0.5, lo, hi)), one_hand_gap))
        def playable(s: float) -> bool:
            lh, rh = chord[chord < s], chord[chord > s]
            return all(len(h) < 2 or h.max() - h.min() <= reach for h in (lh, rh))

        def over_octave(s: float) -> float:  # semitones each hand's share of the window exceeds an octave
            return sum(max(0.0, h.max() - h.min() - 12.0) for h in (ps[ps < s], ps[ps > s]) if len(h) > 1)

        cands = [c for c in cands if playable(c[0])] or cands
        best, best_score = center if prev is None else prev, -np.inf
        for s, gap in cands:
            score = gap - bias * abs(s - center) / 12 - (0.0 if prev is None else stick * abs(s - prev) / 12)
            score -= span_cost * over_octave(s) if span_cost else 0.0
            if score > best_score:
                best, best_score = s, score
        raw[i] = prev = best
    order = np.argsort(starts, kind="stable")
    sm = raw.copy()
    for k, i in enumerate(order):
        nb = order[max(0, k - smooth): k + smooth + 1]
        sm[i] = np.median(raw[nb])
    return sm


def assign_hands_adaptive(notes: Iterable[Note], free: float = 10.0, w_lane: float = 4.0, w_prior: float = 3.0,
                          w_reg: float = 2.0, lh_hi: float = 64.0, rh_lo: float = 55.0, reach: float = 15.0,
                          beam: int = 32, **split_kw) -> list[Note]:
    """Hands by a beam search over onset groups (notes within CHORD_TOL). Lead notes stay in the right
    hand and bass notes in the left (arrange mode); the other notes of a group split at one point of
    their sorted pitches. Each split costs:
      move      per hand that plays: semitones its centre moves beyond `free`, divided by the seconds
                since that hand's last onset (+0.15): a leap right after the hand's last note costs
                more than the same distance travelled slowly
      lane      per note: semitones it is nearer the other hand's last centre than its own (x w_lane/12),
                so a line stays in one hand
      prior     per note: semitones on the far side of local_splits' texture split (x w_prior/12)
      register  per note: LH above `lh_hi`, RH below `rh_lo` (x w_reg/12)
    A split that leaves a hand wider than `reach` semitones or more than 5 notes is not considered
    (unless no split avoids it). The cheapest path to each (LH centre, RH centre) state survives a step, `beam` states in all.
    local_splits alone chooses by pitch gaps in a +-1.5 s window, where pedal-held notes look busy:
    it gave the right hand a whole 15-semitone eighth-note figure while the left hand rested
    (Connections bars 46-49; here the left hand takes its low notes), and on the corpus it gave the
    right hand 9% of the notes the score puts in the left hand, against 2% the other way.
    Measured 2026-10-26, hand = staff agreement (corpus.py, performance MIDI as input): corpus tune
    half 0.850 -> 0.875, held-out half 0.905 -> 0.921, Connections 0.850 -> 0.874, Starlight 1.00 ->
    1.00; one step either way on each weight moves none of these by more than 0.015. On the
    recordings (transcribed): tune 0.853 -> 0.871, held-out 0.906 -> 0.924."""
    notes = sort_notes(notes)
    if not notes:
        return []
    free_idx = [i for i, n in enumerate(notes) if n.role not in ("lead", "bass")]
    split = np.full(len(notes), 60.0)
    if free_idx:
        split[free_idx] = local_splits([notes[i] for i in free_idx], **split_kw)
    groups: list[list[int]] = []
    for i, n in enumerate(notes):
        if groups and n.start - notes[groups[-1][0]].start <= CHORD_TOL:
            groups[-1].append(i)
        else:
            groups.append([i])
    # state: (cost, LH centre, LH last onset, RH centre, RH last onset, (previous history, split))
    states: list[tuple] = [(0.0, None, -1e9, None, -1e9, ())]
    for g in groups:
        t = notes[g[0]].start
        fixed_l = [notes[i].pitch for i in g if notes[i].role == "bass"]
        fixed_r = [notes[i].pitch for i in g if notes[i].role == "lead"]
        ps = sorted(notes[i].pitch for i in g if notes[i].role not in ("lead", "bass"))
        sp = float(np.median(split[g]))
        ok = [j for j in range(len(ps) + 1) if all(not h or (h[-1] - h[0] <= reach and len(h) <= 5) for h in (
            sorted(fixed_l + ps[:j]), sorted(fixed_r + ps[j:])))] or list(range(len(ps) + 1))
        nxt: dict[tuple, tuple] = {}
        for cost, lp, lt, rp, rt, hist in states:
            for j in ok:
                lh, rh = sorted(fixed_l + ps[:j]), sorted(fixed_r + ps[j:])
                c = cost + w_prior * (sum(max(0.0, p - sp) for p in ps[:j]) + sum(max(0.0, sp - p) for p in ps[j:])) / 12
                c += w_reg * (sum(max(0.0, p - lh_hi) for p in lh) + sum(max(0.0, rh_lo - p) for p in rh)) / 12
                if lp is not None and rp is not None:
                    c += w_lane * (sum(max(0.0, abs(p - lp) - abs(p - rp)) for p in lh) +
                                   sum(max(0.0, abs(p - rp) - abs(p - lp)) for p in rh)) / 12
                nl, ntl, nr, ntr = lp, lt, rp, rt
                if lh:
                    nl, ntl = float(np.mean(lh)), t
                    c += 0.0 if lp is None else max(0.0, abs(nl - lp) - free) / (t - lt + 0.15)
                if rh:
                    nr, ntr = float(np.mean(rh)), t
                    c += 0.0 if rp is None else max(0.0, abs(nr - rp) - free) / (t - rt + 0.15)
                key = (None if nl is None else round(nl), None if nr is None else round(nr))
                if key not in nxt or c < nxt[key][0]:
                    nxt[key] = (c, nl, ntl, nr, ntr, (hist, j))
        states = sorted(nxt.values(), key=lambda s: s[0])[:beam]
    hist, cuts = min(states, key=lambda s: s[0])[5], []
    while hist:
        hist, j = hist
        cuts.append(j)
    out = list(notes)
    for g, j in zip(groups, reversed(cuts)):
        free_g = sorted((i for i in g if notes[i].role not in ("lead", "bass")), key=lambda i: notes[i].pitch)
        for k, i in enumerate(free_g):
            out[i] = replace(notes[i], hand="L" if k < j else "R")
        for i in g:
            if notes[i].role in ("lead", "bass"):
                out[i] = replace(notes[i], hand="R" if notes[i].role == "lead" else "L")
    return out


def key_lengths(notes: Iterable[Note], tol: float = CHORD_TOL) -> list[Note]:
    """Estimate key-press lengths from sounding lengths.

    The piano model reports when a note stops *sounding*; under sustain pedal that is often
    seconds after the key came up (Starlight's riff eighths came out ~2 s long, and note ends
    cluster at pedal releases). Assume legato within a hand: a key is up by the hand's next
    onset. The sounding end is kept in `sound_end` so the synth still rings. Needs hands.
    Holding each hand's top line (and the left hand's bass) on to its own next note instead was
    checked against both references (2026-10-26): no written length changed, and on Connections
    the played lengths grew to 1.5x the written ones (median), so legato-per-hand stays.
    """
    out: list[Note] = []
    by_hand: dict[Hand | None, list[Note]] = {}
    for n in sort_notes(notes):
        by_hand.setdefault(n.hand, []).append(n)
    for ns in by_hand.values():
        starts = np.array([n.start for n in ns])
        for n in ns:
            k = int(np.searchsorted(starts, n.start + tol, side="right"))
            nxt = starts[k] if k < len(starts) else np.inf
            out.append(replace(n, end=min(n.end, float(nxt)), sound_end=max(n.end, n.sound_end or n.end)))
    return sort_notes(out)


def scale_velocity(notes: Iterable[Note], factor: float) -> list[Note]:
    return [replace(n, velocity=int(np.clip(round(n.velocity * factor), 1, 127))) for n in notes]


# --------------------------------------------------------------------------- #
# Arrangement recipes — one per (source, parts) choice. See DESIGN.md §4.
# --------------------------------------------------------------------------- #

def arrange_piano_only(piano: list[Note], parts: str) -> list[Note]:
    """source=piano: the song already has a piano part; transcribe it as-is.
    Hands follow the texture and how fast each hand must move (assign_hands_adaptive), not a fixed
    middle C; lengths are key presses
    (key_lengths), not pedal sustain. The lead is the right hand's top line."""
    notes = clamp_to_piano(drop_short(piano, 0.03))
    both = key_lengths(assign_hands_adaptive(with_role(notes, "accomp")))
    if parts == "lead":
        mel = skyline([n for n in both if n.hand == "R"], top=True)
        return assign_hands(with_role(drop_short(mel, 0.06), "lead"))
    return both


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
    # accompaniment split follows the texture and hand movement (assign_hands_adaptive), not middle C.
    # Viva la FAI arrange/lead+accomp (2026-10-26), fixed C4 -> local_splits: stepwise accompaniment
    # figures changing hand 10/55 -> 3/55, RH accompaniment chords that span > 15 semitones with the
    # held melody note 4/207 -> 0/124, unplayable onset clusters 1/454 -> 0/454, hand crossings 0 -> 0;
    # with the beam search (§11) still 0/454 unplayable and 0 crossings
    return assign_hands_adaptive(mel + hm + bl)


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
