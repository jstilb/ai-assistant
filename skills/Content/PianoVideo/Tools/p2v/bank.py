"""Measurement bank: every song type scored with one command (DESIGN.md §13).

Song types (Jm 2026-10-27: "we want this to handle all of them. find a way to measure all of them"):
  T1 solo piano cover of a pop song   T2 solo classical piano
  T3 piano-led song with vocals       T4 song with no piano
  T5 an instrumental section (no voice in the reference span) of a song with no piano lead: a drop,
     a riff, an instrumental track (DESIGN.md §21)
An arrangement is not a transcript, so every song is scored on what any good arrangement must keep
(meter, tempo, bar lines, key, the melody, chords: the "invariants"); where a note-level piano
reference exists (T1, T2, the piano part of a piano-vocal score) also on fidelity (notes, hands,
written position and length); and every song, with or without a reference, on reference-free
measures (unplayable chords, reading load, notes per second, hand span).

References come in three kinds, all turned into one form (`Ref`: notes in score quarters, a
quarters -> seconds map of the recording, beats, bar lines, key, chords):
  score  a MusicXML/MIDI score of this recording, aligned by `evaluate.align` (DTW + onset snapping)
  asap   an ASAP piece (corpus.py): the annotated beats give the alignment
  timed  annotations already in seconds (a dataset): JSON with meter, beats, downbeats, key,
         melody [[on, off, midi]], chords [[on, off, "A:min"]], span
Each song is run through the whole pipeline (Demucs, transcription, every source x parts variant,
no video), so the bank measures what a user gets. Data lives in ~/.kaya/piano2video/bank/ (P2V_BANK),
never in the repo: songs.json (the song list), work/<id>/ (cached stages), runs/<label>/<id>/,
results/<label>.json.

Usage (from Tools/):
  python -m p2v.bank list
  python -m p2v.bank run --label base [--types T1,T3] [--half tune|check] [--songs a,b] [--set meter.DBN_RANGE=1.3]
  python -m p2v.bank compare base new [--variant arrange_lead-accomp]
"""

from __future__ import annotations

import argparse
import ast
import hashlib
import importlib
import json
import os
import shutil
import sys
import time
from dataclasses import dataclass, field, replace
from pathlib import Path

import numpy as np

from .arrange import CHORD_TOL, Note
from .evaluate import (ONSET_TOL, Reference, RefNote, bar_quarters, grid_map, load_reference, match,
                       note_scores, notation_load, score_notation, score_notes, top_line)

ROOT = Path(os.environ.get("P2V_BANK", Path.home() / ".kaya/piano2video/bank"))
TYPES = {"T1": "solo piano cover of a pop song", "T2": "solo classical piano",
         "T3": "piano-led song with vocals", "T4": "song with no piano",
         "T5": "instrumental section, no piano lead"}
# the path each type should take (the router's target, DESIGN.md §4)
EXPECTED_SOURCE = {"T1": "piano", "T2": "piano", "T3": "hybrid", "T4": "arrange", "T5": "arrange"}
REACH, MAX_NOTES = 15, 5  # a hand spanning more semitones, or playing more notes at once, is unplayable
SAME_BARS = {"6/4": "12/8", "2/2": "4/4"}  # meters written differently with the same bars


@dataclass
class Song:
    id: str
    type: str                    # T1..T5
    half: str                    # tune | check: settings are chosen on tune, reported on check
    audio: str                   # file, http(s) URL (yt-dlp) or "asap:<ASAP folder>"
    start: float | None = None   # seconds of the source the pipeline trims to
    duration: float | None = None
    ref: dict = field(default_factory=dict)  # {} = no reference: reference-free measures only
    note: str = ""


@dataclass
class Ref:
    melody: Reference            # the melody line (quarters); empty when the reference has none
    texture: Reference | None    # the full piano texture with hands (fidelity), None for melody-only refs
    q2s: object                  # score quarters -> seconds of the run's input.wav
    span: tuple[float, float]    # seconds the reference covers
    meter: str | None
    beats: np.ndarray | None     # counted beats, seconds
    downbeats: np.ndarray | None
    sharps: int | None
    chords: list[tuple[float, float, str]] | None  # (start s, end s, Harte label)


# ----------------------------------------------------------------- songs -- #

def builtin_songs() -> list[Song]:
    """The songs whose references are already on disk: the two pop covers with scores (T1), the 19
    ASAP pieces (T2: corpus.py's tune/check split), Viva la FAI (T3, reference-free only)."""
    from . import corpus
    home = Path.home() / ".kaya/piano2video"
    songs = [
        Song("connections", "T1", "tune", str(home / "samples/connections/connections.mp3"), None, None,
             {"kind": "score", "path": str(home / "reference/connections-b1-35.musicxml"), "span": [0.9, 79.05]},
             "Jennie Chen's cover; her own score, bars 1-35 (DESIGN.md §8)"),
        Song("starlight-piano", "T1", "check", str(home / "samples/starlight/starlight.mp3"), None, None,
             {"kind": "score", "path": str(home / "reference/starlight-intro.musicxml"), "span": [0.0, 17.13]},
             "Jai Wolf's piano version; 8-bar intro of a different arrangement, loosely aligned (§7)"),
        Song("viva-la-fai", "T3", "tune", str(home / "samples/viva_la_fai.opus"), None, None, {},
             "Wikimedia Commons, CC BY 3.0: piano and voice; no reference"),
    ]
    songs += [Song(f"asap-{corpus.slug(p)}", "T2", "tune" if i % 2 == 0 else "check", f"asap:{p}", None, None,
                   {"kind": "asap", "folder": p}) for i, p in enumerate(corpus.PIECES)]
    return songs


def all_songs() -> list[Song]:
    """Built-in songs plus ROOT/songs.json (dataset songs and hand-added ones; same fields as Song)."""
    songs = builtin_songs()
    extra = ROOT / "songs.json"
    if extra.exists():
        known = {s.id for s in songs}
        songs += [Song(**d) for d in json.loads(extra.read_text()) if d["id"] not in known]
    return songs


def select(songs: list[Song], types: str | None = None, half: str | None = None, ids: str | None = None) -> list[Song]:
    keep = [s for s in songs if (not types or s.type in types.split(",")) and (not half or s.half == half)]
    return [s for s in keep if not ids or s.id in ids.split(",")]


# ------------------------------------------------------------ references -- #

def beat_quarters(meter: str | None) -> float:
    """Quarters per counted beat: a dotted quarter in 6/8, 9/8, 12/8; the denominator's note otherwise."""
    if not meter or "/" not in meter:
        return 1.0
    n, d = (int(x) for x in meter.split("/"))
    return 1.5 if d == 8 and n % 3 == 0 and n > 3 else 4.0 / d


def same_bars(a: str | None, b: str | None) -> bool:
    return a is not None and b is not None and SAME_BARS.get(a, a) == SAME_BARS.get(b, b)


def sharps_of(tonic: str, mode: str) -> int:
    """Key signature (sharps > 0, flats < 0) of a key such as ("Bb", "major") or ("F#", "minor")."""
    from music21 import key
    return int(key.Key(tonic.replace("b", "-") if len(tonic) > 1 else tonic, mode).sharps)


