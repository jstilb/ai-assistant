"""Corpus check: the stages after transcription, scored on many performed pieces instead of two.

ASAP (Foscarin et al. 2020, github.com/fosfrancesco/asap-dataset, CC BY-NC-SA 4.0) pairs piano
scores with MAESTRO performances (Hawthorne et al. 2019, CC BY-NC-SA 4.0) and annotates every beat
and downbeat in both. So no alignment is guessed: score quarters map to performance seconds through
the annotated beats, then each score onset snaps to the performance MIDI's own onsets. The scores'
staves stand in for the hands. The pieces are classical, not pop covers: a check that a setting
tuned on Connections and Starlight holds elsewhere, not a target in itself.

Each piece is the first EXCERPT seconds of one performance. `--input audio` transcribes the real
recording (ByteDance piano model, cached); `--input midi` feeds the performance MIDI (key-up ends
extended by the sustain pedal, like the model's) to isolate the later stages.

Usage (from Tools/):
  python -m p2v.corpus fetch                         # ASAP clone + MAESTRO audio excerpts
  python -m p2v.corpus run --label base [--input audio|midi] [--pieces 0,3,5] [--beats beat-this]
  python -m p2v.corpus compare base new
"""

from __future__ import annotations

import argparse
import csv
import io
import json
import os
import subprocess
import sys
import urllib.request
import zipfile
from pathlib import Path

import numpy as np

from .arrange import Note, arrange_piano_only
from .evaluate import (Reference, RefNote, bar_quarters, grid_map, load_reference, notation_load, score_notation,
                       score_notes)

ROOT = Path(os.environ.get("P2V_CORPUS", Path.home() / ".kaya/piano2video/corpus"))
ASAP_GIT = "https://github.com/fosfrancesco/asap-dataset.git"
MAESTRO_ZIP = "https://storage.googleapis.com/magentadata/datasets/maestro/v3.0.0/maestro-v3.0.0.zip"
EXCERPT = 90.0  # seconds of each performance
# one performance (the first with MAESTRO audio) per piece; one meter each, mostly melody over
# accompaniment. Even indices tune, odd ones check (`--pieces tune|check`).
PIECES = (
    "Bach/Prelude/bwv_846",                       # 4/4 broken chords
    "Chopin/Etudes_op_25/1",                      # 4/4 melody over arpeggios
    "Rachmaninoff/Preludes_op_23/6",              # 4/4
    "Schubert/Piano_Sonatas/664-1",               # 4/4
    "Glinka/The_Lark",                            # 4/4
    "Mozart/Piano_Sonatas/12-1",                  # 3/4
    "Rachmaninoff/Preludes_op_23/4",              # 3/4
    "Scriabin/Etudes_op_8/11",                    # 3/4
    "Beethoven/Piano_Sonatas/22-1",               # 3/4
    "Schubert/Moment_musical_no_3",               # 2/4
    "Haydn/Keyboard_Sonatas/48-2",                # 2/4
    "Chopin/Berceuse_op_57",                      # 6/8
    "Mozart/Piano_Sonatas/12-3",                  # 6/8
    "Beethoven/Piano_Sonatas/28-1",               # 6/8
    "Liszt/Annees_de_pelerinage_2/1_Gondoliera",  # 6/8
    "Chopin/Ballades/2",                          # 6/8
    "Chopin/Barcarolle",                          # 12/8
    "Bach/Prelude/bwv_854",                       # 12/8
    "Bach/Prelude/bwv_865",                       # 9/8
)
# Beat This!'s training data holds most of ASAP: its 8-fold cross-validation (CPJKU/beat_this_annotations,
# asap/8-folds.split, folds grouped by work) says which fold model never heard each piece. The three
# pieces missing here are in none of its training data, so final0 is fair on them (DESIGN.md §12).
BT_HELDOUT = {
    "Bach/Prelude/bwv_846": "fold3", "Chopin/Etudes_op_25/1": "fold7", "Rachmaninoff/Preludes_op_23/6": "fold0",
    "Schubert/Piano_Sonatas/664-1": "fold4", "Mozart/Piano_Sonatas/12-1": "fold4",
    "Rachmaninoff/Preludes_op_23/4": "fold3", "Scriabin/Etudes_op_8/11": "fold6",
    "Schubert/Moment_musical_no_3": "fold3", "Haydn/Keyboard_Sonatas/48-2": "fold1", "Chopin/Berceuse_op_57": "fold7",
    "Mozart/Piano_Sonatas/12-3": "fold1", "Beethoven/Piano_Sonatas/28-1": "fold5",
    "Liszt/Annees_de_pelerinage_2/1_Gondoliera": "fold0", "Chopin/Barcarolle": "fold4",
    "Bach/Prelude/bwv_854": "fold2", "Bach/Prelude/bwv_865": "fold2",
}


