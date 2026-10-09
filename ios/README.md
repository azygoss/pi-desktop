# Pi Remote for iOS

The iPhone and iPad companion to [Pi Desktop](../README.md): control the app
on your computer from your phone. Start and follow chats, steer or stop a
run, answer pi's questions, review, commit and push changes, manage
automations. It does what the Android app in [`mobile/`](../mobile/README.md)
does, written natively in SwiftUI.

Pi Remote is a remote control, not a second agent. pi keeps running on the
computer; the phone talks to Pi Desktop directly over your network (the same
Wi-Fi, or a VPN such as Tailscale). There is no account and no relay server,
and everything between the two is end-to-end encrypted
(see [docs/remote.md](../docs/remote.md)).

## Pairing

1. On the computer: Pi Desktop → Settings → Remote control → **Show pairing code**.
2. On the phone: open Pi Remote and scan the code. Scanning it with the
   iPhone's Camera app, or opening the pairing link, opens Pi Remote and
   pairs as well; the link can also be pasted in.

On a server without the desktop app, run [pi-remote](../docs/pi-remote.md)
and scan the code `pi-remote pair` prints. Pi Remote keeps up to eight
computers: pair more from Settings → Computers or the computer menu at the
top of the home screen, and switch there.

iOS asks once for **Local Network** access the first time the app reaches
the computer; without it the link cannot open.

## What it does

The same as the Android app: chats (search, pin, archive, rename, trash),
a chat with streaming replies, thinking, tool steps, folded work, stop /
steer / queue, `@` file mentions, `/` commands, `!shell` runs, model and
thinking effort, context usage, fork / retry / restore files, the session
tree, compaction, side chat, copy as Markdown and share as a web page;
images pi took or showed (full screen, zoom, share, save); photo, camera,
clipboard and file attachments; the project file viewer; the working-tree
diff with shared line comments, a review pass by pi (with the chat's model
or another one), posting comments to the pull request, discard, commit and
push; the pull request and its checks; computer use on/off with pause and
stop; projects, worktrees and branches; automations; usage.

Long-press (touch and hold) does what it does on Android: on a chat in the
list, on a prompt in a chat, on a line of the diff. Lists also take swipe
actions.

## Notifications

With "When pi finishes or needs you" on, the phone tells you when a chat is
done or pi asks something. There is no push server, so this works within
what iOS allows an app in the background:

- When you leave the app while pi works, it keeps its link to the computer
  for the time iOS grants (usually about half a minute) and posts the
  notification itself if a run ends or pi asks something in that time.
- After that, iOS wakes the app now and then for a background refresh (when
  it decides to: typically every 15 minutes or more, less often on low
  battery). The app reconnects briefly and announces the chats that
  finished or wait on you since.

A run that ends while the app is suspended is therefore announced late, not
at once. Background App Refresh must be on for Pi Remote (iOS Settings →
General → Background App Refresh).

## Build

Requirements: macOS with Xcode 16 or newer (iOS 17 SDK) and
[XcodeGen](https://github.com/yonaskolb/XcodeGen) (`brew install xcodegen`).

```bash
cd ios
xcodegen generate                  # writes PiRemote.xcodeproj from project.yml
open PiRemote.xcodeproj            # pick your team under Signing, then Run
```

Command line, without signing:

```bash
xcodebuild -project PiRemote.xcodeproj -scheme PiRemote \
  -destination 'generic/platform=iOS Simulator' CODE_SIGNING_ALLOWED=NO build
swift test --package-path Packages/PiRemoteKit
```

`PiRemote.xcodeproj` and `PiRemote/Info.plist` are generated from
`project.yml` and not committed. To install on a device, set your own team
and, if needed, your own bundle identifier in Xcode; never commit
certificates, provisioning profiles or signing settings tied to an account.

## Layout

- `Packages/PiRemoteKit/` — the platform-neutral half, a Swift package with
  its own tests (`swift test`):
  - `Crypto/` — the link's encryption: X25519 (CryptoKit), SHA-512 key
    derivation and XSalsa20-Poly1305 boxes byte-compatible with TweetNaCl,
    which the desktop uses (the tests check them against TweetNaCl output).
  - `Protocol/` — pairing links, frames, raw-deflate frames from the desktop.
  - `Models/`, `Chat/`, `Lib/` — Swift ports of the desktop's
    platform-neutral modules (`src/shared`, `src/renderer/src/lib`) and the
    Android app's transcript and markdown code, so a chat renders the same
    on every screen.
- `PiRemote/Remote/` — the WebSocket client (`RemoteClient`), Keychain
  storage of this phone's key pair and paired computers, and the typed calls
  on the desktop's IPC channels (`API`).
- `PiRemote/State/` — the connection (pairing, dialing, switching
  computers), the lists, the open chats, notifications and background
  refresh, navigation and incoming links.
- `PiRemote/Chat/`, `PiRemote/Screens/`, `PiRemote/UI/` — the SwiftUI views.

When the desktop's shared modules or the Android app change behavior, port
the change to `PiRemoteKit` too; the tests there pin the shared rules.
