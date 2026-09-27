import { describe, expect, it } from 'vitest'

import type { SessionSummary } from '../../shared/session-types'
import { mergeProjects } from './projects'

function session(cwd: string, modified: string): SessionSummary {
  return {
    id: 's',
    path: `/sessions/${cwd.replaceAll('/', '-')}-1.jsonl`,
    cwd,
    title: 'Chat',
    created: modified,
    modified,
    messageCount: 2
  }
}

const SCRATCH = '/app-data/workspace'

describe('mergeProjects', () => {
  it('groups sessions by cwd and sorts by last activity', () => {
    const projects = mergeProjects(
      [
        session('/Users/example/old', '2024-01-01T00:00:00Z'),
        session('/Users/example/new', '2024-03-01T00:00:00Z'),
        session('/Users/example/old', '2024-02-01T00:00:00Z')
      ],
      [],
      [],
      SCRATCH
    )
    expect(projects.map((p) => p.cwd)).toEqual([
      '/Users/example/new',
      '/Users/example/old'
    ])
    expect(projects[1]?.sessionCount).toBe(2)
  })

  it('includes user-added projects that have no sessions', () => {
    const projects = mergeProjects(
      [session('/Users/example/active', '2024-03-01T00:00:00Z')],
      [{ cwd: '/Users/example/empty', addedAt: '2024-02-01T00:00:00Z' }],
      [],
      SCRATCH
    )
    expect(projects.map((p) => p.cwd)).toEqual([
      '/Users/example/active',
      '/Users/example/empty'
    ])
    expect(projects[1]?.sessionCount).toBe(0)
    expect(projects[1]?.name).toBe('empty')
  })

  it('does not duplicate a user-added project that already has sessions', () => {
    const projects = mergeProjects(
      [session('/Users/example/dup', '2024-03-01T00:00:00Z')],
      [{ cwd: '/Users/example/dup', addedAt: '2024-01-01T00:00:00Z' }],
      [],
      SCRATCH
    )
    expect(projects).toHaveLength(1)
    expect(projects[0]?.sessionCount).toBe(1)
  })

  it('excludes hidden projects from both sources', () => {
    const projects = mergeProjects(
      [session('/Users/example/hidden', '2024-03-01T00:00:00Z')],
      [
        { cwd: '/Users/example/hidden', addedAt: '2024-01-01T00:00:00Z' },
        { cwd: '/Users/example/shown', addedAt: '2024-01-01T00:00:00Z' }
      ],
      ['/Users/example/hidden'],
      SCRATCH
    )
    expect(projects.map((p) => p.cwd)).toEqual(['/Users/example/shown'])
  })

  it('treats scratch-dir and empty-cwd sessions as project-less', () => {
    const projects = mergeProjects(
      [session(SCRATCH, '2024-03-01T00:00:00Z'), session('', '2024-02-01T00:00:00Z')],
      [{ cwd: SCRATCH, addedAt: '2024-01-01T00:00:00Z' }],
      [],
      SCRATCH
    )
    expect(projects).toEqual([])
  })
})