def slug(folder: str) -> str:
    return folder.replace("/", "_")


def perf_row(folder: str) -> dict:
    rows = csv.DictReader(open(ROOT / "asap" / "metadata.csv"))
    return next(r for r in rows if r["folder"] == folder and r["maestro_audio_performance"])


# ---------------------------------------------------------------- fetch -- #

class _HttpFile(io.RawIOBase):
    """Read-only, seekable view of a URL through HTTP range requests (1 MB blocks), so zipfile can
    pull single recordings out of MAESTRO's 108 GB archive."""

    def __init__(self, url: str, block: int = 1 << 20):
        self.url, self.block, self.pos, self.cache = url, block, 0, {}
        with urllib.request.urlopen(urllib.request.Request(url, method="HEAD")) as r:
            self.size = int(r.headers["Content-Length"])

    def seekable(self):
        return True

    def readable(self):
        return True

    def tell(self):
        return self.pos

    def seek(self, off, whence=0):
        self.pos = off if whence == 0 else self.pos + off if whence == 1 else self.size + off
        return self.pos

    def _blk(self, i: int) -> bytes:
        if i not in self.cache:
            lo, hi = i * self.block, min(self.size, (i + 1) * self.block) - 1
            with urllib.request.urlopen(urllib.request.Request(self.url, headers={"Range": f"bytes={lo}-{hi}"})) as r:
                self.cache[i] = r.read()
            if len(self.cache) > 64:
                self.cache.pop(next(iter(self.cache)))
        return self.cache[i]

    def readinto(self, b):
        n, out, got = min(len(b), self.size - self.pos), memoryview(b), 0
        while got < n:
            i, o = divmod(self.pos, self.block)
            chunk = self._blk(i)[o: o + n - got]
            out[got: got + len(chunk)] = chunk
            got += len(chunk)
            self.pos += len(chunk)
        return got


def fetch(pieces: list[str]):
    import soundfile as sf
    import wave
    if not (ROOT / "asap").exists():
        ROOT.mkdir(parents=True, exist_ok=True)
        subprocess.run(["git", "clone", "--depth", "1", ASAP_GIT, str(ROOT / "asap")], check=True)
    (ROOT / "audio").mkdir(exist_ok=True)
    todo = [p for p in pieces if not (ROOT / "audio" / f"{slug(p)}.wav").exists()]
    if not todo:
        return
    z = zipfile.ZipFile(io.BufferedReader(_HttpFile(MAESTRO_ZIP), buffer_size=1 << 16))
    for p in todo:
        row = perf_row(p)
        member = row["maestro_audio_performance"].replace("{maestro}", "maestro-v3.0.0")
        # ASAP time 0 is 0.5 s before `start` in the MAESTRO recording: a cut performance keeps half a
        # second of lead-in (onset cross-correlation, all three cut pieces here: 0.50 s)
        start = max(0.0, float(row["start"]) - 0.5) if row["start"] else 0.0
        print(f"corpus: {p}: {member} from {start:.1f}s", file=sys.stderr)
        with z.open(member) as f, wave.open(f) as w:
            sr, ch = w.getframerate(), w.getnchannels()
            w.readframes(int(round(start * sr)))  # deflated: no random access, read through
            raw = w.readframes(int((EXCERPT + 2.0) * sr))
        y = np.frombuffer(raw, dtype="<i2").reshape(-1, ch)
        sf.write(str(ROOT / "audio" / f"{slug(p)}.wav"), y, sr, subtype="PCM_16")


