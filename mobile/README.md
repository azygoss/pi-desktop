# Pi Remote

The Android companion to [Pi Desktop](../README.md): control the app on your
computer from your phone. Start and follow chats, steer or stop a run, answer
pi's questions, review, commit and push changes, manage automations.

Pi Remote is a remote control, not a second agent. pi keeps running on the
computer; the phone talks to Pi Desktop directly over your network (the same
Wi-Fi, or a VPN such as Tailscale). There is no account and no relay server,
and everything between the two is end-to-end encrypted
(see [docs/remote.md](../docs/remote.md)).

## Install

Download `Pi-Remote-<version>.apk` from
[Releases](https://github.com/azygoss/pi-desktop/releases) and open it on the
phone (Android asks once to allow installing from that source). It needs Pi
Desktop (or pi-remote) 0.11.0 or newer on the computer; file uploads, chat
export, image previews, paging and the computer-use switch need 0.12.0.

## Pairing

1. On the computer: Pi Desktop → Settings → Remote control → **Show pairing code**.
2. On the phone: open Pi Remote and scan the code. Scanning it with the
   phone's own camera, or opening the pairing link, opens the app and pairs
   as well; the link can also be pasted in.

On a server without the desktop app, run [pi-remote](../docs/pi-remote.md)
and scan the code `pi-remote pair` prints.

The code works once, for five minutes. Pi Remote keeps several computers
(your Mac, a VPS, a home server): pair more from Settings → Computers or by
tapping the computer's name at the top, and switch there. Remove a phone on
the computer (Settings → Remote control, or `pi-remote revoke`), or forget a
computer in the app's settings.

## What it does

- **Chats** — every session on the computer, with what is active on top;
  search titles and the text of conversations; pin, archive, rename, delete.
- **A chat** — streaming replies, thinking, tool steps (shell output, edits as
  diffs, live elapsed time), folded work groups, stop / steer / queue, `@`
  file mentions, `/` commands, `!shell` runs, model and thinking effort,
  context usage, fork / retry / restore files to before a prompt, the
  session tree, compaction, side chat, copy as Markdown, share as a web page.
  Older messages load as you scroll up.
- **Images** — screenshots pi takes and images it shows you (its `show_image`
  tool) appear in the chat even with the steps folded; open them full screen,
  at actual size, and share or save them.
- **Attachments** — photos from the library, the camera or the clipboard, and
  any file up to 20 MB (stored on the computer for pi to read).
- **Files** — open files of the project from replies or steps, with syntax
  highlighting; images show as images. `localhost` links open at the
  computer's address.
- **Changes** — the working-tree diff with line comments, a review pass by pi,
  discard, commit and push; the branch's pull request with its checks, also
  in the chat's header, which says when they finish.
- **Computer use** — turn it on or off for the Mac from the composer's menu;
  pause or stop it while it runs.
- **Projects** — start a chat in a project, in a fresh git worktree, in any
  folder on the computer, or without a project.
- **Automations** — create, edit, enable and run scheduled prompts.
- **Usage** — tokens and cost over the last 30 days.

A chat open on both the computer and the phone is the same chat: both see the
same stream, and a question answered on one closes on the other.

Not on the phone: the interactive terminal and browser panels, dictation
(use the keyboard's own) and the app's other settings.

## Notifications

With "When pi finishes or needs you" on (Settings, or the prompt on the chat
list), the phone tells you when a chat is done or pi asks something, also
with the app in the background. There is no push server: while pi is working,
a foreground service keeps the app's link to the computer open (Android shows
it as an ongoing "pi is working" notification) and the app posts the
notification itself. When nothing is running the service stops.

Limits that follow from that: a run that starts while the app is already in
the background is not covered (Android only lets the service start with the
app on screen), nothing arrives if the app was swiped away or the phone lost
the computer for more than a few minutes, and a phone left untouched long
enough for Android's Doze to cut its network will hear late.

## Development

Requirements: Node.js 22+, JDK 17 and the Android SDK (`ANDROID_HOME`).

```bash
cd mobile
npm install
npm run typecheck
npm run android        # debug build on a connected device or emulator
npm run apk            # release APK: android/app/build/outputs/apk/release/
```

`npm run apk` signs with the debug keystore, which is fine for installing on
your own phone. An APK other people install must be signed with your own key:
`scripts/sign-apk.sh` re-signs the build with the keystore in
`$PI_REMOTE_KEYSTORE` (see the script). Keep the keystore and its password
out of the repository, and back them up: updates must be signed with the
same key.

The Android project under `android/` is generated by `expo prebuild` from
`app.json` and is not committed.

## Layout

- `src/desktop/` — re-exports of the desktop's platform-neutral modules
  (`../src/shared`, `../src/renderer/src/lib`): the phone renders a chat with
  the same reducers, summaries and parsers as the window. Metro watches those
  folders (`metro.config.js`).
- `src/remote/` — the encrypted connection (`client.ts`), pairing storage in
  the Android Keystore (`storage.ts`) and the typed calls (`api.ts`).
- `src/state/` — Zustand stores: connection and reconnection, the session
  lists, and the chats (events apply to mutable drafts and reach React at
  most 20 times a second).
- `src/chat/` — transcript rows, tool steps, markdown, composer, sheets.
- `modules/pi-remote-background/` — a small native module (Kotlin): the
  keep-alive foreground service and the notifications; `src/lib/background.ts`
  decides when it runs.
- `src/screens/`, `src/ui/`, `src/theme/` — screens, primitives and tokens.

The look follows [docs/design.md](../docs/design.md): color is signal (blue =
pi is working, amber = pi needs you, coral = error), readouts are IBM Plex
Mono, status marks are square pixels, and nothing animates in a loop — live
indicators tick on one shared 1 Hz clock (`src/lib/live-clock.ts`).
