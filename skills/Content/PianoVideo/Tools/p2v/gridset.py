"""Grid test sets (DESIGN.md §45): the score grid alone — meter, tempo level, beat F, downbeat F — on many
recordings that no Beat This! model trained on, so that a change of the grid builder can be decided (§44: a
song's change of beat F has an SD of 0.07-0.09, so a 0.02 gain needs about 100 songs a half; the bank has 3-11).

  asap   one performance of each ASAP work that has MAESTRO audio and one Beat This! fold, up to CAP seconds,
         with the logits of the fold model that never heard the work (as corpus.BT_HELDOUT, §12) and the notes of
         the piano model on the recording (a solo-piano recording takes the piano path and its mix, §14).
  gtzan  PER_GENRE 30 s clips of each of GTZAN's 10 genres (Tzanetakis & Cook 2002; beats and downbeats from
         CPJKU/beat_this_annotations). No Beat This! model trained on GTZAN (its paper keeps it for testing, and
         its folder has no split file), so the default nine-model mean is fair; Demucs, the route and the routed
         transcriptions come from `pipeline.run`. GTZAN annotates counted beats, not a written meter: the meter
         and the tempo are scored in counted beats (`count_scores`).

Each item keeps a small cache (the routed notes, the logits, the sample count) and its working audio is deleted:
a variant of the grid builder is measured from the caches in minutes (`score_set` reads `meter` at call time, so
a patched module is measured), and the sets fit a nearly full disk. The halves come from a hash of the id
(`bank.hash_half`); `gate` applies Kaya's adoption rule (`bank.adopt`). The audio and annotations are research
data: they stay in ~/.kaya/piano2video and never enter the repo.

Usage (from Tools/):
  python -m p2v.gridset run asap|gtzan --label base [--half tune] [--limit N] [--ids a,b]  # prepare, then score
  python -m p2v.gridset gate base new [--sets asap,gtzan] [--half tune] [--target beat_f_best]
"""
from __future__ import annotations

import argparse
import collections
import csv
import functools
import hashlib
import io
import json
import os
import shutil
import sys
import tarfile
import time
import urllib.request
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np

from . import bank, meter
from .arrange import Note
from .evaluate import Reference

ROOT = Path(os.environ.get("P2V_GRIDSETS", Path.home() / ".kaya/piano2video/gridsets"))
ANN = bank.ROOT / "raw/beat_this_annotations/x/beat_this_annotations-1.0"
CAP = 600.0  # seconds of an ASAP performance (Kaya's bound on the runtime: 7 of the 152 works run longer)
GTZAN_URL = "https://huggingface.co/datasets/marsyas/gtzan/resolve/main/data/genres.tar.gz"
GTZAN_SHA256 = "b28cc067ff6199bd826f5d1a6931458586d64acae7f44b2e882b7a97af057531"  # the HF LFS pointer's
GTZAN_BYTES = 1_226_192_050
GTZAN_AUDIO = Path.home() / ".kaya/piano2video/datasets/gtzan"
# jazz 00054 is corrupt; six jazz clips have no downbeats (Beat This!'s paper scores the other 993)
GTZAN_DROP = frozenset(["gtzan_jazz_00054", *(f"gtzan_jazz_{k:05d}" for k in (3, 9, 10, 14, 18, 20))])
PER_GENRE = 40
SETS = ("asap", "gtzan")
STOP_AFTER = 3  # items failed in a row: the run stops (a missing tool or model would fail every item, slowly)


@dataclass
class Item:
    id: str
    set: str
    group: str  # asap: "asap"; gtzan: the genre
    half: str
    ck: str     # Beat This! weights
    src: dict = field(default_factory=dict)


# ------------------------------------------------------------------ items -- #

def need(path: Path, what: str):
    if not path.exists():
        raise SystemExit(f"gridset: {path} is missing. Fix: {what}")


