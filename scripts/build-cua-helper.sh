#!/bin/bash
# Build the computer-use helper as a universal binary.
# Produces resources/cua-helper/bin/pi-desktop-cua (arm64 + x86_64).
# No-op on non-macOS so cross-platform builds keep working.
set -euo pipefail

cd "$(dirname "$0")/.."

if [ "$(uname -s)" != "Darwin" ]; then
  echo "build-cua-helper: not macOS, skipping"
  exit 0
fi

SRC_DIR="resources/cua-helper/Sources"
OUT_DIR="resources/cua-helper/bin"
BIN="$OUT_DIR/pi-desktop-cua"

mkdir -p "$OUT_DIR"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

SWIFTC_FLAGS=(
  -O
  -framework AppKit
  -framework ApplicationServices
  -framework CoreGraphics
  -module-name cua_helper
)

for arch in arm64 x86_64; do
  echo "build-cua-helper: compiling $arch"
  swiftc "${SWIFTC_FLAGS[@]}" \
    -target "${arch}-apple-macos13" \
    -o "$TMP/pi-desktop-cua-$arch" \
    "$SRC_DIR"/*.swift
done

lipo -create "$TMP/pi-desktop-cua-arm64" "$TMP/pi-desktop-cua-x86_64" -o "$BIN"
chmod +x "$BIN"
echo "build-cua-helper: $BIN"
lipo -info "$BIN"
