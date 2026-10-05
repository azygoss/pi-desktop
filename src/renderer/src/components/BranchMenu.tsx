import { Check, ChevronDown, FolderGit2, GitBranch, Plus, Search } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import clsx from 'clsx'

import type { RepoBranches } from '../../../shared/git-branches'
import { usePopoverPlacement } from '../lib/popover-placement'
import { errorText, newChatInWorktree, openWorktreeChat } from '../lib/worktree-actions'
import { toast } from '../state/toast-store'

const PLACEMENT = { max: 480, min: 220 }

type Row =
  | { kind: 'branch'; name: string; current: boolean; worktree?: string; meta: string }
  | { kind: 'remote'; name: string; meta: string }
  | { kind: 'worktree'; path: string; label: string; branch?: string; current: boolean }
  | { kind: 'create-branch'; name: string }
  | { kind: 'create-worktree'; name?: string }

const AGE = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto', style: 'narrow' })

function age(seconds: number): string {
  if (!seconds) {
    return ''
  }
  const diff = seconds - Date.now() / 1000
  const abs = Math.abs(diff)
  if (abs < 3600) {
    return AGE.format(Math.round(diff / 60), 'minute')
  }
  if (abs < 86_400) {
    return AGE.format(Math.round(diff / 3600), 'hour')
  }
  if (abs < 86_400 * 45) {
    return AGE.format(Math.round(diff / 86_400), 'day')
  }
  return AGE.format(Math.round(diff / (86_400 * 30)), 'month')
}

function worktreeLabel(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean)
  return parts.slice(-2).join('/')
}

/**
 * The branch chip in the chat header and its menu: switch this folder to a
 * branch (local or remote), create a branch, open a branch in a new
 * worktree, or jump to one of the repository's worktrees. A chat that is
 * running keeps its branch: pi is working in that folder.
 */