def asap_items() -> list[Item]:
    """The first performance (metadata order) of each ASAP work with MAESTRO audio and a fold; a work whose
    performances sit in two folds is left out (some fold model heard it)."""
    from . import corpus
    need(ANN / "asap/8-folds.split", "the Beat This! annotations (bank.ROOT/raw/beat_this_annotations, DESIGN.md §12)")
    need(corpus.ROOT / "asap/metadata.csv", "ASAP: run python -m p2v.corpus fetch")
    split = dict(line.split("\t") for line in (ANN / "asap/8-folds.split").read_text().splitlines() if line.strip())
    first: dict[str, dict] = {}
    folds = collections.defaultdict(set)
    with open(corpus.ROOT / "asap/metadata.csv") as f:
        rows = list(csv.DictReader(f))
    for r in rows:
        name = f"{corpus.slug(r['folder'])}_{Path(r['midi_performance']).stem}"
        if r["maestro_audio_performance"] and name in split:
            folds[r["folder"]].add(split[name].strip())
            first.setdefault(r["folder"], r)
    return [Item(f"asap-{corpus.slug(f)}", "asap", "asap", bank.hash_half(f"asap-{corpus.slug(f)}"),
                 f"fold{next(iter(folds[f]))}", {"row": r}) for f, r in first.items() if len(folds[f]) == 1]


def gtzan_items(per_genre: int = PER_GENRE) -> list[Item]:
    """`per_genre` clips of each genre, chosen by a hash of the id (no one picks them), outside GTZAN_DROP."""
    by = collections.defaultdict(list)
    for p in sorted((ANN / "gtzan/annotations/beats").glob("gtzan_*.beats")):
        if p.stem not in GTZAN_DROP:
            by[p.stem.split("_")[1]].append(p)
    out = []
    for genre, ps in sorted(by.items()):
        keep = sorted(ps, key=lambda p: hashlib.sha1(f"select:{p.stem}".encode()).hexdigest())[:per_genre]
        out += [Item(p.stem, "gtzan", genre, bank.hash_half(p.stem), "ensemble", {"beats": str(p)}) for p in sorted(keep)]
    return out


ITEMS = {"asap": asap_items, "gtzan": gtzan_items}


# ------------------------------------------------------------- references -- #

@functools.lru_cache(maxsize=1)
def asap_annotations() -> dict:
    from . import corpus
    return json.loads((corpus.ROOT / "asap/asap_annotations.json").read_text())


def main_meter(sigs: dict[str, list], beats: np.ndarray) -> str:
    """The time signature that holds the most annotated beats (a piece may change meter; a pickup before the
    first signature counts to it)."""
    ts = sorted((float(t), v[0]) for t, v in sigs.items())
    ends = [t for t, _ in ts[1:]] + [np.inf]
    count: dict[str, int] = {}
    for k, ((t0, label), t1) in enumerate(zip(ts, ends)):
        count[label] = count.get(label, 0) + int(np.sum(((beats >= t0 - 1e-6) | (k == 0)) & (beats < t1 - 1e-6)))
    return max(count, key=lambda m: count[m])


def asap_ref(a: dict) -> bank.Ref:
    """The performance's annotated beats and bar lines up to CAP − 1 s, and its main meter."""
    beats, downs = np.asarray(a["performance_beats"], dtype=float), np.asarray(a["performance_downbeats"], dtype=float)
    end = min(float(beats[-1]), CAP - 1.0)
    beats, downs = beats[beats <= end + 1e-6], downs[downs <= end + 1e-6]
    m = main_meter(a["perf_time_signatures"], beats)
    return bank.Ref(Reference([], None, m, None), None, None, (float(beats[0]), float(beats[-1])), m, beats, downs,
                    None, None)


def beats_per_bar(counts: np.ndarray) -> int | None:
    """The usual bar in counted beats: the commonest count just before a 1."""
    ends = collections.Counter(int(counts[i - 1]) for i in range(1, len(counts)) if counts[i] == 1)
    return ends.most_common(1)[0][0] if ends else None


def gtzan_ref(path: Path) -> tuple[bank.Ref, int | None]:
    """A `.beats` file (time, count in the bar) as a reference with no written meter, and its beats per bar."""
    rows = [line.split() for line in path.read_text().splitlines() if line.strip()]
    t = np.array([float(r[0]) for r in rows])
    k = np.array([int(float(r[1])) for r in rows])
    return (bank.Ref(Reference([], None, None, None), None, None, (float(t[0]), float(t[-1])), None, t, t[k == 1],
                     None, None), beats_per_bar(k))


