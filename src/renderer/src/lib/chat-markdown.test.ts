import { describe, expect, it } from 'vitest'

import type { DisplayMessage, ToolRun } from '../../../shared/chat-view'
import { chatToMarkdown } from './chat-markdown'

describe('chatToMarkdown', () => {
  it('renders prompts, prose and a tool trace', () => {
    const messages: DisplayMessage[] = [
      { kind: 'user', key: 'u1', text: 'Fix the bug', images: [] },
      {
        kind: 'assistant',
        key: 'a1',
        blocks: [
          { type: 'thinking', thinking: 'hidden' },
          { type: 'toolCall', id: 't1', name: 'read', arguments: { path: '/repo/src/a.ts' } },
          { type: 'toolCall', id: 't2', name: 'bash', arguments: { command: 'pnpm test' } },
          { type: 'text', text: 'Fixed it.' }
        ]
      }
    ]
    const toolRuns: Record<string, ToolRun> = {
      t2: { toolCallId: 't2', name: 'bash', args: { command: 'pnpm test' }, status: 'error' }
    }
    const md = chatToMarkdown('Bug hunt', messages, toolRuns, '/repo')
    expect(md).toContain('# Bug hunt\n\n## You\n\nFix the bug')
    expect(md).toContain('- `read` src/a.ts\n- `bash` pnpm test (failed)\n\nFixed it.')
    expect(md).not.toContain('hidden')
  })

  it('fences shell runs past any backticks in the output', () => {
    const md = chatToMarkdown(
      '',
      [{ kind: 'bash', key: 'b', command: 'cat x.md', output: '```js\n1\n```' }],
      {},
      '/repo'
    )
    expect(md.startsWith('# Chat\n\n````console\n$ cat x.md\n```js')).toBe(true)
    expect(md.trimEnd().endsWith('````')).toBe(true)
  })
})