# ------------------------------------------------------------ reference -- #

def _ann(path: Path) -> tuple[np.ndarray, list[str]]:
    rows = [line.split("\t") for line in path.read_text().splitlines() if line.strip()]
    return np.array([float(r[0]) for r in rows]), [r[2].strip() for r in rows]


def perf_notes(folder: str, until: float) -> list[Note]:
    """Performance MIDI notes starting before `until`, each held while the sustain pedal (CC64 >= 64)
    is down at its key-up: the sounding length the piano model reports."""
    import pretty_midi
    pm = pretty_midi.PrettyMIDI(str(ROOT / "asap" / perf_row(folder)["midi_performance"]))
    cc = sorted((c.time, c.value >= 64) for i in pm.instruments for c in i.control_changes if c.number == 64)
    times, down = np.array([t for t, _ in cc]), np.array([d for _, d in cc], dtype=bool)
    out = []
    for n in (n for i in pm.instruments for n in i.notes if n.start < until):
        k, end = int(np.searchsorted(times, n.end, side="right")) - 1, n.end
        if k >= 0 and down[k]:  # pedal down at key-up: sounds until the next release
            ups = np.flatnonzero(~down[k:])
            end = float(times[k + ups[0]]) if len(ups) else n.end
        out.append(Note(float(n.start), float(max(end, n.end)), int(n.pitch), int(n.velocity)))
    return sorted(out, key=lambda n: (n.start, n.pitch))


def _clusters(items: list[tuple[float, int, float]], tol: float) -> list[tuple[float, dict[int, float]]]:
    """(position, pitch, time) sorted by position -> [(first position, {pitch: time})] per onset group."""
    out: list[tuple[float, dict[int, float]]] = []
    for pos, pitch, t in items:
        if not out or pos - out[-1][0] > tol:
            out.append((pos, {}))
        out[-1][1].setdefault(pitch, t)
    return out


def align_notes(sq: np.ndarray, pt: np.ndarray, notes: list[RefNote], perf: list[Note]):
    """Score quarter -> performance second, exact at every annotated beat and at every score onset
    matched to a performed one. Between two beats, score onset groups and performed onset groups are
    matched in order, maximising shared pitches (an LCS); a matched group's time is the median start
    of its shared pitches. Straight lines between beats missed by 150 ms and more inside slow 6/8
    beats (Beethoven op. 101: 21% of score notes over 100 ms from their performed note)."""
    aq, at = list(sq), list(pt)
    for k in range(len(sq) - 1):
        r = _clusters(sorted((n.q_on, n.pitch, n.q_on) for n in notes if sq[k] + 1e-6 < n.q_on < sq[k + 1] - 1e-6), 1e-6)
        p = _clusters(sorted((n.start, n.pitch, n.start) for n in perf if pt[k] + 0.03 < n.start < pt[k + 1] - 0.03), 0.035)
        if not r or not p:
            continue
        ov = np.array([[len(a.keys() & b.keys()) for _, b in p] for _, a in r])
        dp = np.zeros((len(r) + 1, len(p) + 1))
        for i in range(len(r)):
            for j in range(len(p)):
                dp[i + 1, j + 1] = max(dp[i, j + 1], dp[i + 1, j], dp[i, j] + ov[i, j])
        i, j = len(r), len(p)
        while i and j:
            if ov[i - 1, j - 1] and dp[i, j] == dp[i - 1, j - 1] + ov[i - 1, j - 1]:
                shared = r[i - 1][1].keys() & p[j - 1][1].keys()
                if len(shared) * 2 >= len(r[i - 1][1]):  # at least half the score chord was played there
                    aq.append(r[i - 1][0])
                    at.append(float(np.median([p[j - 1][1][x] for x in shared])))
                i, j = i - 1, j - 1
            elif dp[i - 1, j] >= dp[i, j - 1]:
                i -= 1
            else:
                j -= 1
    o = np.argsort(aq, kind="stable")
    aq_, at_ = np.array(aq)[o], np.maximum.accumulate(np.array(at)[o])
    return grid_map(aq_, at_)