def count_scores(ref: bank.Ref, bpb: int | None, grid) -> dict:
    """`bank.grid_scores` with the meter and the tempo in counted beats: a 12/8 grid (four dotted-quarter beats)
    matches four counted beats, and its tempo is its beats a minute against the annotated beats a minute."""
    out = bank.grid_scores(ref, grid)
    out.pop("ref_qpm", None)
    out.pop("qpm", None)
    ref_bpm = 60.0 / float(np.median(np.diff(ref.beats)))
    ratio = grid.bpm / ref_bpm
    out.update(ref_meter=f"{bpb} beats" if bpb else None,
               meter_match=bool(round(grid.bar_q / grid.beat_q) == bpb) if bpb else None,
               ref_bpm=round(ref_bpm, 1), bpm=round(grid.bpm, 1), tempo_ratio=round(ratio, 3),
               tempo_match=bool(abs(np.log(ratio)) < np.log(1.04)))
    return out


# ------------------------------------------------------------------ cache -- #

def item_dir(it: Item) -> Path:
    return ROOT / it.set / "items" / it.id


def prepared(it: Item) -> bool:
    return (item_dir(it) / "item.json").exists()


def cache_duration(samples: int) -> float:
    """A duration that gives `meter.track_beats` the frame count the recording gives (`samples` at meter.SR):
    ceil((samples − 0.5) / HOP) = ceil(samples / HOP) for every whole `samples`."""
    return (samples - 0.5) / meter.SR


def load(it: Item) -> tuple[list[Note], meter.ModelBeats, float, dict]:
    from .pipeline import _notes_from_json
    d = item_dir(it)
    info = json.loads((d / "item.json").read_text())
    with np.load(d / f"beats-{it.ck}.npz", allow_pickle=False) as z:
        mb = meter.ModelBeats(z["beat"], z["downbeat"])
    return _notes_from_json(d / "notes.json"), mb, cache_duration(info["samples"]), info


def same_grid(a, b) -> bool:
    return len(a.t) == len(b.t) and bool(np.allclose(a.t, b.t, atol=1e-4) and np.allclose(a.q, b.q, atol=1e-4)) \
        and a.meter == b.meter


def finish(it: Item, wav: Path, notes: list[Note], mb: meter.ModelBeats, run_grid, extra: dict) -> dict:
    """Write the item's cache: its notes, the sample count, and whether the grid rebuilt from the cache equals the
    run's grid (`run_grid`: the grid the pipeline made from the recording)."""
    import librosa
    from .pipeline import _notes_to_json
    d = item_dir(it)
    samples = len(librosa.load(str(wav), sr=meter.SR, mono=True)[0])
    _notes_to_json(notes, d / "notes.json")
    rebuilt = meter.score_grid(notes, None, cache_duration(samples), model=mb) if notes else None
    info = {"id": it.id, "ck": it.ck, "samples": samples, "notes": len(notes),
            "rebuilt_equal": None if run_grid is None or rebuilt is None else same_grid(run_grid, rebuilt), **extra}
    if info["rebuilt_equal"] is False:
        print(f"gridset: {it.id}: the grid rebuilt from the cache differs from the run's", file=sys.stderr)
    (d / "item.json").write_text(json.dumps(info, indent=1, default=bank._json))  # last: marks the item prepared
    return info


def fresh(it: Item) -> Path:
    """An empty folder for an item not yet prepared: a failed attempt's notes or logits are not reused, since
    they may belong to other audio (another CAP, another row)."""
    shutil.rmtree(item_dir(it), ignore_errors=True)
    item_dir(it).mkdir(parents=True)
    return item_dir(it)


