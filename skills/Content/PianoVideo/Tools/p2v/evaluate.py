"""Score a piano2video run against a ground-truth score (MusicXML or MIDI).

The reference lives in score time (quarter notes); the recording in seconds.
DTW on chroma + onset-chroma features aligns the two, every reference note is
mapped to seconds, and then each stage is scored with mir_eval:

  notes      onset-only note P/R/F1 — exact pitch, and pitch class (octave errors forgiven)
  hands      of the matched notes, the share in the same hand (staff) as the reference
  melody     reference RH top line vs the variant's RH top line
  durations  median ratio of our note length to the reference's aligned length
  beats      beat F-measure of the pipeline's beat grid vs the reference quarter-note grid
  key/meter  our key signature and meter vs the reference's

The reference is usually an arrangement, not a performance transcript, so
absolute precision is a floor. Compare runs against each other, not against 1.0.

Usage:
  python -m p2v.evaluate <work_dir> --reference ref.musicxml [--json out.json]
"""

from __future__ import annotations

import argparse
import json
import sys
from dataclasses import dataclass
from pathlib import Path

import numpy as np

from .arrange import CHORD_TOL, Note

HOP, SR = 1024, 22050
ONSET_TOL = 0.10  # s — DTW alignment is good to roughly one 46 ms frame, so allow two


@dataclass(frozen=True)
class RefNote:
    q_on: float  # quarter notes from the start of the (repeat-expanded) score
    q_off: float
    pitch: int
    hand: str  # "L" for the bottom staff, "R" for every staff above it (a voice line included)
    staff: int = 0  # 0 = top staff


@dataclass(frozen=True)
class Reference:
    notes: list[RefNote]
    sharps: int | None
    meter: str | None
    bpm: float | None  # tempo marking, if the score has one


# ------------------------------------------------------------ reference -- #

def load_reference(path: Path, staves: list[int] | None = None) -> Reference:
    """Staves are numbered from 0 at the top; `staves` keeps only those (e.g. drop a voice line
    the recording doesn't play). The lowest kept staff is the left hand, the rest the right."""
    if path.suffix.lower() in (".mid", ".midi"):
        return _load_reference_midi(path)
    from music21 import converter, harmony, key, meter, tempo
    s = converter.parse(str(path))
    try:
        s = s.expandRepeats()
    except Exception as e:  # noqa: BLE001 — music21 raises several types for odd repeat marks
        print(f"evaluate: repeats not expanded ({e}); scoring the score as written", file=sys.stderr)
    parts = list(s.parts)
    keep = staves if staves is not None else list(range(len(parts)))
    notes: list[RefNote] = []
    for i, part in enumerate(parts):
        if i not in keep:
            continue
        hand = "L" if i == max(keep) and len(keep) > 1 else "R"
        for el in part.stripTies().flatten().notes:
            if el.duration.isGrace or isinstance(el, harmony.ChordSymbol):  # a lead sheet's symbol: not played
                continue
            q0, q1 = float(el.offset), float(el.offset + el.quarterLength)
            notes.extend(RefNote(q0, q1, p.midi, hand, i) for p in el.pitches)
    ks = next(iter(s.recurse().getElementsByClass(key.KeySignature)), None)
    ts = next(iter(s.recurse().getElementsByClass(meter.TimeSignature)), None)
    mm = next(iter(s.recurse().getElementsByClass(tempo.MetronomeMark)), None)
    return Reference(sorted(notes, key=lambda n: (n.q_on, n.pitch)),
                     ks.sharps if ks is not None else None,
                     ts.ratioString if ts is not None else None,
                     float(mm.getQuarterBPM()) if mm is not None and mm.number else None)