def timed_reference(d: dict, offset: float = 0.0) -> Ref:
    """A reference in seconds (dataset annotations) -> Ref. `offset` = the song's trim start, so
    times land on the run's input.wav. Score quarters count counted beats (beat_quarters of the
    meter) from the first downbeat, so position in the bar is q mod bar length."""
    meter = d.get("meter")
    bq = beat_quarters(meter)
    beats = np.asarray(d.get("beats", []), dtype=float) - offset
    downs = np.asarray(d.get("downbeats", []), dtype=float) - offset
    q2s = s2q = None
    if len(beats) >= 2:
        first = int(np.argmin(np.abs(beats - downs[0]))) if len(downs) else 0
        qs = (np.arange(len(beats)) - first) * bq
        q2s, s2q = grid_map(qs, beats), grid_map(beats, qs)
    melody = []
    for on, off, p in d.get("melody", []):
        on, off = on - offset, off - offset
        if s2q is not None:
            melody.append(RefNote(float(s2q(on)), float(s2q(off)), int(p), "R", 0))
        else:  # no beats: quarters = seconds (positions in the bar are not scored then)
            melody.append(RefNote(float(on), float(off), int(p), "R", 0))
    if q2s is None:
        q2s = lambda q: np.asarray(q, dtype=float)  # noqa: E731
    k = d.get("key")
    sharps = d.get("sharps") if "sharps" in d else (sharps_of(k["tonic"], k["mode"]) if k else None)
    span = tuple(float(x) - offset for x in d["span"]) if "span" in d else (
        (float(beats[0]), float(beats[-1])) if len(beats) else
        (min(n[0] for n in d["melody"]) - offset, max(n[1] for n in d["melody"]) - offset))
    chords = [(float(a) - offset, float(b) - offset, str(c)) for a, b, c in d.get("chords", [])] or None
    return Ref(Reference(sorted(melody, key=lambda n: (n.q_on, n.pitch)), sharps, meter, None), None, q2s,
               span, meter, beats if len(beats) else None, downs if len(downs) else None, sharps, chords)


def score_reference(spec: dict, wav: Path) -> Ref:
    """A score of this recording, aligned to it (evaluate.align). `melody_staff` names the staff
    holding the melody (a voice line); the other staves are the piano texture. Without it the
    melody is the right hand's top line, as in evaluate.score_notes."""
    import librosa
    from .evaluate import SR, align
    path = Path(spec["path"]).expanduser()
    staves = spec.get("staves")
    ref = load_reference(path, staves)
    y, _ = librosa.load(str(wav), sr=SR, mono=True)
    q2s = align(ref, y, nominal_bpm=spec.get("bpm"), span=tuple(spec["span"]) if spec.get("span") else None)
    total_q = max(n.q_off for n in ref.notes)
    span = (float(q2s(0.0)), float(q2s(total_q)))
    ms = spec.get("melody_staff")
    if ms is None:
        melody, texture = _top_line_ref(ref), ref
    else:
        piano = [n for n in ref.notes if n.staff != ms]
        low = max((n.staff for n in piano), default=0)
        piano = [RefNote(n.q_on, n.q_off, n.pitch, "L" if n.staff == low else "R", n.staff) for n in piano]
        melody = Reference([n for n in ref.notes if n.staff == ms], ref.sharps, ref.meter, ref.bpm)
        texture = Reference(piano, ref.sharps, ref.meter, ref.bpm) if piano else None
    bq, barq = beat_quarters(ref.meter), bar_quarters(ref.meter)
    return Ref(melody, texture, q2s, span, ref.meter, q2s(np.arange(0, total_q + 1e-9, bq)),
               q2s(np.arange(0, total_q + 1e-9, barq)), ref.sharps, _score_chords(path, q2s, total_q))


def _top_line_ref(ref: Reference) -> Reference:
    rh = [n for n in ref.notes if n.hand == "R"]
    keep = top_line(np.array([n.q_on for n in rh]), np.array([n.pitch for n in rh])) if rh else []
    return Reference(sorted((rh[i] for i in keep), key=lambda n: n.q_on), ref.sharps, ref.meter, ref.bpm)


def _score_chords(path: Path, q2s, total_q: float) -> list[tuple[float, float, str]] | None:
    """Chord symbols written in a MusicXML score (a lead sheet) as timed Harte labels, or None."""
    if path.suffix.lower() in (".mid", ".midi"):
        return None
    from music21 import converter, harmony
    s = converter.parse(str(path))
    cs = sorted(((float(c.getOffsetInHierarchy(s)), c) for c in s.recurse().getElementsByClass(harmony.ChordSymbol)),
                key=lambda t: t[0])
    if not cs:
        return None
    out = []
    for i, (q, c) in enumerate(cs):
        q1 = cs[i + 1][0] if i + 1 < len(cs) else total_q
        out.append((float(q2s(q)), float(q2s(q1)), harte_of(c)))
    return out


def harte_of(cs) -> str:
    """music21 ChordSymbol -> Harte label; a kind not listed is "X" (mir_eval leaves it out of the score)."""
    if cs.root() is None or getattr(cs, "chordKind", "") == "none":
        return "N"
    q = {"major": "maj", "minor": "min", "dominant-seventh": "7", "major-seventh": "maj7", "minor-seventh": "min7",
         "diminished": "dim", "diminished-seventh": "dim7", "half-diminished-seventh": "hdim7", "augmented": "aug",
         "suspended-fourth": "sus4", "suspended-second": "sus2", "major-sixth": "maj6", "minor-sixth": "min6",
         "dominant-ninth": "9", "major-ninth": "maj9", "minor-ninth": "min9"}.get(cs.chordKind or "major")
    return f"{PC_NAMES[cs.root().pitchClass]}:{q}" if q else "X"


# HookTheory (Donahue et al. 2022, github.com/chrisdonahue/sheetsage-data, CC BY-NC-SA 3.0): melody,
# chords, keys and meter of one section of a song, in beats, with a beat -> seconds alignment to a
# YouTube recording (`alignment.refined`). Used for T3/T4 references (DESIGN.md §13).
HT_FILE = ROOT / "raw/hooktheory/Hooktheory.json.gz"
MAJOR_STEPS = (2, 2, 1, 2, 2, 2, 1)
DEGREE = {1: "b2", 2: "2", 3: "b3", 4: "3", 5: "4", 6: "b5", 7: "5", 8: "#5", 9: "6", 10: "b7", 11: "7",
          13: "b9", 14: "9", 15: "#9", 17: "11", 18: "#11", 20: "b13", 21: "13"}
SHORTHAND = {(4, 3): "maj", (3, 4): "min", (3, 3): "dim", (4, 4): "aug", (4, 3, 3): "7", (4, 3, 4): "maj7",
             (3, 4, 3): "min7", (3, 3, 4): "hdim7", (3, 3, 3): "dim7", (5, 2): "sus4", (2, 5): "sus2"}
PC_NAMES = ("C", "C#", "D", "Eb", "E", "F", "F#", "G", "Ab", "A", "Bb", "B")