def prepare_asap(it: Item, z) -> dict:
    import soundfile as sf
    from . import corpus
    from .pipeline import transcribe_piano
    d = fresh(it)
    a = asap_annotations()[it.src["row"]["midi_performance"]]
    t = [time.time()]
    y, sr = corpus.read_performance(z, it.src["row"], min(float(a["performance_beats"][-1]) + 2.0, CAP))
    wav = d / "audio.wav"
    sf.write(str(wav), y, sr, subtype="PCM_16")
    try:
        t.append(time.time())
        notes = transcribe_piano(wav, d / "notes.json")
        t.append(time.time())
        mb = meter.beat_this(wav, it.ck, cache=d / f"beats-{it.ck}.npz")
        t.append(time.time())
        run_grid = meter.score_grid(notes, wav, model=mb) if notes else None
        return finish(it, wav, notes, mb, run_grid, {"folder": it.src["row"]["folder"], "seconds": round(len(y) / sr, 2),
                                                     "stage_s": [round(b - a, 1) for a, b in zip(t, t[1:])]})
    finally:
        wav.unlink(missing_ok=True)


def routed_notes(report: dict, work: Path) -> list[Note]:
    """The notes the routed source's grid follows (`pipeline.source_notes`), from the run's transcription caches."""
    from .pipeline import STEMS, _notes_from_json, active_stems, source_notes
    lead = report.get("lead_stem", "vocals")
    tx = {}
    for s in STEMS:
        if s == "piano":
            p = work / "tx" / ("piano-mix.json" if report.get("piano_input") == "mix" else "piano.json")
        elif s == lead and report.get("lead_f0") in ("some", "pyin"):
            p = work / "tx" / f"{s}-{'some' if report['lead_f0'] == 'some' else 'f0'}.json"
        else:
            p = work / "tx" / f"{s}.json"
        if p.exists():
            tx[s] = _notes_from_json(p)
    return source_notes(report["route"], tx, active_stems(report["stem_db"]), lead)


def prepare_gtzan(it: Item) -> dict:
    from . import pipeline
    flac = GTZAN_AUDIO / f"{it.id}.flac"
    if not flac.exists():
        raise FileNotFoundError(f"{flac}: not in the fetched clips (PER_GENRE changed?). Fix: move {GTZAN_AUDIO} "
                                "to the Trash and run again (one download of 1.2 GB)")
    work = ROOT / "gtzan" / "work"
    shutil.rmtree(work / it.id, ignore_errors=True)
    fresh(it)
    try:
        rep = pipeline.run(pipeline.build_parser().parse_args(
            [str(flac), "--out", str(work), "--name", it.id, "--parts", "lead", "--no-video", "--no-pdf",
             "--audio-track", "none"]))
        wd = work / it.id
        route = rep["route"]
        notes = routed_notes(rep, wd) if route in rep["grids"] else []
        shutil.copy2(wd / "beats-ensemble.npz", item_dir(it) / "beats-ensemble.npz")
        with np.load(wd / "beats-ensemble.npz", allow_pickle=False) as z:
            mb = meter.ModelBeats(z["beat"], z["downbeat"])
        run_grid = bank.grid_of(rep["grids"][route]) if route in rep["grids"] else None
        return finish(it, wd / "input.wav", notes, mb, run_grid,
                      {"route": route, "stem_db": rep["stem_db"], "lead_f0": rep.get("lead_f0")})
    finally:
        shutil.rmtree(work / it.id, ignore_errors=True)


class _Hashing(io.RawIOBase):
    """A read-only stream that feeds every byte it passes to a hash."""

    def __init__(self, raw, h):
        self.raw, self.h, self.n = raw, h, 0

    def readable(self):
        return True

    def readinto(self, b):
        data = self.raw.read(len(b))
        self.h.update(data)
        self.n += len(data)
        b[:len(data)] = data
        return len(data)


