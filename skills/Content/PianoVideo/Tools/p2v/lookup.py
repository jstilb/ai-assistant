"""A song's written meter and tempo by its title, from the HookTheory dump (DESIGN.md §54).

The written tempo level and the bar length are not in the audio (§48, §54): a song listing states them. HookTheory
(Donahue et al. 2022, github.com/chrisdonahue/sheetsage-data, CC BY-NC-SA 3.0; personal use) annotates 26,175
sections of 15,213 songs with their meter and a beat alignment on a YouTube recording. `build` turns the dump into an
index of (artist, song) -> meter and beats a minute; `find` matches a video title (and its channel) to one entry,
the artist and the song both in the title; `hint_for` gives the entry's meter and the recording's tempo as a
`meter.Hint` only when the recording's own beat tempo is within HINT_RANGE of the entry's at the same level (LEVELS:
the lookup confirms the audio's level, it does not move it; a cover or a wrong match at another tempo keeps the
audio's grid). The dump and the index are data: they stay in ~/.kaya/piano2video and never enter the repo.
"""

from __future__ import annotations

import gzip
import json
import os
import re
import unicodedata
from collections import Counter
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path

import numpy as np

from .meter import HINT_RANGE, METERS, Hint, ModelBeats, peak_times, steady_beats

DUMP = Path(os.environ.get("P2V_BANK", Path.home() / ".kaya/piano2video/bank")) / "raw/hooktheory/Hooktheory.json.gz"
INDEX = Path(os.environ.get("P2V_LOOKUP", Path.home() / ".kaya/piano2video/lookup/hooktheory-index.json"))
INDEX_VERSION = 1  # bump when build's rules change: an older index is refused ("rebuild") rather than read
WRITTEN = {"2/2": "4/4", "6/4": "12/8"}  # the same bars, as bank.ref_hint writes them
COMPOUND = ("6/8", "9/8", "12/8")
# words of a channel name that are not the artist's ("Adele - Topic", "Queen Official"); "AdeleVEVO" loses its "vevo"
CHANNEL_NOISE = ("topic", "official", "music", "channel", "tv", "vevo")
MAX_SONG_TOKENS = 12


@dataclass(frozen=True)
class Entry:
    artist: str          # HookTheory's slugs, as in its URLs
    song: str
    meter: str           # a METERS value
    bpm: float           # beats a minute, the beat as the meter counts it (a dotted quarter in 6/8, 9/8, 12/8)
    sections: int        # sections of the song at this meter (the median's sample)


def section_tempo(entry: dict) -> tuple[str, float] | None:
    """One dump section -> (meter, beats a minute), or None: a meter change, a meter the grid cannot write, no
    alignment. The beat tempo is the median of the alignment's beat intervals (refined, else the user's)."""
    a = entry.get("annotations") or {}
    meters = a.get("meters") or []
    if len(meters) != 1:
        return None
    bpb, unit = int(meters[0]["beats_per_bar"]), int(meters[0]["beat_unit"])
    meter = WRITTEN.get(f"{bpb}/{unit}", f"{bpb}/{unit}")
    al = (entry.get("alignment") or {}).get("refined") or (entry.get("alignment") or {}).get("user")
    if meter not in METERS.values() or not al:
        return None
    beats, times = np.asarray(al["beats"], dtype=float), np.asarray(al["times"], dtype=float)
    if len(beats) < 2 or len(beats) != len(times):
        return None
    db = np.diff(beats)
    ok = db > 0
    if not ok.any():
        return None
    step = float(np.median(np.diff(times)[ok] / db[ok]))  # seconds a HookTheory beat (the meter's beat unit)
    if not step > 0:
        return None
    qpm = 60.0 / step * 4.0 / unit
    bpm = qpm / 1.5 if meter in COMPOUND else qpm
    return (meter, bpm) if 10.0 <= bpm <= 400.0 else None


AGREE = 1.04  # two sections at the same tempo: within 4%, the bank's tempo_match


def song_entry(artist: str, song: str, tempos: list[tuple[str, float]]) -> Entry | None:
    """A song's sections -> one entry: the most common meter; at that meter, the median tempo of the largest group
    of sections that agree (within AGREE of one of them). Sections annotated at two levels must not average to a
    tempo of neither (Faded: 179 and 90 gave 134); a tie keeps the slower group, since HookTheory's annotators write
    some songs at double time (Divinity at 179, §48)."""
    if not tempos:
        return None
    meter = Counter(m for m, _ in tempos).most_common(1)[0][0]
    bpms = sorted(b for m, b in tempos if m == meter)
    groups = [[x for x in bpms if abs(np.log(x / b)) <= np.log(AGREE)] for b in bpms]
    top = max(groups, key=len)  # the first of the largest: the slowest, as bpms is sorted
    return Entry(artist, song, meter, round(float(np.median(top)), 2), len(top))


