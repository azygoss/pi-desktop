# AGENTS.md

Instructions for AI agents and human contributors working on **Pi Desktop**, an
open-source Electron desktop app for the [pi](https://pi.dev) coding agent harness.

## Project summary

- Pi Desktop is a GUI shell. **The real agent is pi itself**, running in the background as
  `pi --mode rpc` (JSONL over stdin/stdout). The app never re-implements agent logic.
- The app reuses the user's existing pi installation data in `~/.pi/agent`
  (or `$PI_CODING_AGENT_DIR`): settings, models, auth, packages, extensions, skills,
  prompt templates and sessions. Sessions created in the app must stay fully compatible
  with the pi TUI (`pi -r`, `pi --session`) and vice versa.
- Pi runtime resolution: prefer the user's installed `pi` binary; fall back to the pinned
  `@earendil-works/pi-coding-agent` dependency bundled with the app.
- Target platform: macOS first. Keep code cross-platform (no hard-coded `/` separators,
  no macOS-only APIs without a guard).

## Stack

- Electron + electron-vite, React, TypeScript (strict), Tailwind CSS v4, Zustand
- Vitest for tests, ESLint + Prettier for lint/format, pnpm as package manager
- electron-builder for packaging

## Layout

- `src/main/` - Electron main process (pi process management, session index, IPC handlers)
- `src/preload/` - the only bridge between main and renderer (`contextBridge`, typed API)
- `src/renderer/` - React UI; styles live in `src/renderer/src/styles/` (`tokens.css` holds
  the palette and fonts), and the visual language is described in `docs/design.md`
- `src/shared/` - types and pure helpers shared by main/preload/renderer
- `resources/pi-extension/` - pi extension loaded into every chat's pi process; registers
  the `browser_*` and `computer_*` tools, which call back into the app over the loopback
  bridge (`src/main/bridge/`) with a per-chat token
- `resources/cua-helper/`, `resources/dictation-helper/` - Swift helpers (computer use,
  speech dictation), JSONL over stdio; build with `pnpm build:cua`
- `src/main/automations/` - scheduled prompts: a JSON store in userData and one timer aimed
  at the next due run; the renderer starts each run as a background chat
- `scripts/` - helper build scripts and the `energy.mjs` / `perf.mjs` harnesses
- `test/e2e/` - Playwright-driven Electron tests; `test/fixtures/fake-pi.mjs` is a scripted,
  synthetic stand-in for `pi --mode rpc`; `fake-gh.mjs` stands in for the GitHub CLI

## Commands

```bash
pnpm install
pnpm dev          # run the app in development
pnpm typecheck    # TypeScript checks (main + renderer)
pnpm lint         # ESLint
pnpm test         # Vitest
pnpm test:e2e     # builds, then runs the Electron e2e suite against the fake pi
pnpm build        # production build
pnpm build:cua    # compile the Swift helpers (needs the Xcode Command Line Tools)
pnpm dist:dir     # unpacked .app
node scripts/energy.mjs   # CPU + wakeups per phase (run `pnpm build` first)
```

Run `pnpm typecheck && pnpm lint && pnpm test` before every commit. Run `pnpm test:e2e`
for user-visible changes, and `node scripts/energy.mjs` before and after changes to
anything that renders while idle or streaming.

## Language and commits

- This is a public open-source project. **Everything committed must be in English**:
  code, comments, identifiers, UI strings, docs, commit messages, PR titles/descriptions,
  issue text.
- Commit messages: short imperative subject (under ~72 chars), optional body explaining
  *why*. Example: `Add strict JSONL framing to RPC client`.
- Keep commits focused; one logical change per commit.

## Privacy and security (mandatory)

Never commit, push, log or send to the renderer anything private or sensitive:

- No credentials of any kind: API keys, OAuth tokens, `auth.json`, `models.json`,
  `models-store.json`, `.env*` files, `.npmrc` tokens, certificates, signing identities.
- No real pi user data: session `.jsonl` files, session contents, exported HTML sessions,
  `settings.json` from a real machine, MCP configs.
- No personal information: real names, emails (other than the public git author),
  usernames, home directory paths such as `/Users/<name>` or `/home/<name>`, hostnames,
  internal URLs. Use `~`, `os.homedir()` or placeholders like `/Users/example`.
- Test fixtures must be fully synthetic.
- Screenshots in docs must not show real conversations, paths, keys or account names.
- Before every commit, review `git diff --cached` for secrets and personal paths.
  A quick check: `git diff --cached | grep -nE "(sk-|api[_-]?key|token|secret|/Users/|/home/)"`.

Runtime rules for the app itself:

- The app must **never read, parse, copy or display `auth.json`**. Authentication is pi's job.
- Never log full RPC payloads in production builds (they may contain user code and secrets).
- Renderer is untrusted: `contextIsolation: true`, `sandbox: true`, `nodeIntegration: false`,
  strict CSP, and a minimal typed preload API. Validate every IPC input in main.
- Destructive actions (deleting sessions, discarding an untracked file from the diff
  panel) go to the OS trash, never `rm`, and require user confirmation.
- Git actions the renderer can trigger (`src/main/git/`) take a validated cwd and
  repo-relative paths only, and run `git` through `execFile` — never a shell. The file
  viewer reads only inside the chat's project folder and never inside the pi agent dir.

## Pi RPC notes

- Protocol docs ship with pi: `docs/rpc.md` in the `@earendil-works/pi-coding-agent` package.
- Framing is strict JSONL: split on `\n` only, strip trailing `\r`. **Do not use Node
  `readline`**; it also splits on U+2028/U+2029 which are valid inside JSON strings.
- One `pi --mode rpc` process per open chat, spawned with `cwd` set to the project folder.
  Warm spares (one for project-less chats, up to two for projects, expiring after 5 minutes)
  absorb pi's startup:
  new drafts adopt a spare as is, and reopened sessions adopt the spare for their cwd and
  load through `switch_session`. Idle chats are evicted and revived on demand.
- Correlate requests and responses via the `id` field. Events have no `id`.
- `message_update` carries deltas only; assemble partial messages by `contentIndex` and treat
  `message_end.message` as authoritative.
- Sessions live in `~/.pi/agent/sessions/--<cwd with / replaced by ->--/<timestamp>_<uuid>.jsonl`.
  The first line is the session header; `session_info` entries carry the display name.

## Performance and energy

Pi Desktop sits open all day and agent runs last minutes; every frame it paints costs battery.

- **No looping animations.** On macOS each repaint keeps Chromium producing frames for
  ~0.3s, so a 7px CSS pulse, a spinner or a text shimmer costs 10-30% CPU for as long as it
  runs. Live indicators tick on the shared 1Hz clock (`src/renderer/src/lib/live-clock.ts`,
  `LiveDot` / `Elapsed`); prefer showing elapsed time over motion. One-shot transitions on
  user interaction are fine.
- Keep `caret-animation: manual` (set on `html`): Chromium's blinking caret is a 60fps
  compositor animation that otherwise keeps the GPU awake whenever the composer is focused.
- Streaming updates are batched: main coalesces deltas into one IPC payload per 32ms and the
  chat store commits at most ~30 times a second (10 while the window is unfocused, 4 while
  hidden). Don't add per-delta work to the render path;
  memoize per message/block and keep expensive formatting (e.g. `Intl` formatters) at
  module scope.
- Verify with `node scripts/energy.mjs` (per-phase CPU and wakeups, window visible).

## macOS signing and native helpers

- `pnpm dist:mac` signs with the keychain's Developer ID Application identity (or `CSC_NAME`)
  under the hardened runtime (`build/entitlements.mac.plist`); `pnpm dist:mac:release`
  also notarizes through the `pi-desktop-notary` notarytool profile. Never commit
  certificates, profiles or notarization credentials.
- The Swift helpers must be signed with the app's identity. macOS checks an executable
  inside the bundle against the app's designated requirement, so with ad-hoc signing the
  helpers cannot use Pi Desktop's Accessibility / Screen Recording / microphone grants.
- The helpers run requests on a serial queue off the main thread (see
  `resources/cua-helper/README.md`); keep AX work bounded by the messaging timeout.
