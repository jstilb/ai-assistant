"""Pure note transforms: turn raw transcriptions into a two-hand piano arrangement.

Everything here operates on plain `Note` lists (times in seconds) and has no ML
or I/O dependencies, so it is fully unit-tested in __tests__/test_arrange.py.
"""

from __future__ import annotations

from dataclasses import dataclass, replace
from typing import TYPE_CHECKING, Callable, Iterable, Literal

import numpy as np

if TYPE_CHECKING:
    from .meter import Grid

PIANO_LO, PIANO_HI = 21, 108  # A0 .. C8

Role = Literal["lead", "accomp", "bass"]
Hand = Literal["R", "L"]

# Registers (MIDI pitch, inclusive lo / exclusive hi) used when arranging
# non-piano stems onto the keyboard.
LEAD_RANGE = (64, 89)    # E4 .. E6  — right-hand melody
ACCOMP_RANGE = (48, 72)  # C3 .. B4  — chord voicings under the melody
BASS_RANGE = (28, 53)    # E1 .. E3  — left-hand bass line
# a sung line's median moves by whole octaves to land nearest D5: a man's voice an octave up (as vocal parts
# are written in treble clef), a woman's mostly as sung. Counting notes inside LEAD_RANGE instead moved low
# voices two octaves up (Viva la FAI to A5: the right hand then spanned the piano part, 7% unplayable chords)
LEAD_CENTER = 74
# a lead that rests this many bars hands the right hand to the band's top line (DESIGN.md §21: T4 tune melody
# overlap 0.670 -> 0.685 at 1 bar, 0.670 at 2; half a bar fills a sung breath and costs note F1 on the check half)
HOOK_REST_BARS = 1.0

CHORD_TOL = 0.035  # seconds — onsets closer than this count as one chord
HAND_REACH, HAND_NOTES = 15, 5  # a hand spanning more semitones, or striking more notes at once, cannot (bank.REACH)


@dataclass(frozen=True)
class Note:
    start: float
    end: float  # key release
    pitch: int
    velocity: int = 80
    role: Role = "accomp"
    hand: Hand | None = None
    sound_end: float | None = None  # when the note stops sounding (pedal), if later than `end`
    hook: bool = False  # a lead note from the band's line (`hook_line`), not the voice: written like the piano part (§28)

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


def octave_toward(notes: list[Note], center: int) -> int:
    """Whole-octave transposition (semitones) that puts the line's median pitch nearest `center`."""
    if not notes:
        return 0
    return 12 * int(np.round((center - float(np.median([n.pitch for n in notes]))) / 12))


def fit_register(notes: Iterable[Note], lo: int, hi: int, keep_contour: bool = True,
                 center: int | None = None) -> list[Note]:
    """Move a part into a register.

    keep_contour: first shift the whole line by one octave amount (melodies keep
    their shape: the most notes in range, or the median nearest `center`), then
    octave-fold only the stragglers.
    """
    notes = list(notes)
    if not keep_contour:
        shift = 0
    elif center is not None:
        shift = octave_toward(notes, center)
    else:
        shift = best_octave_shift(notes, lo, hi)
    out = []
    for n in notes:
        p = n.pitch + shift
        while p < lo:
            p += 12
        while p >= hi:
            p -= 12
        out.append(replace(n, pitch=p))
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


# --------------------------------------------------------------------------- #
# The band arrangement on the score grid (`arrange` lead+accomp, DESIGN.md §20)
# --------------------------------------------------------------------------- #

def snap_to_grid(notes: Iterable[Note], grid: Grid) -> list[Note]:
    """Onsets and ends to the nearest tatum, in seconds, each note at least a tatum long, so the MIDI,
    the video and the score play the same rhythm (the score alone used to merge 16ths)."""
    out = []
    for n in notes:
        q0, q1 = grid.sec_to_q([n.start, n.end])
        a = np.round(q0 / grid.tatum_q) * grid.tatum_q
        b = max(a + grid.tatum_q, np.round(q1 / grid.tatum_q) * grid.tatum_q)
        t0, t1 = grid.q_to_sec([a, b])
        out.append(replace(n, start=float(t0), end=float(t1)))
    return out


