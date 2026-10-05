import { execFile } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdir, stat } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative } from 'node:path'

import type { GitActionResult, WorktreeInfo } from '../../shared/api'
import { worktreeSlug, type WorktreeSource } from '../../shared/git-branches'
import { validBranchName, validStartPoint } from './branches'

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

/** A folder under `parent` named after `slug` that does not exist yet. */
async function freeDir(parent: string, slug: string): Promise<string> {
  for (let n = 1; n < 100; n++) {
    const dir = join(parent, n === 1 ? slug : `${slug}-${n}`)
    if (!(await stat(dir).catch(() => null))) {
      return dir
    }
  }
  throw new Error('Too many worktrees with that name')
}

function readSource(value: unknown): WorktreeSource {
  const v = (value ?? {}) as Record<string, unknown>
  if (v['kind'] === 'existing') {
    return { kind: 'existing', branch: typeof v['branch'] === 'string' ? v['branch'] : '' }
  }
  return {
    kind: 'new',
    ...(typeof v['branch'] === 'string' && v['branch'].trim() ? { branch: v['branch'] } : {}),
    ...(typeof v['from'] === 'string' && v['from'].trim() ? { from: v['from'] } : {})
  }
}

/**
 * Create a git worktree of the repository containing `cwd` under
 * `baseDir/<repo>/<name>`. By default it is a new `pi/<slug>` branch cut
 * from HEAD; `source` can name the new branch and where it starts, or check
 * out an existing branch (a remote one gets a local tracking branch). Each
 * worktree is an isolated checkout, so chats can change the same project in
 * parallel without touching each other's files.
 */
export async function createWorktree(
  cwd: string,
  baseDir: string,
  source: unknown = { kind: 'new' },
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
  const parent = join(baseDir, basename(root))
  await mkdir(parent, { recursive: true })
  const want = readSource(source)
  let branch: string
  let args: string[]
  let dir: string
  if (want.kind === 'existing') {
    const name = await validBranchName(root, want.branch)
    const local = (await git(root, ['show-ref', '--verify', '--quiet', `refs/heads/${name}`])).ok
    const remote =
      !local && (await git(root, ['show-ref', '--verify', '--quiet', `refs/remotes/${name}`])).ok
    if (!local && !remote) {
      throw new Error(`No branch named "${name}"`)
    }
    // "origin/x" becomes a local "x" that tracks it.
    branch = remote ? name.slice(name.indexOf('/') + 1) : name
    if (remote && (await git(root, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`])).ok) {
      throw new Error(`A local branch named "${branch}" already exists`)
    }
    dir = await freeDir(parent, worktreeSlug(branch))
    args = remote ? ['worktree', 'add', '--track', '-b', branch, dir, name] : ['worktree', 'add', dir, name]
  } else {
    branch = want.branch ? await validBranchName(root, want.branch) : `pi/${slug}`
    if ((await git(root, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`])).ok) {
      throw new Error(`A branch named "${branch}" already exists`)
    }
    const from = want.from ? await validStartPoint(root, want.from) : undefined
    dir = await freeDir(parent, want.branch ? worktreeSlug(branch) : slug)
    args = ['worktree', 'add', '-b', branch, dir, ...(from ? [from] : [])]
  }
  const add = await git(root, args)
  if (!add.ok) {
    throw new Error(lastLine(add.err || add.out))
  }
  return { cwd: dir, branch, repo: root }
}

/**
 * Remove a worktree the app created. Git refuses when it has uncommitted
 * changes unless `force` is set. With `deleteBranch`, its branch goes too,
 * but only when it is merged (`git branch -d`); an unmerged branch is kept
 * and the message says so.
 */
export async function removeWorktree(
  cwd: string,
  baseDir: string,
  force = false,
  deleteBranch = false,
  /** Where a forced removal puts the folder (the OS trash), so nothing is lost for good. */
  trash?: (path: string) => Promise<void>
): Promise<GitActionResult> {
  if (!isAppWorktree(cwd, baseDir)) {
    throw new Error('Not a Pi Desktop worktree')
  }
  const common = await git(cwd, ['rev-parse', '--path-format=absolute', '--git-common-dir'])
  if (!common.ok || !common.out.trim()) {
    return { ok: false, message: 'Worktree is no longer registered with git' }
  }
  const mainRepo = dirname(common.out.trim())
  const branch = (await git(cwd, ['branch', '--show-current'])).out.trim()
  if (force && trash) {
    // Uncommitted files go to the trash with the folder; git then forgets
    // the worktree it can no longer find.
    await trash(cwd)
    await git(mainRepo, ['worktree', 'prune'])
  } else {
    const remove = await git(mainRepo, [
      'worktree',
      'remove',
      ...(force ? ['--force'] : []),
      cwd
    ])
    if (!remove.ok) {
      return { ok: false, message: lastLine(remove.err || remove.out) }
    }
  }
  if (deleteBranch && branch) {
    // Merged branches only (-d): their commits stay reachable. The tip is
    // named so the branch can be made again.
    const del = await git(mainRepo, ['branch', '-d', branch])
    const tip = /\(was ([0-9a-f]+)\)/.exec(del.out)?.[1]
    return {
      ok: true,
      message: del.ok
        ? `Worktree and branch ${branch} removed${tip ? ` (it was at ${tip}: git branch ${branch} ${tip} brings it back)` : ''}`
        : `Worktree removed; ${branch} was kept because it is not merged`
    }
  }
  return { ok: true, message: 'Worktree removed' }
}
