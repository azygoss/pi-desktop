# Pi Desktop design language

Pi Desktop's look comes from the pi mark itself: squares on a grid in three
colors. Everything below follows from that, so new UI should too.

## Principles

- **Color is signal, never decoration.** The mark's three colors each carry
  one meaning, and nothing else uses them:
  - blue (`--accent`): pi is working / the active thing (focus, links, the
    current selection);
  - amber (`--warning`): pi needs you (a confirm, a question, context
    running out);
  - coral (`--danger`): an error, a failed tool, stop.

  Everything else is ink on graphite (dark) or ink on paper (light).
- **Pixels, not dots.** Status marks are small squares (`border-radius`
  ≤ 2px): hollow blue while something runs (it blinks on the shared 1 Hz
  clock, never a CSS animation), solid amber when pi needs you, solid coral
  on error, solid blue for an unread reply.
- **Two voices of type.** Prose, titles and controls use the system face
  (SF Pro on macOS). Every *readout* uses IBM Plex Mono: times, token
  counts, model names, tool names and arguments, project names in chips,
  keyboard hints and code. Section labels ("Projects", "Recent", a
  palette group) are plain sentence case in the system face, 12px medium,
  muted (`.section-label`) — no all-caps, no letter-spacing.
- **One selection mark.** The current row (a chat in the sidebar, a
  palette row, a settings page) is shown by its ground (`--active` /
  `--surface-hover`) alone — no accent stripe on the edge. Blue is kept for
  signal.
- **Sheets on chrome.** The window is chrome (`--chrome`, with macOS
  vibrancy); the main pane and the right panel are sheets (`--bg`) inset by
  8px with a 10px radius and a hairline border. The sidebar sits on the
  chrome directly.
- **Agent work is a soft list of steps.** Every thinking block and tool
  call is a borderless row with an icon tile that tells its kind (terminal,
  read, edit, write, browser, reasoning…) and, by its color, its state —
  blue while running (blinking on the 1 Hz clock), coral when it failed,
  quiet ink when done. Hover lifts a row onto a faint ground; an open step
  sits on that ground with its detail inside, and its chevron turns. The
  header is one line (the command for shell steps, tool + path otherwise)
  with a `+a −r` stat for edits and the duration (hidden under 0.1s).
  Consecutive tools fold into a group row with a tool count and diff
  stats. An open edit or write shows the change itself; its "ok" result
  line is left out.
  Stats count changed lines only: context an edit's old and new text share
  at either end is not a change (`changedLines` in `lib/tool-summary.ts`).
  - *Shell steps* expand into one terminal surface: the output, then a
    footer with the exit status (`exit 0` green, `exit N` / `timed out` /
    `aborted` coral) and a copy button. pi's trailing "Command exited with
    code N" line becomes that footer instead of output (`lib/trace.ts`).
    A `!command` the user runs from the composer is the same card, opened.
  - *Edits* are one unified diff: removed and added lines interleaved, with
    three lines of context and a `⋯` for skipped runs (`lib/line-diff.ts`).
    A write shows its content as added lines.
  - *Work groups*: agents often answer in many small messages that are only
    thinking and a tool call. Two or more in a row fold into one row —
    "Worked for 2m 15s · Ran 3 commands, edited a file · 6 tools · 6
    thoughts" — open while the turn is live, folded once it settles (the
    user's toggle wins; find-in-chat opens them all).
- **Popovers open toward the room.** A composer popover (model, project,
  `+`, context, `/` and `@` lists) opens upward from the docked chat
  composer and downward from the home composer, which sits mid-screen, and
  its height fits that side (`lib/popover-placement.ts`). Long lists scroll
  inside the popover; its search and footer actions stay put.
- **Waiting is visible.** Messages sent mid-run sit in a strip above the
  composer ("Steer" lands after the current tool call, "Next" when the run
  ends) until pi delivers them; they join the transcript only then.
- **A pull request is a readout.** `#42` in the header with one word for
  its checks: "running" beside the hollow blue pixel, "N failing" in coral
  with a coral edge, "passing" in green. No badge when there is no PR.
- **Review happens on the diff.** A `+` appears in the gutter of the line
  under the pointer; a comment sits under its line in an amber-edged note
  (amber: it is waiting on you to send it). The toolbar's amber-edged
  "N comments" button moves them into the composer as one prompt. A remark
  pi left in a review pass has a blue edge and a small `pi` label: blue is
  pi's, amber is yours. Comments belong to the project, not the screen:
  the computer keeps them and every window and paired phone shows the same.
- **Prompts are prompts.** A user message is a prompt block with a `›` in
  the gutter, not a chat bubble; its actions float in the corner on hover.

## Identity glyphs (`src/renderer/src/components/Pixels.tsx`)

- `ProjectSigil` — a deterministic, mirrored 3×3 pixel pattern in one of six
  hues (`--sigil-1…6`), derived from the project path
  (`src/renderer/src/lib/sigil.ts`). It replaces the folder icon wherever a
  project appears. `ScratchSigil` (a dashed square) marks chats without a
  project.
- `ContextCells` — context usage as nine cells filling bottom-up.
- `LevelMeter` — thinking effort as five rising bars (the composer's model
  chip).
- `EffortSlider` (`components/EffortSlider.tsx`) — the model popover's
  effort control: a slim track with one stop per level the model offers, a
  white rounded-pixel thumb with a grip, and notched labels beneath.
  Dragging follows the pointer and settles on the nearest stop (the name and
  a one-line hint of what the level buys follow along); clicking the track
  or a label jumps; ←/→, Home and End step. At the model's top level the
  track is *charged*: the fill runs hot (`--accent-hot`), fill and thumb
  glow, the grip turns blue, a soft halo pools in the panel, a ⚡ sits by
  the name, and one light sweep crosses the fill on arrival — one-shot,
  never a loop.

## Tokens (`src/renderer/src/styles/tokens.css`)

Surfaces step up from `--chrome` → `--bg` (sheet) → `--surface` (cards,
composer) → `--raised` (popovers). Borders: `--border` for hairlines inside a
sheet, `--border-strong` for control outlines. Text: `--text`, `--text-2`,
`--muted`; `--faint` is decorative only (empty cells, rules), never text.
Every text color meets WCAG AA (4.5:1) on the surfaces it is used on, in
both themes.

## Motion

One-shot only: popovers rise 3px over 130ms, rows fade in once, the right
panel slides, the effort track sweeps once when it charges. No loops, no shimmer, no spinners (see "Performance and
energy" in `AGENTS.md`), and everything respects `prefers-reduced-motion`.