def mode_sharps(tonic_pc: int, steps: tuple[int, ...]) -> int:
    """Key signature of a mode given by its tonic and its first six scale steps (HookTheory's
    `scale_degree_intervals`): the relative major's signature, -5..6. A scale that is no rotation of
    the major scale (harmonic minor) counts as major or minor by its third."""
    for r in range(7):
        rot = MAJOR_STEPS[r:] + MAJOR_STEPS[:r]
        if tuple(steps) == rot[:6]:
            major = (tonic_pc - sum(MAJOR_STEPS[:r])) % 12
            break
    else:
        major = (tonic_pc + 3) % 12 if sum(steps[:2]) == 3 else tonic_pc
    s = (major * 7) % 12
    return s - 12 if s > 6 else s


def harte_from_intervals(root_pc: int, intervals: list[int]) -> str:
    """HookTheory chord (root, stacked intervals in semitones) -> Harte label: a shorthand when one
    fits, else the explicit degree list (mir_eval reads both); no intervals: the root alone ("(1)":
    mir_eval refuses "Bb:()", Hey Brother's second drop)."""
    q = SHORTHAND.get(tuple(intervals))
    if not intervals:
        q = "(1)"
    elif q is None:
        degs = np.cumsum(intervals)
        q = "(" + ",".join(DEGREE.get(int(x), DEGREE.get(int(x) % 12, "5")) for x in degs) + ")"
    return f"{PC_NAMES[root_pc % 12]}:{q}"


def hooktheory_timed(entry: dict) -> dict:
    """One HookTheory entry -> the bank's timed-reference JSON (seconds of the YouTube recording)."""
    al = entry["alignment"]["refined"]
    b2s = grid_map(al["beats"], al["times"])
    a = entry["annotations"]
    if len(a["meters"]) != 1 or len(a.get("keys") or []) > 1:
        raise ValueError("meter or key changes: not supported as a reference")
    m = a["meters"][0]
    bpb, unit = int(m["beats_per_bar"]), int(m["beat_unit"])
    n = int(a["num_beats"])
    per = 3 if unit == 8 and bpb % 3 == 0 and bpb > 3 else 1  # compound meter: count dotted quarters
    beats = [float(b2s(b)) for b in range(0, n + 1, per)]
    downs = [float(b2s(b)) for b in range(0, n + 1, bpb)]
    k = (a.get("keys") or [None])[0]  # no key annotation: the key is not scored
    melody = [[float(b2s(x["onset"])), float(b2s(x["offset"])), 60 + 12 * int(x["octave"]) + int(x["pitch_class"])]
              for x in a.get("melody") or []]
    chords = [[float(b2s(h["onset"])), float(b2s(h["offset"])), harte_from_intervals(h["root_pitch_class"],
                                                                                   h["root_position_intervals"])]
              for h in a.get("harmony") or []]
    return {"meter": f"{bpb}/{unit}", "beats": beats, "downbeats": downs,
            "sharps": mode_sharps(int(k["tonic_pitch_class"]), tuple(k["scale_degree_intervals"])) if k else None,
            "melody": melody, "chords": chords, "span": [float(b2s(0)), float(b2s(n))],
            "source": f"hooktheory {entry['hooktheory']['id']} ({entry['split']}): "
                      f"{entry['hooktheory']['artist']} / {entry['hooktheory']['song']}"}


def add_hooktheory(key: str, song_id: str, song_type: str, half: str, context: float = 20.0) -> Song:
    """Add one HookTheory entry to songs.json: its reference JSON in refs/, the YouTube recording
    trimmed to the annotated section +- `context` seconds (the grid needs some music around it). Adding a
    song again keeps the faults found by hand in its old entry (`ref` skip/why, shift/shift_why: §41)."""
    import gzip
    entry = json.load(gzip.open(HT_FILE))[key]
    ref = hooktheory_timed(entry)
    start = max(0.0, ref["span"][0] - context)
    end = min(float(entry["youtube"]["duration"]), ref["span"][1] + context)
    path = ROOT / "refs" / "hooktheory" / f"{song_id}.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(ref))
    songs_file = ROOT / "songs.json"
    old = json.loads(songs_file.read_text()) if songs_file.exists() else []
    kept = next(({k: v for k, v in d["ref"].items() if k not in ("kind", "path")} for d in old if d["id"] == song_id), {})
    song = Song(song_id, song_type, half, entry["youtube"]["url"], round(start, 2), round(end - start, 2),
                {"kind": "timed", "path": str(path), **kept}, ref["source"])
    songs = [d for d in old if d["id"] != song_id]
    songs_file.write_text(json.dumps(songs + [song.__dict__], indent=1))
    return song


def asap_reference(folder: str) -> Ref:
    from . import corpus
    ref, q2s, span, ann = corpus.reference(folder)
    return Ref(_top_line_ref(ref), ref, q2s, span, ann["meter"], ann["beats"], ann["downbeats"], ann["sharps"], None)


def load_ref(song: Song, wav: Path) -> Ref | None:
    """The song's reference. `ref["skip"]` names parts found faulty (the reason in `ref["why"]`): a
    skipped melody is left out of the melody measures, skipped chords out of the chord measures; the
    rest of the reference still counts. `ref["shift"]` (seconds, timed references): added to every time
    of an annotation found offset from the recording (its beats and its melody both agree on the lag, §41)."""
    kind = song.ref.get("kind")
    if "shift" in song.ref and kind != "timed":
        raise ValueError(f"{song.id}: ref.shift moves timed references only, not a {kind!r} reference")
    if kind == "score":
        ref = score_reference(song.ref, wav)
    elif kind == "asap":
        ref = asap_reference(song.ref["folder"])
    elif kind == "timed":
        ref = timed_reference(json.loads(Path(song.ref["path"]).expanduser().read_text()),
                              (song.start or 0.0) - float(song.ref.get("shift", 0.0)))
    else:
        return None
    skip = song.ref.get("skip", ())
    if "melody" in skip:
        ref = replace(ref, melody=replace(ref.melody, notes=[]))
    if "chords" in skip:
        ref = replace(ref, chords=None)
    return ref


# -------------------------------------------------------------- measures -- #

def melody_line(notes: list[Note]) -> list[Note]:
    """Our melody: the right hand's skyline (`arrange.skyline`: a chord struck under a held melody
    note is not part of the tune; the onset top line counted it as a melody note)."""
    from .arrange import skyline
    return skyline([n for n in notes if (n.hand or "R") == "R"], top=True)


def melody_scores(ref: Ref, est: list[Note]) -> dict:
    """The reference melody against our melody line: note F1 with exact pitch and with pitch class
    (an arrangement may move the tune by octaves: `fit_register`), onset within ONSET_TOL; and the
    share of pitch-class matches that also match in octave after our one most common shift."""
    lo, hi = ref.span
    rm = [n for n in ref.melody.notes if lo - 1e-6 <= float(ref.q2s(n.q_on)) <= hi + 1e-6]
    em = [n for n in melody_line(est) if lo - ONSET_TOL <= n.start <= hi + ONSET_TOL]
    if not rm:
        return {}
    ri = np.array([[ref.q2s(n.q_on), ref.q2s(n.q_off)] for n in rm], dtype=float)
    rp = np.array([n.pitch for n in rm])
    ei = np.array([[n.start, n.end] for n in em], dtype=float).reshape(-1, 2)
    ep = np.array([n.pitch for n in em])
    s = note_scores(ri, rp, ei, ep)
    out = {"n_ref": len(rm), "n_est": len(em), "f1": s["exact"]["f1"], "f1_pc": s["pitch_class"]["f1"],
           "precision_pc": s["pitch_class"]["precision"], "recall_pc": s["pitch_class"]["recall"],
           "overlap_pc": pc_overlap(ri, rp, ei, ep)}
    pairs = match(ri, 60 + rp % 12, ei, 60 + ep % 12) if len(em) else []
    if pairs:
        shift = [int(round((ep[j] - rp[i]) / 12)) for i, j in pairs]
        common = max(set(shift), key=shift.count)
        out["octave_consistent"] = round(float(np.mean([x == common for x in shift])), 3)
        out["octave_shift"] = common
    return out


