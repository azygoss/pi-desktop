/**
 * Pure helpers for the transcript trace: shell tool output and durations.
 */

export type ShellStatus =
  { kind: 'exit'; code: number } | { kind: 'timeout'; seconds: number } | { kind: 'aborted' }

// pi's bash tool appends one of these after a blank line when a command
// does not exit cleanly (see appendStatus in pi's tools/bash.js).
const STATUS_LINE =
  /(?:^|\n\n)(Command exited with code (-?\d+)|Command timed out after (\d+(?:\.\d+)?) seconds|Command aborted)\s*$/

/** Split pi's trailing shell status line off a bash tool's output. */
export function splitShellStatus(text: string): { output: string; status?: ShellStatus } {
  const match = STATUS_LINE.exec(text)
  if (!match) {
    return { output: text }
  }
  const output = text.slice(0, match.index)
  if (match[2] !== undefined) {
    return { output, status: { kind: 'exit', code: Number(match[2]) } }
  }
  if (match[3] !== undefined) {
    return { output, status: { kind: 'timeout', seconds: Number(match[3]) } }
  }
  return { output, status: { kind: 'aborted' } }
}

/** Short label for a shell status: "exit 1", "timed out", "aborted". */
export function shellStatusLabel(status: ShellStatus): string {
  switch (status.kind) {
    case 'exit':
      return `exit ${status.code}`
    case 'timeout':
      return 'timed out'
    case 'aborted':
      return 'aborted'
  }
}

/** Steps faster than this show no duration: "0.0s" is noise. */
export const MIN_SHOWN_DURATION_MS = 100

/** "0.4s", "12s", "2m 05s" — compact duration for a finished step. */
export function formatDuration(ms: number): string {
  if (ms < 1000) {
    return `${(Math.max(ms, 0) / 1000).toFixed(1)}s`
  }
  const total = Math.round(ms / 1000)
  if (total < 60) {
    return `${total}s`
  }
  return `${Math.floor(total / 60)}m ${String(total % 60).padStart(2, '0')}s`
}