export function BranchMenu({
  cwd,
  branch,
  busy
}: {
  cwd: string
  branch: string | null
  /** pi is running in this folder: no switching under it. */
  busy: boolean
}) {
  const [open, setOpen] = useState(false)
  const [data, setData] = useState<RepoBranches | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [highlight, setHighlight] = useState(0)
  const [working, setWorking] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const placement = usePopoverPlacement(rootRef, open, PLACEMENT)

  // The typed name also searches on the computer (debounced): the list it
  // sends is capped, the search covers every branch.
  const [search, setSearch] = useState('')
  useEffect(() => {
    const timer = setTimeout(() => setSearch(query.trim()), 250)
    return () => clearTimeout(timer)
  }, [query])

  useEffect(() => {
    if (!open) {
      return
    }
    let live = true
    const load = () =>
      window.piDesktop.git
        .branches({ cwd, ...(search ? { query: search } : {}) })
        .then((next) => {
          if (live) {
            setData(next)
            setError(null)
          }
        })
        .catch((e: unknown) => live && setError(errorText(e)))
    void load()
    const off = window.piDesktop.git.onChanged(() => void load())
    const onPointerDown = (e: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    document.addEventListener('pointerdown', onPointerDown)
    return () => {
      live = false
      off()
      document.removeEventListener('pointerdown', onPointerDown)
    }
  }, [open, cwd, search])

  const rows = useMemo<Row[]>(() => {
    if (!data) {
      return []
    }
    const needle = query.trim().toLowerCase()
    const match = (text: string) => !needle || text.toLowerCase().includes(needle)
    const out: Row[] = []
    for (const b of data.branches) {
      if (match(b.name)) {
        const track = [b.ahead ? `↑${b.ahead}` : '', b.behind ? `↓${b.behind}` : '', b.gone ? 'gone' : '']
          .filter(Boolean)
          .join(' ')
        out.push({
          kind: 'branch',
          name: b.name,
          current: b.current,
          ...(b.worktree ? { worktree: b.worktree } : {}),
          meta: [track, age(b.date)].filter(Boolean).join(' · ')
        })
      }
    }
    for (const r of data.remotes) {
      if (match(r.name)) {
        out.push({ kind: 'remote', name: r.name, meta: age(r.date) })
      }
    }
    for (const w of data.worktrees) {
      if (!w.prunable && (match(w.path) || match(w.branch ?? ''))) {
        out.push({
          kind: 'worktree',
          path: w.path,
          label: w.main ? `${worktreeLabel(w.path)} (main checkout)` : worktreeLabel(w.path),
          ...(w.branch ? { branch: w.branch } : {}),
          current: w.current
        })
      }
    }
    const typed = query.trim()
    const exists =
      data.branches.some((b) => b.name === typed) ||
      data.remotes.some((r) => r.name === typed || r.branch === typed)
    if (typed && !exists) {
      out.push({ kind: 'create-branch', name: typed })
      out.push({ kind: 'create-worktree', name: typed })
    } else if (!typed) {
      out.push({ kind: 'create-worktree' })
    }
    return out
  }, [data, query])

  const run = async (row: Row | undefined): Promise<void> => {
    if (!row || working) {
      return
    }
    if (row.kind === 'branch' && row.current) {
      setOpen(false)
      return
    }
    if (row.kind === 'worktree') {
      setOpen(false)
      if (!row.current) {
        await openWorktreeChat(row.path)
      }
      return
    }
    if (row.kind === 'branch' && row.worktree) {
      // Git checks a branch out in one place only: go to where it is.
      setOpen(false)
      await openWorktreeChat(row.worktree)
      return
    }
    if (row.kind === 'create-worktree') {
      setWorking(true)
      const ok = await newChatInWorktree(
        cwd,
        row.name ? { kind: 'new', branch: row.name } : undefined
      )
      setWorking(false)
      if (ok) {
        setOpen(false)
      }
      return
    }
    if (busy) {
      toast('pi is working in this folder: wait for it to finish, or use a worktree')
      return
    }
    setWorking(true)
    try {
      const result =
        row.kind === 'create-branch'
          ? await window.piDesktop.git.createBranch({ cwd, name: row.name })
          : await window.piDesktop.git.switchBranch({ cwd, branch: row.name })
      toast(result.ok ? result.message : `Git refused: ${result.message}`)
      if (result.ok) {
        setOpen(false)
      }
    } catch (e) {
      toast(errorText(e))
    } finally {
      setWorking(false)
    }
  }

  const inWorktree = async (name: string): Promise<void> => {
    setWorking(true)
    const ok = await newChatInWorktree(cwd, { kind: 'existing', branch: name })
    setWorking(false)
    if (ok) {
      setOpen(false)
    }
  }

  const onKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setHighlight((h) => Math.min(h + 1, rows.length - 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setHighlight((h) => Math.max(h - 1, 0))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      void run(rows[highlight])
    } else if (e.key === 'Escape') {
      e.preventDefault()
      setOpen(false)
    }
  }

  const sectionOf = (row: Row): string =>
    row.kind === 'branch'
      ? 'Branches'
      : row.kind === 'remote'
        ? 'Remote branches'
        : row.kind === 'worktree'
          ? 'Worktrees'
          : ''

  return (
    <div className="branch-menu" ref={rootRef}>
      <button
        type="button"
        className="repo-chip"
        data-testid="branch-chip"
        title="Branches and worktrees"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => {
          if (!open) {
            setQuery('')
            setHighlight(0)
          }
          setOpen(!open)
        }}
      >
        <GitBranch size={11} />
        <span className="repo-chip-branch">{branch ?? 'detached'}</span>
        <ChevronDown size={10} className="branch-chevron" />
      </button>
      {open && (
        <div
          className={clsx('model-popover branch-popover', { 'popover-below': placement.below })}
          style={{ maxHeight: placement.maxHeight }}
          data-testid="branch-popover"
        >
          <div className="model-search">
            <Search size={13} />
            <input
              autoFocus
              value={query}
              onChange={(e) => {
                setQuery(e.target.value)
                setHighlight(0)
              }}
              onKeyDown={onKeyDown}
              placeholder="Switch to a branch or name a new one"
              spellCheck={false}
              aria-label="Branch name"
            />
          </div>
          {data && data.changes > 0 && (
            <div className="branch-note">
              {data.changes} changed {data.changes === 1 ? 'file comes' : 'files come'} along on a
              switch (git refuses if they would be overwritten)
            </div>
          )}
          {data?.truncated && (
            <div className="branch-note">Showing the newest branches: type to search them all</div>
          )}
          {busy && <div className="branch-note">pi is working here: switching waits until it is done</div>}
          <div className="model-list">
            {error && <div className="model-empty">{error}</div>}
            {!data && !error && <div className="model-empty">Reading branches…</div>}
            {rows.map((row, i) => {
              const section = sectionOf(row)
              const header = section && (i === 0 || sectionOf(rows[i - 1]!) !== section) ? section : null
              return (
                <div key={`${row.kind}:${'name' in row ? row.name : 'path' in row ? row.path : i}`}>
                  {header && <div className="model-provider">{header}</div>}
                  <div
                    className={clsx('model-row branch-row', { 'is-highlight': i === highlight })}
                    role="button"
                    tabIndex={-1}
                    data-testid={`branch-row-${row.kind}`}
                    onMouseEnter={() => setHighlight(i)}
                    onClick={() => void run(row)}
                  >
                    <span className="model-check">
                      {row.kind === 'branch' && row.current && <Check size={13} />}
                      {(row.kind === 'create-branch' || row.kind === 'create-worktree') && (
                        <Plus size={13} />
                      )}
                      {row.kind === 'worktree' && <FolderGit2 size={13} />}
                    </span>
                    <span className="model-row-name">
                      {row.kind === 'create-branch'
                        ? `Create branch “${row.name}” from ${branch ?? 'HEAD'}`
                        : row.kind === 'create-worktree'
                          ? row.name
                            ? `New worktree chat on “${row.name}”`
                            : 'New worktree chat (new pi/ branch)'
                          : row.kind === 'worktree'
                            ? row.label
                            : row.name}
                    </span>
                    <span className="model-row-hint">
                      {row.kind === 'branch' && row.worktree
                        ? 'in a worktree'
                        : row.kind === 'worktree'
                          ? row.current
                            ? 'here'
                            : (row.branch ?? 'detached')
                          : row.kind === 'branch' || row.kind === 'remote'
                            ? row.meta
                            : ''}
                    </span>
                    {(row.kind === 'branch' || row.kind === 'remote') &&
                      !(row.kind === 'branch' && (row.current || row.worktree)) && (
                        <button
                          type="button"
                          className="icon-btn branch-row-action"
                          title={`Open ${row.name} in a new worktree chat`}
                          aria-label={`Open ${row.name} in a new worktree chat`}
                          onClick={(e) => {
                            e.stopPropagation()
                            void inWorktree(row.name)
                          }}
                        >
                          <FolderGit2 size={12} />
                        </button>
                      )}
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      )}
    </div>
  )
}