def restrike(notes: Iterable[Note], tol: float = 0.01) -> list[Note]:
    """Per pitch: notes struck together become one (the longest end, the loudest velocity); a note
    still sounding when its pitch is struck again ends there (a repeated chord stays repeated, which
    `merge_same_pitch` would join into one long note)."""
    by_pitch: dict[int, list[Note]] = {}
    for n in sort_notes(notes):
        lst = by_pitch.setdefault(n.pitch, [])
        if lst and abs(n.start - lst[-1].start) <= tol:
            prev = lst[-1]
            lst[-1] = replace(prev, end=max(prev.end, n.end), velocity=max(prev.velocity, n.velocity))
            continue
        if lst and lst[-1].end > n.start:
            lst[-1] = replace(lst[-1], end=n.start)
        lst.append(n)
    return sort_notes(x for lst in by_pitch.values() for x in lst if x.end > x.start)


def lowest_per_onset(notes: Iterable[Note], tol: float = 0.01) -> list[Note]:
    """A bass line after snapping: one note per onset (the lowest; a repeat of it joins it, as in
    `restrike`), each cut at the next onset."""
    out: list[Note] = []
    for n in sort_notes(notes):
        if out and abs(n.start - out[-1].start) <= tol:  # sorted by pitch within an onset: the first is the lowest
            if n.pitch == out[-1].pitch:
                out[-1] = replace(out[-1], end=max(out[-1].end, n.end), velocity=max(out[-1].velocity, n.velocity))
            continue
        if out and out[-1].end > n.start:
            out[-1] = replace(out[-1], end=n.start)
        out.append(n)
    return [n for n in out if n.end > n.start]


def onset_clusters(notes: Iterable[Note], tol: float = 0.01) -> list[list[Note]]:
    out: list[list[Note]] = []
    for n in sort_notes(notes):
        if out and n.start - out[-1][0].start <= tol:
            out[-1].append(n)
        else:
            out.append([n])
    return out


def zone_voice(accomp: list[Note], mel: list[Note], bass: list[Note],
               chord_tones: Callable[[float], set[int] | None] | None = None, max_notes: int = 3,
               per_hand: int = 2, reach: int = 11, rh_free: tuple[int, int] = (60, 71),
               lh_free: tuple[int, int] = (48, 59), onset_s: float = 0.04) -> list[Note]:
    """Re-voice each accompaniment onset cluster into the hands' reach. The cluster keeps its loudest
    pitch classes (only the chord's tones when `chord_tones(t)` names a chord and the cluster has
    one), at most `max_notes`, at most `per_hand` a hand. Each goes to the octave inside a hand's
    zone nearest its transcribed pitch: the right hand's `reach` semitones under the melody note
    struck with the chord (or sounding just after it), the left hand's `reach` above the bass note
    sounding; a hand without its line uses a free zone, and the right hand's zone starts above the
    left's. Hands are set here: at the onset a hand spans at most `reach` semitones beyond its own
    line (`end_at_crossing` keeps the lines outside while the chord sounds)."""
    out = []
    for cl in onset_clusters(accomp):
        t0, t1 = cl[0].start, max(n.end for n in cl)
        ms = [m.pitch for m in mel if abs(m.start - t0) <= onset_s or (m.start < t0 and m.end > t0 + onset_s)]
        bs = [b.pitch for b in bass if b.start < t0 + 0.01 and b.end > t0] or [b.pitch for b in bass if b.start < t1 and b.end > t0]
        zones = {"R": (min(ms) - reach, min(ms) - 1) if ms else rh_free,
                 "L": (min(bs) + 1, min(bs) + reach) if bs else lh_free}
        zones["R"] = (max(zones["R"][0], zones["L"][1] + 1), zones["R"][1])  # a low tune over a high bass: no crossing
        weight: dict[int, float] = {}
        near: dict[int, int] = {}
        for n in cl:
            weight[n.pitch % 12] = weight.get(n.pitch % 12, 0.0) + n.velocity
            near.setdefault(n.pitch % 12, n.pitch)
        tones = chord_tones(t0) if chord_tones else None
        if tones and any(pc in tones for pc in weight):
            weight = {pc: w for pc, w in weight.items() if pc in tones}
        taken: dict[str, list[int]] = {"R": [], "L": []}
        for pc in sorted(weight, key=lambda k: -weight[k]):
            if len(taken["R"]) + len(taken["L"]) >= max_notes:
                break
            opts = []
            for hand, (lo, hi) in zones.items():
                p = lo + (pc - lo) % 12
                if len(taken[hand]) < per_hand and p <= hi:
                    opts.append((abs(p - near[pc]), hand, p))
            if not opts:
                continue
            _, hand, p = min(opts)
            taken[hand].append(p)
            src = max((n for n in cl if n.pitch % 12 == pc), key=lambda n: n.velocity)
            out.append(replace(src, pitch=p, hand=hand))
    return sort_notes(out)


