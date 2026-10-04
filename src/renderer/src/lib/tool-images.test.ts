import { describe, expect, it } from 'vitest'

import type { DisplayMessage, ToolRun } from '../../../shared/chat-view'
import { collectToolShots, toolShots } from './tool-images'

const run = (over: Partial<ToolRun>): ToolRun => ({
  toolCallId: 't1',
  name: 'browser_screenshot',
  args: {},
  status: 'done',
  result: {
    content: [
      { type: 'image', data: 'AAAA', mimeType: 'image/jpeg' },
      { type: 'text', text: 'Screenshot of YouTube\nmore' }
    ]
  },
  ...over
})

describe('tool images', () => {
  it('turns a screenshot into a captioned thumbnail', () => {
    expect(toolShots(run({}))).toEqual([
      { key: 't1:0', mimeType: 'image/jpeg', data: 'AAAA', caption: 'Screenshot of YouTube', shown: false }
    ])
  })

  it('shows show_image results large with the agent caption', () => {
    const shots = toolShots(run({ name: 'show_image', args: { paths: ['a.png'], caption: 'The new header' } }))
    expect(shots).toMatchObject([{ shown: true, caption: 'The new header' }])
  })

  it('ignores runs that are still going or failed', () => {
    expect(toolShots(run({ status: 'running' }))).toEqual([])
    expect(toolShots(run({ status: 'error' }))).toEqual([])
  })

  it('collects in message order across messages', () => {
    const messages = [
      {
        kind: 'assistant',
        key: 'm1',
        blocks: [
          { type: 'toolCall', id: 'a', name: 'show_image', arguments: {} },
          { type: 'toolCall', id: 'b', name: 'bash', arguments: {} }
        ]
      },
      { kind: 'assistant', key: 'm2', blocks: [{ type: 'toolCall', id: 'c', name: 'computer_screenshot', arguments: {} }] }
    ] as unknown as DisplayMessage[]
    const runs = {
      a: run({ toolCallId: 'a', name: 'show_image' }),
      b: run({ toolCallId: 'b', name: 'bash', result: { content: [{ type: 'text', text: 'ok' }] } }),
      c: run({ toolCallId: 'c', name: 'computer_screenshot' })
    }
    expect(collectToolShots(messages, runs).map((s) => s.key)).toEqual(['a:0', 'c:0'])
  })
})
