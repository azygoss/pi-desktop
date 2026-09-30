# pi-desktop-dictation

Native macOS speech-dictation helper for Pi Desktop. Records from the
microphone and streams transcripts into the composer (⌘⇧D) using
`SFSpeechRecognizer` — on-device when the language supports it, otherwise
Apple's speech service.

## Build

```bash
pnpm build:cua   # builds this and the computer-use helper
# or: bash scripts/build-dictation-helper.sh
```

Produces `bin/pi-desktop-dictation` as a universal binary (arm64 + x86_64,
macOS 13+), shipped via `extraResources` in `electron-builder.yml`. Like the
computer-use helper it must be signed with the app's identity so the
Microphone and Speech Recognition grants (prompted with the usage strings in
the app's Info.plist) belong to Pi Desktop; the hardened runtime needs the
`com.apple.security.device.audio-input` entitlement from
`build/entitlements.mac.plist`.

## Protocol

JSONL over stdin/stdout; exits on stdin EOF.

Commands:

- `{"id":N,"cmd":"permissions","args":{}}` → `{microphone, speech}` (each
  `authorized`, `denied`, `restricted` or `notDetermined`)
- `{"id":N,"cmd":"locales","args":{}}` → `{locales: [...]}` (BCP-47)
- `{"id":N,"cmd":"start","args":{"locale":"en-US","autoStop":true}}` → `ok`,
  then events; `autoStop` ends the recording after a stretch of silence
- `{"id":N,"cmd":"stop","args":{}}` → final transcript, then `stopped`
- `{"id":N,"cmd":"cancel","args":{}}` → `cancelled` (transcript discarded)

Events (no id):

- `{"event":"partial","text":"..."}` — interim transcript
- `{"event":"final","text":"..."}` — committed transcript
- `{"event":"level","rms":0.0-1.0}` — input level, ~15/s while recording
- `{"event":"error","message":"..."}` — fatal for this recording
- `{"event":"stopped"}` / `{"event":"cancelled"}`
