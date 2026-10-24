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

BLACK_PCS = {1, 3, 6, 8, 10}

# Synthesia-ish palette: right hand green, left hand blue (black-key notes darker)
COLORS = {
    ("R", False): (122, 206, 92), ("R", True): (74, 150, 52),
    ("L", False): (92, 160, 230), ("L", True): (50, 108, 184),
}
BG = (24, 24, 28)
GRID = (40, 40, 46)


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


class Renderer:
    def __init__(self, notes: list[Note], width=1280, height=720, fps=30,
                 lookahead=2.5, title: str = "", full_keyboard=False):
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
        except OSError:
            self.font = ImageFont.load_default()
        self.base = self._static_layer()

    def _static_layer(self) -> Image.Image:
        img = Image.new("RGB", (self.W, self.H), BG)
        d = ImageDraw.Draw(img)
        for p, g in self.geom.items():  # octave guide lines at every C
            if p % 12 == 0:
                d.line([(g.x0, 0), (g.x0, self.kb_top)], fill=GRID, width=1)
        d.rectangle([0, self.kb_top - 4, self.W, self.kb_top], fill=(150, 30, 40))
        return img

    def _draw_keys(self, d: ImageDraw.ImageDraw, active: dict[int, str]):
        top, bot = self.kb_top, self.H
        for p, g in self.geom.items():
            if g.black:
                continue
            fill = COLORS[(active[p], False)] if p in active else (245, 245, 245)
            d.rectangle([g.x0, top, g.x1 - 1, bot], fill=fill, outline=(60, 60, 60))
        bh = top + int(self.kb_h * 0.62)
        for p, g in self.geom.items():
            if not g.black:
                continue
            fill = COLORS[(active[p], True)] if p in active else (20, 20, 20)
            d.rectangle([g.x0, top, g.x1, bh], fill=fill, outline=(0, 0, 0))

    def frame(self, t: float) -> Image.Image:
        img = self.base.copy()
        d = ImageDraw.Draw(img)
        lo_i = bisect.bisect_left(self.starts, t - self.max_dur)
        hi_i = bisect.bisect_right(self.starts, t + self.lookahead)
        active: dict[int, str] = {}
        # white-key notes first so black-key notes draw on top
        visible = [n for n in self.notes[lo_i:hi_i] if n.end > t and n.pitch in self.geom]
        visible.sort(key=lambda n: is_black(n.pitch))
        for n in visible:
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
        self._draw_keys(d, active)
        if self.title:
            d.text((12, 10), self.title, fill=(200, 200, 200), font=self.font)
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
        length = min(n.dur, 6.0) + 0.25  # short release tail
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