def _load_reference_midi(path: Path) -> Reference:
    import pretty_midi
    pm = pretty_midi.PrettyMIDI(str(path))
    res = pm.resolution
    notes = []
    for i, inst in enumerate(i for i in pm.instruments if not i.is_drum):
        hand = "L" if ("left" in inst.name.lower() or " lh" in f" {inst.name.lower()}" or i == 1) else "R"
        for n in inst.notes:
            notes.append(RefNote(pm.time_to_tick(n.start) / res, pm.time_to_tick(n.end) / res, n.pitch, hand))
    ts = pm.time_signature_changes[0] if pm.time_signature_changes else None
    ks = pm.key_signature_changes[0] if pm.key_signature_changes else None
    sharps = None
    if ks is not None:
        from music21 import key
        name = pretty_midi.key_number_to_key_name(ks.key_number).replace(" Major", "").replace(" Minor", " minor")
        tonic, *mode = name.split()
        sharps = key.Key(tonic.replace("b", "-"), mode[0] if mode else "major").sharps
    _, tempi = pm.get_tempo_changes()
    return Reference(sorted(notes, key=lambda n: (n.q_on, n.pitch)), sharps,
                     f"{ts.numerator}/{ts.denominator}" if ts else None,
                     float(tempi[0]) if len(tempi) else None)


# ------------------------------------------------------------ alignment -- #

def _l2(x: np.ndarray) -> np.ndarray:
    return x / (np.linalg.norm(x, axis=0, keepdims=True) + 1e-9)


def audio_features(y: np.ndarray, sr: int = SR, hop: int = HOP) -> np.ndarray:
    """24 x T: L2-normalised chroma stacked on half-wave-rectified chroma flux (onsets)."""
    import librosa
    c = librosa.feature.chroma_cqt(y=y, sr=sr, hop_length=hop)
    flux = np.maximum(0.0, np.diff(np.log1p(100 * c), axis=1, prepend=np.log1p(100 * c[:, :1])))
    return np.vstack([_l2(c), _l2(flux)])


def align(ref: Reference, y: np.ndarray, sr: int = SR, hop: int = HOP, nominal_bpm: float | None = None,
          span: tuple[float, float] | None = None, refine: bool = True):
    """Return q -> seconds for the reference against the recording.

    The score is synthesized at a nominal tempo and both signals go through the
    same feature extractor, then a full DTW (steps weighted by length, so steep
    paths aren't favoured). The reference must cover `span` (default: the whole
    recording) — songs built on a repeating loop make partial matches ambiguous.
    DTW frames are 46 ms, so `refine` then snaps each reference onset to the recording's
    own onsets (refine_onsets)."""
    import librosa
    from .render import synthesize
    t0, t1 = span or (0.0, len(y) / sr)
    seg = y[int(t0 * sr): int(t1 * sr)]
    total_q = max(n.q_off for n in ref.notes)
    bpm = nominal_bpm or ref.bpm or total_q / (len(seg) / sr) * 60.0
    spq = 60.0 / bpm  # nominal seconds per quarter
    synth = synthesize([Note(n.q_on * spq, n.q_off * spq, n.pitch, 80) for n in ref.notes], total_q * spq, sr)
    R, A = audio_features(synth, sr, hop), audio_features(seg, sr, hop)
    cost = 1.0 - 0.5 * (R[:12].T @ A[:12]) - 0.5 * (R[12:].T @ A[12:])
    _, wp = librosa.sequence.dtw(C=cost, step_sizes_sigma=np.array([[1, 1], [1, 2], [2, 1]]),
                                 weights_mul=np.array([2.0, 3.0, 3.0]))
    wp = wp[::-1]
    q = wp[:, 0] * hop / sr / spq
    t = t0 + wp[:, 1] * hop / sr
    # one time per reference frame (mean over the audio frames it maps to), non-decreasing in q
    uq, inv = np.unique(q, return_inverse=True)
    ut = np.bincount(inv, weights=t) / np.bincount(inv)
    coarse = lambda qq: np.interp(qq, uq, np.maximum.accumulate(ut))  # noqa: E731
    if not refine:
        return coarse
    return refine_onsets(coarse, sorted({n.q_on for n in ref.notes}), audio_onsets(seg, sr) + t0)


def audio_onsets(y: np.ndarray, sr: int = SR, hop: int = 128) -> np.ndarray:
    """Onset times (s) detected in the recording itself at 5.8 ms hops — independent of any
    transcription, so snapping the reference to them doesn't favour the pipeline. Backtracking
    to the energy minimum matters: flux peaks lag the piano model's onsets by 20-37 ms, the
    backtracked times by ~2 ms (Connections, 444 onsets)."""
    import librosa
    return librosa.onset.onset_detect(y=y, sr=sr, hop_length=hop, units="time", backtrack=True)


