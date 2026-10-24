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
# Demucs htdemucs_6s weights download on first run into ~/.cache/torch.
echo "ok — try: $HERE/piano2video <song.mp3> --all-variants"
