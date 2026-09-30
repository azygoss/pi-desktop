# Contributing to Pi Desktop

Thanks for your interest! Pi Desktop is a small project with a few hard
rules — please read [AGENTS.md](AGENTS.md) before sending a PR; it covers
the architecture (the app is a shell around `pi --mode rpc`, never a
reimplementation), privacy constraints, and coding conventions.

## Getting set up

You need macOS 13+, Node.js 22.19+, [pnpm](https://pnpm.io) and the Xcode
Command Line Tools (the computer-use and dictation helpers are Swift).

```bash
git clone https://github.com/azygoss/pi-desktop.git
cd pi-desktop
pnpm install
pnpm build:cua    # compile the Swift helpers (once, and after changing them)
pnpm dev
```

## Before opening a PR

```bash
pnpm typecheck && pnpm lint && pnpm test && pnpm build
```

- Keep commits focused: one logical change per commit, short imperative
  subject.
- Write everything in English: code, comments, docs, commit messages.
- Add unit tests for new logic; the e2e suite (`pnpm test:e2e`) runs the
  built app against a synthetic fake pi — extend it for user-visible
  features.
- Anything that renders while the app is idle or streaming must stay cheap:
  no looping CSS animations (use the shared live clock), and compare
  `node scripts/energy.mjs` before and after. AGENTS.md explains why.
- **Never commit real pi data**: session files, settings, credentials,
  personal paths or usernames. Fixtures must be synthetic, and the secret
  check `git diff --cached | grep -nE "(sk-|api[_-]?key|token|secret|/Users/|/home/)"`
  should come back clean (test placeholders are fine).

## Reporting bugs

Use the bug report template under Issues. Never paste API keys, auth
tokens or session contents — logs are fine as long as you redact them.
