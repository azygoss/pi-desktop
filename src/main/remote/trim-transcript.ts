import type { AgentMessage } from '../../shared/pi-types'

/** Tool output longer than this is cut for the phone (head and tail kept). */
const MAX_TEXT_CHARS = 8_000
const HEAD_CHARS = 5_000
const TAIL_CHARS = 2_500

function trimText(text: string): string {
  if (text.length <= MAX_TEXT_CHARS) {
    return text
  }
  const cut = text.length - HEAD_CHARS - TAIL_CHARS
  return `${text.slice(0, HEAD_CHARS)}\n⋯ ${cut.toLocaleString('en-US')} characters not sent to the phone ⋯\n${text.slice(-TAIL_CHARS)}`
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
