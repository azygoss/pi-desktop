import type { ChatSessionStats } from '../../../shared/api'

/** The context ring only makes sense once the session has used tokens —
 *  a fresh draft (or an empty session that reports zeros) shows nothing. */
export function contextRingVisible(stats: ChatSessionStats | undefined): boolean {
  const pct = stats?.contextUsage?.percent
  const used = stats?.contextUsage?.tokens
  return typeof pct === 'number' && pct > 0 && typeof used === 'number' && used > 0
}
