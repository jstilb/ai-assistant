"""Sung lead -> notes with SOME, a singing-note model (DESIGN.md §15).

SOME ("Singing-Oriented MIDI Extractor", openvpi, github.com/openvpi/SOME, code MIT; release v1.0.0-baseline,
checkpoint 0119_continuous256_5spk, weights licence not stated): a conformer over an 80-band log-mel that
predicts, per 11.6 ms frame, a MIDI-pitch distribution and a note-boundary probability; the decode turns
those into notes. The network and decode here are our own code, written from the upstream source
(read as text, never run) and checked against it: the checkpoint loads strictly (every key and shape).
The checkpoint is pinned by SHA-256, loaded as tensors only (weights_only) and never fetched at run time
(setup.sh fetches it). The values of the release's config.yaml are constants below.

The decode functions are pure torch (unit-tested); `transcribe` runs the model on a stem.
"""

from __future__ import annotations

import os
from pathlib import Path

import numpy as np

from .arrange import Note

SOME_DIR = Path(os.environ.get("P2V_SOME", Path.home() / ".kaya/piano2video/models/some"))
SOME_CKPT = "model_ckpt_steps_100000_simplified.ckpt"
SOME_SHA256 = "aa710fce920b4dae281b0e6cc2acba83345d82ee62d51f7bafeb29636f28f97c"
SR, HOP, WIN, N_MELS, FMIN, FMAX = 44100, 512, 2048, 80, 40, 8000  # the release's config.yaml
LAYERS, DIM, KERNEL, HEADS, HEAD_DIM, BINS = 8, 512, 31, 8, 64, 128
MIDI_MIN, MIDI_MAX, DEVIATION, REST_THRESHOLD = 0.0, 127.0, 1.0, 0.1
CHUNK_S, SEARCH_S = 30.0, 3.0  # attention is quadratic in length: cut long stems at a quiet point near every 30 s


def some_missing() -> str | None:
    """Why SOME can't run here (None when it can)."""
    p = SOME_DIR / SOME_CKPT
    return None if p.exists() else f"no SOME weights at {p} (DESIGN.md §15)"


# ------------------------------------------------------------------ decode -- #

def decode_gaussian_blurred_probs(probs, vmin: float, vmax: float, deviation: float, threshold: float):
    """Per frame: the pitch = the probability-weighted mean over the bins within 3 deviations of the
    peak bin; a rest where the peak is under `threshold`. probs: (batch, frames, bins)."""
    import torch
    n = int(probs.shape[-1])
    interval = (vmax - vmin) / (n - 1)
    width = int(3 * deviation / interval)
    idx = torch.arange(n)[None, None, :]
    center = probs.argmax(dim=-1, keepdim=True)
    w = probs * ((idx >= (center - width).clamp(min=0)) & (idx < (center + width + 1).clamp(max=n)))
    wsum = w.sum(dim=2)
    values = (w * (idx * interval + vmin)).sum(dim=2) / (wsum + (wsum == 0))
    return values, probs.max(dim=-1)[0] < threshold


def decode_bounds_to_alignment(bounds):
    """Boundary probabilities (batch, frames) -> the note index of every frame (1-based): a new note
    starts where the rounded running sum of the probabilities steps up."""
    import torch
    step = bounds.cumsum(dim=1).round().long()
    inc = torch.diff(step, dim=1, prepend=torch.full((bounds.shape[0], 1), -1, dtype=step.dtype)) > 0
    return inc.long().cumsum(dim=1)


def decode_note_sequence(frame2item, values, masks, threshold: float = 0.5):
    """Frames -> notes: a note's length is its frame count; it is a rest unless >= `threshold` of its
    frames are voiced; its pitch is the mean of its voiced frames within half a semitone of the most
    common rounded pitch among them."""
    import torch
    b, space = frame2item.shape[0], int(frame2item.max()) + 1
    z = frame2item.new_zeros
    item_dur = z(b, space).scatter_add(1, frame2item, torch.ones_like(frame2item))[:, 1:]
    item_masks = z(b, space).scatter_add(1, frame2item, masks.long())[:, 1:] / item_dur >= threshold
    vq = values.round().long().clamp(0, 127)
    hist = z(b, space * 128).scatter_add(1, frame2item * 128 + vq, masks.long()).unflatten(1, [space, 128])[:, 1:, :]
    center = torch.gather(torch.nn.functional.pad(hist.float().argmax(dim=2).to(values.dtype), [1, 0]), 1, frame2item)
    near = masks & (values >= center - 0.5) & (values <= center + 0.5)
    valid = z(b, space).scatter_add(1, frame2item, near.long())[:, 1:]
    item_values = values.new_zeros(b, space).scatter_add(1, frame2item, values * near)[:, 1:] / (valid + (valid == 0))
    return item_values, item_dur, item_masks


