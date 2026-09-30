# pi-desktop-cua

Native macOS computer-use helper for Pi Desktop. Drives accessibility-tree
inspection, screenshots and input synthesis for `pi`'s `computer_*` tools.

## Build

```bash
pnpm build:cua   # both helpers; or: bash scripts/build-cua-helper.sh
```

Produces `bin/pi-desktop-cua` as a universal binary (arm64 + x86_64,
macOS 13+). No-op on non-Darwin. The `bin/` directory is gitignored and the
binary is shipped via `extraResources` in `electron-builder.yml`.

## Permissions and signing

The helper needs Accessibility (AX tree, input) and Screen Recording
(screenshots). The grants belong to Pi Desktop: the app spawns the helper,
and macOS attributes it to the app only when the helper carries the app's
signing identity — electron-builder signs it with the same Developer ID
during `pnpm dist:mac`. An ad-hoc signed build cannot inherit the grants,
because macOS checks an executable inside the bundle against the app's
designated requirement (the Electron binary's cdhash when ad-hoc). The
`permissions` command reports what the helper process itself sees.

AX calls use a 2s messaging timeout; a tree walk stops at the first
timeout and reports the app as not responding instead of stalling.

## Protocol

JSONL over stdin/stdout — one JSON object per line, nothing else on stdout
(diagnostics go to stderr). Exit on stdin EOF.

Request:  `{"id": 1, "cmd": "app_state", "args": {...}}`
Reply:    `{"id": 1, "ok": true, "result": {...}}` or
          `{"id": 1, "ok": false, "error": "..."}`

Requests run sequentially on a dedicated serial queue. Do not move command
handling onto the main dispatch queue: a synchronously-executing block there
starves NSWorkspace's running-app notifications, so freshly launched apps
never appear in `runningApplications`.

## Commands

- `permissions {prompt?}` → `{accessibility, screenRecording}`
- `list_apps {excludeBundleId|excludeBundleIds}` → running apps first
  (with window titles), then installed apps
- `app_state {app, full?, screenshot?, query?}` → front-window AX tree
  (diff by default), window frame, optional JPEG screenshot (captured on a
  background queue while the tree walk runs)
- `click {app, element?|x+y, button?, count?}` — prefers `AXPress` for
  left single-clicks on elements that support it
- `set_value {app, element, value}` — checkbox/radio accept "true"/"false"
- `type_text {app, text, submit?}` — unicode keyboard events
- `press_key {app, key}` — chords like `cmd+shift+s`, named keys, single chars
- `scroll {app, element?, direction, pages?}`
- `drag {app, fromElement|fromX+fromY, toElement|toX+toY}`
- `secondary_action {app, element, action}` — short names map back to `AX*`
- `activate {app}` / `launch {app}`
- `screenshot {app?|screen?}` — window or main display, JPEG ≤1568px on the
  long edge and ≤1.15 megapixels (what vision models keep after their own
  downscaling)
- `--self-test` — print permission state and app count, exit 0

Element ids come from the latest `app_state` snapshot of that app; they are
per-process and are re-derived every snapshot. Actions end with a settle wait
so a following `app_state` is instant.
