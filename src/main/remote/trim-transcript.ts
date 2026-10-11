import type { AgentMessage } from '../../shared/pi-types'

/** Tool output longer than this is cut for the phone (head and tail kept). */
const MAX_TEXT_CHARS = 8_000
const HEAD_CHARS = 5_000
const TAIL_CHARS = 2_500

/** True for the first half of a UTF-16 surrogate pair. */
function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff
}

function trimText(text: string): string {
  if (text.length <= MAX_TEXT_CHARS) {
    return text
  }
  // Never cut between the halves of a surrogate pair (an emoji): a lone half
  // is invalid Unicode, and the iOS app's JSON reader rejects it.
  let head = HEAD_CHARS
  if (isHighSurrogate(text.charCodeAt(head - 1))) {
    head -= 1
  }
  let tail = text.length - TAIL_CHARS
  if (isHighSurrogate(text.charCodeAt(tail - 1))) {
    tail -= 1
  }
  const cut = tail - head
  return `${text.slice(0, head)}\n⋯ ${cut.toLocaleString('en-US')} characters not sent to the phone ⋯\n${text.slice(tail)}`
}

/**
 * A transcript sized for a phone: tool results (a build log, a whole file)
 * keep their head and tail. Prompts, replies and images are sent whole. The
 * session file itself is never changed.
 */
export function trimTranscript(messages: AgentMessage[]): AgentMessage[] {
  return messages.map((message) => {
    if (message.role !== 'toolResult') {
      return message
    }
    let changed = false
    const content = message.content.map((block) => {
      if (block.type !== 'text' || block.text.length <= MAX_TEXT_CHARS) {
        return block
      }
      changed = true
      return { ...block, text: trimText(block.text) }
    })
    return changed ? { ...message, content } : message
  })
}
