# Pi Desktop

An open-source desktop GUI for the [pi](https://pi.dev) coding agent.

Pi Desktop is a shell: the actual agent is `pi` itself, running in the
background as `pi --mode rpc` (JSONL over stdin/stdout). It reuses your
existing pi data in `~/.pi/agent` — settings, models, auth, sessions,
extensions and skills — so chats you start in the app remain fully
compatible with the pi TUI (`pi -r`, `pi --session`) and vice versa.

![Pi Desktop home](docs/screenshots/home-dark.png)

## Features

- **One window, all your pi chats** — sessions are indexed, grouped by
  project and date, searchable (⌘K palette, ⌘⇧F sidebar filter), and
  shared with the pi TUI. Pin chats to the top or archive them.
- **Full chat engine** — streaming replies, thinking blocks, markdown with
  syntax highlighting, tool cards (bash/read/edit/write with diffs, grouped
  when consecutive), retry and compaction notices, stop / steer /
  follow-up controls, find in chat (⌘F), and live elapsed time while pi
  works.
- **Composer** — `@` mentions for project files, image and file
  attachments (drag, paste or ⌘U), a context-usage gauge with session
  stats, and dictation (⌘⇧D; on-device where macOS supports the language).
- **Model & thinking-level picker** — live catalog from pi
  (`get_available_models`), grouped by provider.
- **Slash commands** — pi's skills, prompt templates and extension
  commands, plus app commands like `/new`, `/name`, `/compact`, `/fork`,
  `/tree`, `/export`, `/model`, `/thinking` and `/hotkeys`.
- **Session management** — rename, export to HTML, import a `.jsonl`,
  reveal in Finder, copy path, move to Trash, fork from any user message,
  and clone a chat.
- **Projects and chats** — sessions nest under their project folder;
  project-less chats run in an app-owned scratch workspace.
- **Side panel** — browser tabs, a real terminal (`node-pty` + xterm) and
  a live git diff view for the chat's project. ⌘⌥B toggles the panel, ⌃\`
  a terminal, ⌘L the address bar.
- **Agent browser** — pi can drive the in-app browser itself through an
  extension that ships with the app: `browser_open`, `browser_click`,
  `browser_screenshot` and friends, backed by Chrome DevTools Protocol.
- **Computer use** — with Accessibility and Screen Recording granted, pi
  can operate native macOS apps through `computer_*` tools (accessibility
  tree, screenshots, clicks, typing). A strip above the composer shows what
  it is doing; pause or stop it anytime (⌃⌥⌘P).
- **Notifications** — a native notification and dock badge when a run
  finishes or pi needs your input while you are elsewhere.
- **Runtime flexibility** — uses your installed `pi`, the bundled pinned
  `@earendil-works/pi-coding-agent`, or a custom path you choose in
  Settings. Spare pi processes are kept warm so new chats and reopened
  sessions skip pi's startup.
- **Easy on the battery** — no looping animations: live indicators share
  one 1 Hz clock, streaming renders at ~30 fps (10 fps while you are in
  another app), and an idle window stays near 0% CPU
  (`node scripts/energy.mjs` measures it).
- **Its own look** — content on sheets inset from the window, an IBM Plex
  Mono instrument layer for times, tokens, models and tool calls, square
  status pixels in the pi mark's colors, a pixel sigil per project, and
  agent work shown as a trace on a rail (see `docs/design.md`).
- **Native feel** — dark/light themes following the system, native
  menus and dialogs, keyboard shortcuts (⌘N new chat, ⌘B sidebar,
  ⌘[ / ⌘] history, ⌘, settings; `/hotkeys` lists them all).

![Chat with an expanded tool call](docs/screenshots/chat-toolcard.png)

![Right panel with browser tab](docs/screenshots/panel-browser.png)

## Install

### Download

Grab the latest `.dmg` (or `.zip`) for Apple Silicon (`arm64`) or Intel
(`x64`) from [Releases](https://github.com/azygoss/pi-desktop/releases).
Builds are signed with a Developer ID and notarized by Apple, so they open
like any other app.

Computer use needs **Accessibility** and **Screen Recording** permission
for Pi Desktop (System Settings → Privacy & Security); Settings → Computer
use shows both and opens the right panes. Dictation asks for the microphone
and speech recognition the first time you use it. Upgrading from 0.4.0 or earlier (unsigned builds): grant these
once more, since macOS sees the signed app as new; later updates keep them.

### Build from source

Requirements: macOS 13+, Node.js 22.19+, [pnpm](https://pnpm.io) and the
Xcode Command Line Tools (`swiftc` builds the native helpers).

```bash
git clone https://github.com/azygoss/pi-desktop.git
cd pi-desktop
pnpm install
pnpm dist:mac    # release/*.dmg + *.zip (arm64 + x64)
# or for a quick unpacked build:
pnpm dist:dir    # release/mac-*/Pi Desktop.app
```

Without a signing identity in your keychain the build is unsigned; macOS
then asks you to confirm opening it (right-click → Open), and computer use
cannot inherit the app's permissions.

### Signed, notarized release builds

`pnpm dist:mac` signs with the keychain's **Developer ID Application**
identity (or the one named in `CSC_NAME`) under the hardened runtime,
including the Swift helpers, so macOS attributes their Accessibility,
Screen Recording and microphone use to Pi Desktop. Notarization needs
credentials stored once in the keychain under a notarytool profile:

```bash
xcrun notarytool store-credentials pi-desktop-notary --team-id <TEAM_ID>
```

It asks for your Apple ID and an app-specific password (create one at
account.apple.com → Sign-In and Security → App-Specific Passwords); an App
Store Connect API key works too (`--key`, `--key-id`, `--issuer`). Then:

```bash
pnpm dist:mac:release   # sign + notarize + staple (profile: pi-desktop-notary)
```

## pi runtime and sign-in

- **pi is optional.** When `pi` is not on `PATH`, Pi Desktop falls back to
  a bundled, pinned pi runtime (see Settings → Pi Runtime to force a mode
  or point at a custom executable).
- **Authentication** is handled by pi itself: run `pi` once in a terminal
  and use `/login`, or configure API keys per the
  [pi docs](https://pi.dev/docs/latest). Pi Desktop never touches
  credentials.

## How it works

```
┌──────────────┐  typed IPC (contextBridge)  ┌──────────────┐  JSONL  ┌─────────────────┐
│   Renderer   │◀───────────────────────────▶│     Main     │◀───────▶│  Swift helpers  │
│   React UI   │     window.piDesktop.*      │  Node host   │         │  computer use,  │
└──────────────┘                             └──┬────────▲──┘         │  dictation      │
                                                │        │            └─────────────────┘
                              spawn per chat,   │        │  browser_* / computer_* calls
                              JSONL over stdio  ▼        │  (loopback HTTP, per-chat token)
                                             ┌───────────┴──┐
                                             │ pi --mode rpc│
                                             │ (the agent)  │
                                             └──────────────┘
```

The renderer is fully sandboxed (`contextIsolation`, `sandbox`, strict
CSP) and only talks to a minimal typed preload API. The main process owns
the pi child processes — one per open chat, plus warm spares — and
validates every IPC input. Pi Desktop never re-implements agent logic;
models, commands, sessions, skills and extension UI all come from the real
`pi`.

An extension that ships with the app registers the `browser_*` and
`computer_*` tools in each pi process; they call back into the app over a
loopback HTTP bridge authenticated with a per-chat token. Native work runs
in two small Swift helpers (`resources/cua-helper`,
`resources/dictation-helper`) that speak JSONL over stdio.

## Privacy

- The app **never reads, parses or displays `auth.json`** or any model
  registry/credential file.
- Session `.jsonl` files are read locally, only to index and display your
  chats.
- Apart from pages you open in the browser panel, Pi Desktop itself makes
  one network request: a daily check of this repository's latest GitHub
  release (turn it off in Settings → General). Everything else that leaves
  your machine is what the pi agent sends to its configured model
  providers — including screenshots and accessibility trees when it uses
  computer use.
- Dictation uses Apple's on-device speech recognition when the language
  supports it, otherwise Apple's speech service.
- Deleting a chat moves the session file to the OS Trash, never `rm`.

## Development

```bash
pnpm install
pnpm dev          # run the app in development
pnpm typecheck    # TypeScript checks (main + renderer)
pnpm lint         # ESLint
pnpm test         # Vitest unit tests
pnpm test:e2e     # Electron e2e against a synthetic fake pi
pnpm build        # production build
pnpm build:cua    # compile the Swift computer-use + dictation helpers
pnpm dist:dir     # unpacked .app (quick packaging check)
pnpm dist:mac     # dmg + zip for macOS, signed when a Developer ID is in the keychain
pnpm dist:mac:release  # dist:mac + notarize and staple

node scripts/energy.mjs  # CPU + wakeups per phase: idle, streaming, tool run, panel
node scripts/perf.mjs    # startup, session open, IPC throughput, frame timing
```

Both harnesses run the built app (`pnpm build`) against the synthetic fake
pi and never touch `~/.pi`.

Environment overrides (tests and development):

| Variable | Effect |
|---|---|
| `PI_DESKTOP_PI_COMMAND` | Path to the pi executable (the e2e suite points it at `test/fixtures/fake-pi.mjs`) |
| `PI_DESKTOP_USER_DATA_DIR` | App data directory instead of Electron's userData |
| `PI_CODING_AGENT_DIR` / `PI_CODING_AGENT_SESSION_DIR` | pi's agent / sessions directory |
| `PI_DESKTOP_CUA_HELPER` / `PI_DESKTOP_DICTATION_HELPER` | Custom helper binaries |
| `PI_DESKTOP_PERF=1` | React commit counters read by `scripts/perf.mjs` |

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) and the agent-facing rules in
[AGENTS.md](AGENTS.md). Bug reports are welcome — please don't paste API
keys or session contents into issues.

## Acknowledgements

pi is built by Earendil / Mario Zechner. Pi Desktop is a community
project and is not affiliated with or endorsed by pi. The pi logo used in
the app icon and UI (build/pi-logo.svg, downloaded from
[pi.dev](https://pi.dev/logo.svg)) belongs to Earendil / the pi project and
is used solely to identify pi.

## License

[MIT](LICENSE) — Copyright © 2026 Pi Desktop contributors.
