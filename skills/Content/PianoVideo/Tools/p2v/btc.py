"""Chords heard in the recording: BTC (Park, Choi, Bae & Lee, "A Bi-directional Transformer for Musical
Chord Recognition", ISMIR 2019; github.com/jayg996/BTC-ISMIR19, MIT), its 25-class major/minor model,
ported to plain torch for inference (DESIGN.md §19). The authors' checkpoint is checked once (pickle
globals, weights_only, strict load) and pinned here; it is never fetched at run time (setup.sh).

Input: log |CQT| (144 bins, 24 an octave from C1, hop 2048 at 22.05 kHz) of 10 s chunks, as the authors
compute it (108 frames a chunk), normalised by the checkpoint's mean and std. Output per frame:
probabilities over 2r = root r major, 2r + 1 = root r minor, 24 = no chord.
"""

from __future__ import annotations

import hashlib
import math
import os
from pathlib import Path

import numpy as np

BTC_DIR = Path(os.environ.get("P2V_BTC", Path.home() / ".kaya/piano2video/models/btc"))
BTC_SHA256 = {"btc_model": "71c2c5db17e8c43b8a9a9da5db36ef2d667158c07a214eba16344c154c00bf54"}
SR, HOP, BINS, BPO = 22050, 2048, 144, 24
CHUNK_S, T = 10.0, 108  # the authors' CQT chunk and the model's window (frames)
N_CLASSES = 25


def btc_missing(name: str = "btc_model") -> str | None:
    """Why BTC can't run here (None when it can): no weights, or not the verified ones (checked before
    Demucs and the transcription, not after them)."""
    path = BTC_DIR / f"{name}.pt"
    if not path.exists():
        return f"no weights at {path} (DESIGN.md §19)"
    digest = hashlib.sha256(path.read_bytes()).hexdigest()
    if digest != BTC_SHA256.get(name):
        return f"{path}: SHA-256 {digest} is not the verified one (DESIGN.md §19)"
    return None


