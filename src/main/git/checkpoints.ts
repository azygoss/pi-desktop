import { execFile } from 'node:child_process'
import { copyFile, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { CheckpointRestoreResult } from '../../shared/api'

const GIT_TIMEOUT_MS = 30_000
const TREE_RE = /^[0-9a-f]{40,64}$/

interface GitRun {
  ok: boolean
  out: string
  err: string
}

function git(
  cwd: string,
  args: string[],
  env?: Record<string, string>,
  input?: string
): Promise<GitRun> {
  return new Promise((resolvePromise) => {
    const child = execFile(
      'git',
      ['-C', cwd, ...args],
      {
        timeout: GIT_TIMEOUT_MS,
        maxBuffer: 64 * 1024 * 1024,
        env: { ...process.env, ...env }
      },
      (error, stdout, stderr) => resolvePromise({ ok: !error, out: stdout, err: stderr })
    )
    if (input !== undefined) {
      child.stdin?.end(input)
    }
  })
}

async function repoRoot(cwd: string): Promise<string | null> {
  const top = await git(cwd, ['rev-parse', '--show-toplevel'])
  return top.ok && top.out.trim() ? top.out.trim() : null
}

/**
 * Run `fn` with a scratch index seeded from the repository's own, so git
 * can reuse its stat cache; the real index (the user's staging) is never
 * written.
 */
async function withScratchIndex<T>(
  root: string,
  fn: (env: Record<string, string>) => Promise<T>
): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'pi-desktop-index-'))
  const index = join(dir, 'index')
  try {
    const real = await git(root, ['rev-parse', '--path-format=absolute', '--git-path', 'index'])
    if (real.ok && real.out.trim()) {
      await copyFile(real.out.trim(), index).catch(() => {})
    }
    return await fn({ GIT_INDEX_FILE: index })
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

/** Tree of everything in the working tree now: tracked and untracked, not ignored. */
async function snapshotTree(root: string): Promise<string | null> {
  return withScratchIndex(root, async (env) => {
    const add = await git(root, ['add', '-A'], env)
    if (!add.ok) {
      return null
    }
    const tree = await git(root, ['write-tree'], env)
    const hash = tree.out.trim()
    return tree.ok && TREE_RE.test(hash) ? hash : null
  })
}

/**
 * Record the project's files as they are now, as a git tree object. Nothing
 * in the repository changes: no commit, no ref, no staging. Returns null
 * outside a git repository. The object stays until git's own garbage
 * collection prunes unreferenced objects (two weeks by default).
 */
export async function createCheckpoint(cwd: string): Promise<string | null> {
  const root = await repoRoot(cwd)
  return root ? snapshotTree(root) : null
}

/**
 * Put the working tree back to a checkpoint: files changed or deleted since
 * are restored, files created since are handed to `trash` (the OS trash,
 * never unlink). The state just before restoring is itself checkpointed and
 * returned as `undo`.
 */
export async function restoreCheckpoint(
  cwd: string,
  tree: unknown,
  trash: (absolutePath: string) => Promise<void>
): Promise<CheckpointRestoreResult> {
  if (typeof tree !== 'string' || !TREE_RE.test(tree)) {
    throw new Error('Invalid checkpoint')
  }
  const root = await repoRoot(cwd)
  if (!root) {
    throw new Error('Not a git repository')
  }
  const kind = await git(root, ['cat-file', '-t', tree])
  if (!kind.ok || kind.out.trim() !== 'tree') {
    throw new Error('That checkpoint is no longer available')
  }
  const current = await snapshotTree(root)
  if (!current) {
    throw new Error('Could not read the working tree')
  }
  if (current === tree) {
    return { restored: 0, trashed: 0, undo: current }
  }
  // What happened to each path between the checkpoint and now.
  const diff = await git(root, ['diff', '--name-status', '--no-renames', '-z', tree, current])
  if (!diff.ok) {
    throw new Error('Could not compare with the checkpoint')
  }
  const parts = diff.out.split('\0')
  const created: string[] = []
  const changed: string[] = []
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const status = parts[i]!
    const path = parts[i + 1]!
    if (!path) {
      continue
    }
    if (status === 'A') {
      created.push(path)
    } else {
      changed.push(path)
    }
  }
  if (changed.length > 0) {
    const restored = await withScratchIndex(root, async (env) => {
      const read = await git(root, ['read-tree', tree], env)
      if (!read.ok) {
        return false
      }
      const checkout = await git(
        root,
        ['checkout-index', '-f', '-z', '--stdin'],
        env,
        changed.join('\0') + '\0'
      )
      return checkout.ok
    })
    if (!restored) {
      throw new Error('Could not restore the files')
    }
  }
  for (const path of created) {
    await trash(join(root, path)).catch(() => {})
  }
  return { restored: changed.length, trashed: created.length, undo: current }
}