def pc_overlap(ri: np.ndarray, rp: np.ndarray, ei: np.ndarray, ep: np.ndarray) -> float:
    """Share of the reference melody's time during which our melody sounds the same pitch class: a
    time-based melody accuracy that a split or merged note does not punish (a sung tune against a
    lead sheet's simplified rhythm: Someone Like You's notes match at F1 0.24 but overlap 70%)."""
    tot = float(np.sum(ri[:, 1] - ri[:, 0]))
    if tot <= 0 or not len(ei):
        return 0.0
    o = np.argsort(ei[:, 0])
    ei, ep = ei[o], ep[o]
    hit = 0.0
    for (a, b), p in zip(ri, rp):
        k = slice(max(0, int(np.searchsorted(ei[:, 0], a)) - 64), int(np.searchsorted(ei[:, 0], b)))
        cover = sorted((max(a, x), min(b, y)) for (x, y), q in zip(ei[k], ep[k]) if (q - p) % 12 == 0 and y > a and x < b)
        end = a  # the union of the covering notes: two of the same pitch class (octaves) count once
        for x, y in cover:
            hit += max(0.0, y - max(x, end))
            end = max(end, y)
    return round(hit / tot, 3)


def melody_notation(ref: Ref, xml: Path, est_q2s) -> dict:
    """Where our written melody notes sit in the bar and how long they are written, against the
    reference melody (pitch class, so an octave shift is not a miss). Needs the reference's meter."""
    if not ref.meter or not ref.melody.notes:
        return {}
    est = load_reference(xml)
    mel = written_melody(est.notes)
    if not mel:
        return {}
    pc = lambda ns: [RefNote(n.q_on, n.q_off, 60 + n.pitch % 12, n.hand, n.staff) for n in ns]  # noqa: E731
    r = Reference(pc(ref.melody.notes), None, ref.meter, None)
    e = Reference(pc(mel), None, est.meter, None)
    return score_notation(r, ref.q2s, e, est_q2s, ref.span)


def written_melody(notes: list[RefNote]) -> list[RefNote]:
    """The written right hand's skyline (quarters), as `melody_line` takes it from the sounding notes:
    a note struck under a held melody note (a lower voice) is not part of the tune. In a one-voice
    staff nothing is held over a later onset, so this is the onset top line."""
    from .arrange import Note, skyline
    rh = [Note(n.q_on, n.q_off, n.pitch, hand="R") for n in notes if n.hand == "R"]
    return [RefNote(n.start, n.end, n.pitch, "R", 0) for n in skyline(rh, top=True, tol=1e-6)]  # quarters: exact


def chord_scores(ref: list[tuple[float, float, str]], est: list[tuple[float, float, str]],
                 span: tuple[float, float]) -> dict:
    """mir_eval chord overlap over the reference span: root and major/minor (majmin), weighted by time."""
    import mir_eval
    ref = [(max(a, span[0]), min(b, span[1]), c) for a, b, c in ref if b > span[0] and a < span[1] and b > a]
    if not ref or not est:
        return {}
    ri = np.array([[a, b] for a, b, _ in ref])
    ei = np.array([[a, b] for a, b, _ in est])
    ei, el = mir_eval.util.adjust_intervals(ei, [c for _, _, c in est], ri.min(), ri.max(), "N", "N")
    ii, rl, el = mir_eval.util.merge_labeled_intervals(ri, [c for _, _, c in ref], ei, el)
    dur = mir_eval.util.intervals_to_durations(ii)
    out = {}
    for name, f in (("root", mir_eval.chord.root), ("majmin", mir_eval.chord.majmin)):
        out[name] = round(float(mir_eval.chord.weighted_accuracy(f(rl, el), dur)), 3)
    return out


def chord_tones(harte: str) -> set[int] | None:
    import mir_eval
    root, bitmap, bass = mir_eval.chord.encode(harte)
    if root < 0:
        return None
    return {(root + i) % 12 for i in range(12) if bitmap[i]} | {(root + bass) % 12}


def chord_fit(ref_chords: list[tuple[float, float, str]], span: tuple[float, float], notes: list[Note]) -> float | None:
    """The share of the accompaniment's sounding time (every note but the melody line) inside the
    reference span that is a tone of the reference chord (DESIGN.md §20)."""
    segs = [(max(a, span[0]), min(b, span[1]), chord_tones(c)) for a, b, c in ref_chords]
    segs = [(a, b, t) for a, b, t in segs if b > a and t]
    mel = {(round(m.start, 4), m.pitch) for m in melody_line(notes)}
    total = on = 0.0
    for n in notes:
        if (round(n.start, 4), n.pitch) in mel:
            continue
        for a, b, t in segs:
            d = min(b, n.end) - max(a, n.start)
            if d > 0:
                total += d
                on += d * (n.pitch % 12 in t)
    return round(on / total, 4) if total else None


CHROMA_SR, CHROMA_HOP = 22050, 512


def recording_chroma(work: Path) -> tuple[np.ndarray, np.ndarray] | None:
    """Frame times and the 12 x frames chroma (CQT, not normalised) of every stem but the drums,
    cached in <work>/chroma-nodrums.npz under a key of the settings and the stems' sizes and times;
    None without stems."""
    cache = work / "chroma-nodrums.npz"
    stems = [work / "stems" / f"{s}.wav" for s in ("vocals", "bass", "guitar", "other", "piano")]
    stems = [p for p in stems if p.exists()]
    if not stems:
        return None
    key = json.dumps([CHROMA_SR, CHROMA_HOP] + [[p.name, p.stat().st_size, p.stat().st_mtime_ns] for p in stems])
    if cache.exists():
        with np.load(cache) as z:
            if "key" in z and str(z["key"]) == key:
                return z["t"], z["c"]
    import librosa
    y = None
    for p in stems:
        x, _ = librosa.load(str(p), sr=CHROMA_SR, mono=True)
        y = x if y is None else y[: len(x)] + x[: len(y)]
    c = librosa.feature.chroma_cqt(y=y, sr=CHROMA_SR, hop_length=CHROMA_HOP, norm=None)
    t = librosa.frames_to_time(np.arange(c.shape[1]), sr=CHROMA_SR, hop_length=CHROMA_HOP)
    with open(cache.with_suffix(f".{os.getpid()}.part"), "wb") as f:
        np.savez(f, t=t, c=c, key=key)
    cache.with_suffix(f".{os.getpid()}.part").replace(cache)
    return t, c


