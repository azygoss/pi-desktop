import { execFile } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative } from 'node:path'

import type { GitActionResult, WorktreeInfo } from '../../shared/api'

const GIT_TIMEOUT_MS = 30_000

const WORDS = [
  'amber', 'brisk', 'calm', 'dusk', 'ember', 'fern', 'glint', 'haze', 'iris', 'jade',
  'kite', 'lumen', 'moss', 'nova', 'opal', 'pine', 'quill', 'reef', 'sage', 'tide'
]

function git(cwd: string, args: string[]): Promise<{ ok: boolean; out: string; err: string }> {
  return new Promise((resolvePromise) => {
    execFile(
      'git',
      ['-C', cwd, ...args],
      { timeout: GIT_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 },
      (error, stdout, stderr) => resolvePromise({ ok: !error, out: stdout, err: stderr })
    )
  })
}

function lastLine(text: string): string {
  const lines = text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
  return (lines[lines.length - 1] ?? 'git failed').slice(0, 300)
}

/** True when `cwd` is a worktree the app created under `baseDir`. */
export function isAppWorktree(cwd: string, baseDir: string): boolean {
  const rel = relative(baseDir, cwd)
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)
}

/** "repo · slug" for a worktree path, so the sidebar says which repo it is. */
export function worktreeDisplayName(cwd: string): string {
  return `${basename(dirname(cwd))} · ${basename(cwd)}`
}

export function randomSlug(bytes: Buffer = randomBytes(3)): string {
  return `${WORDS[bytes[0]! % WORDS.length]}-${WORDS[bytes[1]! % WORDS.length]}-${(bytes[2]! % 100)
    .toString()
    .padStart(2, '0')}`
}

/**
 * Create a git worktree of the repository containing `cwd`, on a new
 * `pi/<slug>` branch cut from HEAD, under `baseDir/<repo>/<slug>`. Each
 * worktree is an isolated checkout, so chats can change the same project
 * in parallel without touching each other's files.
 */
export async function createWorktree(
  cwd: string,
  baseDir: string,
  slug: string = randomSlug()
): Promise<WorktreeInfo> {
  const top = await git(cwd, ['rev-parse', '--show-toplevel'])
  if (!top.ok || !top.out.trim()) {
    throw new Error('Worktrees need a git repository')
  }
  const root = top.out.trim()
  const head = await git(root, ['rev-parse', '--verify', 'HEAD'])
  if (!head.ok) {
    throw new Error('Worktrees need at least one commit')
  }
  const dir = join(baseDir, basename(root), slug)
  const branch = `pi/${slug}`
  await mkdir(dirname(dir), { recursive: true })
  const add = await git(root, ['worktree', 'add', '-b', branch, dir])
  if (!add.ok) {
    throw new Error(lastLine(add.err || add.out))
  }
  return { cwd: dir, branch, repo: root }
}

/**
 * Remove a worktree the app created. Git refuses when it has uncommitted
 * changes unless `force` is set; the branch is kept either way.
 */
export async function removeWorktree(
  cwd: string,
  baseDir: string,
  force = false
): Promise<GitActionResult> {
  if (!isAppWorktree(cwd, baseDir)) {
    throw new Error('Not a Pi Desktop worktree')
  }
  const common = await git(cwd, ['rev-parse', '--path-format=absolute', '--git-common-dir'])
  if (!common.ok || !common.out.trim()) {
    return { ok: false, message: 'Worktree is no longer registered with git' }
  }
  const mainRepo = dirname(common.out.trim())
  const remove = await git(mainRepo, [
    'worktree',
    'remove',
    ...(force ? ['--force'] : []),
    cwd
  ])
  return remove.ok
    ? { ok: true, message: 'Worktree removed' }
    : { ok: false, message: lastLine(remove.err || remove.out) }
}
