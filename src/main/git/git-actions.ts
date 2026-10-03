import { execFile } from 'node:child_process'
import { isAbsolute, join, normalize, sep } from 'node:path'

import type { GitActionResult } from '../../shared/api'

const GIT_TIMEOUT_MS = 20_000
const PUSH_TIMEOUT_MS = 90_000

interface GitRun {
  ok: boolean
  out: string
  err: string
}

function git(cwd: string, args: string[], timeout = GIT_TIMEOUT_MS): Promise<GitRun> {
  return new Promise((resolvePromise) => {
    execFile(
      'git',
      ['-C', cwd, ...args],
      // Never let git stop to ask for credentials: the app has no terminal.
      { timeout, maxBuffer: 8 * 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } },
      (error, stdout, stderr) => resolvePromise({ ok: !error, out: stdout, err: stderr })
    )
  })
}

/** Last meaningful line of git's output, for a one-line error. */
function lastLine(run: GitRun): string {
  const lines = `${run.err}\n${run.out}`
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
  return (lines[lines.length - 1] ?? 'git failed').slice(0, 300)
}

/**
 * A repo-relative path from the renderer, checked before it reaches git:
 * relative, no parent segments, no leading dash.
 */
export function safeRepoPath(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 4096) {
    throw new Error('Invalid path')
  }
  const normalized = normalize(value)
  if (
    isAbsolute(normalized) ||
    normalized.startsWith('-') ||
    normalized === '..' ||
    normalized.startsWith(`..${sep}`) ||
    normalized.includes('\0')
  ) {
    throw new Error('Invalid path')
  }
  return normalized
}

async function repoRoot(cwd: string): Promise<string> {
  const root = await git(cwd, ['rev-parse', '--show-toplevel'])
  if (!root.ok || !root.out.trim()) {
    throw new Error('Not a git repository')
  }
  return root.out.trim()
}

/**
 * Throw away a file's working-tree changes. Tracked files are restored from
 * HEAD; an untracked file is handed to `trash` (the OS trash, never unlink).
 */
export async function discardFile(
  cwd: string,
  path: unknown,
  trash: (absolutePath: string) => Promise<void>
): Promise<GitActionResult> {
  const rel = safeRepoPath(path)
  const root = await repoRoot(cwd)
  const tracked = await git(root, ['ls-files', '--error-unmatch', '--', rel])
  if (!tracked.ok) {
    await trash(join(root, rel))
    return { ok: true, message: 'Moved to Trash' }
  }
  // A file added in the index but absent from HEAD is unstaged and trashed.
  const inHead = await git(root, ['cat-file', '-e', `HEAD:${rel.split(sep).join('/')}`])
  if (!inHead.ok) {
    const unstage = await git(root, ['rm', '--cached', '-q', '--', rel])
    if (!unstage.ok) {
      return { ok: false, message: lastLine(unstage) }
    }
    await trash(join(root, rel))
    return { ok: true, message: 'Moved to Trash' }
  }
  const restore = await git(root, ['checkout', 'HEAD', '--', rel])
  return restore.ok ? { ok: true, message: 'Changes discarded' } : { ok: false, message: lastLine(restore) }
}

/** Stage everything and commit with `message`. */
export async function commitAll(cwd: string, message: unknown): Promise<GitActionResult> {
  if (typeof message !== 'string' || !message.trim() || message.length > 5000) {
    throw new Error('Invalid commit message')
  }
  const root = await repoRoot(cwd)
  const add = await git(root, ['add', '-A'])
  if (!add.ok) {
    return { ok: false, message: lastLine(add) }
  }
  const commit = await git(root, ['commit', '-m', message.trim()])
  if (!commit.ok) {
    return { ok: false, message: lastLine(commit) }
  }
  const head = await git(root, ['rev-parse', '--short', 'HEAD'])
  return { ok: true, message: `Committed ${head.out.trim()}` }
}

/** Push the current branch, setting its upstream on the first push. */
export async function pushBranch(cwd: string): Promise<GitActionResult> {
  const root = await repoRoot(cwd)
  const branch = (await git(root, ['branch', '--show-current'])).out.trim()
  if (!branch) {
    return { ok: false, message: 'Not on a branch' }
  }
  const upstream = await git(root, ['rev-parse', '--abbrev-ref', '@{upstream}'])
  const push = upstream.ok
    ? await git(root, ['push'], PUSH_TIMEOUT_MS)
    : await git(root, ['push', '-u', 'origin', branch], PUSH_TIMEOUT_MS)
  return push.ok ? { ok: true, message: `Pushed ${branch}` } : { ok: false, message: lastLine(push) }
}
