import { basename } from 'node:path'

import type { AppProject } from '../config/app-settings'
import { listProjects } from './session-index'
import type { ProjectSummary, SessionSummary } from '../../shared/session-types'

/**
 * The sidebar's Projects section = cwds found in existing sessions unioned
 * with projects the user added explicitly, minus hidden projects and minus
 * the scratch dir (sessions there are project-less "Chats"). Sorted by last
 * activity — added projects without sessions fall back to `addedAt`.
 */
export function mergeProjects(
  sessions: SessionSummary[],
  addedProjects: AppProject[],
  hiddenProjects: string[],
  scratchDir: string
): ProjectSummary[] {
  const hidden = new Set(hiddenProjects)
  const grouped = listProjects(
    sessions.filter((s) => !hidden.has(s.cwd) && s.cwd !== scratchDir && s.cwd !== '')
  )
  const known = new Set(grouped.map((p) => p.cwd))
  for (const added of addedProjects) {
    if (hidden.has(added.cwd) || added.cwd === scratchDir || known.has(added.cwd)) {
      continue
    }
    known.add(added.cwd)
    grouped.push({
      cwd: added.cwd,
      name: basename(added.cwd),
      sessionCount: 0,
      lastModified: added.addedAt
    })
  }
  return grouped.sort((a, b) => b.lastModified.localeCompare(a.lastModified))
}