def refine_onsets(q2s, q_onsets, onsets: np.ndarray, win: float = 0.07, outlier: float = 0.04, k: int = 4):
    """Snap a q -> seconds map to audio onsets: each reference onset moves to the nearest detected
    onset within `win` s; a snap that disagrees with the median of its +-k neighbours' snaps by more
    than `outlier` s is dropped (a missed onset pulls toward the wrong note), and so is any that
    would run backwards. Snapped onsets are exact. Where at most one reference onset between two
    snapped ones went unsnapped, the map is a straight line between them: DTW's path wobbles by
    50-100 ms on single notes, and the line predicts that onset better (Connections: p90 error
    52 -> 16 ms). Where three or more in a row went unsnapped (soft, pedalled passages: the
    detector finds few onsets, as in Starlight's intro) the input map is kept, shifted by the
    interpolated snap correction; two blend the two."""
    q_onsets = np.asarray(q_onsets, dtype=float)
    onsets = np.sort(np.asarray(onsets, dtype=float))
    if len(q_onsets) == 0 or len(onsets) < 2:
        return q2s
    td = q2s(q_onsets)
    i = np.clip(np.searchsorted(onsets, td), 1, len(onsets) - 1)
    near = np.where(np.abs(onsets[i - 1] - td) <= np.abs(onsets[i] - td), onsets[i - 1], onsets[i])
    ok = np.abs(near - td) <= win
    qa, ra = q_onsets[ok], (near - td)[ok]
    keep = [j for j in range(len(ra)) if abs(ra[j] - np.median(ra[max(0, j - k): j + k + 1])) <= outlier]
    aq: list[float] = []
    at: list[float] = []
    for j in keep:  # strictly increasing times: two reference onsets can't share one audio onset
        t = float(q2s(qa[j]) + ra[j])
        if not at or t > at[-1]:
            aq.append(float(qa[j]))
            at.append(t)
    if len(aq) < 2:
        return q2s
    aq_, at_ = np.array(aq), np.array(at)
    ar_ = at_ - q2s(aq_)
    rank = np.searchsorted(q_onsets, aq_)  # each anchor's index among all reference onsets
    missed = np.r_[0, np.diff(rank) - 1]   # unsnapped reference onsets before each anchor
    w_gap = np.clip((3.0 - missed) / 2.0, 0.0, 1.0)  # 0-1 missed: line; 2: half; 3+: input map

    def fine(qq):
        qq = np.asarray(qq, dtype=float)
        line = np.interp(qq, aq_, at_)
        shifted = q2s(qq) + np.interp(qq, aq_, ar_)  # also covers both ends: the end correction is held
        j = np.clip(np.searchsorted(aq_, qq), 1, len(aq_) - 1)
        w = np.where((qq < aq_[0]) | (qq > aq_[-1]), 0.0, w_gap[j])
        return w * line + (1 - w) * shifted
    return fine


# --------------------------------------------------------------- metrics -- #

def _mir(intervals, pitches):
    import mir_eval
    iv = np.asarray(intervals, dtype=float).reshape(-1, 2)
    iv[:, 1] = np.maximum(iv[:, 1], iv[:, 0] + 0.01)
    return iv, mir_eval.util.midi_to_hz(np.asarray(pitches, dtype=float))


def note_scores(ref_iv, ref_p, est_iv, est_p, tol: float = ONSET_TOL) -> dict:
    import mir_eval
    out = {}
    for label, f in (("exact", lambda p: np.asarray(p)), ("pitch_class", lambda p: 60 + np.asarray(p) % 12)):
        ri, rp = _mir(ref_iv, f(ref_p))
        ei, ep = _mir(est_iv, f(est_p))
        p, r, f1, _ = mir_eval.transcription.precision_recall_f1_overlap(ri, rp, ei, ep, onset_tolerance=tol,
                                                                         offset_ratio=None)
        out[label] = {"precision": round(p, 3), "recall": round(r, 3), "f1": round(f1, 3)}
    return out


def match(ref_iv, ref_p, est_iv, est_p, tol: float = ONSET_TOL) -> list[tuple[int, int]]:
    import mir_eval
    ri, rp = _mir(ref_iv, ref_p)
    ei, ep = _mir(est_iv, est_p)
    return mir_eval.transcription.match_notes(ri, rp, ei, ep, onset_tolerance=tol, offset_ratio=None)