def build(dump: Path = DUMP, out: Path = INDEX) -> tuple[int, list[str]]:
    """The dump -> the index file (a JSON list of entries). Returns the number of songs and the keys of the sections
    left out as malformed (a missing field, a non-numeric value), which the caller reports."""
    with gzip.open(dump) as f:
        data = json.load(f)
    by_song: dict[tuple[str, str], list[tuple[str, float]]] = {}
    bad = []
    for key, e in data.items():
        try:
            t = section_tempo(e)
            if t is not None:
                by_song.setdefault((e["hooktheory"]["artist"], e["hooktheory"]["song"]), []).append(t)
        except (KeyError, TypeError, ValueError):
            bad.append(key)
    entries = [x for (a, s), ts in sorted(by_song.items()) if (x := song_entry(a, s, ts)) is not None]
    out.parent.mkdir(parents=True, exist_ok=True)
    tmp = out.with_suffix(".part")
    tmp.write_text(json.dumps({"version": INDEX_VERSION, "source": f"{dump.name} (HookTheory, CC BY-NC-SA 3.0)",
                               "entries": [e.__dict__ for e in entries]}))
    tmp.replace(out)
    return len(entries), bad


DROP = ("the", "and")  # "Lady Gaga, Bradley Cooper" is lady-gaga-and-bradley-cooper; "Beatles" the-beatles


def tokens(s: str) -> list[str]:
    """Lowercase ASCII words, for titles and slugs alike: accents dropped, apostrophes removed (HookTheory slugs
    write "dont"), & as "and", then "the" and "and" left out, and -ing as -in in words of 6 letters or more
    ("Believin'" is dont-stop-believing; "sing", "king" and "thing" stay themselves)."""
    s = unicodedata.normalize("NFKD", s.replace("ß", "ss")).encode("ascii", "ignore").decode().lower()
    s = re.sub(r"['’`]", "", s).replace("&", " and ")
    return [t[:-1] if t.endswith("ing") and len(t) >= 6 else t
            for t in re.split(r"[^a-z0-9]+", s) if t and t not in DROP]


def umlauts(s: str) -> str:
    """German umlauts as HookTheory's slugs write them ("Für Elise" -> fuer-elise)."""
    for a, b in (("ä", "ae"), ("ö", "oe"), ("ü", "ue"), ("Ä", "Ae"), ("Ö", "Oe"), ("Ü", "Ue")):
        s = s.replace(a, b)
    return s


def channel_tokens(channel: str) -> list[str]:
    """The channel's words without CHANNEL_NOISE words, and "vevo" cut from the end of a word ("AdeleVEVO")."""
    out = []
    for t in tokens(channel):
        if t.endswith("vevo") and len(t) > 4:
            t = t[:-4]
        if t not in CHANNEL_NOISE:
            out.append(t)
    return out


def _at(seq: list[str], sub: list[str], skip: tuple[int, int] = (0, 0)) -> bool:
    """`sub` is a run of `seq` that does not overlap seq[skip[0]:skip[1]]."""
    n = len(sub)
    return any(seq[i:i + n] == sub and (i + n <= skip[0] or i >= skip[1]) for i in range(len(seq) - n + 1))


class Index:
    def __init__(self, entries: list[Entry]):
        self.entries = entries
        self.by_song: dict[tuple[str, ...], list[Entry]] = {}
        for e in entries:
            if song := tuple(tokens(e.song)):
                self.by_song.setdefault(song, []).append(e)

    @classmethod
    def load(cls, path: Path = INDEX) -> Index:
        d = json.loads(path.read_text())
        if d.get("version") != INDEX_VERSION:
            raise ValueError(f"index version {d.get('version')}, not {INDEX_VERSION}: run `python -m p2v.lookup build`")
        return cls([Entry(**e) for e in d["entries"]])

    def find(self, title: str, channel: str = "") -> Entry | None:
        """The entry whose song is a run of the title's words and whose artist is another run of the title or the
        channel's words (or the channel's name run together: "AdeleVEVO"). The longest song name wins, then the
        longest artist match, then the song with more sections; a full tie keeps the first (index order)."""
        chan = channel_tokens(channel)
        best, key = None, (0, 0, 0)
        variants = [tokens(title)]
        if (u := tokens(umlauts(title))) != variants[0]:
            variants.append(u)
        for words in variants:
            for i in range(len(words)):
                for j in range(i + 1, min(len(words), i + MAX_SONG_TOKENS) + 1):
                    for e in self.by_song.get(tuple(words[i:j]), []):
                        art = tokens(e.artist)
                        if art and (_at(words, art, (i, j)) or _at(chan, art) or "".join(art) in chan):
                            k = (j - i, len(art), e.sections)
                            if k > key:
                                best, key = e, k
        return best


