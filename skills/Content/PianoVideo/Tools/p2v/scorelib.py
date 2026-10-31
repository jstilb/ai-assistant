"""A piece's score by its title, from a public score library (DESIGN.md §55).

Without a score, the written meter, tempo level and bar lines of a classical piece are wrong on about half of the
bank's pieces (§47, §48); with the piece's score (`--score`, §52) they are right on nearly all. PDMX (Long et al.
2024, zenodo.org/records/15571083, CC BY 4.0; 254,077 MuseScore scores marked public domain or CC0) holds the scores
of much of the piano repertoire, as MIDI files that keep the score's bars (a pickup or a cadenza bar is a time
signature of its own). `build` writes an index of its piano scores (the title, subtitle, composer and artist words);
`Library.candidates` ranks them against a recording's title (idf-weighted words, a catalogue number such as BWV 846,
K. 332, Op. 25 No. 1 or D. 664 one word); `pick` aligns the best few with the recording's notes (`scorefile`) and
keeps the one that fits the most of them. The title chooses the work; the notes choose the score: a movement, an
edition, or nothing when no candidate fits. The library and the index are data: they stay in ~/.kaya/piano2video
and never enter the repo.
"""

from __future__ import annotations

import csv
import json
import math
import os
import re
import sys
from dataclasses import dataclass
from pathlib import Path

from .lookup import tokens

LIB = Path(os.environ.get("P2V_PDMX", Path.home() / ".kaya/piano2video/datasets/pdmx"))
INDEX = Path(os.environ.get("P2V_SCORELIB", Path.home() / ".kaya/piano2video/lookup/pdmx-index.json"))
INDEX_VERSION = 1  # bump when build's rules change: an older index is refused ("rebuild") rather than read
PIANO = range(0, 8)  # General MIDI pianos: a score of piano tracks only
# a catalogue prefix and its number are one word ("bwv846", "op25", "no1"); KV is K, opus op, Nr. and N. No.
CATALOGUE = {"bwv": "bwv", "k": "k", "kv": "k", "op": "op", "opus": "op", "d": "d", "hob": "hob", "woo": "woo",
             "s": "s", "lw": "lw", "l": "l", "kk": "kk", "hwv": "hwv", "rv": "rv", "sz": "sz", "no": "no",
             "nr": "no", "n": "no", "nos": "no"}
ROMAN = {"i": 1, "ii": 2, "iii": 3, "iv": 4, "v": 5, "vi": 6, "vii": 7, "viii": 8, "ix": 9, "x": 10, "xi": 11,
         "xii": 12, "xiii": 13, "xiv": 14, "xv": 15, "xvi": 16, "xvii": 17}
STOP = {"in", "a", "of", "for", "from", "by", "de", "la", "le", "et", "for", "piano", "solo", "version", "score",
        "sheet", "music", "full", "complete", "arr", "arranged", "transcription", "musescore"}
TOP = 8        # candidates aligned a recording (distinct scores: copies of one file count once)


def terms(s: str) -> list[str]:
    """`lookup.tokens`, with a catalogue prefix and its number joined ("BWV 846" -> bwv846, "Op. 25 No. 1" -> op25,
    no1; "Op. 10/3" -> op10, no3; "Hob. XVI:48" -> hob16, 48) and common words left out."""
    t = tokens(s)
    out, i = [], 0
    while i < len(t):
        w = t[i]
        if w in CATALOGUE and i + 1 < len(t) and (t[i + 1].isdigit() or (w == "hob" and t[i + 1] in ROMAN)):
            n = t[i + 1] if t[i + 1].isdigit() else str(ROMAN[t[i + 1]])
            out.append(CATALOGUE[w] + n)
            i += 2
            if CATALOGUE[w] == "op" and i < len(t) and t[i].isdigit():  # "Op. 10/3": the number in the opus
                out.append("no" + t[i])
                i += 1
            continue
        if m := re.fullmatch(r"(bwv|kv|k|op|d|hwv|rv|woo)(\d+)", w):  # "BWV846", "K332", "Op25"
            out.append(CATALOGUE[m.group(1)] + m.group(2))
        elif w not in STOP:
            out.append(w)
        i += 1
    return out


