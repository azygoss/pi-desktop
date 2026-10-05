import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

import type { PiReviewComment, ReviewComment } from '../../shared/review'

/** Per project; a review pass adds at most 20, the rest are yours. */
export const MAX_COMMENTS_PER_PROJECT = 200
const MAX_TEXT = 4000
const MAX_LINE_TEXT = 1000
const MAX_PATH = 1000
const MAX_PROJECTS = 200
/** Ids or paths one request may name. */
const MAX_LIST = 500

function cleanPath(value: unknown): string {
  if (typeof value !== 'string') {
    throw new Error('Invalid path')
  }
  const path = value.replace(/\\/g, '/').replace(/^\.\//, '').trim()
  if (
    !path ||
    path.length > MAX_PATH ||
    path.startsWith('/') ||
    path.split('/').includes('..') ||
    // eslint-disable-next-line no-control-regex
    /[\u0000-\u001f\u007f]/.test(path)
  ) {
    throw new Error('Invalid path')
  }
  return path
}

/** The strings of a request's id or path list, bounded. */
function stringList(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > MAX_LIST) {
    throw new Error('Invalid list')
  }
  return value.filter((item): item is string => typeof item === 'string' && item.length <= MAX_PATH)
}

function cleanLine(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : undefined
}

function isComment(value: unknown): value is ReviewComment {
  if (value === null || typeof value !== 'object') {
    return false
  }
  const c = value as Record<string, unknown>
  return (
    typeof c['id'] === 'string' &&
    typeof c['path'] === 'string' &&
    typeof c['lineText'] === 'string' &&
    typeof c['text'] === 'string' &&
    typeof c['createdAt'] === 'number' &&
    (c['line'] === undefined || typeof c['line'] === 'number') &&
    (c['author'] === undefined || c['author'] === 'pi')
  )
}

/**
 * The diff comments of every project, kept on the computer so each window
 * and paired phone shows the same list, and they outlive the screen they
 * were written on. Stored in the app's data directory (0600), keyed by the
 * project folder; a commit clears a project's list.
 */
export class ReviewCommentStore {
  private cache: Map<string, ReviewComment[]> | null = null
  /** Changes run one at a time, each from the list the previous one left. */
  private queue: Promise<unknown> = Promise.resolve()

  constructor(
    private readonly file: string,
    private readonly onChange: (cwd: string, comments: ReviewComment[]) => void
  ) {}

  private async load(): Promise<Map<string, ReviewComment[]>> {
    if (this.cache) {
      return this.cache
    }
    const cache = new Map<string, ReviewComment[]>()
    try {
      const raw = JSON.parse(await readFile(this.file, 'utf8')) as { projects?: unknown }
      if (raw.projects && typeof raw.projects === 'object') {
        for (const [cwd, list] of Object.entries(raw.projects as Record<string, unknown>)) {
          if (Array.isArray(list)) {
            const comments = list.filter(isComment).slice(0, MAX_COMMENTS_PER_PROJECT)
            if (comments.length > 0) {
              cache.set(cwd, comments)
            }
          }
        }
      }
    } catch {
      // No store yet, or unreadable: start empty.
    }
    this.cache ??= cache
    return this.cache
  }

  /** Run a read-modify-write change after the ones before it. */
  private serial<T>(change: () => Promise<T>): Promise<T> {
    const run = this.queue.then(change, change)
    this.queue = run.catch(() => {})
    return run
  }

  /**
   * Write the project's new list, then make it current and announce it. A
   * failed write throws and leaves the list as it was, so a screen never
   * shows a comment the computer could not keep.
   */
  private async commit(cwd: string, comments: ReviewComment[]): Promise<ReviewComment[]> {
    const next = new Map(await this.load())
    next.delete(cwd) // most recently touched last, so the oldest go first
    if (comments.length > 0) {
      next.set(cwd, comments)
      while (next.size > MAX_PROJECTS) {
        next.delete(next.keys().next().value!)
      }
    }
    const tmp = `${this.file}.tmp-${process.pid}`
    await mkdir(dirname(this.file), { recursive: true, mode: 0o700 })
    await writeFile(tmp, JSON.stringify({ version: 1, projects: Object.fromEntries(next) }), {
      mode: 0o600
    })
    await rename(tmp, this.file)
    this.cache = next
    this.onChange(cwd, comments)
    return comments
  }

  async list(cwd: string): Promise<ReviewComment[]> {
    return [...((await this.load()).get(cwd) ?? [])]
  }

  /** Add one of your comments. */
  async add(
    cwd: string,
    input: { path: unknown; line?: unknown; lineText?: unknown; text: unknown }
  ): Promise<ReviewComment> {
    return this.serial(() => this.addNow(cwd, input))
  }

  private async addNow(
    cwd: string,
    input: { path: unknown; line?: unknown; lineText?: unknown; text: unknown }
  ): Promise<ReviewComment> {
    const text = typeof input.text === 'string' ? input.text.trim().slice(0, MAX_TEXT) : ''
    if (!text) {
      throw new Error('The comment is empty')
    }
    const current = await this.list(cwd)
    if (current.length >= MAX_COMMENTS_PER_PROJECT) {
      throw new Error(`A project holds up to ${MAX_COMMENTS_PER_PROJECT} comments`)
    }
    const line = cleanLine(input.line)
    const comment: ReviewComment = {
      id: randomUUID(),
      path: cleanPath(input.path),
      ...(line !== undefined ? { line } : {}),
      lineText:
        typeof input.lineText === 'string' ? input.lineText.slice(0, MAX_LINE_TEXT) : '',
      text,
      createdAt: Date.now()
    }
    await this.commit(cwd, [...current, comment])
    return comment
  }

  /** A review pass's remarks replace pi's earlier ones; yours stay. */
  replacePi(cwd: string, remarks: readonly PiReviewComment[]): Promise<ReviewComment[]> {
    return this.serial(() => this.replacePiNow(cwd, remarks))
  }

  private async replacePiNow(
    cwd: string,
    remarks: readonly PiReviewComment[]
  ): Promise<ReviewComment[]> {
    const now = Date.now()
    const yours = (await this.list(cwd)).filter((c) => c.author !== 'pi')
    const pi: ReviewComment[] = []
    for (const remark of remarks) {
      let path: string
      try {
        path = cleanPath(remark.path)
      } catch {
        continue
      }
      const line = cleanLine(remark.line)
      pi.push({
        id: randomUUID(),
        path,
        ...(line !== undefined ? { line } : {}),
        lineText: '',
        text: remark.comment.slice(0, MAX_TEXT),
        author: 'pi',
        createdAt: now
      })
    }
    return this.commit(cwd, [...yours, ...pi].slice(0, MAX_COMMENTS_PER_PROJECT))
  }

  async remove(cwd: string, ids: unknown): Promise<ReviewComment[]> {
    const drop = new Set(stringList(ids))
    return this.serial(async () => {
      const current = await this.list(cwd)
      const next = current.filter((c) => !drop.has(c.id))
      return next.length === current.length ? current : this.commit(cwd, next)
    })
  }

  /**
   * Remove the comments on `paths` (a file whose changes were discarded),
   * or all of them (after a commit, or once they went to pi).
   */
  async clear(cwd: string, paths?: unknown): Promise<ReviewComment[]> {
    const only = paths === undefined ? null : new Set(stringList(paths))
    return this.serial(async () => {
      const current = await this.list(cwd)
      const next = only ? current.filter((c) => !only.has(c.path)) : []
      return next.length === current.length ? current : this.commit(cwd, next)
    })
  }
}
