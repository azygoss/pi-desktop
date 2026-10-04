import type { DisplayMessage, Model } from '../desktop'

type Assistant = Extract<DisplayMessage, { kind: 'assistant' }>

/** One row of the transcript list. */
export type TranscriptItem =
  | { kind: 'user'; key: string; message: Extract<DisplayMessage, { kind: 'user' }>; userIndex: number }
  | { kind: 'assistant'; key: string; message: Assistant; live: boolean }
  /** A stretch of thinking-and-tools-only messages, folded into one row. */
  | { kind: 'work'; key: string; messages: Assistant[]; live: boolean; startedAt?: number; endedAt?: number }
  | { kind: 'bash'; key: string; message: Extract<DisplayMessage, { kind: 'bash' }> }
  | { kind: 'notice'; key: string; message: Extract<DisplayMessage, { kind: 'notice' }> }
  /** "model · 14:02 · 1.8k tokens out · $0.04" under a finished turn. */
  | { kind: 'meta'; key: string; text: string }

/** Consecutive trace-only messages folded into one work row. */
const WORK_GROUP_MIN = 2

/** Assistant messages made only of reasoning and tool calls (no prose). */
export function isTraceOnly(message: DisplayMessage): message is Assistant {
  return (
    message.kind === 'assistant' &&
    !message.errorMessage &&
    message.blocks.length > 0 &&
    message.blocks.every((b) => b.type === 'thinking' || b.type === 'toolCall')
  )
}

function shortTokens(n: number): string {
  if (n < 1000) {
    return `${n}`
  }
  const k = n / 1000
  return `${k >= 100 ? Math.round(k) : k.toFixed(1).replace(/\.0$/, '')}k`
}

function clock(timestamp: number): string {
  const d = new Date(timestamp)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

function turnMeta(turn: Assistant[], models: Model[]): string {
  const last = turn[turn.length - 1]!
  let output = 0
  let cost = 0
  for (const message of turn) {
    if (message.usage) {
      output += message.usage.output
      cost += message.usage.cost
    }
  }
  const parts: string[] = []
  if (last.model) {
    parts.push(models.find((m) => m.id === last.model)?.name ?? last.model)
  }
  if (last.timestamp) {
    parts.push(clock(last.timestamp))
  }
  if (output > 0) {
    parts.push(`${shortTokens(output)} tokens out`)
  }
  if (cost > 0) {
    parts.push(`$${cost.toFixed(cost < 0.1 ? 3 : 2)}`)
  }
  return parts.join(' · ')
}

/**
 * Flatten the message list into list rows, oldest first: user prompts,
 * assistant messages, folded work groups, shell runs, notices and a meta
 * line under each finished turn.
 */
export function buildTranscript(
  messages: DisplayMessage[],
  streaming: boolean,
  models: Model[]
): TranscriptItem[] {
  const items: TranscriptItem[] = []
  let turn: Assistant[] = []
  let userIndex = 0

  const flushTurn = (live: boolean): void => {
    if (turn.length === 0) {
      return
    }
    let run: Assistant[] = []
    const flushRun = (next?: Assistant): void => {
      if (run.length >= WORK_GROUP_MIN) {
        items.push({
          kind: 'work',
          key: `${run[0]!.key}:work`,
          messages: run,
          live: live && next === undefined,
          startedAt: run[0]!.timestamp,
          endedAt: next?.timestamp ?? run[run.length - 1]!.timestamp
        })
      } else {
        for (const message of run) {
          items.push({ kind: 'assistant', key: message.key, message, live })
        }
      }
      run = []
    }
    turn.forEach((message, index) => {
      // The turn's last message stays out of a group: while pi works it is
      // the step on screen, afterwards it is usually the answer.
      if (index < turn.length - 1 && isTraceOnly(message)) {
        run.push(message)
        return
      }
      flushRun(message)
      items.push({ kind: 'assistant', key: message.key, message, live })
    })
    flushRun()
    if (!live) {
      const text = turnMeta(turn, models)
      if (text) {
        items.push({ kind: 'meta', key: `${turn[turn.length - 1]!.key}:meta`, text })
      }
    }
    turn = []
  }

  for (const message of messages) {
    switch (message.kind) {
      case 'assistant':
        turn.push(message)
        break
      case 'user':
        flushTurn(false)
        items.push({ kind: 'user', key: message.key, message, userIndex: userIndex++ })
        break
      case 'bash':
        flushTurn(false)
        items.push({ kind: 'bash', key: message.key, message })
        break
      case 'notice':
        flushTurn(false)
        items.push({ kind: 'notice', key: message.key, message })
        break
    }
  }
  flushTurn(streaming)
  return items
}
