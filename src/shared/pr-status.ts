/**
 * Pull-request status for a project's current branch, as reported by the
 * GitHub CLI. Pure types and parsing, shared by main and renderer.
 */

export type CheckState = 'pass' | 'fail' | 'pending' | 'skipped'

export interface PrCheck {
  name: string
  state: CheckState
  url?: string
  /** GitHub Actions run id, when the check is an Actions job. */
  runId?: string
}

export interface PullRequest {
  number: number
  title: string
  url: string
  state: 'OPEN' | 'CLOSED' | 'MERGED'
  draft: boolean
  /** Head commit, so a new push is told apart from a re-run. */
  headSha: string
  reviewDecision?: 'APPROVED' | 'CHANGES_REQUESTED' | 'REVIEW_REQUIRED'
  checks: PrCheck[]
}

export interface PrStatus {
  /** False when the GitHub CLI is missing or not signed in. */
  available: boolean
  pr?: PullRequest
}

export type PrSummary = 'none' | 'pending' | 'failing' | 'passing'

const FAIL = new Set(['FAILURE', 'ERROR', 'TIMED_OUT', 'CANCELLED', 'ACTION_REQUIRED', 'STARTUP_FAILURE'])
const SKIP = new Set(['SKIPPED', 'NEUTRAL', 'STALE'])

function checkState(item: Record<string, unknown>): CheckState {
  // StatusContext carries `state`; CheckRun carries `status` + `conclusion`.
  if (typeof item['state'] === 'string' && item['__typename'] !== 'CheckRun') {
    const state = item['state']
    return state === 'SUCCESS' ? 'pass' : FAIL.has(state) ? 'fail' : 'pending'
  }
  if (item['status'] !== 'COMPLETED') {
    return 'pending'
  }
  const conclusion = typeof item['conclusion'] === 'string' ? item['conclusion'] : ''
  if (conclusion === 'SUCCESS') {
    return 'pass'
  }
  if (SKIP.has(conclusion)) {
    return 'skipped'
  }
  return FAIL.has(conclusion) ? 'fail' : 'pending'
}

/** Parse `gh pr view --json …` output; null when it is not a PR object. */
export function parsePrView(json: string): PullRequest | null {
  let raw: Record<string, unknown>
  try {
    raw = JSON.parse(json) as Record<string, unknown>
  } catch {
    return null
  }
  if (raw === null || typeof raw !== 'object' || typeof raw['number'] !== 'number') {
    return null
  }
  const rollup = Array.isArray(raw['statusCheckRollup']) ? raw['statusCheckRollup'] : []
  const checks: PrCheck[] = []
  for (const entry of rollup as Record<string, unknown>[]) {
    if (entry === null || typeof entry !== 'object') {
      continue
    }
    const name =
      typeof entry['name'] === 'string'
        ? entry['name']
        : typeof entry['context'] === 'string'
          ? entry['context']
          : 'check'
    const url =
      typeof entry['detailsUrl'] === 'string'
        ? entry['detailsUrl']
        : typeof entry['targetUrl'] === 'string'
          ? entry['targetUrl']
          : undefined
    const runId = url ? /\/actions\/runs\/(\d+)/.exec(url)?.[1] : undefined
    checks.push({
      name: name.slice(0, 120),
      state: checkState(entry),
      ...(url && /^https:\/\//.test(url) ? { url } : {}),
      ...(runId ? { runId } : {})
    })
  }
  const state = raw['state']
  const review = raw['reviewDecision']
  return {
    number: raw['number'],
    title: typeof raw['title'] === 'string' ? raw['title'] : '',
    url: typeof raw['url'] === 'string' && /^https:\/\//.test(raw['url']) ? raw['url'] : '',
    state: state === 'MERGED' || state === 'CLOSED' ? state : 'OPEN',
    draft: raw['isDraft'] === true,
    headSha: typeof raw['headRefOid'] === 'string' ? raw['headRefOid'] : '',
    ...(review === 'APPROVED' || review === 'CHANGES_REQUESTED' || review === 'REVIEW_REQUIRED'
      ? { reviewDecision: review }
      : {}),
    checks
  }
}

/** One word for the whole set of checks. */
export function summarizeChecks(checks: readonly PrCheck[]): PrSummary {
  if (checks.some((c) => c.state === 'fail')) {
    return 'failing'
  }
  if (checks.some((c) => c.state === 'pending')) {
    return 'pending'
  }
  return checks.some((c) => c.state === 'pass') ? 'passing' : 'none'
}

/** The prompt that asks pi to fix failing checks, with the log tail if any. */
export function fixChecksPrompt(pr: PullRequest, log: string): string {
  const failing = pr.checks.filter((c) => c.state === 'fail').map((c) => c.name)
  const head = `CI is failing on pull request #${pr.number} (${pr.title}). Failing ${
    failing.length === 1 ? 'check' : 'checks'
  }: ${failing.join(', ')}.`
  const ask = 'Find the cause, fix it, and tell me what you changed. Do not push.'
  const trimmed = log.trim()
  if (!trimmed) {
    return `${head}\n\n${ask}`
  }
  const longest = (trimmed.match(/`+/g) ?? []).reduce((max, run) => Math.max(max, run.length), 0)
  const fence = '`'.repeat(Math.max(3, longest + 1))
  return `${head}\n\nEnd of the failed job's log:\n\n${fence}\n${trimmed}\n${fence}\n\n${ask}`
}
