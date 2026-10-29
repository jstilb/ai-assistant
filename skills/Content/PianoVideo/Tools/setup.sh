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
# Beat This! weights for the default score grid (DESIGN.md §12): final0 and its 8 fold models, whose mean is
# the default (§43). The authors' share; each file kept only when its SHA-256 is the verified one (the same
# values as meter.BEAT_THIS_SHA256; meter.py checks them again at every load).
BT_DIR="${P2V_BEAT_THIS:-$HOME/.kaya/piano2video/models/beat_this}"
mkdir -p "$BT_DIR"
for pair in final0:8c328b45f59d8dd3dff219253ff6a8d6482be57d0133a29140e2febbf8eb8331 \
            fold0:f5c6b6726179e20710e4be6a0fba4018f6cbc89f32f9c0dfd15072cb047578ad \
            fold1:617b5b9641cefa585c975c97ac4e7fb9c00165ec9827303e8a88fdbd5ff3b71f \
            fold2:cece4323bccc50738e415c91c204c93ca7021e42ab3a24da6a84dccaa7cc0d4c \
            fold3:849de186a21ed1cd41d0ac78dc412c61f5283dcafffa9dd32f390674c50792cf \
            fold4:0a17b1691edbae73a7fac35f6d26d5f8f9aa483b0e3aff5d891c74140f836c52 \
            fold5:ea651e7a0d1a1b243ad3ff268969c8c3d4b7e6d06b1bfb451b020d40526275c2 \
            fold6:07b32a484f2c99b676e7061650ea2cd2f9f889d87ea6c712782c5855742070b1 \
            fold7:f26bed3c18c8f338a39b5a9524ffea7dce654e847ccf3d006e147fa7bf71d43f; do
  BT_NAME="${pair%%:*}" BT_SHA="${pair#*:}"
  if [[ ! -s "$BT_DIR/$BT_NAME.ckpt" ]] || [[ "$(shasum -a 256 "$BT_DIR/$BT_NAME.ckpt" | cut -d' ' -f1)" != "$BT_SHA" ]]; then
    echo "downloading Beat This! weights $BT_NAME.ckpt (~81 MB)…"
    # 7ik4RrBKTS273gp is the id of the authors' public share link (no password), not a secret
    if ! curl -fSL -u "7ik4RrBKTS273gp:" -o "$BT_DIR/$BT_NAME.ckpt.part" "https://cloud.cp.jku.at/public.php/webdav/$BT_NAME.ckpt"; then
      rm -f "$BT_DIR/$BT_NAME.ckpt.part"
      echo "$BT_NAME.ckpt: download failed; run setup.sh again (or use --beat-weights final0)" >&2
      exit 1
    fi
    got="$(shasum -a 256 "$BT_DIR/$BT_NAME.ckpt.part" | cut -d' ' -f1)"
    if [[ "$got" != "$BT_SHA" ]]; then
      rm -f "$BT_DIR/$BT_NAME.ckpt.part"
      echo "$BT_NAME.ckpt: SHA-256 $got is not the verified $BT_SHA (DESIGN.md §12); not installed" >&2
      exit 1
    fi
    mv "$BT_DIR/$BT_NAME.ckpt.part" "$BT_DIR/$BT_NAME.ckpt"
  fi
done
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