def chroma_sim(notes: list[Note], grid, t: np.ndarray, rc: np.ndarray) -> float | None:
    """Reference-free (DESIGN.md §20): the mean over counted beats of the cosine between the pitch
    classes our notes sound (velocity x time) and the recording's chroma without drums, over the
    beats where the recording is not silent (a tenth of its median level)."""
    if not notes or len(t) < 2:
        return None
    dt = float(t[1] - t[0])
    nc = np.zeros((12, len(t)))
    for n in notes:
        i0 = max(0, int(n.start / dt))
        nc[n.pitch % 12, i0:max(i0 + 1, int(n.end / dt))] += n.velocity / 127
    q0, q1 = grid.sec_to_q([min(n.start for n in notes), max(n.end for n in notes)])
    beats = np.arange(np.ceil(q0 / grid.beat_q), np.floor(q1 / grid.beat_q) + 1) * grid.beat_q
    idx = np.searchsorted(t, grid.q_to_sec(beats))
    level = rc.sum(axis=0)
    floor = 0.1 * np.median(level[level > 0]) if np.any(level > 0) else 0.0
    sims = []
    for a, b in zip(idx[:-1], idx[1:]):
        if b <= a or level[a:b].mean() < floor:
            continue
        r, e = rc[:, a:b].sum(axis=1), nc[:, a:b].sum(axis=1)
        nr, ne = np.linalg.norm(r), np.linalg.norm(e)
        sims.append(float(r @ e / (nr * ne)) if nr > 0 and ne > 0 else 0.0)
    return round(float(np.mean(sims)), 4) if sims else None


def playability(notes: list[Note]) -> dict:
    """Reference-free: share of onset groups where a hand spans more than REACH semitones or plays
    more than MAX_NOTES notes; the 95th percentile of a hand's span; notes per second per hand
    (the 95th percentile over 2 s windows: the hardest passages)."""
    ns = sorted(notes, key=lambda n: n.start)
    if not ns:
        return {"notes": 0}
    groups, cur = [], [ns[0]]
    for n in ns[1:]:
        if n.start - cur[0].start > CHORD_TOL:
            groups.append(cur)
            cur = []
        cur.append(n)
    groups.append(cur)
    bad, spans = 0, []
    for g in groups:
        worst = False
        for h in "LR":
            ps = sorted({n.pitch for n in g if n.hand == h})
            if ps:
                spans.append(ps[-1] - ps[0])
                worst |= ps[-1] - ps[0] > REACH or len(ps) > MAX_NOTES
        bad += worst
    t0, t1 = ns[0].start, max(n.end for n in ns)
    rate = {}
    for h in "LR":
        on = np.array([n.start for n in ns if n.hand == h])
        if len(on):
            edges = np.arange(t0, t1 + 2.0, 2.0)
            rate[h] = round(float(np.percentile(np.histogram(on, edges)[0] / 2.0, 95)), 2)
    return {"notes": len(ns), "unplayable": round(bad / len(groups), 4),
            "span_p95": float(np.percentile(spans, 95)) if spans else 0.0,
            "notes_per_s_p95": rate}


def grid_of(g: dict):
    from .meter import Grid
    return Grid(np.asarray(g["t"], dtype=float), np.asarray(g["q"], dtype=float), g["meter"], g["bar_q"],
                g["tatum_q"], g["beat_q"], g["bpm"])


def grid_scores(ref: Ref, grid) -> dict:
    """Meter, tempo level, beats and bar lines of our grid against the reference's."""
    out = {"meter": grid.meter, "ref_meter": ref.meter,
           "meter_match": same_bars(grid.meter, ref.meter) if ref.meter else None}
    if ref.beats is None or len(ref.beats) <= 2:
        return out
    import mir_eval
    from .meter import _extrap
    lo, hi = float(_extrap(ref.span[0], grid.t, grid.q)), float(_extrap(ref.span[1], grid.t, grid.q))
    at = lambda step: np.asarray(_extrap(np.arange(np.ceil(lo / step) * step, hi + 1e-6, step), grid.q, grid.t))  # noqa: E731
    f = lambda r, e: round(float(mir_eval.beat.f_measure(r, e)), 3) if len(r) > 1 and len(e) > 1 else None  # noqa: E731
    rb = np.asarray(ref.beats, dtype=float)
    first = int(np.argmin(np.abs(rb - ref.downbeats[0]))) if ref.downbeats is not None and len(ref.downbeats) else 0
    levels = beat_levels(rb, first)
    est = at(grid.beat_q)
    fs = {k: f(v, est) for k, v in levels.items()}
    best = max(fs, key=lambda k: fs[k] or 0.0)
    ref_qpm = 60.0 / float(np.median(np.diff(rb))) * beat_quarters(ref.meter)
    qpm = grid.bpm * grid.beat_q  # quarters a minute: the same for 6/4 and 12/8 spellings of one tempo
    out.update(beat_f=fs["x1"], beat_f_best=fs[best], beat_level=best, ref_qpm=round(ref_qpm, 1), qpm=round(qpm, 1),
               tempo_ratio=round(qpm / ref_qpm, 3), tempo_match=bool(abs(np.log(qpm / ref_qpm)) < np.log(1.04)))
    if ref.downbeats is not None and len(ref.downbeats) > 1:
        out["downbeat_f"] = f(np.asarray(ref.downbeats, dtype=float), at(grid.bar_q))
    return out


def beat_levels(rb: np.ndarray, first: int = 0) -> dict[str, np.ndarray]:
    """The reference beats at the metrical levels a tracker may lock to: as annotated, twice as
    fast, half, a third, and x1.5 / x2/3 (a dotted-quarter pulse against quarters, or the reverse),
    the slower ones phased from the first downbeat."""
    idx = np.arange(len(rb), dtype=float)
    pick = lambda step: np.interp(np.arange(first % step, len(rb) - 1 + 1e-9, step), idx, rb)  # noqa: E731
    return {"x1": rb, "half": np.sort(np.r_[rb, (rb[:-1] + rb[1:]) / 2]), "double": pick(2.0), "triple": pick(3.0),
            "dotted": pick(1.5), "two_thirds": pick(2.0 / 3.0)}


def score_variant(ref: Ref | None, run_dir: Path, tag: str, report: dict) -> dict:
    """Every measure of one variant (a source x parts output) of one song."""
    from .evaluate import _notes_from_midi
    v = report["variants"][tag]
    source = tag.split("_")[0]
    mid, xml = run_dir / f"{tag}.mid", run_dir / f"{tag}.musicxml"
    notes = _notes_from_midi(mid)
    grid = grid_of(report["grids"][source])
    out = {"free": {**playability(notes), "load": notation_load(xml, 0.0, 1e9, REACH, MAX_NOTES),
                    "meter": v["meter"], "bpm": report["grids"][source]["bpm"]}}
    rc = recording_chroma(Path(report["work_dir"])) if report.get("work_dir") else None
    out["free"]["chroma_sim"] = chroma_sim(notes, grid, *rc) if rc else None
    if ref is None:
        return out
    shift = float(v.get("score_offset_q", 0.0))
    gq2s = grid_map(grid.q, grid.t)
    est_q2s = lambda qq: gq2s(np.asarray(qq, dtype=float) + shift)  # noqa: E731
    inv = {**grid_scores(ref, grid)}
    if ref.sharps is not None and v.get("key_signatures"):
        inv["key_match"] = (int(v["key_signatures"][0]) - int(ref.sharps)) % 12 == 0  # 6 sharps = 6 flats
    inv["melody"] = melody_scores(ref, notes)
    inv["melody_notation"] = melody_notation(ref, xml, est_q2s)
    if ref.chords and v.get("chords"):
        cq = [(float(q), c) for q, c in v["chords"]]
        ends = [q for q, _ in cq[1:]] + [float(grid.sec_to_q(max(n.end for n in notes)))]
        est = [(float(gq2s(q)), float(gq2s(e)), c) for (q, c), e in zip(cq, ends)]
        inv["chords"] = chord_scores(ref.chords, est, ref.span)
    if ref.chords:
        inv["chord_fit"] = chord_fit(ref.chords, ref.span, notes)
    out["invariant"] = inv
    if ref.texture is not None:
        fid = score_notes(ref.texture, ref.q2s, notes, ref.span)
        fid["notation"] = score_notation(ref.texture, ref.q2s, load_reference(xml), est_q2s, ref.span)
        q_lo, q_hi = np.interp(ref.span, grid.t, grid.q) - shift
        fid["notation"]["load"] = notation_load(xml, float(q_lo), float(q_hi), REACH, MAX_NOTES)
        out["fidelity"] = fid
    return out