@dataclass(frozen=True)
class Entry:
    mid: str             # the MIDI file, relative to LIB
    title: str
    words: tuple[str, ...]
    views: int
    bars: int
    notes: int


def piano_only(tracks: str) -> bool:
    parts = tracks.split("-") if tracks and tracks != "NA" else []
    return bool(parts) and all(p.isdigit() and int(p) in PIANO for p in parts)


def build(lib: Path = LIB, out: Path = INDEX) -> int:
    """PDMX.csv -> the index file: the piano-only scores without a licence conflict whose MIDI file is there."""
    csv.field_size_limit(sys.maxsize)
    entries = []
    with open(lib / "PDMX.csv", newline="") as f:
        for r in csv.DictReader(f):
            if r.get("subset:no_license_conflict") != "True" or not piano_only(r.get("tracks", "")):
                continue
            mid = r["mid"].removeprefix("./")
            if not (lib / mid).exists():
                continue
            text = " ".join(r[k] for k in ("title", "song_name", "subtitle", "composer_name", "artist_name")
                            if r.get(k) and r[k] != "NA")
            words = tuple(dict.fromkeys(terms(text)))
            if words:
                entries.append({"mid": mid, "title": r["title"], "words": words, "views": int(float(r["n_views"] or 0)),
                                "bars": int(float(r["song_length.bars"] or 0)), "notes": int(float(r["n_notes"] or 0))})
    out.parent.mkdir(parents=True, exist_ok=True)
    tmp = out.with_suffix(".part")
    tmp.write_text(json.dumps({"version": INDEX_VERSION, "source": "PDMX v9 (zenodo.org/records/15571083, CC BY 4.0)",
                               "entries": entries}))
    tmp.replace(out)
    return len(entries)


class Library:
    def __init__(self, entries: list[Entry], root: Path = LIB):
        self.entries, self.root = entries, root
        self.posting: dict[str, list[int]] = {}
        for i, e in enumerate(entries):
            for w in e.words:
                self.posting.setdefault(w, []).append(i)
        n = len(entries)
        self.idf = {w: math.log((n + 1) / (len(p) + 0.5)) for w, p in self.posting.items()}
        self.norm = [math.sqrt(sum(self.idf[w] ** 2 for w in e.words)) for e in entries]

    @classmethod
    def load(cls, path: Path = INDEX, root: Path = LIB) -> Library:
        d = json.loads(path.read_text())
        if d.get("version") != INDEX_VERSION:
            raise ValueError(f"index version {d.get('version')}, not {INDEX_VERSION}: run `python -m p2v.scorelib build`")
        return cls([Entry(**{**e, "words": tuple(e["words"])}) for e in d["entries"]], root)

    def candidates(self, title: str, k: int = TOP) -> list[tuple[float, Entry]]:
        """The `k` entries most like the title (the cosine of their idf-weighted word sets), one per distinct
        score (the same bars and notes: an upload copied), the most viewed copy."""
        q = [w for w in dict.fromkeys(terms(title)) if w in self.idf]
        if not q:
            return []
        qn = math.sqrt(sum(self.idf[w] ** 2 for w in q))
        acc: dict[int, float] = {}
        for w in q:
            for i in self.posting[w]:
                acc[i] = acc.get(i, 0.0) + self.idf[w] ** 2
        ranked = sorted(acc, key=lambda i: (-acc[i] / (qn * self.norm[i]), -self.entries[i].views))
        out, seen = [], set()
        for i in ranked:
            e = self.entries[i]
            if (e.bars, e.notes) in seen:
                continue
            seen.add((e.bars, e.notes))
            out.append((round(acc[i] / (qn * self.norm[i]), 4), e))
            if len(out) == k:
                break
        return out