def top_line(onsets: np.ndarray, pitches: np.ndarray) -> np.ndarray:
    """Indices of the highest note of each onset group (chords within CHORD_TOL) — the onset skyline."""
    keep: list[int] = []
    group: list[int] = []
    for i in np.argsort(onsets, kind="stable"):
        if group and onsets[i] - onsets[group[0]] > CHORD_TOL:
            keep.append(max(group, key=lambda g: pitches[g]))
            group = []
        group.append(int(i))
    if group:
        keep.append(max(group, key=lambda g: pitches[g]))
    return np.asarray(keep, dtype=int)


def score_notes(ref: Reference, q2s, est: list[Note], span: tuple[float, float]) -> dict:
    est = [n for n in est if span[0] - ONSET_TOL <= n.start <= span[1] + ONSET_TOL]
    ref_iv = np.array([[q2s(n.q_on), q2s(n.q_off)] for n in ref.notes])
    ref_p = np.array([n.pitch for n in ref.notes])
    est_iv = np.array([[n.start, n.end] for n in est]).reshape(-1, 2)
    est_p = np.array([n.pitch for n in est])
    res = {"n_ref": len(ref.notes), "n_est": len(est), "notes": note_scores(ref_iv, ref_p, est_iv, est_p)}
    pairs = match(ref_iv, ref_p, est_iv, est_p)
    if pairs and all(n.hand for n in est):
        res["hand_agreement"] = round(float(np.mean([ref.notes[i].hand == est[j].hand for i, j in pairs])), 3)
    if pairs:
        ratio = [(est_iv[j, 1] - est_iv[j, 0]) / max(1e-3, ref_iv[i, 1] - ref_iv[i, 0]) for i, j in pairs]
        res["duration_ratio_p25_p50_p75"] = [round(float(x), 2) for x in np.percentile(ratio, [25, 50, 75])]
    # melody: reference RH onset skyline vs our RH onset skyline
    rh = np.array([i for i, n in enumerate(ref.notes) if n.hand == "R"], dtype=int)
    erh = np.array([j for j, n in enumerate(est) if (n.hand or "R") == "R"], dtype=int)
    if len(rh) and len(erh):
        rm = rh[top_line(ref_iv[rh, 0], ref_p[rh])]
        em = erh[top_line(est_iv[erh, 0], est_p[erh])]
        res["melody"] = note_scores(ref_iv[rm], ref_p[rm], est_iv[em], est_p[em])["exact"]
    return res


def bar_quarters(meter: str | None) -> float:
    """Quarter notes per bar of an 'n/d' meter (4 when unknown)."""
    if not meter or "/" not in meter:
        return 4.0
    n, d = meter.split("/")
    return float(n) * 4.0 / float(d)


def score_beats(ref: Reference, q2s, est_beats: np.ndarray, span: tuple[float, float],
                est_bars: np.ndarray | None = None) -> dict:
    """Beat F-measure against every metrical level of the reference: a 6/8 or 12/8 piece is felt in
    dotted quarters, a slow one in eighths, so `best_level` says which pulse the tracker found.
    With `est_bars` (the score's bar lines in seconds), `downbeat_f_measure` scores them against
    the reference bar lines (70 ms window)."""
    import mir_eval
    total_q = max(n.q_off for n in ref.notes)
    bar_q = bar_quarters(ref.meter)
    est_beats = est_beats[(est_beats >= span[0] - 0.5) & (est_beats <= span[1] + 0.5)]
    ref_beats = q2s(np.arange(0, np.floor(total_q) + 1))
    out = {"ref_bpm_aligned": round(60.0 / float(np.median(np.diff(ref_beats))), 1),
           "est_bpm": round(60.0 / float(np.median(np.diff(est_beats))), 1) if len(est_beats) > 1 else None}
    levels = {"f_measure": 1.0, "f_measure_vs_half": 2.0, "f_measure_vs_double": 0.5,
              "f_measure_vs_dotted": 1.5, "f_measure_vs_bar": bar_q}
    for label, step in levels.items():
        rb = q2s(np.arange(0, total_q + 1e-9, step))
        out[label] = round(float(mir_eval.beat.f_measure(rb, est_beats)), 3) if len(rb) > 1 else None
    best = max(levels, key=lambda k: out[k] or 0.0)
    out["best_level"] = {"f_measure": "quarter", "f_measure_vs_half": "half", "f_measure_vs_double": "eighth",
                         "f_measure_vs_dotted": "dotted quarter", "f_measure_vs_bar": "bar"}[best]
    if est_bars is not None:
        ref_bars = q2s(np.arange(0, total_q + 1e-9, bar_q))
        est_bars = est_bars[(est_bars >= span[0] - 0.5) & (est_bars <= span[1] + 0.5)]
        out["downbeat_f_measure"] = round(float(mir_eval.beat.f_measure(ref_bars, est_bars)), 3)
    return out