# -------------------------------------------------------------------- run -- #

def apply_settings(settings: list[str]) -> dict:
    """--set module.NAME=value: change a p2v module constant for this run (a settings sweep without
    editing code). Only module-level names read at call time change behaviour."""
    done = {}
    for kv in settings:
        name, value = kv.split("=", 1)
        mod, attr = name.rsplit(".", 1)
        m = importlib.import_module(f"p2v.{mod}")
        if not hasattr(m, attr):
            raise SystemExit(f"--set: p2v.{mod} has no {attr}")
        old = getattr(m, attr)
        new = ast.literal_eval(value)
        if isinstance(old, (int, float)) and not isinstance(old, bool) and isinstance(new, (int, float)):
            if type(old)(new) != new:  # int(0.5) would run the sweep at 0
                raise SystemExit(f"--set {kv}: p2v.{mod}.{attr} is {type(old).__name__}; {value} would change")
            new = type(old)(new)
        setattr(m, attr, new)
        done[name] = getattr(m, attr)
    return done


def work_dir(song: Song) -> Path:
    """Cached stages per song; the key changes when the audio or the trim does."""
    key = hashlib.sha1(json.dumps([song.audio, song.start, song.duration]).encode()).hexdigest()[:8]
    return ROOT / "work" / f"{song.id}-{key}"


def audio_input(song: Song) -> str:
    if song.audio.startswith("asap:"):
        from . import corpus
        return str(corpus.ROOT / "audio" / f"{corpus.slug(song.audio[5:])}.wav")
    return song.audio


COMPOUND = ("6/8", "9/8", "12/8")


def ref_hint(ref: Ref | None, downbeat: bool = False) -> list[str]:
    """`--meter` / `--bpm` from the song's reference, as a user with its score would give them (`run --hints ref`,
    DESIGN.md §48). 2/2 is written 4/4 and 6/4 12/8 (the same bars, as `same_bars` counts them); a meter the grid
    cannot write (3/8, 3/2, 5/4 ...) or a reference without beats gives no hint. `downbeat` (`--hints ref-downbeat`,
    §49) adds `--downbeat` at the reference's first bar line at or after 0 s (a trimmed song's reference may start
    before its input)."""
    out = _ref_meter_bpm(ref)
    if downbeat and ref is not None and ref.downbeats is not None:
        ok = np.asarray(ref.downbeats, dtype=float)
        ok = ok[ok >= 0.0]
        if len(ok):
            out += ["--downbeat", f"{float(ok[0]):.3f}"]
    return out


def _ref_meter_bpm(ref: Ref | None) -> list[str]:
    from .meter import METERS
    if ref is None or not ref.meter or ref.beats is None or len(ref.beats) <= 2:
        return []
    m = {"2/2": "4/4", "6/4": "12/8"}.get(ref.meter, ref.meter)
    step = float(np.median(np.diff(np.asarray(ref.beats, dtype=float))))
    if m not in METERS.values() or step <= 0:
        return []
    bpm = 60.0 / step * beat_quarters(ref.meter) / (1.5 if m in COMPOUND else 1.0)
    return ["--meter", m, "--bpm", f"{bpm:.1f}"] if 10.0 <= bpm <= 400.0 else []


def run_song(song: Song, label: str, extra: list[str], redo: set[str], hints: str | None = None) -> dict:
    from . import corpus, pipeline
    wd = work_dir(song)
    for stage in redo:  # a change to separation or transcription must not read old caches
        for p in {"stems": [wd / "stems", wd / "tx"], "tx": [wd / "tx"]}[stage]:  # new stems: new notes too
            shutil.rmtree(p, ignore_errors=True)
    argv = [audio_input(song), "--out", str(wd.parent), "--name", wd.name, "--all-variants", "--no-video",
            "--no-pdf", "--audio-track", "none", *extra]
    if hints in ("ref", "ref-downbeat"):
        if not (wd / "input.wav").exists():
            raise RuntimeError(f"--hints {hints} needs the song's input.wav: run it once without hints first")
        argv += ref_hint(load_ref(song, wd / "input.wav"), downbeat=hints == "ref-downbeat")
    if song.start is not None:
        argv += ["--start", str(song.start)]
    if song.duration is not None:
        argv += ["--duration", str(song.duration)]
    if song.audio.startswith("asap:") and song.audio[5:] in corpus.BT_HELDOUT:
        argv += ["--beat-weights", corpus.BT_HELDOUT[song.audio[5:]]]  # the one model that never heard it (§12)
    # every other song (the three ASAP pieces outside the folds too: no model heard them) gets the default (§43)
    t0 = time.time()
    report = pipeline.run(pipeline.build_parser().parse_args(argv))
    runtime = round(time.time() - t0, 1)
    out = ROOT / "runs" / label / song.id
    shutil.rmtree(out, ignore_errors=True)
    out.mkdir(parents=True)
    for tag in report["variants"]:
        for ext in (".mid", ".musicxml"):
            shutil.copy2(wd / f"{tag}{ext}", out / f"{tag}{ext}")
    report["runtime_s"] = runtime
    (out / "report.json").write_text(json.dumps(report, indent=2))
    return score_song(song, out)


def score_song(song: Song, out: Path) -> dict:
    """Every measure of one song's run (runs/<label>/<id>/), from its saved outputs. The route is
    recomputed from the stem levels with the current `pipeline.route`, so a router change needs no
    new run."""
    from .pipeline import route
    report = json.loads((out / "report.json").read_text())
    ref = load_ref(song, work_dir(song) / "input.wav")
    r = route(report["stem_db"], report.get("lead_stem", "vocals"))  # levels rounded to 0.1 dB in the report
    res = {"id": song.id, "type": song.type, "half": song.half, "runtime_s": report.get("runtime_s"),
           "stem_db": report["stem_db"], "piano_input": report.get("piano_input"),
           "route": r, "route_ok": r == EXPECTED_SOURCE[song.type], "ref": song.ref.get("kind"),
           "hint": report.get("hint"), "variants": {}}  # the --meter / --bpm this song ran with (§48), or None
    if ref is not None:
        res["ref_span_s"] = [round(x, 2) for x in ref.span]
    for tag in report["variants"]:
        res["variants"][tag] = score_variant(ref, out, tag, report)
    (out / "result.json").write_text(json.dumps(res, indent=2, default=_json))
    return res


