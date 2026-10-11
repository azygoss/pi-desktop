#!/bin/sh
# Archive Pi Remote for the App Store and export (or upload) it.
#
#   DEVELOPMENT_TEAM=ABCDE12345 ios/scripts/archive.sh            # build/PiRemote.ipa
#   DEVELOPMENT_TEAM=ABCDE12345 ios/scripts/archive.sh --upload   # straight to App Store Connect
#
# Signing is automatic with the team's App Store distribution certificate,
# which must be in this Mac's keychain (Xcode → Settings → Accounts). The team
# id comes from the environment and is never written into the repository.
set -eu

if [ -z "${DEVELOPMENT_TEAM:-}" ]; then
  echo "Set DEVELOPMENT_TEAM to your Apple Developer team id." >&2
  exit 1
fi
destination=export
if [ "${1:-}" = "--upload" ]; then
  destination=upload
fi

cd "$(dirname "$0")/.."
out=build
mkdir -p "$out"
xcodegen generate

xcodebuild archive \
  -project PiRemote.xcodeproj \
  -scheme PiRemote \
  -configuration Release \
  -destination 'generic/platform=iOS' \
  -archivePath "$out/PiRemote.xcarchive" \
  -allowProvisioningUpdates \
  DEVELOPMENT_TEAM="$DEVELOPMENT_TEAM" \
  CODE_SIGN_STYLE=Automatic

options="$out/ExportOptions.plist"
cat > "$options" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>method</key><string>app-store-connect</string>
  <key>destination</key><string>$destination</string>
  <key>teamID</key><string>$DEVELOPMENT_TEAM</string>
  <key>signingStyle</key><string>automatic</string>
  <key>uploadSymbols</key><true/>
  <key>manageAppVersionAndBuildNumber</key><false/>
</dict>
</plist>
PLIST

xcodebuild -exportArchive \
  -archivePath "$out/PiRemote.xcarchive" \
  -exportPath "$out" \
  -exportOptionsPlist "$options" \
  -allowProvisioningUpdates

if [ "$destination" = upload ]; then
  echo "Uploaded. The build shows in App Store Connect → TestFlight after processing."
else
  echo "Exported $out/PiRemote.ipa. Upload it with Transporter, or run again with --upload."
fi
