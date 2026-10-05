import { describe, expect, it } from 'vitest'

import type { PiTreeNode } from '../../../shared/pi-types'
import { flattenSessionTree } from './session-tree'

const node = (id: string, role: string, text: string, children: PiTreeNode[] = []): PiTreeNode => ({
  entry: { type: 'message', id, message: { role, content: text } as never },
  children
})

describe('flattenSessionTree', () => {
  it('keeps a linear conversation flat', () => {
    const rows = flattenSessionTree({
      tree: [node('u1', 'user', 'hi', [node('a1', 'assistant', 'hello', [node('u2', 'user', 'more')])])],
      leafId: 'u2'
    })
    expect(rows.map((r) => [r.id, r.depth, r.active])).toEqual([
      ['u1', 0, true],
      ['a1', 0, true],
      ['u2', 0, true]
    ])
    expect(rows[2]!.leaf).toBe(true)
    expect(rows.filter((r) => r.forkable).map((r) => r.id)).toEqual(['u1', 'u2'])
  })

  it('indents only at branches and lists the active branch first', () => {
    const rows = flattenSessionTree({
      tree: [
        node('u1', 'user', 'start', [
          node('a-old', 'assistant', 'first try', [node('u-old', 'user', 'old path')]),
          node('a-new', 'assistant', 'second try', [node('u-new', 'user', 'new path')])
        ])
      ],
      leafId: 'u-new'
    })
    expect(rows.map((r) => [r.id, r.depth, r.active, r.branchStart])).toEqual([
      ['u1', 0, true, false],
      ['a-new', 1, true, true],
      ['u-new', 1, true, false],
      ['a-old', 1, false, true],
      ['u-old', 1, false, false]
    ])
  })

  it('survives very deep sessions', () => {
    let tree = node('n4999', 'user', 'last')
    for (let i = 4998; i >= 0; i--) {
      tree = node(`n${i}`, i % 2 ? 'assistant' : 'user', `m${i}`, [tree])
    }
    expect(flattenSessionTree({ tree: [tree], leafId: 'n4999' })).toHaveLength(5000)
  })
})
