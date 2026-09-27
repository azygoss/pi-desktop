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
- `src/renderer/` - React UI
- `src/shared/` - types and pure helpers shared by main/preload/renderer

## Commands

```bash
pnpm install
pnpm dev          # run the app in development
pnpm typecheck    # TypeScript checks (main + renderer)
pnpm lint         # ESLint
pnpm test         # Vitest
pnpm build        # production build
```

Run `pnpm typecheck && pnpm lint && pnpm test` before every commit.

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
- Destructive actions (deleting sessions) go to the OS trash, never `rm`, and require
  user confirmation.

## Pi RPC notes

- Protocol docs ship with pi: `docs/rpc.md` in the `@earendil-works/pi-coding-agent` package.
- Framing is strict JSONL: split on `\n` only, strip trailing `\r`. **Do not use Node
  `readline`**; it also splits on U+2028/U+2029 which are valid inside JSON strings.
- One `pi --mode rpc` process per open chat, spawned with `cwd` set to the project folder.
- Correlate requests and responses via the `id` field. Events have no `id`.
- `message_update` carries deltas only; assemble partial messages by `contentIndex` and treat
  `message_end.message` as authoritative.
- Sessions live in `~/.pi/agent/sessions/--<cwd with / replaced by ->--/<timestamp>_<uuid>.jsonl`.
  The first line is the session header; `session_info` entries carry the display name.
