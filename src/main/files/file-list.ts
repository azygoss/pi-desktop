import { execFile } from 'node:child_process'
import { readdir, stat } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'

/**
 * Project file listing for the composer's @-mention picker. In a git repo we
 * ask git for tracked + untracked-but-not-ignored paths; elsewhere a bounded
 * async walk skips the usual noise directories. Results are capped and
 * cached per cwd for 30 seconds.
 */

const MAX_FILES = 20_000
const CACHE_TTL_MS = 30_000
const GIT_TIMEOUT_MS = 3_000

const SKIP_DIRS = new Set([
  '.git',
  'node_modules',
  'dist',
  'build',
  'out',
  '.next',
  'target',
  '.venv',
  '__pycache__'
])

const cache = new Map<string, string[] | Promise<string[]>>()
const cacheAt = new Map<string, number>()

function runGit(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    execFile(
      'git',
      ['-C', cwd, ...args],
      { timeout: GIT_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024 },
      (error, stdout) => (error ? reject(error) : resolvePromise(stdout))
    )
  })
}

async function listViaGit(cwd: string): Promise<string[] | null> {
  try {
    const inside = await runGit(cwd, ['rev-parse', '--is-inside-work-tree'])
    if (inside.trim() !== 'true') {
      return null
    }
    const out = await runGit(cwd, ['ls-files', '-co', '--exclude-standard', '-z'])
    return out.split('\0').filter(Boolean).slice(0, MAX_FILES)
  } catch {
    return null
  }
}

async function listViaWalk(cwd: string): Promise<string[]> {
  const files: string[] = []
  async function walk(dir: string): Promise<void> {
    if (files.length >= MAX_FILES) {
      return
    }
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (files.length >= MAX_FILES) {
        return
      }
      if (entry.name.startsWith('.') || SKIP_DIRS.has(entry.name)) {
        continue
      }
      const full = join(dir, entry.name)
      // Dirent flags don't follow symlinks — stat them to decide.
      const resolved = entry.isSymbolicLink()
        ? await stat(full)
            .then((s) => ({ dir: s.isDirectory(), file: s.isFile() }))
            .catch(() => null)
        : { dir: entry.isDirectory(), file: entry.isFile() }
      if (resolved?.dir) {
        await walk(full)
      } else if (resolved?.file) {
        files.push(relative(cwd, full).split(sep).join('/'))
      }
    }
  }
  await walk(cwd)
  return files.sort()
}

/**
 * Relative file paths under `cwd` (forward slashes), up to 20k entries.
 * Cached per cwd for 30s — concurrent callers share the in-flight scan.
 */
export function listProjectFiles(cwd: string): Promise<string[]> {
  const now = Date.now()
  const cached = cache.get(cwd)
  if (cached && now - (cacheAt.get(cwd) ?? 0) < CACHE_TTL_MS) {
    return Promise.resolve(cached)
  }
  const pending = (async () => {
    const git = await listViaGit(cwd)
    return git ?? (await listViaWalk(cwd))
  })()
  cache.set(cwd, pending)
  cacheAt.set(cwd, now)
  return pending.then((files) => {
    cache.set(cwd, files)
    return files
  })
}

/** Test hook. */
export function clearFileListCache(): void {
  cache.clear()
  cacheAt.clear()
}