def _json(x):
    if isinstance(x, (np.integer, np.floating)):
        return x.item()
    if isinstance(x, np.bool_):
        return bool(x)
    raise TypeError(type(x))


# ---------------------------------------------------------------- summary -- #

# headline numbers: (name, section, path); a missing number is skipped in the means, never zero
HEADLINE = (
    ("meter", "invariant", ("meter_match",)), ("tempo", "invariant", ("tempo_match",)),
    ("beat_f", "invariant", ("beat_f_best",)), ("downbeat_f", "invariant", ("downbeat_f",)),
    ("key", "invariant", ("key_match",)), ("mel_f1_pc", "invariant", ("melody", "f1_pc")), ("mel_ovl", "invariant", ("melody", "overlap_pc")),
    ("mel_pos", "invariant", ("melody_notation", "onset_in_bar_exact")),
    ("mel_len", "invariant", ("melody_notation", "written_length_exact")),
    ("mel_qpos", "invariant", ("melody_notation", "onset_in_quarter_exact")),  # without the bar (§47)
    ("mel_qlen", "invariant", ("melody_notation", "written_quarters_exact")),
    ("chord_mm", "invariant", ("chords", "majmin")), ("chord_fit", "invariant", ("chord_fit",)),
    ("note_f1", "fidelity", ("notes", "exact", "f1")), ("hands", "fidelity", ("hand_agreement",)),
    ("pos", "fidelity", ("notation", "onset_in_bar_exact")), ("len", "fidelity", ("notation", "written_length_exact")),
    ("qpos", "fidelity", ("notation", "onset_in_quarter_exact")), ("qlen", "fidelity", ("notation", "written_quarters_exact")),
    ("unplay", "free", ("unplayable",)), ("w_unplay", "free", ("load", "unplayable_written")),
    ("short", "free", ("load", "shorter_than_eighth")),
    ("ties", "free", ("load", "tied_on")), ("sym_bar", "free", ("load", "symbols_per_bar")),
    ("ledger3", "free", ("load", "ledger3")),
    ("rests", "free", ("load", "rests_per_bar")), ("two_v", "free", ("load", "two_voice_bars")),
    ("chroma", "free", ("chroma_sim",)),
)


def flat(v: dict) -> dict[str, float | None]:
    out = {}
    for name, sec, path in HEADLINE:
        x = v.get(sec, {})
        for k in path:
            x = x.get(k) if isinstance(x, dict) else None
        out[name] = None if x is None else float(x)
    return out


def summarize(results: list[dict], variant: str | None = None) -> dict:
    """Means per type x half x variant (`variant`: only that one). A song where a variant could not
    run (e.g. `arrange` on solo piano: no vocals) counts in `ran` but in no mean."""
    table: dict = {}
    for r in results:
        variants = dict(r["variants"])
        for tag, v in r["variants"].items():  # auto_<parts>: the variant of the path the router chose
            if r.get("route") and tag.startswith(r["route"] + "_"):
                variants["auto_" + tag.split("_", 1)[1]] = v
        for tag, v in variants.items():
            if variant and tag != variant:
                continue
            for half in (r["half"], "all"):
                table.setdefault(r["type"], {}).setdefault(tag, {}).setdefault(half, []).append(flat(v))
    out: dict = {}
    for t, tags in table.items():
        for tag, halves in tags.items():
            for half, rows in halves.items():
                means = {k: round(float(np.mean([x[k] for x in rows if x[k] is not None])), 3)
                         for k in rows[0] if any(x[k] is not None for x in rows)}
                out.setdefault(t, {}).setdefault(tag, {})[half] = {"n": len(rows), **means}
    return out


def router_accuracy(results: list[dict]) -> dict[str, float]:
    """Per type: the share of songs where --source auto picks the path the type should take."""
    out = {}
    for t in TYPES:
        rs = [r for r in results if r["type"] == t and r.get("route")]
        if rs:
            out[t] = round(float(np.mean([r["route_ok"] for r in rs])), 3)
    return out


def print_summary(summary: dict, songs_per_type: dict[str, int], router: dict[str, float] | None = None):
    keys = [h[0] for h in HEADLINE]
    for t in sorted(summary):
        print(f"\n{t} — {TYPES[t]} ({songs_per_type.get(t, 0)} songs; router right: "
              f"{(router or {}).get(t, '-')}, target path: {EXPECTED_SOURCE[t]})")
        print(f"  {'variant':22s} {'half':5s} {'n':>3s} " + " ".join(f"{k[:9]:>9s}" for k in keys))
        for tag in sorted(summary[t]):
            for half in ("tune", "check", "all"):
                m = summary[t][tag].get(half)
                if m:
                    print(f"  {tag:22s} {half:5s} {m['n']:3d} " + " ".join(
                        f"{m[k]:9.3f}" if k in m else f"{'-':>9s}" for k in keys))


def compare(a: str, b: str, variant: str | None):
    load = lambda lab: json.loads((ROOT / "results" / f"{lab}.json").read_text())  # noqa: E731
    ra, rb = load(a), load(b)
    common = {r["id"] for r in ra["songs"]} & {r["id"] for r in rb["songs"]}
    sa = summarize([r for r in ra["songs"] if r["id"] in common], variant)
    sb = summarize([r for r in rb["songs"] if r["id"] in common], variant)
    keys = [h[0] for h in HEADLINE]
    for t in sorted(set(sa) | set(sb)):
        print(f"\n{t} — {TYPES[t]}: {a} > {b}")
        for tag in sorted(set(sa.get(t, {})) | set(sb.get(t, {}))):
            for half in ("tune", "check", "all"):
                ma, mb = sa.get(t, {}).get(tag, {}).get(half, {}), sb.get(t, {}).get(tag, {}).get(half, {})
                diff = [k for k in keys if k in ma and k in mb and abs(ma[k] - mb[k]) >= 0.0005]
                if ma or mb:
                    cells = " ".join(f"{k}={ma.get(k, '-')}>{mb.get(k, '-')}" for k in diff) or "no change"
                    print(f"  {tag:22s} {half:5s} n={ma.get('n', 0)}/{mb.get('n', 0)} {cells}")


# ------------------------------------------------------------------- gate -- #
# Kaya's adoption rule (DESIGN.md §45; Kaya's method, not Jm's rule: change it when it stops serving the goal):
# a change is adopted when, on the tune half, the 95% CI of the mean per-song change of its target measure lies
# above 0 over all songs, and no CI of any measure (over all songs at 95%, per group Bonferroni-wide, `gate`)
# lies below 0; the check half then confirms it once
# by the same rule. Paired changes, because the songs differ far more than one change moves them (§44).

GATE_MEASURES = ("beat_f_best", "downbeat_f", "meter_match", "tempo_match")


def hash_half(key: str) -> str:
    """'tune' or 'check' from a fixed hash of the id: a set's split that no one chose and that stays as it grows."""
    return "tune" if hashlib.sha1(key.encode()).digest()[0] % 2 == 0 else "check"