def _net():
    """The BTC module tree, named as the checkpoint names its tensors."""
    import torch
    from torch import nn

    class LayerNorm(nn.Module):  # BTC's own: unbiased std, eps added to the std
        def __init__(self, n):
            super().__init__()
            self.gamma, self.beta = nn.Parameter(torch.ones(n)), nn.Parameter(torch.zeros(n))

        def forward(self, x):
            return self.gamma * (x - x.mean(-1, keepdim=True)) / (x.std(-1, keepdim=True) + 1e-6) + self.beta

    class Attention(nn.Module):
        def __init__(self, d, heads):
            super().__init__()
            self.heads = heads
            self.query_linear, self.key_linear, self.value_linear, self.output_linear = (
                nn.Linear(d, d, bias=False) for _ in range(4))

        def forward(self, x, mask):
            b, t, d = x.shape

            def split(y):
                return y.view(b, t, self.heads, d // self.heads).permute(0, 2, 1, 3)
            q = split(self.query_linear(x)) * (d // self.heads) ** -0.5
            w = torch.softmax(q @ split(self.key_linear(x)).transpose(-1, -2) + mask[:t, :t], dim=-1)
            return self.output_linear((w @ split(self.value_linear(x))).permute(0, 2, 1, 3).reshape(b, t, d))

    class Conv(nn.Module):  # kernel 3, one zero frame of padding on each side
        def __init__(self, d):
            super().__init__()
            self.conv = nn.Conv1d(d, d, 3)

        def forward(self, x):
            return self.conv(nn.functional.pad(x.transpose(1, 2), (1, 1))).transpose(1, 2)

    class FeedForward(nn.Module):
        def __init__(self, d):
            super().__init__()
            self.layers = nn.ModuleList([Conv(d), Conv(d)])

        def forward(self, x):
            for layer in self.layers:
                x = torch.relu(layer(x))  # after the last layer too, as BTC does
            return x

    class Block(nn.Module):  # pre-norm attention and feed-forward, each with a residual
        def __init__(self, d, heads):
            super().__init__()
            self.multi_head_attention, self.positionwise_convolution = Attention(d, heads), FeedForward(d)
            self.layer_norm_mha, self.layer_norm_ffn = LayerNorm(d), LayerNorm(d)

        def forward(self, x, mask):
            x = x + self.multi_head_attention(self.layer_norm_mha(x), mask)
            return x + self.positionwise_convolution(self.layer_norm_ffn(x))

    class BiLayer(nn.Module):  # one block sees the past, one the future; both read the same input
        def __init__(self, d, heads):
            super().__init__()
            self.attn_block, self.backward_attn_block = Block(d, heads), Block(d, heads)
            self.linear = nn.Linear(2 * d, d)

        def forward(self, x, past, future):
            return self.linear(torch.cat([self.attn_block(x, past), self.backward_attn_block(x, future)], dim=2))

    class Encoder(nn.Module):
        def __init__(self, feat, d, layers, heads):
            super().__init__()
            self.embedding_proj = nn.Linear(feat, d, bias=False)
            self.self_attn_layers = nn.ModuleList([BiLayer(d, heads) for _ in range(layers)])
            self.layer_norm = LayerNorm(d)

    class Output(nn.Module):
        def __init__(self, d, n):
            super().__init__()
            self.output_projection = nn.Linear(d, n)
            self.lstm = nn.LSTM(d, d // 2, batch_first=True, bidirectional=True)  # in the checkpoint; BTC's forward skips it

    class BTC(nn.Module):
        def __init__(self, feat=BINS, d=128, layers=8, heads=4, n=N_CLASSES, length=T):
            super().__init__()
            self.self_attn_layers, self.output_layer = Encoder(feat, d, layers, heads), Output(d, n)
            k = np.arange(d // 2)
            inv = np.exp(k * -math.log(1.0e4) / (d // 2 - 1))
            st = np.arange(length)[:, None] * inv[None, :]
            self.timing = torch.tensor(np.concatenate([np.sin(st), np.cos(st)], axis=1), dtype=torch.float32)
            self.past = torch.triu(torch.full((length, length), float("-inf")), 1)  # position i sees j <= i
            self.future = self.past.T.contiguous()

        def forward(self, x):  # (b, frames <= T, 144) -> (b, frames, 25) logits
            enc = self.self_attn_layers
            h = enc.embedding_proj(x) + self.timing[: x.shape[1]]
            for layer in enc.self_attn_layers:
                h = layer(h, self.past, self.future)
            return self.output_layer.output_projection(enc.layer_norm(h))

    return BTC


_MODELS: dict = {}


def _model(name: str = "btc_model"):
    """(model, mean, std): SHA-256 must be the pinned one, tensors only (weights_only), every key and
    shape matching (strict). The checkpoint's `std` is a pickled numpy float: the one global outside
    torch's allowlist, decoded here from its bytes (no other code runs)."""
    if name not in _MODELS:
        import torch
        path = BTC_DIR / f"{name}.pt"
        digest = hashlib.sha256(path.read_bytes()).hexdigest()
        if digest != BTC_SHA256.get(name):
            raise RuntimeError(f"{path}: SHA-256 {digest} is not the verified one (DESIGN.md §19)")

        def scalar(dtype, data):
            data = data.encode("latin1") if isinstance(data, str) else data
            if dtype.kind != "f":
                raise ValueError(f"BTC checkpoint: unexpected numpy scalar of type {dtype}")
            return float(np.frombuffer(data, dtype)[0])
        scalar.__module__, scalar.__name__, scalar.__qualname__ = "numpy.core.multiarray", "scalar", "scalar"
        with torch.serialization.safe_globals([scalar, np.dtype, type(np.dtype("float64"))]):
            ck = torch.load(path, map_location="cpu", weights_only=True)
        model = _net()()
        model.load_state_dict(ck["model"], strict=True)
        _MODELS[name] = (model.eval(), float(ck["mean"]), float(ck["std"]))
    return _MODELS[name]


def features(y: np.ndarray, sr: int) -> tuple[np.ndarray, np.ndarray]:
    """(frame times s, log |CQT| (frames, 144)) of a mono signal, in the authors' 10 s chunks."""
    import librosa
    if sr != SR:
        y = librosa.resample(y, orig_sr=sr, target_sr=SR)
    n = int(SR * CHUNK_S)
    feats, times, start = [], [], 0
    while start < len(y):
        part = y[start:start + n] if len(y) > start + n else y[start:]
        if len(part) < HOP and feats:  # a tail under one hop (at most one frame): librosa's CQT refuses a few samples
            break
        c = np.abs(librosa.cqt(part, sr=SR, n_bins=BINS, bins_per_octave=BPO, hop_length=HOP))
        feats.append(np.log(c + 1e-6).T)
        times.append(start / SR + np.arange(c.shape[1]) * HOP / SR)
        start += n
    return np.concatenate(times), np.concatenate(feats)


def probs_of(y: np.ndarray, sr: int, name: str = "btc_model", recenter: bool = False) -> tuple[np.ndarray, np.ndarray]:
    """(frame times s, probabilities (frames, 25)) of a mono signal. `recenter`: shift the song's mean
    log level onto the checkpoint's (a gain correction)."""
    import torch
    t, x = features(y, sr)
    model, mean, std = _model(name)
    x = ((x - x.mean() + mean) if recenter else x)
    x = (x - mean) / std
    pad = (-len(x)) % T
    xs = torch.tensor(np.pad(x, ((0, pad), (0, 0))), dtype=torch.float32).view(-1, T, BINS)
    with torch.no_grad():
        p = torch.softmax(model(xs), dim=-1).reshape(-1, N_CLASSES)[: len(x)].numpy()
    return t, p


def chord_probs(wav: Path, name: str = "btc_model", cache: Path | None = None) -> tuple[np.ndarray, np.ndarray]:
    """(frame times s, probabilities (frames, 25)) of the recording, its level recentred onto the
    checkpoint's (§19: Für Elise, a quiet recording, had every root right and major/minor wrong a
    quarter of the time without it). With `cache` (an .npz in the song's work dir) they are read
    from it when it was made from this recording by these weights (`cache_key`), and written to it
    when not."""
    import soundfile as sf
    key = cache_key(wav, name)
    if cache is not None and cache.exists():
        with np.load(cache, allow_pickle=False) as z:
            if "key" in z and str(z["key"]) == key:
                return z["t"], z["p"]
    y, sr = sf.read(str(wav), dtype="float32")
    t, p = probs_of(y.mean(axis=1) if y.ndim == 2 else y, sr, name, recenter=True)
    if cache is not None:  # through a temporary file of this process: a reader never sees half a cache
        part = cache.with_name(f"{cache.stem}.{os.getpid()}.part.npz")
        np.savez(part, t=t, p=p, key=np.array(key))
        os.replace(part, cache)
    return t, p


def cache_key(wav: Path, name: str = "btc_model") -> str:
    """The recording's SHA-256, the weights' and the front end: another section of the song ingested
    at the same length, or other weights, makes the cache stale."""
    return f"{hashlib.sha256(Path(wav).read_bytes()).hexdigest()}:{BTC_SHA256.get(name)}:recentred-v1"