def bar_phase(down_q: np.ndarray, bar_q: float) -> float:
    """Where the annotated downbeats (score quarters) fall in the bar: the most common `quarter % bar`, to a
    48th of a quarter; 0 when they fall on multiples of the bar (DESIGN.md §25)."""
    if not len(down_q):
        return 0.0
    ph = np.round(np.asarray(down_q, dtype=float) % bar_q * 48) / 48 % bar_q
    vals, counts = np.unique(ph, return_counts=True)
    return float(vals[np.argmax(counts)])


def shift_quarters(notes: list[RefNote], q2s, ph: float) -> tuple[list[RefNote], object]:
    """The notes `ph` quarters earlier and the quarters -> seconds map with them: every note keeps its time."""
    from dataclasses import replace
    return ([replace(n, q_on=n.q_on - ph, q_off=n.q_off - ph) for n in notes],
            lambda q: q2s(np.asarray(q, dtype=float) + ph))


def reference(folder: str) -> tuple[Reference, object, tuple[float, float], dict]:
    """The score's notes (midi_score: repeats unfolded, one track per staff, bottom track = LH) in
    the excerpt's whole bars, the score-quarter -> performance-second map, its span in seconds, and
    the performance's annotated beats and downbeats in that span. The measures take quarter 0 as a bar
    line (written position = quarter % bar), so a score that opens with a pickup is shifted to one (§25)."""
    import pretty_midi
    d, row = ROOT / "asap" / folder, perf_row(folder)
    sm = pretty_midi.PrettyMIDI(str(d / "midi_score.mid"))
    st, _ = _ann(d / "midi_score_annotations.txt")
    pt, labels = _ann(ROOT / "asap" / row["performance_annotations"])
    sq = np.array([sm.time_to_tick(t) / sm.resolution for t in st])
    down = np.array([lab.startswith("db") for lab in labels])
    meter = next(lab.split(",")[1] for lab in labels if lab.startswith("db") and "," in lab)
    # "db,<meter>,<sharps>": the key signature at the first downbeat that names one (later changes not used)
    sharps = next((int(f[2]) for f in (lab.split(",") for lab in labels)
                   if f[0] == "db" and len(f) > 2 and f[2].strip().lstrip("-").isdigit()), None)
    tracks = [i for i in sm.instruments if not i.is_drum and i.notes]
    notes = [RefNote(sm.time_to_tick(n.start) / sm.resolution, sm.time_to_tick(n.end) / sm.resolution, n.pitch,
                     "L" if k == len(tracks) - 1 and len(tracks) > 1 else "R", k)
             for k, i in enumerate(tracks) for n in i.notes]
    last = np.flatnonzero(down & (pt <= EXCERPT - 1.0))[-1]  # the excerpt ends at a bar line
    q0, q1 = float(sq[0]), float(sq[last])
    notes = sorted((n for n in notes if q0 - 1e-6 <= n.q_on < q1 - 1e-6), key=lambda n: (n.q_on, n.pitch))
    q2s = align_notes(sq, pt, notes, perf_notes(folder, EXCERPT))
    span = (float(q2s(q0)), float(q2s(q1)))
    ph = bar_phase(sq[down & (sq >= q0 - 1e-6) & (sq <= q1 + 1e-6)], bar_quarters(meter))
    if ph:  # a score that opens with a pickup (5 of the 19 pieces): a bar line at quarter 0, as the measures take it
        notes, q2s = shift_quarters(notes, q2s, ph)
    keep = (pt >= span[0] - 1e-3) & (pt < span[1] - 1e-3)
    ann = {"meter": meter, "beats": pt[keep], "downbeats": pt[keep & down],
           "beat_q": float(np.median(np.diff(sq))), "sharps": sharps}
    return Reference(notes, sharps, meter, None), q2s, span, ann


# ------------------------------------------------------------------ run -- #

