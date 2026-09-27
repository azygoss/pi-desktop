# Pi Desktop

An open-source desktop GUI for the [pi](https://pi.dev) coding agent harness.
Pi Desktop is a shell: the actual agent is `pi` itself, running in the
background as `pi --mode rpc` (JSONL over stdio). It reuses your existing pi
data (`~/.pi/agent`): settings, models, sessions, extensions and skills, so
sessions stay fully compatible with the pi TUI.

## Requirements

- macOS (first-class target; code is kept cross-platform)
- Node.js 22.19+ and [pnpm](https://pnpm.io) for development
- An installed `pi` CLI is optional. When `pi` is not on `PATH`, Pi Desktop
  falls back to a pinned `@earendil-works/pi-coding-agent` runtime bundled
  with the app.

## Development

```bash
pnpm install
pnpm dev          # run the app in development
pnpm typecheck    # TypeScript checks (main + renderer)
pnpm lint         # ESLint
pnpm test         # Vitest
pnpm build        # production build
```

## Privacy

Pi Desktop never reads `auth.json`, model registries or any credentials —
authentication is entirely pi's job. Session files are only read locally to
index and display them; nothing leaves your machine except what the pi agent
itself sends to its configured model providers.

## License

[MIT](LICENSE)
