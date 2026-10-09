import { execFile } from 'node:child_process'

import type { GitActionResult } from '../../shared/api'
import {
  LOCAL_FORMAT,
  REMOTE_FORMAT,
  parseLocalBranches,
  parseRemoteBranches,
  parseWorktrees,
  type RepoBranches
} from '../../shared/git-branches'
import { isAppWorktree } from './worktrees'

const GIT_TIMEOUT_MS = 30_000
const MAX_BRANCHES = 500

interface GitRun {
  ok: boolean
  out: string
  err: string
}

export function git(cwd: string, args: string[]): Promise<GitRun> {
  return new Promise((resolvePromise) => {
    execFile(
      'git',
      ['-C', cwd, ...args],
      // Never let git stop to ask for anything: the app has no terminal.
      {
        timeout: GIT_TIMEOUT_MS,
        maxBuffer: 8 * 1024 * 1024,
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }
      },
      (error, stdout, stderr) => resolvePromise({ ok: !error, out: stdout, err: stderr })
    )
  })
}

export function lastLine(run: GitRun): string {
  const lines = `${run.err}\n${run.out}`
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
  return (lines[lines.length - 1] ?? 'git failed').slice(0, 300)
}

/**
 * Why git refused, for a person: its error lines without the hints and
 * the closing "Aborting", so the files it names stay in view.
 */
export function gitReason(run: GitRun): string {
  const lines = `${run.err}\n${run.out}`
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !/^hint:/i.test(l) && !/^aborting\.?$/i.test(l))
  return (lines.join(' ') || 'git failed').slice(0, 400)
}

export async function topLevel(cwd: string): Promise<string> {
  const top = await git(cwd, ['rev-parse', '--show-toplevel'])
  if (!top.ok || !top.out.trim()) {
    throw new Error('Not a git repository')
  }
  return top.out.trim()
}

/**
 * A branch name from the renderer, checked by git itself
 * (`check-ref-format --branch`) and never starting with a dash, so it can
 * only ever be read as a branch.
 */
export async function validBranchName(cwd: string, value: unknown): Promise<string> {
  const name = typeof value === 'string' ? value.trim() : ''
  if (!name) {
    throw new Error('Enter a branch name')
  }
  if (name.length > 200) {
    throw new Error('Branch name is too long')
  }
  if (name.startsWith('-')) {
    throw new Error("Branch names can't start with '-'")
  }
  // eslint-disable-next-line no-control-regex
  if (/[\s\u0000-\u001f]/.test(name)) {
    throw new Error("Branch names can't contain spaces or control characters")
  }
  const check = await git(cwd, ['check-ref-format', '--branch', name])
  if (!check.ok) {
    throw new Error(`"${name}" is not a valid branch name`)
  }
  return name
}

/** An existing ref (branch, remote branch, tag or commit) to start from. */
export async function validStartPoint(cwd: string, value: unknown): Promise<string> {
  const ref = typeof value === 'string' ? value.trim() : ''
  // eslint-disable-next-line no-control-regex
  if (!ref || ref.length > 200 || ref.startsWith('-') || /[\s\u0000-\u001f]/.test(ref)) {
    throw new Error('Invalid start point')
  }
  const found = await git(cwd, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`])
  if (!found.ok) {
    throw new Error(`No branch or commit named "${ref}"`)
  }
  return ref
}

async function hasRef(cwd: string, ref: string): Promise<boolean> {
  return (await git(cwd, ['show-ref', '--verify', '--quiet', ref])).ok
}

/**
 * The repository's branches, remote branches and worktrees, seen from
 * `cwd`. With `query`, every branch is searched (by name, case-insensitive)
 * before the newest MAX_BRANCHES are kept, so an old branch can always be
 * found.
 */
export async function listBranches(
  cwd: string,
  worktreesBase: string,
  query?: unknown
): Promise<RepoBranches> {
  const root = await topLevel(cwd)
  const needle = typeof query === 'string' ? query.trim().toLowerCase().slice(0, 200) : ''
  const [current, status, local, remote, worktrees] = await Promise.all([
    git(root, ['branch', '--show-current']),
    git(root, ['status', '--porcelain']),
    git(root, ['for-each-ref', '--sort=-committerdate', `--format=${LOCAL_FORMAT}`, 'refs/heads']),
    git(root, ['for-each-ref', '--sort=-committerdate', `--format=${REMOTE_FORMAT}`, 'refs/remotes']),
    git(root, ['worktree', 'list', '--porcelain'])
  ])
  const all = parseLocalBranches(local.out, root)
  const allRemotes = parseRemoteBranches(remote.out, new Set(all.map((b) => b.name)))
  const hit = (name: string) => !needle || name.toLowerCase().includes(needle)
  const matching = all.filter((b) => b.current || hit(b.name))
  const matchingRemotes = allRemotes.filter((r) => hit(r.name))
  return {
    root,
    current: current.out.trim() || null,
    changes: status.out.split('\n').filter((l) => l.trim()).length,
    branches: matching.slice(0, MAX_BRANCHES),
    remotes: matchingRemotes.slice(0, MAX_BRANCHES),
    worktrees: parseWorktrees(worktrees.out, root, (path) => isAppWorktree(path, worktreesBase)),
    truncated: matching.length > MAX_BRANCHES || matchingRemotes.length > MAX_BRANCHES
  }
}

/**
 * Check out `branch` in `cwd`'s checkout. A remote branch ("origin/x") gets
 * a local tracking branch first. Uncommitted changes come along when git
 * can carry them; when it cannot, git refuses and says why.
 */
export async function switchBranch(cwd: string, input: unknown): Promise<GitActionResult> {
  const root = await topLevel(cwd)
  const raw = (input as { branch?: unknown } | null)?.branch
  const name = await validBranchName(root, raw)
  let args: string[]
  if (await hasRef(root, `refs/heads/${name}`)) {
    args = ['switch', name]
  } else if (await hasRef(root, `refs/remotes/${name}`)) {
    args = ['switch', '--track', name]
  } else {
    throw new Error(`No branch named "${name}"`)
  }
  const run = await git(root, args)
  if (!run.ok) {
    return { ok: false, message: gitReason(run) }
  }
  const now = (await git(root, ['branch', '--show-current'])).out.trim()
  return { ok: true, message: `Switched to ${now || name}` }
}

/** Create a branch from `from` (HEAD when absent) and, by default, switch to it. */
export async function createBranch(cwd: string, input: unknown): Promise<GitActionResult> {
  const root = await topLevel(cwd)
  const i = (input ?? {}) as { name?: unknown; from?: unknown; switch?: unknown }
  const name = await validBranchName(root, i.name)
  if (await hasRef(root, `refs/heads/${name}`)) {
    throw new Error(`A branch named "${name}" already exists`)
  }
  const from = i.from === undefined || i.from === '' ? undefined : await validStartPoint(root, i.from)
  const stay = i.switch === false
  const run = await git(
    root,
    stay ? ['branch', name, ...(from ? [from] : [])] : ['switch', '-c', name, ...(from ? [from] : [])]
  )
  if (!run.ok) {
    return { ok: false, message: gitReason(run) }
  }
  return { ok: true, message: stay ? `Created ${name}` : `Created and switched to ${name}` }
}
