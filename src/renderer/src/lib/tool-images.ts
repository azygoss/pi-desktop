import type { DisplayMessage, ToolRun } from '../../../shared/chat-view'

/** The tool pi calls to put image files in front of the user. */
export const SHOW_IMAGE_TOOL = 'show_image'

/** An image a tool produced: a screenshot, or one the agent chose to show. */
export interface ToolShot {
  key: string
  mimeType: string
  /** base64 */
  data: string
  /** show_image's caption, or the first line of a screenshot tool's text. */
  caption?: string
  /** show_image: part of the answer, shown large. Otherwise a thumbnail. */
  shown: boolean
}

const cache = new WeakMap<ToolRun, ToolShot[]>()

/** The images of one finished tool run (memoized per run object). */
export function toolShots(run: ToolRun): ToolShot[] {
  const cached = cache.get(run)
  if (cached) {
    return cached
  }
  const content = run.status === 'done' ? (run.result?.content ?? []) : []
  const shown = run.name === SHOW_IMAGE_TOOL
  const text = content
    .flatMap((block) => (block.type === 'text' ? [block.text] : []))
    .join(' ')
    .trim()
    .split('\n')[0]
    ?.slice(0, 120)
  const caption = shown
    ? typeof run.args['caption'] === 'string' && run.args['caption'].trim()
      ? run.args['caption'].trim()
      : undefined
    : text || undefined
  const shots: ToolShot[] = []
  content.forEach((block, index) => {
    if (block.type === 'image' && typeof block.data === 'string') {
      shots.push({
        key: `${run.toolCallId}:${index}`,
        mimeType: block.mimeType,
        data: block.data,
        ...(caption ? { caption } : {}),
        shown
      })
    }
  })
  cache.set(run, shots)
  return shots
}

/**
 * Every image the tool calls of these messages produced, in order. Tool
 * steps are folded by default, so a screenshot or an image the agent showed
 * is surfaced under the folded row instead of only inside it.
 */
export function collectToolShots(
  messages: readonly DisplayMessage[],
  toolRuns: Record<string, ToolRun>
): ToolShot[] {
  const shots: ToolShot[] = []
  for (const message of messages) {
    if (message.kind !== 'assistant') {
      continue
    }
    for (const block of message.blocks) {
      if (block.type === 'toolCall') {
        const run = toolRuns[block.id]
        if (run) {
          shots.push(...toolShots(run))
        }
      }
    }
  }
  return shots
}