def cut_points(wav: np.ndarray, sr: int, chunk_s: float = CHUNK_S, search_s: float = SEARCH_S) -> list[int]:
    """Sample indices to cut a long stem at: the quietest 20 ms within `search_s` of every `chunk_s`."""
    total, target = len(wav), int(chunk_s * sr)
    if total <= int(1.5 * target):
        return []
    win = int(0.02 * sr)
    c = np.concatenate([[0.0], np.cumsum(wav.astype(float) ** 2)])
    i = np.arange(total)
    rms = np.sqrt((c[np.minimum(i + win // 2 + 1, total)] - c[np.maximum(i - win // 2, 0)]) / win)  # running, O(n)
    cuts, pos = [], 0
    while total - pos > int(1.5 * target):
        lo = pos + target - int(search_s * sr)
        pos = lo + int(np.argmin(rms[lo:pos + target + int(search_s * sr)]))
        cuts.append(pos)
    return cuts


# ------------------------------------------------------------------- model -- #

_MODEL: dict = {}


def _model():
    """The network and the mel front end, built once: SHA-256 must be the pinned one, tensors only,
    every key and shape matching (strict)."""
    if _MODEL:
        return _MODEL["net"], _MODEL["mel"]
    import hashlib
    import io
    import torch
    import torch.nn as nn
    import torch.nn.functional as F
    path = SOME_DIR / SOME_CKPT
    data = path.read_bytes()  # one read: the bytes hashed are the bytes loaded
    digest = hashlib.sha256(data).hexdigest()
    if digest != SOME_SHA256:
        raise RuntimeError(f"{path}: SHA-256 {digest} is not the verified one (DESIGN.md §15)")

    class GLU(nn.Module):
        def __init__(self, dim):
            super().__init__()
            self.dim = dim

        def forward(self, x):
            out, gate = x.chunk(2, dim=self.dim)
            return out * gate.sigmoid()

    class Attention(nn.Module):
        def __init__(self):
            super().__init__()
            self.to_q = nn.Linear(DIM, HEADS * HEAD_DIM, bias=False)
            self.to_kv = nn.Linear(DIM, 2 * HEADS * HEAD_DIM, bias=False)
            self.to_out = nn.Sequential(nn.Linear(HEADS * HEAD_DIM, DIM))

        def forward(self, x):
            b, t, _ = x.shape
            q, (k, v) = self.to_q(x), self.to_kv(x).chunk(2, dim=2)
            q, k, v = (z.view(b, t, HEADS, -1).transpose(1, 2) for z in (q, k, v))
            return self.to_out(F.scaled_dot_product_attention(q, k, v).transpose(1, 2).reshape(b, t, -1))

    class Conv(nn.Module):
        def __init__(self):
            super().__init__()
            self.act1, self.act2 = GLU(1), nn.SiLU()
            self.pointwise_conv1 = nn.Conv1d(DIM, 2 * DIM, 1)
            self.depthwise_conv = nn.Conv1d(DIM, DIM, KERNEL, padding=(KERNEL - 1) // 2, groups=DIM)
            self.norm = nn.BatchNorm1d(DIM)
            self.pointwise_conv2 = nn.Conv1d(DIM, DIM, 1)

        def forward(self, x):
            x = self.act1(self.pointwise_conv1(x.transpose(1, 2)))
            return self.pointwise_conv2(self.act2(self.norm(self.depthwise_conv(x)))).transpose(1, 2)

    class FFN(nn.Module):
        def __init__(self):
            super().__init__()
            self.ln1, self.ln2, self.act = nn.Linear(DIM, 4 * DIM), nn.Linear(4 * DIM, DIM), nn.SiLU()

        def forward(self, x):
            return self.ln2(self.act(self.ln1(x)))

    class Block(nn.Module):  # conformer: half FFN, attention, convolution, half FFN
        def __init__(self):
            super().__init__()
            self.ffn1, self.ffn2, self.att, self.conv = FFN(), FFN(), Attention(), Conv()
            self.norm1, self.norm2, self.norm3, self.norm4, self.norm5 = (nn.LayerNorm(DIM) for _ in range(5))

        def forward(self, x):
            x = self.ffn1(self.norm1(x)) * 0.5 + x
            x = self.att(self.norm2(x)) + x
            x = self.conv(self.norm3(x)) + x
            return self.norm5(self.ffn2(self.norm4(x)) * 0.5 + x)

    class Gcf(nn.Module):  # the pitch and boundary branches, each gated into the other
        def __init__(self):
            super().__init__()
            self.att1, self.att2 = Block(), Block()
            self.glu1 = nn.Sequential(nn.Linear(DIM, 2 * DIM), GLU(2))
            self.glu2 = nn.Sequential(nn.Linear(DIM, 2 * DIM), GLU(2))

        def forward(self, midi, bound):
            midi, bound = self.att1(midi), self.att2(bound)
            return midi + self.glu2(bound), bound + self.glu1(midi)

    class Net(nn.Module):
        def __init__(self):
            super().__init__()
            self.inln, self.inln1 = nn.Linear(N_MELS, DIM), nn.Linear(N_MELS, DIM)
            self.outln, self.cutheard = nn.Linear(DIM, BINS), nn.Linear(DIM, 1)
            self.cf_lay = nn.ModuleList(Gcf() for _ in range(LAYERS))
            self.att1, self.att2 = Block(), Block()

        def forward(self, mel):
            x, x1 = self.inln(mel), self.inln1(mel)
            for layer in self.cf_lay:
                x, x1 = layer(x, x1)
            return torch.sigmoid(self.outln(self.att1(x))), torch.sigmoid(self.cutheard(self.att2(x1))).squeeze(-1)

    import librosa
    net = Net()
    sd = torch.load(io.BytesIO(data), map_location="cpu", weights_only=True)["state_dict"]
    del data
    net.load_state_dict({k.removeprefix("model.model."): v for k, v in sd.items()}, strict=True)
    basis = torch.from_numpy(librosa.filters.mel(sr=SR, n_fft=WIN, n_mels=N_MELS, fmin=FMIN, fmax=FMAX, htk=True)).float()
    window = torch.hann_window(WIN)

    def mel(audio):  # (1, samples) -> (1, frames, N_MELS); upstream pads by half a window, no centring
        mag = torch.stft(F.pad(audio, (WIN // 2, (WIN + 1) // 2)), n_fft=WIN, hop_length=HOP, win_length=WIN,
                         window=window, center=False, return_complex=True).abs()
        return torch.log(torch.clamp(basis @ mag, min=1e-5)).transpose(1, 2)

    _MODEL.update(net=net.eval(), mel=mel)
    return _MODEL["net"], _MODEL["mel"]


def transcribe(stem: Path) -> list[Note]:
    """The sung notes of a stem (rests dropped), as lead notes."""
    import librosa
    import torch
    net, mel = _model()
    wav = librosa.load(str(stem), sr=SR, mono=True)[0]
    edges = [0, *cut_points(wav, SR), len(wav)]
    notes: list[Note] = []
    with torch.no_grad():
        for a, b in zip(edges, edges[1:]):
            if b - a < WIN:
                continue
            probs, bounds = net(mel(torch.from_numpy(wav[a:b]).float().unsqueeze(0)))
            midi, rest = decode_gaussian_blurred_probs(probs, MIDI_MIN, MIDI_MAX, DEVIATION, REST_THRESHOLD)
            pitch, dur, voiced = decode_note_sequence(decode_bounds_to_alignment(bounds), midi, ~rest)
            t = a / SR
            for p, d, ok in zip(pitch[0].tolist(), dur[0].tolist(), voiced[0].tolist()):
                if ok and d > 0:
                    n = Note(start=t, end=t + d * HOP / SR, pitch=int(round(p)), velocity=80, role="lead")
                    if t == a / SR and notes and notes[-1].pitch == n.pitch and n.start - notes[-1].end < 1e-6:
                        n = Note(start=notes.pop().start, end=n.end, pitch=n.pitch, velocity=80, role="lead")
                    notes.append(n)  # a note held across a cut stays one note
                t += d * HOP / SR
    return notes
