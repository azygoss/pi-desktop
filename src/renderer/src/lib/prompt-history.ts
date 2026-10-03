/**
 * Prompt history for the composer: ↑ on an empty composer recalls earlier
 * prompts, like a shell. Kept in localStorage (the same machine already holds
 * the prompts in pi's session files) and shared by every chat.
 */

const STORAGE_KEY = 'pi-desktop:prompt-history'
export const PROMPT_HISTORY_MAX = 100
/** Very long prompts (pasted logs) are not worth recalling. */
const MAX_ENTRY_CHARS = 4000

/** Append `text`, moving an earlier identical entry to the end. */
export function pushPrompt(
  history: readonly string[],
  text: string,
  max = PROMPT_HISTORY_MAX
): string[] {
  const value = text.trim()
  if (!value || value.length > MAX_ENTRY_CHARS) {
    return [...history]
  }
  const next = history.filter((entry) => entry !== value)
  next.push(value)
  return next.slice(-max)
}

export interface HistoryStep {
  /** New position; null leaves history and restores the stashed text. */
  index: number | null
  text: string
}

/**
 * Move through the history. `index` null means "not browsing"; `stash` is
 * the text that was in the composer when browsing began.
 */
export function stepHistory(
  history: readonly string[],
  index: number | null,
  direction: 'older' | 'newer',
  stash: string
): HistoryStep | null {
  if (history.length === 0) {
    return null
  }
  if (direction === 'older') {
    const next = index === null ? history.length - 1 : index - 1
    if (next < 0) {
      return null
    }
    return { index: next, text: history[next]! }
  }
  if (index === null) {
    return null
  }
  const next = index + 1
  if (next >= history.length) {
    return { index: null, text: stash }
  }
  return { index: next, text: history[next]! }
}

let cache: string[] | null = null

export function loadPromptHistory(): string[] {
  if (cache) {
    return cache
  }
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]')
    cache = Array.isArray(raw)
      ? raw.filter((e): e is string => typeof e === 'string').slice(-PROMPT_HISTORY_MAX)
      : []
  } catch {
    cache = []
  }
  return cache
}

export function recordPrompt(text: string): void {
  cache = pushPrompt(loadPromptHistory(), text)
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(cache))
  } catch {
    // storage unavailable — history stays in memory for this run
  }
}