def end_at_crossing(accomp: list[Note], mel: list[Note], bass: list[Note], onset_s: float = 0.04) -> list[Note]:
    """A held accompaniment note ends where its hand's line crosses it: a right-hand note when a later
    melody note starts at or under it, a left-hand note when a later bass note starts at or over it.
    The tune stays the top line and the bass the bottom one (no doubled pitch, no crossed hands). A
    note whose line leaps more than an octave away stays held, as a pianist pedals it: ending it there
    too cost chroma 0.786 -> 0.774 on the T4 tune half and no playability (DESIGN.md §20)."""
    lines = {"R": sorted(mel, key=lambda m: m.start), "L": sorted(bass, key=lambda b: b.start)}
    out = []
    for n in accomp:
        def crosses(x: int) -> bool:
            return x <= n.pitch if n.hand == "R" else x >= n.pitch
        end = next((x.start for x in lines[n.hand or "R"] if n.start + onset_s < x.start < n.end and crosses(x.pitch)),
                   n.end)
        if end > n.start + 0.02:
            out.append(replace(n, end=end))
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
                          w_reg: float = 2.0, lh_hi: float = 64.0, rh_lo: float = 55.0, reach: float = HAND_REACH,
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
        ok = [j for j in range(len(ps) + 1) if all(not h or (h[-1] - h[0] <= reach and len(h) <= HAND_NOTES) for h in (
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


def rest_spans(lead: list[Note], grid: Grid, end_s: float, min_bars: float = HOOK_REST_BARS) -> list[tuple[float, float]]:
    """Spans (seconds) where the lead sounds no note for at least `min_bars` bars of the grid, the
    time before its first note and after its last (to `end_s`) included; no lead: one span."""
    if not lead:
        return [(0.0, end_s)] if end_s > 0 else []
    spans, t = [], 0.0
    for a, b in sorted((n.start, n.end) for n in lead) + [(end_s, end_s)]:
        if a > t:
            q0, q1 = grid.sec_to_q([t, a])
            if q1 - q0 >= min_bars * grid.bar_q - 1e-6:
                spans.append((t, a))
        t = max(t, b)
    return spans


HOOK_LEAP = 0.5    # cost of a change of pitch, per octave (capped at one), against a frame's reward of about 1 (§23)
HOOK_HIGH = 0.5    # reward per 3 octaves above middle C: the hook is the band's high voice; 0 is no better than the top line
HOOK_FRAME = 0.05  # seconds a frame


def track_line(notes: list[Note], a: float, b: float, leap: float = HOOK_LEAP, high: float = HOOK_HIGH,
               dt: float = HOOK_FRAME, min_dur: float = 0.08) -> list[Note]:
    """One voice through polyphonic notes in [a, b) (DESIGN.md §23): a Viterbi path over frames of `dt`
    seconds, each frame one sounding pitch or none. A frame of pitch p earns 0.3 + 0.7 x velocity/127 +
    `high` x (min(p, E6) - 60)/36; a change of pitch costs `leap` x min(|interval|, 12)/12, a start or end of a
    silence `leap`/4. Each run of one pitch keeps the notes of that pitch that start in it after a release,
    so restruck notes stay notes and two stems doubling a pitch do not; each keeps its own velocity (the
    run's first onset is the note's own start when it is within a frame and after the last note's end)."""
    n_f = int(np.ceil((b - a) / dt - 1e-9))
    if n_f <= 0 or not notes:
        return []
    frames: list[dict[int, int]] = [{} for _ in range(n_f)]
    for n in notes:
        for k in range(max(0, int(np.ceil((n.start - a) / dt - 0.5))), min(n_f, int(np.ceil((n.end - a) / dt - 0.5)))):
            frames[k][n.pitch] = max(frames[k].get(n.pitch, 0), n.velocity)
    prev_p, prev_c, back = np.array([-1]), np.zeros(1), []
    for d in frames:  # state -1 = silence
        p = np.array([-1, *sorted(d)])
        reward = np.r_[0.0, [0.3 + 0.7 * d[x] / 127.0 + high * (min(x, LEAD_RANGE[1]) - 60) / 36.0 for x in p[1:]]]
        now_sil, was_sil = (p < 0)[:, None], (prev_p < 0)[None, :]
        trans = np.where(now_sil & was_sil, 0.0, np.where(now_sil | was_sil, leap / 4.0,
                         leap * np.minimum(np.abs(p[:, None] - prev_p[None, :]), 12) / 12.0))
        tot = prev_c[None, :] + trans
        bp = np.argmin(tot, axis=1)
        prev_c = tot[np.arange(len(p)), bp] - reward
        back.append((p, bp))
        prev_p = p
    seq, j = np.empty(n_f, dtype=int), int(np.argmin(prev_c))
    for k in range(n_f - 1, -1, -1):
        seq[k] = back[k][0][j]
        j = int(back[k][1][j])
    by_pitch: dict[int, list[Note]] = {}
    for n in sorted(notes, key=lambda n: n.start):
        by_pitch.setdefault(n.pitch, []).append(n)
    out: list[Note] = []
    k = 0
    while k < n_f:
        m = k
        while m + 1 < n_f and seq[m + 1] == seq[k]:
            m += 1
        if seq[k] >= 0:
            s, e = a + k * dt, a + (m + 1) * dt
            own = [n for n in by_pitch[int(seq[k])] if n.start < e and n.end > s]
            e = min(e, max(n.end for n in own))
            first = own[0].start if abs(own[0].start - s) < dt else s
            first = max(first, out[-1].end) if out else first  # one voice: never before the last note's end
            ons = [(first, own[0].velocity)]
            for i, n in enumerate(own[1:], 1):  # a restrike: the pitch was released (not a second stem doubling it)
                if ons[-1][0] + min_dur <= n.start <= e - min_dur and all(o.end <= n.start + 0.02 for o in own[:i]):
                    ons.append((n.start, n.velocity))
            ends = [o for o, _ in ons[1:]] + [e]
            out += [Note(o, nxt, int(seq[k]), v) for (o, v), nxt in zip(ons, ends) if nxt - o >= min_dur]
        k = m + 1
    return out


def hook_line(band: dict[str, list[Note]], spans: list[tuple[float, float]], min_dur: float = 0.08) -> list[Note]:
    """The song's own line where the voice rests (a drop, a riff, an instrumental track): per span one
    voice through all the band stems' notes (`track_line`), cut to the span, so it never overlaps the lead
    around it (DESIGN.md §21: Hey Brother's drop 0.29 -> 0.61 melody overlap). Until §23 it was the
    `skyline` top line of the stem with the most note time, which leapt 2-6x as often as the references
    (Veridis Quo: 58% of its intervals a fifth or more, the reference's 11%)."""
    out: list[Note] = []
    for a, b in spans:
        notes = drop_short([n for ns in band.values() for n in ns if a - 0.02 <= n.start < b - 0.05], min_dur)
        line = [replace(n, start=max(n.start, a), end=min(n.end, b)) for n in track_line(notes, a, b, min_dur=min_dur)]
        out += [n for n in line if n.dur >= min_dur]
    return out


def arrange_full(
    lead: list[Note],
    harmony: list[Note],
    bass: list[Note],
    parts: str,
    grid: Grid | None = None,
    chord_tones: Callable[[float], set[int] | None] | None = None,
    max_chord: int = 3,
    lead_center: int | None = None,
    band: dict[str, list[Note]] | None = None,
) -> list[Note]:
    """source=arrange: re-voice the song's core components for two hands.

    lead    — melody stem (usually vocals) -> monophonic RH line; `lead_center` (a sung lead:
              LEAD_CENTER) places it by its median, else the octave with the most notes in E4..E6
    harmony — chordal stems (piano/guitar/other) -> on the score grid, at most `max_chord` pitch
              classes an onset (the chord's tones when `chord_tones` names one), each voiced in
              the reach of the hand under the melody or over the bass (`zone_voice`)
    bass    — bass stem -> monophonic LH line on the score grid
    band    — the chordal stems by name: where the lead rests HOOK_REST_BARS or more (or has no
              note at all: an instrumental song), the RH line is one voice through the band (`hook_line`,
              DESIGN.md §21, §23), each span placed as a sung lead is (median nearest LEAD_CENTER), so
              the line keeps the voice's register; needs `grid`
    `grid` (the score grid) is needed for lead+accomp (DESIGN.md §20).
    """
    mel = skyline(drop_short(lead, 0.08), top=True)
    mel = with_role(fit_register(drop_short(mel, 0.08), *LEAD_RANGE, center=lead_center), "lead")
    if band:
        if grid is None:
            raise ValueError("arrange_full: the band's line (band=) needs the score grid")
        end_s = max([n.end for ns in band.values() for n in ns] + [n.end for n in bass + mel] + [0.0])
        hook = [n for span in rest_spans(mel, grid, end_s)
                for n in fit_register(hook_line(band, [span]), *LEAD_RANGE, center=LEAD_CENTER)]
        mel = sort_notes(mel + [replace(n, role="lead", hook=True) for n in hook])
    if parts == "lead":
        return assign_hands(mel)
    if grid is None:
        raise ValueError("arrange_full: lead+accomp needs the score grid")

    bl = skyline(drop_short(bass, 0.08), top=False)
    bl = with_role(lowest_per_onset(snap_to_grid(fit_register(bl, *BASS_RANGE), grid)), "bass")

    hm = merge_same_pitch(fit_register(drop_short(harmony, 0.06), *ACCOMP_RANGE, keep_contour=False))
    hm = restrike(snap_to_grid(hm, grid))
    # T4 (DESIGN.md §20, tune half): notes shorter than an eighth 32% -> 0%, written unplayable onsets
    # 3.5% -> 0.4%, MIDI unplayable 0.6% -> 0%, chord tones 0.92 -> 0.95; the band's thinner texture
    # costs pitch-class similarity to the recording 0.815 -> 0.790
    acc = end_at_crossing(zone_voice(hm, mel, bl, chord_tones, max_notes=max_chord), mel, bl)
    acc = with_role(scale_velocity(restrike(acc), 0.75), "accomp")
    return sort_notes([replace(n, hand="R") for n in mel] + [replace(n, hand="L") for n in bl] + acc)


def under_melody(accomp: list[Note], mel: list[Note], gap: int = 1) -> list[Note]:
    """Accompaniment notes that stay below the melody: a note that sounds while a melody note sounds
    and reaches within `gap` semitones of it (or above it) is dropped, so the tune is the top line."""
    ms = sorted(mel, key=lambda m: m.start)
    starts = np.array([m.start for m in ms])
    ends = np.maximum.accumulate(np.array([m.end for m in ms])) if ms else np.array([])
    out = []
    for n in accomp:
        hi = int(np.searchsorted(starts, n.end))       # melody notes starting before this one ends
        lo = int(np.searchsorted(ends, n.start, side="right"))  # ... and (some) ending after it starts
        if any(ms[i].end > n.start and n.pitch >= ms[i].pitch - gap for i in range(lo, hi)):
            continue
        out.append(n)
    return out


def arrange_hybrid(lead: list[Note], piano: list[Note], parts: str, lead_center: int | None = None) -> list[Note]:
    """source=hybrid, a piano-led song with vocals (DESIGN.md §14): the sung melody in the right hand
    over the song's own piano part. The melody is fitted to E4-E6 as in `arrange`; the piano part
    keeps its own voicing (the piano model's notes, not Basic Pitch's re-voiced harmony), minus the
    notes that would sound at, just under or above the melody (doubles included). Hands come from the
    beam search over both (`assign_hands_adaptive`, lead notes stay right), then `fit_hands` keeps each
    written chord playable (§24); key-press lengths (`key_lengths`) apply to the piano part only, so a held
    sung note is not cut by the next chord."""
    mel = skyline(drop_short(lead, 0.08), top=True)
    mel = with_role(fit_register(drop_short(mel, 0.08), *LEAD_RANGE, center=lead_center), "lead")
    if parts == "lead":
        return assign_hands(mel)
    acc = under_melody(with_role(clamp_to_piano(drop_short(piano, 0.03)), "accomp"), mel)
    both = fit_hands(assign_hands_adaptive(mel + acc))
    return sort_notes([n for n in both if n.role == "lead"] + key_lengths([n for n in both if n.role != "lead"]))


FIT_NEAR = 0.25  # seconds: notes this near are one written chord (a 16th at 60 a minute; 0.15 left 2.5% unplayable, §24)


def fit_hands(notes: list[Note], reach: int = HAND_REACH, near: float = FIT_NEAR) -> list[Note]:
    """Each hand's written chords within `reach` semitones (DESIGN.md §24). The hand search groups notes within
    CHORD_TOL, but a sung note and the piano's chord start up to a 16th apart and the score writes them as one
    chord. Right hand: a piano note more than `reach` under a lead note that starts within `near` of it goes to
    the left hand if that hand can take it, else up by octaves into reach (under the lead), else it is dropped.
    Left hand: a note more than `reach` over the lowest left-hand note within `near` goes to the right hand if
    that hand can take it under the lead, else down by octaves, else it is dropped. A hand takes a note when its
    notes within `near` stay within `reach`, under HAND_NOTES, and do not strike that pitch already (no doubled
    key). Lead notes and each window's lowest note never move; a chord of more than HAND_NOTES notes within
    reach is not thinned."""
    out = sort_notes(notes)
    lead = [n for n in out if n.role == "lead"]
    l_on = np.array([n.start for n in lead])  # sorted, as `out` is
    l_p = np.array([n.pitch for n in lead])
    starts = np.array([n.start for n in out])
    keep = [True] * len(out)

    def window(i: int, hand: str) -> set[int]:  # the pitches that hand strikes within `near` of note i
        lo = int(np.searchsorted(starts, starts[i] - near))
        hi = int(np.searchsorted(starts, starts[i] + near, side="right"))
        return {out[k].pitch for k in range(lo, hi) if keep[k] and k != i and out[k].hand == hand}

    def lead_top(t: float) -> int | None:  # the highest lead note starting within `near` of t
        lo, hi = int(np.searchsorted(l_on, t - near)), int(np.searchsorted(l_on, t + near, side="right"))
        return int(l_p[lo:hi].max()) if hi > lo else None

    def takes(ps: set[int], p: int) -> bool:  # a hand striking `ps` can also strike p
        return p not in ps and max(ps | {p}) - min(ps | {p}) <= reach and len(ps) < HAND_NOTES

    for i, n in enumerate(out):  # the right hand, under the lead
        if n.role == "lead" or n.hand != "R":
            continue
        top = lead_top(n.start)
        if top is None or n.pitch >= top - reach:
            continue
        if takes(window(i, "L"), n.pitch):
            out[i] = replace(n, hand="L")
            continue
        q = n.pitch + 12 * int(np.ceil((top - reach - n.pitch) / 12))
        rh = window(i, "R")
        if q <= top - 2 and q not in rh and len(rh) < HAND_NOTES:
            out[i] = replace(n, pitch=q)
        else:
            keep[i] = False
    for i, n in enumerate(out):  # the left hand, over its lowest note
        if not keep[i] or n.role == "lead" or n.hand != "L":
            continue
        lh = window(i, "L")
        bottom = min(lh | {n.pitch})
        if n.pitch <= bottom + reach:
            continue
        top = lead_top(n.start)
        if (top is None or n.pitch <= top - 2) and takes(window(i, "R"), n.pitch):
            out[i] = replace(n, hand="R")
            continue
        q = n.pitch - 12 * int(np.ceil((n.pitch - bottom - reach) / 12))
        if q > bottom and q not in lh and len(lh) < HAND_NOTES:
            out[i] = replace(n, pitch=q)
        else:
            keep[i] = False
    return [n for n, k in zip(out, keep) if k]


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