# the recording's beat level times these may be the entry's. x1 only: the lookup confirms the audio's level, it does
# not move it. On the bank's covers with their own scores, all three moves to x0.5 / x2 were wrong (The Moon Song
# 103 -> 46, California 75 -> 155, Flower Duet 94 -> 194 in 3/4 against 12/8 at 65): HookTheory's level is its
# annotator's, and a cover's score may count the beat at another level (§54)
LEVELS = (1.0,)


def hint_for(entry: Entry, audio_bpm: float, levels: tuple[float, ...] = LEVELS,
             downbeat: float | None = None) -> Hint | None:
    """The entry's meter and the recording's own tempo at the entry's level, when the recording's beat tempo (the
    grid's level without a hint) is within HINT_RANGE of the entry's at one of `levels`. The tempo is the
    recording's, not the entry's: a cover a little slower than the listed recording keeps its own beats. A recording
    at another tempo (a cover, a live take, a wrong match) gives None, and the audio's own grid stays."""
    if not audio_bpm > 0:
        return None
    for f in levels:
        bpm = round(audio_bpm * f, 2)
        if abs(float(np.log(bpm / entry.bpm))) <= float(np.log(HINT_RANGE)) + 1e-9 and 10.0 <= bpm <= 400.0:
            return Hint(meter=entry.meter, bpm=bpm, downbeat=downbeat)
    return None


def audio_bpm(mb: ModelBeats) -> float:
    """The recording's beat tempo: the model grid's level without a hint (`meter.steady_beats`), beats a minute."""
    beats = steady_beats(mb.beat, peak_times(mb.beat))
    return float(60.0 / np.median(np.diff(beats))) if len(beats) >= 2 else 0.0


def video_channel(src: Path) -> str:
    """The channel of a downloaded video (yt-dlp's info file next to the audio, pipeline.fetch_url), or ""."""
    try:
        d = json.loads((src.parent / "source.info.json").read_text())
    except (OSError, ValueError):  # no info file, or not JSON: the title alone
        return ""
    return str(d.get("channel") or d.get("uploader") or "") if isinstance(d, dict) else ""


def lookup_hint(title: str, channel: str, tempo: Callable[[], float], downbeat: float | None = None,
                path: Path = INDEX) -> tuple[Hint | None, dict]:
    """The hint a title gives (None when nothing matches, the guard fails, or the index is missing or unreadable)
    and what to report. `tempo` gives the recording's beat tempo; it is called only for a match (a DBN pass)."""
    if not path.exists():
        return None, {"error": f"no index at {path}: run `python -m p2v.lookup build`"}
    try:
        idx = Index.load(path)
    except (OSError, ValueError, KeyError, TypeError) as err:  # an optional step: a bad index never ends the run
        return None, {"error": f"index {path} unreadable ({err})"}
    e = idx.find(title, channel)
    if e is None:
        return None, {"title": title, "channel": channel, "match": None}
    bpm = tempo()
    h = hint_for(e, bpm, downbeat=downbeat)
    return h, {"title": title, "channel": channel, "match": f"{e.artist} / {e.song}", "meter": e.meter,
               "bpm": e.bpm, "audio_bpm": round(bpm, 1), "used": h is not None}


def main() -> None:
    import argparse
    ap = argparse.ArgumentParser(prog="python -m p2v.lookup", description=__doc__.split("\n\n")[0])
    sub = ap.add_subparsers(dest="cmd", required=True)
    b = sub.add_parser("build", help=f"build the index from the dump ({DUMP}) into {INDEX}")
    b.add_argument("--dump", type=Path, default=DUMP)
    b.add_argument("--out", type=Path, default=INDEX)
    f = sub.add_parser("find", help="the entry a title matches")
    f.add_argument("title")
    f.add_argument("--channel", default="")
    args = ap.parse_args()
    if args.cmd == "build":
        if not args.dump.exists():
            raise SystemExit(f"no HookTheory dump at {args.dump} (DESIGN.md §13: the bank's raw data)")
        n, bad = build(args.dump, args.out)
        print(f"{n} songs -> {args.out}")
        if bad:
            print(f"{len(bad)} malformed sections left out: {', '.join(bad[:10])}{' …' if len(bad) > 10 else ''}")
    else:
        e = Index.load().find(args.title, args.channel)
        print(json.dumps(e.__dict__ if e else None))


if __name__ == "__main__":
    main()
