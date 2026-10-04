#!/usr/bin/env bash
# Sign a release APK with your own key instead of the debug key the build
# uses (which every React Native project shares: fine for your own phone,
# not for an APK other people install).
#
#   scripts/sign-apk.sh [input.apk] [output.apk]
#
# The keystore is $PI_REMOTE_KEYSTORE (default ~/.config/pi-remote/
# pi-remote-release.jks, alias "pi-remote"). Its password comes from
# $PI_REMOTE_KEYSTORE_PASSWORD or, on macOS, from the login keychain item
# "pi-remote-keystore". Neither the keystore nor the password belongs in
# the repository.
set -euo pipefail

cd "$(dirname "$0")/.."
input="${1:-android/app/build/outputs/apk/release/app-release.apk}"
output="${2:-android/app/build/outputs/apk/release/pi-remote-signed.apk}"
keystore="${PI_REMOTE_KEYSTORE:-$HOME/.config/pi-remote/pi-remote-release.jks}"
sdk="${ANDROID_HOME:?Set ANDROID_HOME to the Android SDK}"
tools="$sdk/build-tools/$(ls "$sdk/build-tools" | sort -V | tail -1)"

if [ ! -f "$keystore" ]; then
  echo "No keystore at $keystore" >&2
  exit 1
fi
if [ -z "${PI_REMOTE_KEYSTORE_PASSWORD:-}" ] && command -v security >/dev/null; then
  PI_REMOTE_KEYSTORE_PASSWORD="$(security find-generic-password -a pi-remote -s pi-remote-keystore -w)"
fi
export PI_REMOTE_KEYSTORE_PASSWORD

aligned="$(mktemp -t pi-remote-aligned).apk"
trap 'rm -f "$aligned"' EXIT
"$tools/zipalign" -f -p 4 "$input" "$aligned"
"$tools/apksigner" sign --ks "$keystore" --ks-key-alias pi-remote \
  --ks-pass env:PI_REMOTE_KEYSTORE_PASSWORD --out "$output" "$aligned"
"$tools/apksigner" verify "$output"
echo "Signed: $output"
