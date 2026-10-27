"""Synthesia-style falling-notes video: PIL frames piped to ffmpeg, plus a
lightweight additive piano synth so the video's audio *is* the transcription."""

from __future__ import annotations

import bisect
import subprocess
from dataclasses import dataclass
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFont

from .arrange import PIANO_HI, PIANO_LO, Note
from .meter import Grid

BLACK_PCS = {1, 3, 6, 8, 10}

# Synthesia-ish palette: right hand green, left hand blue (black-key notes darker)
COLORS = {
    ("R", False): (122, 206, 92), ("R", True): (74, 150, 52),
    ("L", False): (92, 160, 230), ("L", True): (50, 108, 184),
}
BG = (24, 24, 28)
GRID = (40, 40, 46)
BAR_LINE, BEAT_LINE = (105, 105, 118), (44, 44, 52)
GLOW_S = 0.2  # a struck key flashes this long (6 frames at 30 fps), so a repeated note shows twice


def is_black(pitch: int) -> bool:
    return pitch % 12 in BLACK_PCS


@dataclass(frozen=True)
class KeyGeom:
    x0: float
    x1: float
    black: bool


def keyboard_geometry(width: int, lo: int = PIANO_LO, hi: int = PIANO_HI) -> dict[int, KeyGeom]:
    """Pixel span of every key. White keys tile the width; black keys are 60%
    width centered on the boundary between their neighbours."""
    whites = [p for p in range(lo, hi + 1) if not is_black(p)]
    ww = width / len(whites)
    geom: dict[int, KeyGeom] = {}
    xi = 0
    for p in range(lo, hi + 1):
        if not is_black(p):
            geom[p] = KeyGeom(xi * ww, (xi + 1) * ww, False)
            xi += 1
    bw = ww * 0.6
    for p in range(lo, hi + 1):
        if is_black(p):
            edge = geom[p - 1].x1  # boundary after the white key below
            geom[p] = KeyGeom(edge - bw / 2, edge + bw / 2, True)
    return geom