def grid_map(q_knots, t_knots):
    """Score quarter offset -> seconds through matching knots, extrapolated linearly at both ends."""
    q, t = np.asarray(q_knots, dtype=float), np.asarray(t_knots, dtype=float)
    lo, hi = (t[1] - t[0]) / (q[1] - q[0]), (t[-1] - t[-2]) / (q[-1] - q[-2])

    def f(qq):
        qq = np.asarray(qq, dtype=float)
        return np.where(qq < q[0], t[0] + (qq - q[0]) * lo,
                        np.where(qq > q[-1], t[-1] + (qq - q[-1]) * hi, np.interp(qq, q, t)))
    return f


def score_notation(ref: Reference, q2s, est: Reference, est_q2s, span: tuple[float, float]) -> dict:
    """Score-space accuracy of the engraved score. Notated notes are placed in seconds through the
    pipeline's own beat grid and matched to the reference (exact pitch, onset within ONSET_TOL).
    For each pair, compare where the note sits in its bar and how long it is written, both as a
    fraction of the bar, so 6/4 and 12/8 spellings of the same bars agree."""
    rb, eb = bar_quarters(ref.meter), bar_quarters(est.meter)
    en = [n for n in est.notes if span[0] - ONSET_TOL <= float(est_q2s(n.q_on)) <= span[1] + ONSET_TOL]
    ref_iv = np.array([[q2s(n.q_on), q2s(n.q_off)] for n in ref.notes])
    est_iv = np.array([[est_q2s(n.q_on), est_q2s(n.q_off)] for n in en]).reshape(-1, 2)
    pairs = match(ref_iv, np.array([n.pitch for n in ref.notes]), est_iv, np.array([n.pitch for n in en]))
    if not pairs:
        return {"matched": 0}
    pos_err, dur_ratio = [], []
    for i, j in pairs:
        r, e = ref.notes[i], en[j]
        d = (e.q_on % eb) / eb - (r.q_on % rb) / rb
        pos_err.append(abs((d + 0.5) % 1.0 - 0.5) * rb * 4)  # in reference sixteenths
        dur_ratio.append(((e.q_off - e.q_on) / eb) / max(1e-6, (r.q_off - r.q_on) / rb))
    pos_err, dur_ratio = np.array(pos_err), np.array(dur_ratio)
    return {"matched": len(pairs),
            "onset_in_bar_exact": round(float(np.mean(pos_err < 1e-3)), 3),
            "onset_in_bar_within_16th": round(float(np.mean(pos_err <= 1 + 1e-3)), 3),
            "written_length_exact": round(float(np.mean(np.abs(np.log(dur_ratio)) < 0.01)), 3),
            "written_length_ratio_p25_p50_p75": [round(float(x), 2) for x in np.percentile(dur_ratio, [25, 50, 75])]}


