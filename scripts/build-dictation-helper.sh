#!/bin/bash
# Build the dictation helper as a universal binary.
# Produces resources/dictation-helper/bin/pi-desktop-dictation (arm64 + x86_64).
# No-op on non-macOS so cross-platform builds keep working.
set -euo pipefail

cd "$(dirname "$0")/.."

if [ "$(uname -s)" != "Darwin" ]; then
  echo "build-dictation-helper: not macOS, skipping"
  exit 0
fi

SRC_DIR="resources/dictation-helper/Sources"
OUT_DIR="resources/dictation-helper/bin"
BIN="$OUT_DIR/pi-desktop-dictation"

mkdir -p "$OUT_DIR"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

SWIFTC_FLAGS=(
  -O
  -framework AVFoundation
  -framework Speech
  -framework Foundation
  -module-name dictation_helper
)

for arch in arm64 x86_64; do
  echo "build-dictation-helper: compiling $arch"
  swiftc "${SWIFTC_FLAGS[@]}" \
    -target "${arch}-apple-macos13" \
    -o "$TMP/pi-desktop-dictation-$arch" \
    "$SRC_DIR"/*.swift
done

lipo -create "$TMP/pi-desktop-dictation-arm64" "$TMP/pi-desktop-dictation-x86_64" -o "$BIN"
chmod +x "$BIN"
echo "build-dictation-helper: $BIN"
lipo -info "$BIN"
