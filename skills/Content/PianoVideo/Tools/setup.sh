#!/usr/bin/env bash
# One-time setup for piano2video: Python 3.11 venv + pinned deps + piano model.
# Re-runnable; nothing here touches the Kaya repo.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VENV="${P2V_VENV:-$HOME/.kaya/venvs/piano2video}"
MODEL_DIR="${P2V_MODEL_DIR:-$HOME/.kaya/piano2video/models}"
CKPT="$MODEL_DIR/note_F1=0.9677_pedal_F1=0.9186.pth"

command -v ffmpeg >/dev/null || { echo "need ffmpeg (brew install ffmpeg)" >&2; exit 1; }
command -v uv >/dev/null || { echo "need uv (brew install uv)" >&2; exit 1; }
[[ -e /opt/homebrew/lib/libcairo.2.dylib || -e /usr/local/lib/libcairo.2.dylib ]] \
  || { echo "need cairo for PDF engraving (brew install cairo)" >&2; exit 1; }

[[ -x "$VENV/bin/python" ]] || uv venv --python 3.11 "$VENV"
VIRTUAL_ENV="$VENV" uv pip install -r "$HERE/requirements.txt"

mkdir -p "$MODEL_DIR"
if [[ ! -s "$CKPT" ]]; then
  echo "downloading ByteDance piano transcription checkpoint (~165 MB, zenodo is slow)…"
  curl -fSL -o "$CKPT.part" \
    "https://zenodo.org/record/4034264/files/CRNN_note_F1%3D0.9677_pedal_F1%3D0.9186.pth?download=1"
  mv "$CKPT.part" "$CKPT"
fi
# Beat This! weights for the default score grid (DESIGN.md §12): the authors' share, kept only when the
# SHA-256 is the verified one (meter.py checks it again at every load).
BT_DIR="${P2V_BEAT_THIS:-$HOME/.kaya/piano2video/models/beat_this}"
BT_SHA=8c328b45f59d8dd3dff219253ff6a8d6482be57d0133a29140e2febbf8eb8331
mkdir -p "$BT_DIR"
if [[ ! -s "$BT_DIR/final0.ckpt" ]] || [[ "$(shasum -a 256 "$BT_DIR/final0.ckpt" | cut -d' ' -f1)" != "$BT_SHA" ]]; then
  echo "downloading Beat This! weights final0.ckpt (~81 MB)…"
  # 7ik4RrBKTS273gp is the id of the authors' public share link (no password), not a secret
  curl -fSL -u "7ik4RrBKTS273gp:" -o "$BT_DIR/final0.ckpt.part" "https://cloud.cp.jku.at/public.php/webdav/final0.ckpt"
  got="$(shasum -a 256 "$BT_DIR/final0.ckpt.part" | cut -d' ' -f1)"
  if [[ "$got" != "$BT_SHA" ]]; then
    rm -f "$BT_DIR/final0.ckpt.part"
    echo "final0.ckpt: SHA-256 $got is not the verified $BT_SHA (DESIGN.md §12); not installed" >&2
    exit 1
  fi
  mv "$BT_DIR/final0.ckpt.part" "$BT_DIR/final0.ckpt"
fi
# SOME singing-note weights for the sung melody (DESIGN.md §15): the openvpi release zip, kept only when the
# zip and the checkpoint inside it have the verified SHA-256 (some.py checks the checkpoint again at every load).
SOME_DIR="${P2V_SOME:-$HOME/.kaya/piano2video/models/some}"
SOME_ZIP_SHA=bc91b1afc3ae350bd70d36ec418c471baa65c94fbeeaa09d6e178cbcfca886ec
SOME_SHA=aa710fce920b4dae281b0e6cc2acba83345d82ee62d51f7bafeb29636f28f97c
SOME_CKPT="$SOME_DIR/model_ckpt_steps_100000_simplified.ckpt"
mkdir -p "$SOME_DIR"
if [[ ! -s "$SOME_CKPT" ]] || [[ "$(shasum -a 256 "$SOME_CKPT" | cut -d' ' -f1)" != "$SOME_SHA" ]]; then
  echo "downloading SOME weights 0119_continuous128_5spk.zip (~435 MB)…"
  curl -fSL -o "$SOME_DIR/some.zip.part" \
    "https://github.com/openvpi/SOME/releases/download/v1.0.0-baseline/0119_continuous128_5spk.zip"
  got="$(shasum -a 256 "$SOME_DIR/some.zip.part" | cut -d' ' -f1)"
  if [[ "$got" != "$SOME_ZIP_SHA" ]]; then
    rm -f "$SOME_DIR/some.zip.part"
    echo "SOME zip: SHA-256 $got is not the verified $SOME_ZIP_SHA (DESIGN.md §15); not installed" >&2
    exit 1
  fi
  unzip -p "$SOME_DIR/some.zip.part" "0119_continuous256_5spk/model_ckpt_steps_100000_simplified.ckpt" > "$SOME_CKPT.part"
  rm -f "$SOME_DIR/some.zip.part"
  got="$(shasum -a 256 "$SOME_CKPT.part" | cut -d' ' -f1)"
  if [[ "$got" != "$SOME_SHA" ]]; then
    rm -f "$SOME_CKPT.part"
    echo "SOME checkpoint: SHA-256 $got is not the verified $SOME_SHA (DESIGN.md §15); not installed" >&2
    exit 1
  fi
  mv "$SOME_CKPT.part" "$SOME_CKPT"
fi
# BTC chord weights for the lead sheet's chords (DESIGN.md §19): the authors' 25-class checkpoint at a pinned
# commit, kept only when the SHA-256 is the verified one (btc.py checks it again at every load).
BTC_DIR="${P2V_BTC:-$HOME/.kaya/piano2video/models/btc}"
BTC_SHA=71c2c5db17e8c43b8a9a9da5db36ef2d667158c07a214eba16344c154c00bf54
mkdir -p "$BTC_DIR"
if [[ ! -s "$BTC_DIR/btc_model.pt" ]] || [[ "$(shasum -a 256 "$BTC_DIR/btc_model.pt" | cut -d' ' -f1)" != "$BTC_SHA" ]]; then
  echo "downloading BTC chord weights btc_model.pt (~12 MB)…"
  curl -fSL -o "$BTC_DIR/btc_model.pt.part" \
    "https://raw.githubusercontent.com/jayg996/BTC-ISMIR19/f4edfb4d427179726b8b50dca71247dc34da5030/test/btc_model.pt"
  got="$(shasum -a 256 "$BTC_DIR/btc_model.pt.part" | cut -d' ' -f1)"
  if [[ "$got" != "$BTC_SHA" ]]; then
    rm -f "$BTC_DIR/btc_model.pt.part"
    echo "btc_model.pt: SHA-256 $got is not the verified $BTC_SHA (DESIGN.md §19); not installed" >&2
    exit 1
  fi
  mv "$BTC_DIR/btc_model.pt.part" "$BTC_DIR/btc_model.pt"
fi
# Demucs htdemucs_6s weights download on first run into ~/.cache/torch.
echo "ok — try: $HERE/piano2video <song.mp3> --all-variants"