def notation_load(path: Path, q_lo: float, q_hi: float, reach: int = 15, max_notes: int = 5) -> dict:
    """Reading load of a MusicXML score between two quarter offsets (all staves): written symbols
    (notes, chords, rests) per bar, the share of notes shorter than an eighth, and the share of
    notes tied on to another (split by a bar line or beat). A hidden rest (a lower voice's gap) is not a
    symbol, nor is a chord symbol; the bars end where the score ends (the whole-score call passes q_hi = 1e9). Written
    playability: the share of a staff's written onsets (all voices) that strike more than `max_notes`
    notes or span more than `reach` semitones (the bank's rule on the MIDI, here on the score)."""
    from music21 import converter, harmony, meter
    s = converter.parse(str(path))
    ts = next(iter(s.recurse().getElementsByClass(meter.TimeSignature)), None)
    bar_q = float(ts.barDuration.quarterLength) if ts is not None else 4.0
    sym = short = tied = notes = 0
    onsets: list[set[int]] = []
    for part in s.parts:
        struck: dict[float, set[int]] = {}
        for el in part.flatten().notesAndRests:
            if not q_lo <= float(el.offset) < q_hi or el.duration.isGrace or isinstance(el, harmony.ChordSymbol):
                continue
            if el.isRest and el.style.hideObjectOnPrint:
                continue
            sym += 1
            if el.isRest:
                continue
            notes += 1
            short += el.quarterLength < 0.5 - 1e-6
            tied += el.tie is not None and el.tie.type in ("start", "continue")
            new = [n.pitch.midi for n in (el.notes if el.isChord else [el]) if n.tie is None or n.tie.type == "start"]
            if new:  # a chord's own pitches each carry a tie: only the struck ones count
                struck.setdefault(round(float(el.offset), 4), set()).update(new)
        onsets.extend(struck.values())
    end = float(np.ceil(float(s.highestTime) / bar_q - 1e-9) * bar_q)  # the last bar, whole
    bars = max(1e-9, (min(q_hi, end) - q_lo) / bar_q)
    return {"symbols_per_bar": round(sym / bars, 1),
            "shorter_than_eighth": round(short / max(1, notes), 3),
            "tied_on": round(tied / max(1, notes), 3),
            "unplayable_written": round(sum(len(ps) > max_notes or max(ps) - min(ps) > reach for ps in onsets)
                                        / max(1, len(onsets)), 3)}


def bar_check(ref: Reference, q2s, est: list[Note], low: float = 0.6) -> dict:
    """Per-bar onset F1 (pitch class) of a transcription against the reference: the check that the
    score is this recording's music before any scoring. Bars under `low` need a look."""
    bar_q = bar_quarters(ref.meter)
    n_bars = int(np.ceil(max(n.q_off for n in ref.notes) / bar_q - 1e-9))
    f1 = []
    for b in range(n_bars):
        rn = [n for n in ref.notes if b * bar_q <= n.q_on < (b + 1) * bar_q]
        t0, t1 = float(q2s(b * bar_q)), float(q2s((b + 1) * bar_q))
        en = [n for n in est if t0 - 0.05 <= n.start < t1 - 0.05]
        if not rn:
            f1.append(None)
            continue
        s = note_scores(np.array([[q2s(n.q_on), q2s(n.q_off)] for n in rn]), np.array([n.pitch for n in rn]),
                        np.array([[n.start, n.end] for n in en]).reshape(-1, 2), np.array([n.pitch for n in en]))
        f1.append(s["pitch_class"]["f1"])
    return {"bar_quarters": bar_q, "low_f1_bars": [b + 1 for b, f in enumerate(f1) if f is not None and f < low],
            "f1_pitch_class_per_bar": f1}


# ---------------------------------------------------------------- driver -- #

def _notes_from_midi(path: Path) -> list[Note]:
    import pretty_midi
    pm = pretty_midi.PrettyMIDI(str(path))
    out = []
    for inst in pm.instruments:
        hand = "L" if "LH" in inst.name else "R" if "RH" in inst.name else None
        out.extend(Note(n.start, n.end, n.pitch, n.velocity, hand=hand) for n in inst.notes)
    return sorted(out, key=lambda n: (n.start, n.pitch))


def _variant_key(musicxml: Path) -> tuple[int | None, str | None]:
    from music21 import converter, key, meter
    s = converter.parse(str(musicxml))
    ks = next(iter(s.recurse().getElementsByClass(key.KeySignature)), None)
    ts = next(iter(s.recurse().getElementsByClass(meter.TimeSignature)), None)
    return (ks.sharps if ks is not None else None), (ts.ratioString if ts is not None else None)