def fetch_gtzan(items: list[Item]):
    """One pass over the archive: every byte hashed, the chosen clips kept (FLAC: lossless, half the bytes) in a
    .part folder that becomes GTZAN_AUDIO only when the size and the SHA-256 match. No path from the archive is
    used: a member is read when its file name is a chosen clip's."""
    import soundfile as sf
    want = {f"{i.id.split('_')[1]}.{i.id.split('_')[2]}.wav": i.id for i in items}
    part = GTZAN_AUDIO.with_name(GTZAN_AUDIO.name + ".part")
    shutil.rmtree(part, ignore_errors=True)
    part.mkdir(parents=True)
    h = hashlib.sha256()
    print(f"gridset: GTZAN: streaming {GTZAN_URL} ({GTZAN_BYTES / 1e9:.2f} GB), keeping {len(want)} clips",
          file=sys.stderr, flush=True)
    with urllib.request.urlopen(GTZAN_URL, timeout=60) as r:
        src = _Hashing(r, h)
        with tarfile.open(fileobj=io.BufferedReader(src, 1 << 20), mode="r|gz") as tar:
            for m in tar:
                name = Path(m.name).name
                if m.isfile() and name in want:
                    y, sr = sf.read(io.BytesIO(tar.extractfile(m).read()), dtype="int16")
                    sf.write(str(part / f"{want[name]}.flac"), y, sr, subtype="PCM_16")
        while src.read(1 << 20):  # the bytes after the archive's end still count to the hash
            pass
    got = {p.stem for p in part.glob("*.flac")}
    if src.n != GTZAN_BYTES or h.hexdigest() != GTZAN_SHA256:
        shutil.rmtree(part)
        raise SystemExit(f"GTZAN: {src.n} bytes, SHA-256 {h.hexdigest()}: not the pinned archive; nothing kept")
    if missing := set(want.values()) - got:
        shutil.rmtree(part)
        raise SystemExit(f"GTZAN: {len(missing)} chosen clips not in the archive (e.g. {sorted(missing)[:3]})")
    os.replace(part, GTZAN_AUDIO)


# ------------------------------------------------------------------ score -- #

def score_set(name: str, label: str, items: list[Item] | None = None) -> list[dict]:
    """Every prepared item's grid rebuilt from its cache with the `meter` module as it is now, scored against the
    reference; written to ROOT/<set>/results/<label>.json."""
    rows = []
    for it in items if items is not None else ITEMS[name]():
        if not prepared(it):
            continue
        notes, mb, dur, info = load(it)
        row = {"id": it.id, "set": name, "group": it.group, "half": it.half}
        if not notes:
            rows.append({**row, "error": f"no notes (route {info.get('route')})"})
            continue
        grid = meter.score_grid(notes, None, dur, model=mb)
        if name == "asap":
            sc = bank.grid_scores(asap_ref(asap_annotations()[it.src["row"]["midi_performance"]]), grid)
        else:
            sc = count_scores(*gtzan_ref(Path(it.src["beats"])), grid)
        rows.append({**row, **sc})
    out = ROOT / name / "results" / f"{label}.json"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(rows, indent=1, default=bank._json))
    return rows


def summary(rows: list[dict]) -> list[str]:
    lines = []
    for g in sorted({r["group"] for r in rows}):
        for half in ("tune", "check"):
            rs = [r for r in rows if r["group"] == g and r["half"] == half and "error" not in r]
            if rs:
                mean = lambda k: np.mean([float(r[k]) for r in rs if r.get(k) is not None])  # noqa: E731
                lines.append(f"{g:10s} {half:5s} n {len(rs):3d}  meter {mean('meter_match'):.3f}  tempo "
                             f"{mean('tempo_match'):.3f}  beatF {mean('beat_f_best'):.3f}  downF {mean('downbeat_f'):.3f}")
    return lines


def interleave(items: list[Item]) -> list[Item]:
    """The order to prepare items in: one of each group in turn, by a hash of the id within a group, so that a set
    stopped part-way is still balanced across its groups and not ordered by composer or file name."""
    rank = collections.Counter()
    keyed = []
    for it in sorted(items, key=lambda i: (i.group, hashlib.sha1(i.id.encode()).hexdigest())):
        keyed.append((rank[it.group], it.group, it))
        rank[it.group] += 1
    return [it for _, _, it in sorted(keyed, key=lambda x: x[:2])]