def beat_scores(grid, ann: dict, span: tuple[float, float]) -> dict:
    """Beat F at the annotated level (and the best of half / double / x1.5 / x3 of it), downbeat F of
    the score's bar lines against the annotated downbeats (mir_eval, 70 ms)."""
    import mir_eval
    from .meter import _extrap
    lo, hi = float(_extrap(span[0], grid.t, grid.q)), float(_extrap(span[1], grid.t, grid.q))
    at = lambda step: np.asarray(_extrap(np.arange(np.ceil(lo / step) * step, hi + 1e-6, step), grid.q, grid.t))  # noqa: E731
    beats, bars = at(grid.beat_q), at(grid.bar_q)
    rb, rd = ann["beats"], ann["downbeats"]
    f = lambda ref, est: round(float(mir_eval.beat.f_measure(ref, est)), 3) if len(ref) > 1 and len(est) > 1 else None  # noqa: E731
    sub = np.sort(np.r_[rb, (rb[:-1] + rb[1:]) / 2])
    levels = {"x1": f(rb, beats), "half": f(sub, beats), "double": f(rb[::2], beats), "triple": f(rb[::3], beats)}
    return {"beat_f": levels["x1"], "beat_f_best": max(v or 0.0 for v in levels.values()),
            "beat_level": max(levels, key=lambda k: levels[k] or 0.0), "downbeat_f": f(rd, bars),
            "est_beat_q": grid.beat_q, "ref_beat_q": round(ann["beat_q"], 3)}


def run_piece(folder: str, label: str, mode: str, beats: str = "notes", checkpoint: str = "heldout") -> dict:
    import soundfile as sf
    from .meter import beat_this, score_grid
    from .notation import build_score, key_plan, lead_in, piece_key, write_musicxml
    from .pipeline import transcribe_piano
    ref, q2s, span, ann = reference(folder)
    out = ROOT / "runs" / label / slug(folder)
    out.mkdir(parents=True, exist_ok=True)
    wav = ROOT / "audio" / f"{slug(folder)}.wav"
    ck = (BT_HELDOUT.get(folder, "final0") if checkpoint == "heldout" else checkpoint) if beats == "beat-this" else None
    model = beat_this(wav, ck) if ck else None  # the recording, also for --input midi (MAESTRO is aligned)
    if mode == "audio":
        (ROOT / "tx").mkdir(exist_ok=True)
        raw = transcribe_piano(wav, ROOT / "tx" / f"{slug(folder)}.json")
        grid = score_grid(raw, wav, model=model)
    else:
        raw = perf_notes(folder, EXCERPT)
        grid = score_grid(raw, None, sf.info(str(wav)).duration, model=model)
    notes = arrange_piano_only(raw, "lead+accomp")
    keys = key_plan(raw, grid, piece_key(raw))
    xml = write_musicxml(build_score(notes, grid, slug(folder), keys=keys), out / "piano.musicxml")
    shift = lead_in(notes, grid)
    res = {"piece": folder, "mode": mode, "beats": f"beat-this {ck}" if ck else "notes",
           "ref_meter": ann["meter"], "meter": grid.meter,
           "meter_match": grid.meter == ann["meter"], "span_s": [round(x, 2) for x in span],
           **beat_scores(grid, ann, span), **score_notes(ref, q2s, notes, span)}
    gq2s = grid_map(grid.q, grid.t)
    est_q2s = lambda qq: gq2s(np.asarray(qq, dtype=float) + shift)  # noqa: E731
    res["notation"] = score_notation(ref, q2s, load_reference(xml), est_q2s, span)
    q_lo, q_hi = np.interp(span, grid.t, grid.q) - shift
    res["notation"]["load"] = notation_load(xml, float(q_lo), float(q_hi))
    res["ref_shorter_than_eighth"] = round(float(np.mean([n.q_off - n.q_on < 0.5 - 1e-6 for n in ref.notes])), 3)
    res["grid"], res["score_offset_q"] = grid.to_json(), shift
    (out / "result.json").write_text(json.dumps(res, indent=2))
    return res


# -------------------------------------------------------------- summary -- #