def paired_deltas(a: dict[str, float | bool | None], b: dict[str, float | bool | None]) -> dict[str, float]:
    """b − a for every id measured in both (True / False count as 1 / 0)."""
    return {k: float(b[k]) - float(a[k]) for k in a if k in b and a[k] is not None and b[k] is not None}


def delta_stats(deltas, n_boot: int = 10000, seed: int = 0, alpha: float = 0.05) -> dict:
    """n, the mean change, its 1 − alpha bootstrap CI (percentile, seeded: the same numbers every run; None under 2
    songs), and the songs that got better and worse."""
    x = np.asarray(list(deltas), dtype=float)
    out = {"n": len(x), "mean": round(float(x.mean()), 4) if len(x) else None, "lo": None, "hi": None,
           "better": int((x > 1e-9).sum()), "worse": int((x < -1e-9).sum())}
    if len(x) >= 2:
        means = x[np.random.default_rng(seed).integers(0, len(x), (n_boot, len(x)))].mean(axis=1)
        out["lo"], out["hi"] = (round(float(v), 4) for v in np.percentile(means, [50 * alpha, 100 - 50 * alpha]))
    return out


def gate(rows_a: list[dict], rows_b: list[dict], measures=GATE_MEASURES) -> dict[str, dict[str, dict]]:
    """Per measure, over 'all' songs and per group (`row["group"]`): `delta_stats` of the paired change from
    rows_a to rows_b (rows: dicts with "id", "group" and the measures). 'all' has a 95% CI; the groups' CIs are
    Bonferroni-wide (alpha 0.05 / (measures x groups)), so that among some 44 group CIs one does not fall
    below 0 by chance and veto a change (code review of §45)."""
    a, b = {r["id"]: r for r in rows_a}, {r["id"]: r for r in rows_b}
    ids = [i for i in a if i in b]
    groups = sorted({a[i]["group"] for i in ids})
    alpha_g = 0.05 / (len(measures) * max(1, len(groups)))
    out = {}
    for m in measures:
        d = paired_deltas({i: a[i].get(m) for i in ids}, {i: b[i].get(m) for i in ids})
        out[m] = {"all": delta_stats(d.values())}
        out[m].update({g: delta_stats((v for i, v in d.items() if a[i]["group"] == g), alpha=alpha_g) for g in groups})
    return out


def adopt(g: dict[str, dict[str, dict]], target: str) -> tuple[bool, list[str]]:
    """Kaya's rule on one half's `gate`: the target measure's CI over all songs above 0, and no group's CI of
    any measure below 0. The verdict and its reasons."""
    t = g[target]["all"]
    ok = t["lo"] is not None and t["lo"] > 0
    why = [f"{target} all: n {t['n']}, mean {t['mean']}, CI [{t['lo']}, {t['hi']}] "
           f"{'above 0' if ok else 'not above 0'}"]
    for m, per in g.items():
        for grp, s in per.items():
            if s["hi"] is not None and s["hi"] < 0:
                ok = False
                why.append(f"{m} {grp}: n {s['n']}, mean {s['mean']}, CI [{s['lo']}, {s['hi']}] below 0")
    return ok, why


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("list")
    h = sub.add_parser("add-hooktheory", help="add a HookTheory entry (its key in Hooktheory.json.gz) as a song")
    h.add_argument("key")
    h.add_argument("--id", required=True)
    h.add_argument("--type", required=True, choices=sorted(TYPES))
    h.add_argument("--half", required=True, choices=("tune", "check"))
    r = sub.add_parser("run")
    r.add_argument("--label", required=True)
    r.add_argument("--types", help="comma list of T1..T5 (default: all)")
    r.add_argument("--half", choices=("tune", "check"))
    r.add_argument("--songs", help="comma list of song ids")
    r.add_argument("--set", action="append", default=[], metavar="MODULE.NAME=VALUE",
                   help="change a p2v module constant for this run (e.g. meter.DBN_RANGE=1.3)")
    r.add_argument("--redo", action="append", default=[], choices=("stems", "tx"),
                   help="discard cached stems or transcriptions first (when the change is in those stages)")
    r.add_argument("--hints", choices=("ref", "ref-downbeat"),
                   help="ref: give each song its reference's meter and tempo as `--meter` / `--bpm` (§48); "
                        "ref-downbeat: and its first bar line as `--downbeat` (§49)")
    r.add_argument("pipeline_args", nargs="*", help="extra pipeline flags after --, e.g. -- --beats notes")
    sc = sub.add_parser("score", help="score a run's saved outputs again (after a change to a measure or the router)")
    sc.add_argument("--label", required=True, help="the run to score (runs/<label>/)")
    sc.add_argument("--as", dest="as_label", required=True, help="the result label to write")
    c = sub.add_parser("compare")
    c.add_argument("a")
    c.add_argument("b")
    c.add_argument("--variant", help="only this variant, e.g. piano_lead-accomp")
    args = ap.parse_args(argv)
    if args.cmd == "add-hooktheory":
        print(json.dumps(add_hooktheory(args.key, args.id, args.type, args.half).__dict__))
        return
    songs = all_songs()
    if args.cmd == "list":
        for s in songs:
            print(f"{s.type} {s.half:5s} {s.id:44s} ref={s.ref.get('kind', '-'):6s} {s.note}")
        return
    if args.cmd == "compare":
        compare(args.a, args.b, args.variant)
        return
    if args.cmd == "score":
        args.label, src = args.as_label, args.label
        prev = ROOT / "results" / f"{src}.json"  # keep the source run's settings with its scores
        old = json.loads(prev.read_text()) if prev.exists() else {}
        args.set, args.pipeline_args, args.hints = [], old.get("pipeline_args", []), old.get("hints")
        todo = [s for s in songs if (ROOT / "runs" / src / s.id / "report.json").exists()]
        work = lambda s: score_song(s, ROOT / "runs" / src / s.id)  # noqa: E731
    else:
        old = {}
        todo = select(songs, args.types, args.half, args.songs)
        work = lambda s: run_song(s, args.label, args.pipeline_args, set(args.redo), args.hints)  # noqa: E731
    changed = apply_settings(args.set)
    results, failed = [], {}
    for s in todo:
        print(f"bank: {s.type} {s.id}", file=sys.stderr, flush=True)
        try:
            results.append(work(s))
        except (Exception, SystemExit) as e:  # noqa: BLE001 — one song's failure is a result, not a crash
            failed[s.id] = f"{type(e).__name__}: {e}"
            print(f"bank: {s.id} FAILED {failed[s.id]}", file=sys.stderr, flush=True)
    (ROOT / "results").mkdir(parents=True, exist_ok=True)
    summary = summarize(results)
    (ROOT / "results" / f"{args.label}.json").write_text(json.dumps(
        {"label": args.label, "settings": {k: repr(v) for k, v in changed.items()} or old.get("settings", {}),
         "pipeline_args": args.pipeline_args, "hints": args.hints,
         "failed": failed, "router": router_accuracy(results), "summary": summary, "songs": results},
        indent=2, default=_json))
    print_summary(summary, {t: sum(s.type == t for s in todo) for t in TYPES}, router_accuracy(results))
    if failed:
        print(f"\nFAILED ({len(failed)}): " + "; ".join(f"{k}: {v[:120]}" for k, v in failed.items()))


if __name__ == "__main__":
    main()
