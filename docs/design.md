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
  keyboard hints, section labels and code. Section labels are mono,
  uppercase, tracked (`.label-mono`).
- **Sheets on chrome.** The window is chrome (`--chrome`, with macOS
  vibrancy); the main pane and the right panel are sheets (`--bg`) inset by
  8px with a 10px radius and a hairline border. The sidebar sits on the
  chrome directly.
- **Agent work is a trace.** Thinking and tool calls render as rows with a
  status pixel; expanding a step drops its detail down a hairline rail.
  Consecutive tools fold into one group row with a count and diff stats.
  Finished steps show their duration (hidden under 0.1s).
  - *Shell steps* read as a prompt line (`$ command`); expanded, they are one
    terminal surface: the output, then a footer with the exit status
    (`exit 0` green, `exit N` / `timed out` / `aborted` coral) and a copy
    button. pi's trailing "Command exited with code N" line becomes that
    footer instead of output (`lib/trace.ts`).
  - *Thinking*, collapsed, hangs a two-line italic excerpt off the rail
    under its label: the tail while pi thinks, the opening (heading plus
    first sentence) once done. Expanded, the reasoning renders as markdown.
  - *Edit and write steps*, collapsed, show a peek of up to four changed
    lines (`−` coral, `+` green) plus "+N more lines", and a `+a −r` stat
    on the row. Stats count changed lines only: context that an edit's old
    and new text share at either end is not a change
    (`changedLines` in `lib/tool-summary.ts`).
  - *Work groups*: agents often answer in many small messages that are only
    thinking and a tool call. Two or more in a row fold into one row —
    "Worked for 2m 15s · Ran 3 commands, edited a file · 6 tools · 6
    thoughts" — open while the turn is live, folded once it settles (the
    user's toggle wins; find-in-chat opens them all). Trace rows stack 4px
    apart; prose keeps its own margins.
- **Prompts are prompts.** A user message is a prompt block with a `›` in
  the gutter, not a chat bubble; its actions float in the corner on hover.

## Identity glyphs (`src/renderer/src/components/Pixels.tsx`)

- `ProjectSigil` — a deterministic, mirrored 3×3 pixel pattern in one of six
  hues (`--sigil-1…6`), derived from the project path
  (`src/renderer/src/lib/sigil.ts`). It replaces the folder icon wherever a
  project appears. `ScratchSigil` (a dashed square) marks chats without a
  project.
- `ContextCells` — context usage as nine cells filling bottom-up.
- `LevelMeter` — thinking effort as five rising bars.

## Tokens (`src/renderer/src/styles/tokens.css`)

Surfaces step up from `--chrome` → `--bg` (sheet) → `--surface` (cards,
composer) → `--raised` (popovers). Borders: `--border` for hairlines inside a
sheet, `--border-strong` for control outlines. Text: `--text`, `--text-2`,
`--muted`; `--faint` is decorative only (empty cells, rules), never text.
Every text color meets WCAG AA (4.5:1) on the surfaces it is used on, in
both themes.

## Motion

One-shot only: popovers rise 3px over 130ms, rows fade in once, the right
panel slides. No loops, no shimmer, no spinners (see "Performance and
energy" in `AGENTS.md`), and everything respects `prefers-reduced-motion`.