def flat(r: dict) -> dict[str, float]:
    """The headline numbers of one piece's result."""
    n, nl = r.get("notation", {}), r.get("notation", {}).get("load", {})
    return {"note_f1": r["notes"]["exact"]["f1"], "hands": r.get("hand_agreement"), "melody_f1": r.get("melody", {}).get("f1"),
            "meter": float(r["meter_match"]), "beat_f": r["beat_f"], "beat_f_best": r["beat_f_best"],
            "downbeat_f": r["downbeat_f"], "pos_exact": n.get("onset_in_bar_exact"),
            "len_exact": n.get("written_length_exact"), "short": nl.get("shorter_than_eighth"),
            "tied": nl.get("tied_on")}


def summarize(results: list[dict]) -> dict[str, float]:
    rows = [flat(r) for r in results]
    return {k: round(float(np.mean([x[k] for x in rows if x[k] is not None])), 3) for k in rows[0]} if rows else {}


def select(spec: str | None) -> list[str]:
    if not spec:
        return list(PIECES)
    if spec in ("tune", "check"):
        return [p for i, p in enumerate(PIECES) if i % 2 == (spec == "check")]
    return [PIECES[int(i)] for i in spec.split(",")]


def compare(a: str, b: str):
    load = lambda lab: {r["piece"]: r for r in json.loads((ROOT / "results" / f"{lab}.json").read_text())["pieces"]}  # noqa: E731
    ra, rb = load(a), load(b)
    keys = list(flat(next(iter(ra.values()))))
    print(f"{'piece':44s} " + " ".join(f"{k[:10]:>10s}" for k in keys))
    for p in ra:
        if p not in rb:
            continue
        fa, fb = flat(ra[p]), flat(rb[p])
        cell = lambda k: f"{'' if fa[k] is None else round(fa[k], 2)}>{'' if fb[k] is None else round(fb[k], 2)}"  # noqa: E731
        print(f"{p[:44]:44s} " + " ".join(f"{cell(k):>10s}" for k in keys))
    common = [p for p in ra if p in rb]
    for part, ps in (("tune", [p for p in common if PIECES.index(p) % 2 == 0]),
                     ("check", [p for p in common if PIECES.index(p) % 2 == 1]), ("all", common)):
        sa, sb = summarize([ra[p] for p in ps]), summarize([rb[p] for p in ps])
        print(f"{'mean ' + part + f' (n={len(ps)})':44s} " + " ".join(f"{str(sa.get(k)) + '>' + str(sb.get(k)):>10s}" for k in keys))


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    sub = ap.add_subparsers(dest="cmd", required=True)
    f = sub.add_parser("fetch")
    f.add_argument("--pieces")
    r = sub.add_parser("run")
    r.add_argument("--label", required=True)
    r.add_argument("--input", choices=("audio", "midi"), default="audio")
    r.add_argument("--pieces", help="tune | check | comma list of indices (default: all)")
    r.add_argument("--beats", choices=("notes", "beat-this"), default="beat-this", help="score grid's beat source (as the pipeline)")
    r.add_argument("--checkpoint", default="heldout",
                   help="Beat This! weights: heldout = the fold model that never heard the piece (BT_HELDOUT), or a name")
    c = sub.add_parser("compare")
    c.add_argument("a")
    c.add_argument("b")
    args = ap.parse_args(argv)
    if args.cmd == "fetch":
        fetch(select(args.pieces))
    elif args.cmd == "compare":
        compare(args.a, args.b)
    else:
        results = []
        for p in select(args.pieces):
            print(f"corpus: {p}", file=sys.stderr, flush=True)
            results.append(run_piece(p, args.label, args.input, args.beats, args.checkpoint))
            print("  " + json.dumps(flat(results[-1])), file=sys.stderr, flush=True)
        (ROOT / "results").mkdir(parents=True, exist_ok=True)
        path = ROOT / "results" / f"{args.label}.json"
        path.write_text(json.dumps({"label": args.label, "input": args.input, "summary": summarize(results),
                                    "pieces": results}, indent=2))
        print(json.dumps(summarize(results), indent=2))


if __name__ == "__main__":
    main()