def visible_range(notes: list[Note]) -> tuple[int, int]:
    """Zoom the keyboard to the arrangement's span (whole octaves, >= 4 octaves) for bigger notes."""
    if not notes:
        return PIANO_LO, PIANO_HI
    lo = max(PIANO_LO, (min(n.pitch for n in notes) // 12) * 12)
    hi = min(PIANO_HI, (max(n.pitch for n in notes) // 12) * 12 + 12)
    while hi - lo < 48:
        lo, hi = max(PIANO_LO, lo - 6), min(PIANO_HI, hi + 6)
        if lo == PIANO_LO and hi == PIANO_HI:
            break
    if is_black(lo):
        lo -= 1
    if is_black(hi):
        hi += 1
    return lo, hi


def grid_lines(grid: Grid, duration: float) -> tuple[np.ndarray, np.ndarray]:
    """Times and grid positions (quarters) of every counted beat in [0, duration]."""
    q0, q1 = float(grid.sec_to_q(0.0)), float(grid.sec_to_q(duration))
    q = np.arange(np.ceil(q0 / grid.beat_q - 1e-9), np.floor(q1 / grid.beat_q + 1e-9) + 1) * grid.beat_q
    return grid.q_to_sec(q), q


def is_downbeat(q: float, bar_q: float) -> bool:
    return abs(q / bar_q - round(q / bar_q)) < 1e-6


def score_bar(q: float, grid: Grid, lead_in: float) -> int | None:
    """The PDF's bar number at grid position q: the score starts `lead_in` quarters into the grid."""
    n = int(np.floor((q - lead_in) / grid.bar_q + 1e-6)) + 1
    return n if n >= 1 else None


def strike_glow(age: float) -> float:
    """Flash strength `age` seconds after a key is struck: 1 at the onset, fading to 0 at GLOW_S."""
    return 1.0 - age / GLOW_S if 0.0 <= age < GLOW_S else 0.0


def note_name(pitch: int, sharps: int) -> str:
    from .notation import spell
    return spell(pitch, sharps).name.replace("-", "b")


def _lighten(col: tuple[int, int, int], f: float) -> tuple[int, int, int]:
    r, g, b = col
    return (int(r + (255 - r) * f), int(g + (255 - g) * f), int(b + (255 - b) * f))


class Renderer:
    def __init__(self, notes: list[Note], width=1280, height=720, fps=30,
                 lookahead=2.5, title: str = "", full_keyboard=False, grid: Grid | None = None,
                 lead_in: float = 0.0, keys: list[tuple[float, int]] | None = None, note_names=False):
        self.notes = sorted(notes, key=lambda n: n.start)
        self.starts = [n.start for n in self.notes]
        self.max_dur = max((n.dur for n in self.notes), default=0.0)
        self.W, self.H, self.fps = width, height, fps
        self.lo, self.hi = (PIANO_LO, PIANO_HI) if full_keyboard else visible_range(self.notes)
        self.geom = keyboard_geometry(width, self.lo, self.hi)
        self.kb_h = int(height * 0.17)
        self.kb_top = height - self.kb_h
        self.pps = self.kb_top / lookahead
        self.lookahead = lookahead
        self.title = title
        try:
            self.font = ImageFont.truetype("/System/Library/Fonts/Helvetica.ttc", 20)
            self.big = ImageFont.truetype("/System/Library/Fonts/Helvetica.ttc", 30, index=1)
            self.small = ImageFont.truetype("/System/Library/Fonts/Helvetica.ttc", 13, index=1)
        except OSError:
            self.font = self.big = self.small = ImageFont.load_default()
        self.grid, self.lead_in = grid, lead_in
        self.line_t, self.line_q = grid_lines(grid, self.notes[-1].end + lookahead if self.notes else 0.0) \
            if grid else (np.zeros(0), np.zeros(0))
        self.labels: list[str] = []
        if note_names:
            from .notation import sharps_at
            plan = keys or [(0.0, 0)]
            self.labels = [note_name(n.pitch, sharps_at(plan, float(grid.sec_to_q(n.start)) if grid else 0.0))
                           for n in self.notes]
            self.label_w = {s: self.small.getlength(s) for s in set(self.labels)}
        self.base = self._static_layer()

    def _static_layer(self) -> Image.Image:
        img = Image.new("RGB", (self.W, self.H), BG)
        d = ImageDraw.Draw(img)
        for p, g in self.geom.items():  # octave guide lines at every C
            if p % 12 == 0:
                d.line([(g.x0, 0), (g.x0, self.kb_top)], fill=GRID, width=1)
        d.rectangle([0, self.kb_top - 4, self.W, self.kb_top], fill=(150, 30, 40))
        return img

    def visible_lines(self, t: float) -> list[tuple[float, int | None]]:
        """(y, bar) of each beat line on screen at time t; bar = the PDF bar number on a downbeat
        (0 before the score's bar 1), None on other beats."""
        i0 = bisect.bisect_left(self.line_t, t)
        i1 = bisect.bisect_right(self.line_t, t + self.lookahead)
        out: list[tuple[float, int | None]] = []
        for lt, q in zip(self.line_t[i0:i1], self.line_q[i0:i1]):
            bar = (score_bar(q, self.grid, self.lead_in) or 0) if is_downbeat(q, self.grid.bar_q) else None
            out.append((self.kb_top - (lt - t) * self.pps, bar))
        return out

    def bar_at(self, t: float) -> int | None:
        return score_bar(float(self.grid.sec_to_q(t)), self.grid, self.lead_in) if self.grid else None

    def glows(self, t: float) -> dict[int, float]:
        """Flash strength per key struck in the last GLOW_S seconds (the latest strike wins)."""
        out: dict[int, float] = {}
        for n in self.notes[bisect.bisect_right(self.starts, t - GLOW_S):bisect.bisect_right(self.starts, t)]:
            out[n.pitch] = strike_glow(t - n.start)
        return {p: g for p, g in out.items() if g > 0}

    def _draw_keys(self, d: ImageDraw.ImageDraw, active: dict[int, str], glow: dict[int, float]):
        top, bot = self.kb_top, self.H
        for p, g in self.geom.items():
            if g.black:
                continue
            fill = _lighten(COLORS[(active[p], False)], 0.6 * glow.get(p, 0.0)) if p in active else (245, 245, 245)
            d.rectangle([g.x0, top, g.x1 - 1, bot], fill=fill, outline=(60, 60, 60))
        bh = top + int(self.kb_h * 0.62)
        for p, g in self.geom.items():
            if not g.black:
                continue
            fill = _lighten(COLORS[(active[p], True)], 0.6 * glow.get(p, 0.0)) if p in active else (20, 20, 20)
            d.rectangle([g.x0, top, g.x1, bh], fill=fill, outline=(0, 0, 0))
        for p, f in glow.items():  # flash over the red line, above the struck key
            if p in self.geom and p in active:
                g = self.geom[p]
                d.rectangle([g.x0 - 3 * f, top - 4 - 10 * f, g.x1 + 3 * f, top - 1],
                            fill=_lighten(COLORS[(active[p], False)], 0.3 + 0.5 * f))

    def frame(self, t: float) -> Image.Image:
        img = self.base.copy()
        d = ImageDraw.Draw(img)
        lo_i = bisect.bisect_left(self.starts, t - self.max_dur)
        hi_i = bisect.bisect_right(self.starts, t + self.lookahead)
        active: dict[int, str] = {}
        if self.grid:
            for y, bar in self.visible_lines(t):
                d.line([(0, y), (self.W, y)], fill=BEAT_LINE if bar is None else BAR_LINE,
                       width=1 if bar is None else 2)
                if bar:
                    d.text((6, y - 17), str(bar), fill=(150, 150, 165), font=self.small)
        # white-key notes first so black-key notes draw on top
        visible = [i for i in range(lo_i, hi_i) if self.notes[i].end > t and self.notes[i].pitch in self.geom]
        visible.sort(key=lambda i: is_black(self.notes[i].pitch))
        for i in visible:
            n = self.notes[i]
            g = self.geom[n.pitch]
            y_bot = self.kb_top - (n.start - t) * self.pps
            y_top = self.kb_top - (n.end - t) * self.pps
            if n.start <= t:
                active[n.pitch] = n.hand or "R"
            y_bot = min(y_bot, self.kb_top - 1)
            if y_bot - y_top < 2:
                y_top = y_bot - 2
            col = COLORS[(n.hand or "R", g.black)]
            d.rounded_rectangle([g.x0 + 1, y_top, g.x1 - 1, y_bot], radius=4, fill=col,
                                outline=tuple(max(0, c - 60) for c in col))
            if self.labels and y_bot - y_top >= 17 and g.x1 - g.x0 >= self.label_w[self.labels[i]] + 4:
                d.text(((g.x0 + g.x1 - self.label_w[self.labels[i]]) / 2, y_bot - 16), self.labels[i],
                       fill=(16, 16, 20), font=self.small)
        self._draw_keys(d, active, self.glows(t))
        if self.title:
            d.text((12, 10), self.title, fill=(200, 200, 200), font=self.font)
        bar = self.bar_at(t)
        if bar:
            d.text((self.W - 12, 8), f"Bar {bar}", fill=(230, 230, 230), font=self.big, anchor="ra")
        return img

    def render(self, out: Path, duration: float, audio: Path | None):
        n_frames = int(np.ceil(duration * self.fps))
        cmd = ["ffmpeg", "-v", "error", "-y",
               "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", f"{self.W}x{self.H}",
               "-r", str(self.fps), "-i", "-"]
        if audio:
            cmd += ["-i", str(audio), "-c:a", "aac", "-b:a", "192k", "-shortest"]
        cmd += ["-c:v", "libx264", "-preset", "medium", "-crf", "20",
                "-pix_fmt", "yuv420p", "-movflags", "+faststart", str(out)]
        proc = subprocess.Popen(cmd, stdin=subprocess.PIPE)
        try:
            for i in range(n_frames):
                proc.stdin.write(self.frame(i / self.fps).tobytes())
        finally:
            proc.stdin.close()
            rc = proc.wait()
        if rc != 0:
            raise RuntimeError(f"ffmpeg exited {rc}")
        return out


def synthesize(notes: list[Note], duration: float, sr: int = 44100) -> np.ndarray:
    """Cheap piano-like additive synth (decaying harmonics). Not pretty, but it
    lets you *hear* the transcription — no soundfont/FluidSynth dependency."""
    y = np.zeros(int((duration + 3) * sr), dtype=np.float32)
    harmonics = [(1, 1.0), (2, 0.45), (3, 0.22), (4, 0.12), (5, 0.06)]
    for n in notes:
        f0 = 440.0 * 2 ** ((n.pitch - 69) / 12)
        sounding = max(n.end, n.sound_end or n.end) - n.start  # pedal keeps it ringing past the key
        length = min(sounding, 6.0) + 0.25  # short release tail
        t = np.arange(int(length * sr)) / sr
        decay = np.exp(-t * (1.2 + f0 / 600))
        tone = sum(a * np.sin(2 * np.pi * f0 * h * t) * decay ** h for h, a in harmonics if f0 * h < sr / 2)
        env = np.minimum(1.0, t / 0.005)
        rel = np.clip((length - t) / 0.25, 0, 1)
        sig = (tone * env * rel * (n.velocity / 127) * 0.2).astype(np.float32)
        i0 = int(n.start * sr)
        seg = y[i0:i0 + len(sig)]
        seg += sig[: len(seg)]
    peak = float(np.abs(y).max()) or 1.0
    return (y / peak * 0.89)[: int(duration * sr)]