def evaluate(work: Path, reference: Path, nominal_bpm: float | None = None,
             span: tuple[float, float] | None = None, staves: list[int] | None = None,
             refine: bool = True) -> dict:
    import librosa
    from .pipeline import _notes_from_json
    ref = load_reference(reference, staves)
    wav = work / "input.wav"
    y, _ = librosa.load(str(wav), sr=SR, mono=True)
    q2s = align(ref, y, nominal_bpm=nominal_bpm, span=span, refine=refine)
    total_q = max(n.q_off for n in ref.notes)
    span = (float(q2s(0.0)), float(q2s(total_q)))
    out: dict = {"reference": str(reference), "ref_notes": len(ref.notes), "ref_key_sharps": ref.sharps,
                 "ref_meter": ref.meter, "ref_tempo_mark": ref.bpm, "aligned_span_s": [round(x, 2) for x in span],
                 "stages": {}}
    for tx in sorted((work / "tx").glob("*.json")):
        out["stages"][f"tx/{tx.stem}"] = score_notes(ref, q2s, _notes_from_json(tx), span)
    piano_tx = next((p for p in (work / "tx" / "piano-mix.json", work / "tx" / "piano.json") if p.exists()), None)
    if piano_tx is not None:
        out["bar_check"] = bar_check(ref, q2s, _notes_from_json(piano_tx))
    report = json.loads((work / "report.json").read_text()) if (work / "report.json").exists() else {}
    grids = report.get("grids", {})
    if not grids:
        print("evaluate: report.json has no score grid (a run before 2026-10-26's meter change): "
              "notation and beats not scored", file=sys.stderr)
    for mid in sorted(work.glob("*.mid")):
        res = score_notes(ref, q2s, _notes_from_midi(mid), span)
        xml = mid.with_suffix(".musicxml")
        grid = grids.get(mid.stem.split("_")[0])
        if xml.exists():
            sharps, ts = _variant_key(xml)
            res["key_match"] = (sharps - ref.sharps) % 12 == 0 if ref.sharps is not None and sharps is not None else None  # 6 sharps = 6 flats
            res["meter"] = ts
        if xml.exists() and grid:
            # the score drops whole empty bars before the variant's first note (notation.lead_in)
            offset = float(report.get("variants", {}).get(mid.stem, {}).get("score_offset_q", 0.0))
            grid_q2s = grid_map(grid["q"], grid["t"])
            est_q2s = lambda qq, f=grid_q2s, o=offset: f(np.asarray(qq, dtype=float) + o)  # noqa: E731
            est = load_reference(xml)
            res["notation"] = score_notation(ref, q2s, est, est_q2s, span)
            q_lo, q_hi = np.interp(span, grid["t"], grid["q"]) - offset  # seconds -> score quarters
            res["notation"]["load"] = notation_load(xml, float(q_lo), float(q_hi))
        out["stages"][mid.stem] = res
    out["reference_load"] = notation_load(reference, 0.0, total_q)
    grid = grids.get("piano") or next(iter(grids.values()), None)
    if grid:
        q2t = grid_map(grid["q"], grid["t"])
        q_lo, q_hi = min(grid["q"]), max(grid["q"])
        beats = q2t(np.arange(np.ceil(q_lo / grid["beat_q"]) * grid["beat_q"], q_hi, grid["beat_q"]))
        bars = q2t(np.arange(np.ceil(q_lo / grid["bar_q"]) * grid["bar_q"], q_hi, grid["bar_q"]))
        out["beats"] = score_beats(ref, q2s, beats, span, bars)
    return out


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("work", type=Path, help="piano2video work dir (has input.wav, tx/, *.mid)")
    ap.add_argument("--reference", type=Path, required=True, help="ground truth .musicxml/.mxl/.mid")
    ap.add_argument("--nominal-bpm", type=float, help="reference tempo hint for alignment (default: score mark)")
    ap.add_argument("--span", type=float, nargs=2, metavar=("START", "END"),
                    help="seconds of the recording the reference covers (default: all of it)")
    ap.add_argument("--staves", help="comma list of staves to score, 0 = top (default: all)")
    ap.add_argument("--json", type=Path, help="also write the report here")
    ap.add_argument("--no-refine", action="store_true", help="DTW map only (no snapping to audio onsets)")
    args = ap.parse_args(argv)
    res = evaluate(args.work.expanduser(), args.reference.expanduser(), args.nominal_bpm,
                   tuple(args.span) if args.span else None,
                   [int(x) for x in args.staves.split(",")] if args.staves else None,
                   refine=not args.no_refine)
    text = json.dumps(res, indent=2)
    if args.json:
        args.json.write_text(text)
    print(text)


if __name__ == "__main__":
    main()
