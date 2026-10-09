import { execFile } from 'node:child_process'
import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'

import type { RepoDiffResult, RepoSummary } from '../../shared/api'
import { parsePorcelainStatus } from '../../shared/diff-parse'

const GIT_TIMEOUT_MS = 15_000
const MAX_BUFFER = 32 * 1024 * 1024
const MAX_UNTRACKED_BYTES = 200 * 1024
const MAX_UNTRACKED_FILES = 20

// Non-ASCII paths must come back as UTF-8, not C-quoted, so the renderer
// shows the real file names and parses ---/+++ headers correctly.
const QUOTEPATH_OFF = ['-c', 'core.quotepath=false']

function git(cwd: string, args: string[]): Promise<{ ok: boolean; out: string }> {
  return new Promise((resolvePromise) => {
    execFile(
      'git',
      ['-C', cwd, ...args],
      { timeout: GIT_TIMEOUT_MS, maxBuffer: MAX_BUFFER },
      (error, stdout) => resolvePromise({ ok: !error, out: stdout })
    )
  })
}

function looksBinary(buffer: Buffer): boolean {
  // NUL in the first bytes → treat as binary.
  return buffer.subarray(0, 8192).includes(0)
}

/**
 * Working-tree diff for the diff panel: `git status` + `git diff HEAD`
 * (falling back to unstaged+staged diffs in a repo without commits), plus
 * untracked text files inlined so they render as all-added files.
 */
export async function getRepoDiff(cwd: string): Promise<RepoDiffResult> {
  const inside = await git(cwd, ['rev-parse', '--is-inside-work-tree'])
  if (!inside.ok || inside.out.trim() !== 'true') {
    return { isRepo: false, diffText: '', untracked: [] }
  }

  const [hasHead, status, branch, root] = await Promise.all([
    git(cwd, ['rev-parse', '--verify', 'HEAD']),
    git(cwd, ['status', '--porcelain=v1', '-z', '--untracked-files=all']),
    git(cwd, ['branch', '--show-current']),
    git(cwd, ['rev-parse', '--show-toplevel'])
  ])
  // Porcelain paths are relative to the repo root, not the given cwd.
  const repoRoot = root.ok && root.out.trim() ? root.out.trim() : cwd

  let diffText: string
  if (hasHead.ok) {
    diffText = (
      await git(cwd, [...QUOTEPATH_OFF, 'diff', 'HEAD', '--no-color', '--no-ext-diff'])
    ).out
  } else {
    // No commits yet: combine staged + unstaged diffs.
    const [staged, unstaged] = await Promise.all([
      git(cwd, [...QUOTEPATH_OFF, 'diff', '--cached', '--no-color', '--no-ext-diff']),
      git(cwd, [...QUOTEPATH_OFF, 'diff', '--no-color', '--no-ext-diff'])
    ])
    diffText = staged.out + unstaged.out
  }

  const untrackedPaths = parsePorcelainStatus(status.out)
    .filter((e) => e.status === '??')
    .map((e) => e.path)
    .slice(0, MAX_UNTRACKED_FILES)

  const untracked: { path: string; content: string; binary?: true; tooLarge?: true }[] = []
  for (const path of untrackedPaths) {
    try {
      const full = join(repoRoot, path)
      const info = await stat(full)
      if (!info.isFile()) {
        continue
      }
      // Binary and oversized files get a row too, flagged so the panel can
      // say why there is nothing to show instead of dropping them silently.
      if (info.size > MAX_UNTRACKED_BYTES) {
        untracked.push({ path, content: '', tooLarge: true })
        continue
      }
      const buffer = await readFile(full)
      if (looksBinary(buffer)) {
        untracked.push({ path, content: '', binary: true })
        continue
      }
      untracked.push({ path, content: buffer.toString('utf8') })
    } catch {
      // file disappeared or unreadable — skip
    }
  }

  return {
    isRepo: true,
    branch: branch.ok ? branch.out.trim() || undefined : undefined,
    root: repoRoot,
    diffText,
    untracked
  }
}

/** Parse `git diff --shortstat` ("3 files changed, 12 insertions(+), 4 deletions(-)"). */
export function parseShortstat(text: string): { added: number; removed: number } {
  const added = /(\d+) insertion/.exec(text)
  const removed = /(\d+) deletion/.exec(text)
  return { added: added ? Number(added[1]) : 0, removed: removed ? Number(removed[1]) : 0 }
}

/**
 * Cheap working-tree summary for the chat header: branch, number of changed
 * files (tracked and untracked) and line stats against HEAD.
 */
export async function getRepoSummary(cwd: string): Promise<RepoSummary> {
  const inside = await git(cwd, ['rev-parse', '--is-inside-work-tree'])
  if (!inside.ok || inside.out.trim() !== 'true') {
    return { isRepo: false, files: 0, added: 0, removed: 0 }
  }
  const [status, branch, stat] = await Promise.all([
    git(cwd, ['status', '--porcelain=v1', '-z', '--untracked-files=all']),
    git(cwd, ['branch', '--show-current']),
    git(cwd, [...QUOTEPATH_OFF, 'diff', 'HEAD', '--shortstat', '--no-ext-diff'])
  ])
  const lines = parseShortstat(stat.ok ? stat.out : '')
  return {
    isRepo: true,
    ...(branch.ok && branch.out.trim() ? { branch: branch.out.trim() } : {}),
    files: status.ok ? parsePorcelainStatus(status.out).length : 0,
    ...lines
  }
}
