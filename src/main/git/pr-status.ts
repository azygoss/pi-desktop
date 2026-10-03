import { execFile } from 'node:child_process'

import { parsePrView, type PrStatus } from '../../shared/pr-status'
import { loginShellEnv } from '../pi/locator'

const GH_TIMEOUT_MS = 20_000
const LOG_TIMEOUT_MS = 45_000
/** The tail of a failed job's log handed to pi. */
const LOG_TAIL_LINES = 120
const LOG_TAIL_CHARS = 8000

const PR_FIELDS =
  'number,title,url,state,isDraft,headRefOid,reviewDecision,statusCheckRollup'

interface GhRun {
  ok: boolean
  out: string
  err: string
  /** The `gh` binary could not be started at all. */
  missing: boolean
}

async function gh(cwd: string, args: string[], timeout: number): Promise<GhRun> {
  // Packaged apps get a minimal PATH; gh lives where the login shell finds it.
  const env = { ...(await loginShellEnv()), GH_PROMPT_DISABLED: '1', NO_COLOR: '1' }
  return new Promise((resolvePromise) => {
    execFile(
      // Test/dev override: a stand-in for the GitHub CLI (e2e fixture).
      process.env['PI_DESKTOP_GH_COMMAND'] || 'gh',
      args,
      { cwd, env, timeout, maxBuffer: 16 * 1024 * 1024 },
      (error, stdout, stderr) =>
        resolvePromise({
          ok: !error,
          out: stdout,
          err: stderr,
          missing: (error as NodeJS.ErrnoException | null)?.code === 'ENOENT'
        })
    )
  })
}

/**
 * The pull request of the branch checked out in `cwd`, with its checks.
 * `available: false` means the GitHub CLI is missing or signed out; a repo
 * or branch without a PR is `available: true` with no `pr`.
 */
export async function getPrStatus(cwd: string): Promise<PrStatus> {
  const view = await gh(cwd, ['pr', 'view', '--json', PR_FIELDS], GH_TIMEOUT_MS)
  if (view.missing) {
    return { available: false }
  }
  if (!view.ok) {
    return { available: !/auth login|not logged in|authentication/i.test(view.err) }
  }
  const pr = parsePrView(view.out)
  return pr ? { available: true, pr } : { available: true }
}

/** Last lines of the failed jobs' logs for an Actions run ('' when unknown). */
export async function getFailedLog(cwd: string, runId: unknown): Promise<string> {
  if (typeof runId !== 'string' || !/^\d{1,20}$/.test(runId)) {
    throw new Error('Invalid run id')
  }
  const log = await gh(cwd, ['run', 'view', runId, '--log-failed'], LOG_TIMEOUT_MS)
  if (!log.ok) {
    return ''
  }
  return log.out
    .split('\n')
    // "job\tstep\t2026-…Z message" → keep the message.
    .map((line) => line.replace(/^[^\t]*\t[^\t]*\t(\d{4}-\d\d-\d\dT[\d:.]+Z )?/, ''))
    .slice(-LOG_TAIL_LINES)
    .join('\n')
    .slice(-LOG_TAIL_CHARS)
}