def run(name: str, label: str, limit: int | None = None, ids: str | None = None, half: str | None = None):
    items = [i for i in ITEMS[name]() if (not ids or i.id in ids.split(",")) and (not half or i.half == half)]
    todo = interleave([i for i in items if not prepared(i)])[:limit]
    if todo and name == "gtzan" and not GTZAN_AUDIO.exists():
        fetch_gtzan(ITEMS[name]())
    for ck in sorted({i.ck for i in todo}) if name == "asap" else ():  # gtzan: pipeline.run checks its own
        if why := meter.beat_this_missing(ck):
            raise SystemExit(f"gridset asap: {why}")
    z = None
    failed = {}
    for k, it in enumerate(todo):
        t0 = time.time()
        print(f"gridset: {name} {k + 1}/{len(todo)} {it.id}", file=sys.stderr, flush=True)
        try:
            if name == "asap":
                if z is None:
                    from .corpus import maestro_zip
                    z = maestro_zip()
                info = prepare_asap(it, z)
            else:
                info = prepare_gtzan(it)
            print(f"gridset: {it.id} done in {time.time() - t0:.0f} s (stages {info.get('stage_s')}): {info['notes']} "
                  f"notes, rebuilt equal {info['rebuilt_equal']}", file=sys.stderr, flush=True)
        except (Exception, SystemExit) as e:  # noqa: BLE001 — one item's failure is reported, the set goes on
            failed[it.id] = f"{type(e).__name__}: {e}"
            print(f"gridset: {it.id} FAILED {failed[it.id]}", file=sys.stderr, flush=True)
            if all(i.id in failed for i in todo[max(0, k + 1 - STOP_AFTER): k + 1]) and k + 1 >= STOP_AFTER:
                print(f"gridset: {STOP_AFTER} items failed in a row: stopping (a missing tool or model fails them all)",
                      file=sys.stderr, flush=True)
                break
    rows = score_set(name, label, items)
    print("\n".join(summary(rows)))
    print(f"{name}: {len(rows)} of {len(items)} items scored ({sum('error' in r for r in rows)} without notes)")
    if failed:
        print(f"FAILED ({len(failed)}): " + "; ".join(f"{k}: {v[:160]}" for k, v in failed.items()))
        raise SystemExit(1)


def results(label: str, sets: list[str], half: str | None) -> list[dict]:
    rows = []
    for s in sets:
        rows += json.loads((ROOT / s / "results" / f"{label}.json").read_text())
    return [r for r in rows if "error" not in r and (half is None or r["half"] == half)]


def print_gate(g: dict[str, dict[str, dict]]):
    for m, per in g.items():
        for grp, s in per.items():
            ci = f"[{s['lo']:+.4f}, {s['hi']:+.4f}]" if s["lo"] is not None else "[-]"
            mean = f"{s['mean']:+.4f}" if s["mean"] is not None else "-"
            print(f"{m:12s} {grp:10s} n {s['n']:3d}  mean {mean}  CI {ci}  better {s['better']:3d}  worse {s['worse']:3d}")


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    sub = ap.add_subparsers(dest="cmd", required=True)
    r = sub.add_parser("run", help="prepare the set's new items (resumable), then score every prepared item")
    r.add_argument("set", choices=SETS)
    r.add_argument("--label", required=True)
    r.add_argument("--limit", type=int, help="prepare at most this many new items")
    r.add_argument("--ids", help="comma list of item ids")
    r.add_argument("--half", choices=("tune", "check"), help="only this half (decide on tune before check exists)")
    g = sub.add_parser("gate", help="Kaya's adoption rule (bank.adopt) on two labels' results")
    g.add_argument("a")
    g.add_argument("b")
    g.add_argument("--sets", default="asap,gtzan")
    g.add_argument("--half", choices=("tune", "check"), default="tune")
    g.add_argument("--target", default="beat_f_best", choices=bank.GATE_MEASURES)
    args = ap.parse_args(argv)
    if args.cmd == "run":
        run(args.set, args.label, args.limit, args.ids, args.half)
        return
    sets = args.sets.split(",")
    res = bank.gate(results(args.a, sets, args.half), results(args.b, sets, args.half))
    print_gate(res)
    ok, why = bank.adopt(res, args.target)
    print(f"\n{args.half}: {'ADOPT' if ok else 'do not adopt'} ({args.a} -> {args.b}, target {args.target})")
    print("\n".join("  " + w for w in why))


if __name__ == "__main__":
    main()
