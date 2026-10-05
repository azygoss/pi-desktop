/**
 * A repository's branches and worktrees, as the branch menu shows them.
 * Pure parsers for git's output live here so they can be tested without git.
 */

export interface LocalBranch {
  name: string
  /** Checked out in this folder. */
  current: boolean
  /** e.g. "origin/main". */
  upstream?: string
  ahead?: number
  behind?: number
  /** The upstream branch is gone (deleted on the remote). */
  gone?: boolean
  /** Last commit, seconds since the epoch. */
  date: number
  subject: string
  /** Checked out in another worktree at this path. */
  worktree?: string
}

export interface RemoteBranch {
  /** e.g. "origin/feature-x". */
  name: string
  remote: string
  /** e.g. "feature-x": the local branch a switch would create. */
  branch: string
  date: number
  subject: string
}

export interface WorktreeEntry {
  path: string
  /** Short branch name; absent on a detached HEAD. */
  branch?: string
  head: string
  /** The worktree this request came from. */
  current: boolean
  /** The repository's main checkout. */
  main: boolean
  /** One the app created (under its worktrees folder). */
  app: boolean
  /** Its folder is gone; `git worktree prune` would drop it. */
  prunable: boolean
}

export interface RepoBranches {
  /** Top of this checkout. */
  root: string
  /** Checked-out branch, or null on a detached HEAD. */
  current: string | null
  /** Changed files in this checkout (a switch carries them along). */
  changes: number
  branches: LocalBranch[]
  /** Remote branches without a local branch of the same name. */
  remotes: RemoteBranch[]
  worktrees: WorktreeEntry[]
  /** More branches matched than were sent: narrow the search to see the rest. */
  truncated: boolean
}

/** What a new worktree checks out. */
export type WorktreeSource =
  /** A new branch (named, or pi/<slug>) cut from `from` (HEAD when absent). */
  | { kind: 'new'; branch?: string; from?: string }
  /** An existing local branch, or a remote one (a tracking branch is made). */
  | { kind: 'existing'; branch: string }

/** Field separator in for-each-ref formats: a character git never emits in them. */
export const FIELD = '\u001f'

export const LOCAL_FORMAT = [
  '%(refname:short)',
  '%(HEAD)',
  '%(upstream:short)',
  '%(upstream:track,nobracket)',
  '%(committerdate:unix)',
  '%(worktreepath)',
  '%(subject)'
].join(FIELD)

export const REMOTE_FORMAT = [
  '%(refname:short)',
  '%(symref)',
  '%(committerdate:unix)',
  '%(subject)'
].join(FIELD)

const MAX_SUBJECT = 200

/** `git for-each-ref refs/heads` output (LOCAL_FORMAT), newest first. */
export function parseLocalBranches(out: string, cwdTop: string): LocalBranch[] {
  const branches: LocalBranch[] = []
  for (const line of out.split('\n')) {
    if (!line.trim()) {
      continue
    }
    const [name = '', head, upstream, track = '', date, worktree, ...subject] = line.split(FIELD)
    if (!name) {
      continue
    }
    const ahead = /ahead (\d+)/.exec(track)
    const behind = /behind (\d+)/.exec(track)
    branches.push({
      name,
      current: head === '*',
      ...(upstream ? { upstream } : {}),
      ...(ahead ? { ahead: Number(ahead[1]) } : {}),
      ...(behind ? { behind: Number(behind[1]) } : {}),
      ...(track === 'gone' ? { gone: true } : {}),
      date: Number(date) || 0,
      subject: subject.join(FIELD).slice(0, MAX_SUBJECT),
      // Checked out elsewhere: the menu offers to open that worktree.
      ...(worktree && worktree !== cwdTop && head !== '*' ? { worktree } : {})
    })
  }
  return branches.sort((a, b) => Number(b.current) - Number(a.current) || b.date - a.date)
}

/**
 * `git for-each-ref refs/remotes` output (REMOTE_FORMAT): remote branches
 * that have no local branch of the same name, newest first.
 */
export function parseRemoteBranches(out: string, local: ReadonlySet<string>): RemoteBranch[] {
  const remotes: RemoteBranch[] = []
  for (const line of out.split('\n')) {
    if (!line.trim()) {
      continue
    }
    const [name = '', symref, date, ...subject] = line.split(FIELD)
    const slash = name.indexOf('/')
    // origin/HEAD is a pointer, and a bare remote name has no branch.
    if (symref || slash <= 0 || slash === name.length - 1) {
      continue
    }
    const branch = name.slice(slash + 1)
    if (local.has(branch)) {
      continue
    }
    remotes.push({
      name,
      remote: name.slice(0, slash),
      branch,
      date: Number(date) || 0,
      subject: subject.join(FIELD).slice(0, MAX_SUBJECT)
    })
  }
  return remotes.sort((a, b) => b.date - a.date)
}

/** `git worktree list --porcelain` output. The first entry is the main checkout. */
export function parseWorktrees(
  out: string,
  cwdTop: string,
  isApp: (path: string) => boolean
): WorktreeEntry[] {
  const entries: WorktreeEntry[] = []
  for (const block of out.split(/\n\s*\n/)) {
    let path = ''
    let head = ''
    let branch: string | undefined
    let prunable = false
    let bare = false
    for (const line of block.split('\n')) {
      if (line.startsWith('worktree ')) {
        path = line.slice('worktree '.length)
      } else if (line.startsWith('HEAD ')) {
        head = line.slice('HEAD '.length)
      } else if (line.startsWith('branch ')) {
        branch = line.slice('branch '.length).replace(/^refs\/heads\//, '')
      } else if (line.startsWith('prunable')) {
        prunable = true
      } else if (line === 'bare') {
        bare = true
      }
    }
    if (!path || bare) {
      continue
    }
    entries.push({
      path,
      ...(branch ? { branch } : {}),
      head,
      current: path === cwdTop,
      main: entries.length === 0,
      app: isApp(path),
      prunable
    })
  }
  return entries
}

/**
 * A folder name for a worktree of `branch`: its last path segment, kept to
 * letters, digits, dots, dashes and underscores.
 */
export function worktreeSlug(branch: string): string {
  const last = branch.split('/').filter(Boolean).pop() ?? ''
  const slug = last
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .slice(0, 48)
  return slug || 'worktree'
}
