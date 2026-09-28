import {
  ArrowUp,
  Check,
  ClipboardPaste,
  File as FileIcon,
  FileCode,
  FileText,
  Folder,
  FolderPlus,
  Globe,
  Image as ImageIcon,
  MousePointerClick,
  Paperclip,
  Plus,
  Search,
  Square,
  SquareTerminal,
  X
} from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import clsx from 'clsx'

import type { ChatSendMode, CuaPermissions } from '../../../shared/api'
import type { ImageContent, ThinkingLevel } from '../../../shared/pi-types'
import { executeAppCommand } from '../lib/app-commands'
import { contextRingVisible } from '../lib/context-ring'
import { fuzzyFilter } from '../lib/fuzzy'
import {
  appendAttachmentRefs,
  formatMention,
  mentionTrigger
} from '../lib/mentions'
import {
  filterSlashCommands,
  findAppCommand,
  flattenSlashGroups,
  parseSlashSend,
  slashQuery
} from '../lib/slash-commands'
import { warmProjectSoon } from '../lib/warm'
import { useAppStore } from '../state/app-store'
import { useChatStore, type ChatState } from '../state/chat-store'
import { usePanelStore } from '../state/panel-store'
import { toast } from '../state/toast-store'
import { ModelPicker } from './ModelPicker'

const MAX_IMAGES = 8
const IMAGE_MIME = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp'])
const MAX_IMAGE_BYTES = 20 * 1024 * 1024
const MAX_MENTION_RESULTS = 50

/** A non-image attachment — sent as an @path reference appended to the text. */
interface FileChip {
  path: string
  name: string
  size: number
}

function formatSize(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

const CODE_EXT = new Set([
  'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'py', 'rb', 'go', 'rs', 'swift',
  'c', 'h', 'cpp', 'hpp', 'java', 'kt', 'cs', 'php', 'sh', 'zsh', 'bash',
  'css', 'scss', 'html', 'vue', 'svelte', 'sql', 'lua', 'r', 'scala', 'pl',
  'json', 'yaml', 'yml', 'toml', 'xml', 'mjs'
])
const TEXT_EXT = new Set(['md', 'txt', 'markdown', 'rst', 'csv', 'log', 'tex'])

function fileIconFor(name: string): typeof FileIcon {
  const ext = name.split('.').pop()?.toLowerCase() ?? ''
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'heic', 'bmp'].includes(ext)) {
    return ImageIcon
  }
  if (CODE_EXT.has(ext)) {
    return FileCode
  }
  if (TEXT_EXT.has(ext)) {
    return FileText
  }
  return FileIcon
}

interface ComposerProps {
  chat: ChatState | null
  /** True when docked in a chat view (enables chat-only slash commands). */
  isChat?: boolean
  placeholder?: string
  autoFocus?: boolean
  onSend(message: string, images: ImageContent[], mode: ChatSendMode): void
}

function fileToImage(file: File): Promise<ImageContent | null> {
  if (!IMAGE_MIME.has(file.type) || file.size > MAX_IMAGE_BYTES) {
    return Promise.resolve(null)
  }
  return new Promise((resolve) => {
    const reader = new FileReader()
    reader.onload = () => {
      const url = String(reader.result)
      const base64 = url.slice(url.indexOf(',') + 1)
      resolve({ type: 'image', data: base64, mimeType: file.type })
    }
    reader.onerror = () => resolve(null)
    reader.readAsDataURL(file)
  })
}

/** Subtle "Starting pi… Ns" line while the chat's pi process warms up. */
function StartingPiStatus({ startedAt, hint }: { startedAt?: number; hint?: string }) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [])
  const seconds = startedAt ? Math.max(0, Math.round((now - startedAt) / 1000)) : 0
  return (
    <div className="composer-status" role="status">
      <span className="composer-status-dot" />
      {seconds > 0 ? `Starting pi… ${seconds}s` : 'Starting pi…'}
      {hint && <span className="composer-status-hint"> — {hint}</span>}
    </div>
  )
}

function formatTokens(n: number): string {
  if (n < 1000) {
    return `${n}`
  }
  const k = n / 1000
  return `${k % 1 === 0 ? k : k.toFixed(1)}k`
}

/**
 * Context-usage ring between the model picker and the send button. Opens a
 * popover with the token breakdown, session cost and a compact action.
 */
function ContextRing({ chat }: { chat: ChatState }) {
  const [open, setOpen] = useState(false)
  const wrapRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) {
      return
    }
    const close = (e: PointerEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpen(false)
      }
    }
    document.addEventListener('pointerdown', close)
    window.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('pointerdown', close)
      window.removeEventListener('keydown', onKey)
    }
  }, [open])

  const stats = chat.stats
  if (!contextRingVisible(stats)) {
    return null
  }
  const pct = stats!.contextUsage!.percent!
  const clamped = Math.max(0, Math.min(100, pct))
  const tone = clamped >= 90 ? 'danger' : clamped >= 75 ? 'warning' : 'muted'
  const used = stats?.contextUsage?.tokens
  const window_ = stats?.contextUsage?.contextWindow
  const tokens = stats?.tokens
  const cost = stats?.cost
  const streaming = chat.status === 'streaming'
  // r=7 circle in an 18px box.
  const radius = 7
  const circumference = 2 * Math.PI * radius
  const compact = () => {
    setOpen(false)
    void window.piDesktop.chat.compact({ chatId: chat.chatId }).catch(() => {})
  }
  return (
    <div className="ctx-wrap" ref={wrapRef}>
      <button
        type="button"
        className={`ctx-ring ctx-${tone}`}
        title={`${Math.round(clamped)}% of context used`}
        aria-label={`${Math.round(clamped)}% of context used`}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true">
          <circle className="ctx-track" cx="9" cy="9" r={radius} />
          <circle
            className="ctx-arc"
            cx="9"
            cy="9"
            r={radius}
            strokeDasharray={circumference}
            strokeDashoffset={circumference * (1 - clamped / 100)}
            transform="rotate(-90 9 9)"
          />
        </svg>
      </button>
      {open && (
        <div className="folder-popover ctx-popover" role="dialog">
          <div className="ctx-popover-title">Context</div>
          {typeof used === 'number' && typeof window_ === 'number' ? (
            <div className="ctx-popover-row ctx-popover-strong">
              {formatTokens(used)} / {formatTokens(window_)} ({Math.round(clamped)}%)
            </div>
          ) : (
            <div className="ctx-popover-row ctx-popover-strong">
              {Math.round(clamped)}% used
            </div>
          )}
          <div className="ctx-bar">
            <div
              className={`ctx-bar-fill ctx-bar-${tone}`}
              style={{ width: `${clamped}%` }}
            />
          </div>
          {tokens && (
            <div className="ctx-tokens">
              {(
                [
                  ['Input', tokens.input],
                  ['Output', tokens.output],
                  ['Cache read', tokens.cacheRead],
                  ['Cache write', tokens.cacheWrite]
                ] as const
              )
                .filter(([, v]) => typeof v === 'number' && v > 0)
                .map(([label, v]) => (
                  <div key={label} className="ctx-popover-row">
                    <span>{label}</span>
                    <span className="ctx-value">{formatTokens(v)}</span>
                  </div>
                ))}
            </div>
          )}
          {typeof cost === 'number' && cost > 0 && (
            <div className="ctx-popover-row">
              <span>Session cost</span>
              <span className="ctx-value">${cost.toFixed(cost < 0.01 ? 4 : 2)}</span>
            </div>
          )}
          <div className="ctx-popover-actions">
            <button
              type="button"
              className="ui-btn ctx-compact"
              disabled={streaming}
              title={streaming ? 'Wait for the current run to finish' : undefined}
              onClick={compact}
            >
              Compact now
            </button>
          </div>
          <div className="ctx-popover-note">pi auto-compacts near the limit</div>
        </div>
      )}
    </div>
  )
}

export function Composer({ chat, isChat, placeholder, autoFocus, onSend }: ComposerProps) {
  const [text, setText] = useState('')
  const [images, setImages] = useState<ImageContent[]>([])
  const [chips, setChips] = useState<FileChip[]>([])
  const [dragging, setDragging] = useState(false)
  const dragDepth = useRef(0)
  const [folderOpen, setFolderOpen] = useState(false)
  const [plusOpen, setPlusOpen] = useState(false)
  const [plusHighlight, setPlusHighlight] = useState(0)
  const [clipHasImage, setClipHasImage] = useState(false)
  const [cuaPerms, setCuaPerms] = useState<CuaPermissions | null>(null)
  const [slashHighlight, setSlashHighlight] = useState(0)
  const [slashDismissed, setSlashDismissed] = useState(false)
  const [modelSignal, setModelSignal] = useState(0)
  const [cursor, setCursor] = useState(0)
  const [projectFiles, setProjectFiles] = useState<string[]>([])
  const [mentionHighlight, setMentionHighlight] = useState(0)
  const [mentionDismissed, setMentionDismissed] = useState(false)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const folderRef = useRef<HTMLDivElement>(null)
  const plusRef = useRef<HTMLDivElement>(null)

  const computerUseEnabled = useAppStore(
    (s) => s.appSettings.computerUse?.enabled ?? true
  )

  const projects = useAppStore((s) => s.projects)
  const workspaceDir = useAppStore((s) => s.appInfo?.workspaceDir ?? '')
  const homeDir = useAppStore((s) => s.appInfo?.homeDir ?? '')
  const [projectQuery, setProjectQuery] = useState('')

  const inChat = isChat === true && chat !== null
  const query = slashQuery(text)
  const isStreaming = chat?.status === 'streaming'
  const slashGroups = useMemo(
    () =>
      query === null
        ? []
        : filterSlashCommands(chat?.commands ?? [], query, inChat, isStreaming),
    [query, chat?.commands, inChat, isStreaming]
  )
  const slashItems = useMemo(() => flattenSlashGroups(slashGroups), [slashGroups])
  const slashOpen = query !== null && !slashDismissed && slashItems.length > 0

  const streaming = chat?.status === 'streaming'
  const canSend = text.trim().length > 0 || images.length > 0 || chips.length > 0
  const cwd = chat?.cwd ?? workspaceDir
  const projectless =
    cwd === '' || cwd === workspaceDir || (homeDir !== '' && cwd === homeDir)

  // `@` mention detection at the caret — only meaningful with a project cwd.
  const mention = mentionDismissed ? null : mentionTrigger(text, cursor)
  const mentionOpen = mention !== null
  const mentionItems = useMemo(
    () =>
      mention === null || projectless
        ? []
        : fuzzyFilter(mention.query, projectFiles, (f) => f).slice(
            0,
            MAX_MENTION_RESULTS
          ),
    [mention, projectFiles, projectless]
  )
  const cwdBase = projectless
    ? 'Without project'
    : (cwd.split('/').filter(Boolean).pop() ?? cwd)
  // Draft chats can move between projects; a chat with history is anchored
  // to the cwd recorded in its session.
  const cwdReadOnly = !!chat && chat.messages.length > 0
  const filteredProjects = useMemo(() => {
    const needle = projectQuery.trim().toLowerCase()
    if (!needle) {
      return projects
    }
    return projects.filter((p) => p.name.toLowerCase().includes(needle) || p.cwd.toLowerCase().includes(needle))
  }, [projects, projectQuery])

  const autosize = useCallback(() => {
    const el = textareaRef.current
    if (!el) {
      return
    }
    el.style.height = '0px'
    const line = 22
    const max = line * 12 + 16
    el.style.height = `${Math.min(el.scrollHeight, max)}px`
  }, [])

  useEffect(() => {
    autosize()
  }, [text, autosize])

  useEffect(() => {
    if (autoFocus) {
      textareaRef.current?.focus()
    }
  }, [autoFocus])

  // Forked messages are handed back by pi for editing before resend; a nonce
  // bump preloads the composer (derived state during render, then focus).
  const seedNonce = chat?.composerSeed?.nonce
  const [appliedSeed, setAppliedSeed] = useState(0)
  if (chat?.composerSeed && chat.composerSeed.nonce !== appliedSeed) {
    setAppliedSeed(chat.composerSeed.nonce)
    setText(chat.composerSeed.text)
  }
  useEffect(() => {
    if (seedNonce) {
      textareaRef.current?.focus()
    }
  }, [seedNonce])

  useEffect(() => {
    if (!folderOpen) {
      return
    }
    const close = (e: PointerEvent) => {
      if (folderRef.current && !folderRef.current.contains(e.target as Node)) {
        setFolderOpen(false)
      }
    }
    document.addEventListener('pointerdown', close)
    return () => document.removeEventListener('pointerdown', close)
  }, [folderOpen])

  // Fresh permission state whenever the plus menu opens, plus once on mount
  // so the "computer use on" indicator chip can render without a first click.
  useEffect(() => {
    let cancelled = false
    const refresh = () =>
      window.piDesktop.cua
        ?.permissions()
        .then((p) => {
          if (!cancelled) {
            setCuaPerms(p)
          }
        })
        .catch(() => {})
    void refresh()
    if (plusOpen) {
      void refresh()
      // Only offer clipboard paste when there's actually an image waiting.
      navigator.clipboard
        ?.read?.()
        .then((items) =>
          setClipHasImage(
            items.some((item) =>
              item.types.some((t) => t.startsWith('image/'))
            )
          )
        )
        .catch(() => setClipHasImage(false))
    }
    return () => {
      cancelled = true
    }
  }, [plusOpen])

  useEffect(() => {
    if (!plusOpen) {
      return
    }
    const close = (e: PointerEvent) => {
      if (plusRef.current && !plusRef.current.contains(e.target as Node)) {
        setPlusOpen(false)
      }
    }
    document.addEventListener('pointerdown', close)
    return () => document.removeEventListener('pointerdown', close)
  }, [plusOpen])

  // Prefetch the project's file list for @-mentions whenever the cwd changes
  // or the composer regains focus — the picker then opens instantly.
  useEffect(() => {
    if (projectless) {
      return
    }
    let cancelled = false
    void window.piDesktop.files
      .list({ cwd })
      .then((r) => {
        if (!cancelled) {
          setProjectFiles(r.files)
        }
      })
      .catch(() => setProjectFiles([]))
    return () => {
      cancelled = true
    }
  }, [cwd, projectless])

  /** Resolve absolute picker/drop paths into images + file chips. */
  async function addPaths(paths: string[]): Promise<void> {
    const results = await window.piDesktop.files
      .readAttachments({ paths })
      .catch(() => [])
    const newImages: ImageContent[] = []
    const newChips: FileChip[] = []
    for (const r of results) {
      if (r.kind === 'image') {
        newImages.push({ type: 'image', data: r.data, mimeType: r.mimeType })
      } else {
        newChips.push({ path: r.path, name: r.name, size: r.size })
      }
    }
    if (newImages.length > 0) {
      setImages((prev) => [...prev, ...newImages].slice(0, MAX_IMAGES))
    }
    if (newChips.length > 0) {
      setChips((prev) => {
        const seen = new Set(prev.map((c) => c.path))
        return [...prev, ...newChips.filter((c) => !seen.has(c.path))]
      })
    }
  }

  /** Drag&drop / paste paths: real paths go through readAttachments, while
   *  pathless clipboard images fall back to inline base64. */
  async function addFiles(files: Iterable<File>): Promise<void> {
    const paths: string[] = []
    const inline: File[] = []
    for (const file of files) {
      const p = window.piDesktop.app.pathForFile?.(file) ?? ''
      if (p) {
        paths.push(p)
      } else {
        inline.push(file)
      }
    }
    if (paths.length > 0) {
      await addPaths(paths)
    }
    if (inline.length > 0) {
      const results = await Promise.all(inline.map(fileToImage))
      setImages((prev) =>
        [...prev, ...results.filter((i): i is ImageContent => i !== null)].slice(
          0,
          MAX_IMAGES
        )
      )
    }
  }

  async function pickFiles(): Promise<void> {
    const paths = await window.piDesktop.app.pickFiles().catch(() => [])
    if (paths.length > 0) {
      await addPaths(paths)
    }
  }

  /** Replace the `@query` token with the selected path, pi-TUI style. */
  function completeMention(path: string): void {
    if (!mention) {
      return
    }
    const inserted = `${formatMention(path)} `
    const next = text.slice(0, mention.start) + inserted + text.slice(mention.end)
    const caret = mention.start + inserted.length
    setText(next)
    setCursor(caret)
    setMentionHighlight(0)
    requestAnimationFrame(() => {
      textareaRef.current?.focus()
      textareaRef.current?.setSelectionRange(caret, caret)
    })
  }

  async function pasteClipboardImage(): Promise<void> {
    try {
      const items = await navigator.clipboard.read()
      const files: File[] = []
      for (const item of items) {
        const type = item.types.find((t) => t.startsWith('image/'))
        if (type) {
          const blob = await item.getType(type)
          files.push(new File([blob], 'clipboard', { type: blob.type }))
        }
      }
      if (files.length > 0) {
        await addFiles(files)
      } else {
        toast('No image on the clipboard')
      }
    } catch {
      toast('Could not read the clipboard')
    }
  }

  function toggleComputerUse(): void {
    const next = !computerUseEnabled
    void useAppStore
      .getState()
      .updateAppSettings({ computerUse: { enabled: next } })
      .catch(() => {})
    // New pi processes pick the flag up; an open chat restarts on next send.
    if (chat) {
      useChatStore.getState().markCuaStale(chat.chatId)
      // Only toast when this chat has a live pi to restart — a fresh draft
      // just spawns with the new flag.
      if (chat.piReady) {
        toast('Takes effect on the next message')
      }
    }
  }

  function grantAccessibility(): void {
    void window.piDesktop.cua
      ?.requestPermissions()
      .then(setCuaPerms)
      .catch(() => {})
    void window.piDesktop.cua?.openSettings('accessibility').catch(() => {})
  }

  /** Selectable rows of the plus menu, in display order (divider excluded). */
  const plusItems = useMemo(() => {
    const items: { key: string; run: () => void; disabled?: boolean }[] = [
      { key: 'photos', run: () => void pickFiles() },
      ...(clipHasImage
        ? [{ key: 'paste', run: () => void pasteClipboardImage() }]
        : []),
      {
        key: 'computer',
        run: () => {
          if (cuaPerms && !cuaPerms.available) {
            return
          }
          toggleComputerUse()
        }
      },
      { key: 'browser', run: () => usePanelStore.getState().addNewTab() },
      { key: 'terminal', run: () => usePanelStore.getState().toggleTerminal(cwd) }
    ]
    return items
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clipHasImage, cuaPerms, computerUseEnabled, cwd])

  function closePlus(restoreFocus = true): void {
    setPlusOpen(false)
    setPlusHighlight(0)
    if (restoreFocus) {
      textareaRef.current?.focus()
    }
  }

  function runPlusItem(index: number): void {
    const item = plusItems[index]
    if (!item || item.disabled) {
      return
    }
    closePlus()
    item.run()
  }

  // Arrow keys / Enter navigate the plus menu while focus stays in the input.
  useEffect(() => {
    if (!plusOpen) {
      return
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setPlusHighlight((h) => Math.min(h + 1, plusItems.length - 1))
      } else if (e.key === 'ArrowUp') {
        e.preventDefault()
        setPlusHighlight((h) => Math.max(h - 1, 0))
      } else if (e.key === 'Enter') {
        e.preventDefault()
        runPlusItem(plusHighlight)
      } else if (e.key === 'Escape') {
        e.preventDefault()
        closePlus()
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  })

  function runAppCommand(command: string, args: string): void {
    void executeAppCommand(
      {
        chat,
        openModelPicker: () => setModelSignal((s) => s + 1),
        setModal: (modal) => useAppStore.getState().setChatModal(modal)
      },
      command,
      args
    )
  }

  /** Insert `/name ` for the highlighted item and keep typing args. */
  function completeSlash(index: number): void {
    const item = slashItems[index]
    if (!item) {
      return
    }
    setText(`/${item.name} `)
    setSlashHighlight(0)
    textareaRef.current?.focus()
  }

  function executeSlash(index: number): void {
    const item = slashItems[index]
    if (!item) {
      return
    }
    if (item.takesArgs) {
      completeSlash(index)
      return
    }
    setSlashDismissed(true)
    if (item.source === 'app') {
      if (item.idleOnly && streaming) {
        return
      }
      runAppCommand(item.name, '')
      setText('')
      setImages([])
    } else {
      // pi commands go out as a normal prompt; pi expands them itself.
      submit('prompt', `/${item.name}`)
    }
  }

  function submit(mode: ChatSendMode, overrideText?: string): void {
    const value = (overrideText ?? text).trim()
    if (!canSend || (mode === 'prompt' && streaming)) {
      return
    }
    const parsed = parseSlashSend(value)
    const appCommand = parsed && findAppCommand(parsed.command)
    if (appCommand) {
      if (appCommand.idleOnly && streaming) {
        return
      }
      runAppCommand(parsed!.command, parsed!.args)
    } else {
      onSend(
        appendAttachmentRefs(value, chips.map((c) => c.path), cwd),
        images.length > 0 ? images : [],
        mode
      )
    }
    setText('')
    setImages([])
    setChips([])
    requestAnimationFrame(autosize)
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>): void {
    // ⌘U opens the file picker directly (also reachable via the + menu).
    if (e.metaKey && (e.key === 'u' || e.key === 'U')) {
      e.preventDefault()
      void pickFiles()
      return
    }
    if (mentionOpen) {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setMentionHighlight((h) => Math.min(h + 1, mentionItems.length - 1))
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        setMentionHighlight((h) => Math.max(h - 1, 0))
        return
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        setMentionDismissed(true)
        return
      }
      if (e.key === 'Tab' || (e.key === 'Enter' && mentionItems.length > 0)) {
        e.preventDefault()
        const item = mentionItems[mentionHighlight]
        if (item) {
          completeMention(item)
        }
        return
      }
    }
    if (slashOpen) {
      const items = slashItems
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setSlashHighlight((h) => Math.min(h + 1, items.length - 1))
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        setSlashHighlight((h) => Math.max(h - 1, 0))
        return
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        setSlashDismissed(true)
        return
      }
      if (e.key === 'Tab') {
        e.preventDefault()
        completeSlash(slashHighlight)
        return
      }
      if (e.key === 'Enter' && !e.shiftKey && !e.altKey) {
        e.preventDefault()
        const item = items[slashHighlight]
        if (item && item.name === query) {
          executeSlash(slashHighlight)
        } else {
          completeSlash(slashHighlight)
        }
        return
      }
    }
    if (e.key !== 'Enter') {
      return
    }
    if (e.shiftKey) {
      return
    }
    e.preventDefault()
    if (streaming) {
      submit(e.altKey ? 'followUp' : 'steer')
    } else {
      submit('prompt')
    }
  }

  function changeChatCwd(cwdPath: string): void {
    if (chat && chat.cwd !== cwdPath) {
      void useChatStore.getState().setCwd(chat.chatId, cwdPath)
    }
  }

  async function chooseFolder(): Promise<void> {
    setFolderOpen(false)
    const folder = await window.piDesktop.app.pickFolder()
    if (folder) {
      await useAppStore.getState().addProject(folder)
      changeChatCwd(folder)
    }
  }

  const sendDisabled = !canSend && !streaming

  return (
    <div
      className={clsx('composer', { 'is-streaming': streaming, 'is-dragover': dragging })}
      onDragEnter={(e) => {
        if (e.dataTransfer.types.includes('Files')) {
          dragDepth.current += 1
          setDragging(true)
        }
      }}
      onDragOver={(e) => e.preventDefault()}
      onDragLeave={() => {
        dragDepth.current = Math.max(0, dragDepth.current - 1)
        if (dragDepth.current === 0) {
          setDragging(false)
        }
      }}
      onDrop={(e) => {
        e.preventDefault()
        dragDepth.current = 0
        setDragging(false)
        void addFiles(e.dataTransfer.files)
      }}
      onPaste={(e) => {
        const files = [...e.clipboardData.files]
        if (files.length > 0) {
          e.preventDefault()
          void addFiles(files)
        }
      }}
    >
      {(images.length > 0 || chips.length > 0) && (
        <div className="composer-attachments">
          {images.map((img, i) => (
            <div key={i} className="attachment-thumb">
              <img src={`data:${img.mimeType};base64,${img.data}`} alt="" />
              <button
                type="button"
                className="attachment-remove"
                onClick={() => setImages((prev) => prev.filter((_, j) => j !== i))}
                aria-label="Remove image"
              >
                <X size={11} />
              </button>
            </div>
          ))}
          {chips.map((chip) => {
            const Icon = fileIconFor(chip.name)
            return (
              <div key={chip.path} className="file-chip" title={chip.path}>
                <Icon size={13} className="file-chip-icon" />
                <span className="file-chip-name">{chip.name}</span>
                <span className="file-chip-size">{formatSize(chip.size)}</span>
                <button
                  type="button"
                  className="attachment-remove"
                  onClick={() =>
                    setChips((prev) => prev.filter((c) => c.path !== chip.path))
                  }
                  aria-label={`Remove ${chip.name}`}
                >
                  <X size={11} />
                </button>
              </div>
            )
          })}
        </div>
      )}

      {mentionOpen && (
        <div className="slash-popover mention-popover" data-testid="mention-popover">
          {projectless ? (
            <div className="folder-popover-empty">Pick a project to mention files</div>
          ) : mentionItems.length === 0 ? (
            <div className="folder-popover-empty">No matching files</div>
          ) : (
            mentionItems.map((path, i) => {
              const slash = path.lastIndexOf('/')
              const dir = slash === -1 ? '' : path.slice(0, slash + 1)
              const base = slash === -1 ? path : path.slice(slash + 1)
              const Icon = fileIconFor(base)
              return (
                <button
                  key={path}
                  type="button"
                  className={clsx('slash-row mention-row', {
                    'is-highlight': i === mentionHighlight
                  })}
                  onMouseEnter={() => setMentionHighlight(i)}
                  onClick={() => completeMention(path)}
                >
                  <Icon size={13} className="mention-icon" />
                  <span className="mention-dir">{dir}</span>
                  <span className="mention-name">{base}</span>
                </button>
              )
            })
          )}
        </div>
      )}

      {slashOpen && (
        <div className="slash-popover" data-testid="slash-popover">
          {(() => {
            let flatIndex = -1
            return slashGroups.map((group) => (
              <div key={group.label}>
                <div className="slash-group-label">{group.label}</div>
                {group.items.map((item) => {
                  flatIndex += 1
                  const i = flatIndex
                  return (
                    <button
                      key={`${item.source}:${item.name}`}
                      type="button"
                      className={clsx('slash-row', { 'is-highlight': i === slashHighlight })}
                      onMouseEnter={() => setSlashHighlight(i)}
                      onClick={() => executeSlash(i)}
                    >
                      <span className="slash-name">/{item.name}</span>
                      {item.description && (
                        <span className="slash-desc">{item.description}</span>
                      )}
                      {item.hint && <span className="slash-hint">{item.hint}</span>}
                      {item.source !== 'app' && (
                        <span className="slash-badge">{item.source}</span>
                      )}
                    </button>
                  )
                })}
              </div>
            ))
          })()}
        </div>
      )}

      <textarea
        ref={textareaRef}
        className="composer-input"
        value={text}
        onChange={(e) => {
          setText(e.target.value)
          setCursor(e.target.selectionStart ?? e.target.value.length)
          setSlashDismissed(false)
          setSlashHighlight(0)
          setMentionDismissed(false)
          setMentionHighlight(0)
        }}
        onSelect={(e) => setCursor(e.currentTarget.selectionStart ?? 0)}
        onFocus={() => {
          // Refresh the cached file list when the composer regains focus.
          if (!projectless) {
            void window.piDesktop.files
              .list({ cwd })
              .then((r) => setProjectFiles(r.files))
              .catch(() => {})
          }
        }}
        onKeyDown={onKeyDown}
        placeholder={placeholder ?? 'How can I help you today?'}
        rows={1}
        spellCheck={false}
      />

      {chat?.status === 'starting' && (
        <StartingPiStatus startedAt={chat.startedAt} hint={chat.startupHint} />
      )}

      <div className="composer-bar">
        <div className="composer-left">
          <div className="plus-wrap" ref={plusRef}>
            <button
              type="button"
              className="icon-btn"
              title="Add files and more"
              aria-label="Add files and more"
              aria-haspopup="menu"
              aria-expanded={plusOpen}
              onClick={() => setPlusOpen(!plusOpen)}
            >
              <Plus size={16} />
            </button>
            {plusOpen && (
              <div className="folder-popover plus-popover" role="menu">
                <button
                  type="button"
                  role="menuitem"
                  className={clsx('folder-row', {
                    'is-highlight': plusHighlight === 0
                  })}
                  onMouseEnter={() => setPlusHighlight(0)}
                  onClick={() => runPlusItem(0)}
                >
                  <Paperclip size={14} />
                  <span className="plus-row-label">Add photos & files</span>
                  <span className="plus-row-hint">⌘U</span>
                </button>
                {clipHasImage &&
                  (() => {
                    const i = plusItems.findIndex((it) => it.key === 'paste')
                    return (
                      <button
                        type="button"
                        role="menuitem"
                        className={clsx('folder-row', {
                          'is-highlight': plusHighlight === i
                        })}
                        onMouseEnter={() => setPlusHighlight(i)}
                        onClick={() => runPlusItem(i)}
                      >
                        <ClipboardPaste size={14} />
                        <span className="plus-row-label">
                          Paste image from clipboard
                        </span>
                      </button>
                    )
                  })()}
                <div className="folder-popover-divider" />
                {(() => {
                  const i = plusItems.findIndex((it) => it.key === 'computer')
                  const unavailable = cuaPerms?.available === false
                  const needsAccess =
                    cuaPerms !== null &&
                    cuaPerms.available &&
                    !cuaPerms.accessibility
                  return (
                    <button
                      type="button"
                      role="menuitem"
                      className={clsx('folder-row', 'plus-cua-row', {
                        'is-highlight': plusHighlight === i
                      })}
                      disabled={unavailable}
                      onMouseEnter={() => setPlusHighlight(i)}
                      onClick={() => runPlusItem(i)}
                    >
                      <MousePointerClick size={14} />
                      <span className="plus-row-label">
                        Computer use
                        <span className="plus-row-sub">
                          {unavailable ? (
                            'Not available on this system'
                          ) : needsAccess ? (
                            <>
                              Needs Accessibility access{' '}
                              <span
                                className="plus-grant"
                                role="link"
                                onClick={(e) => {
                                  e.stopPropagation()
                                  grantAccessibility()
                                }}
                              >
                                Grant
                              </span>
                            </>
                          ) : (
                            'Control Mac apps'
                          )}
                        </span>
                      </span>
                      <span
                        className={clsx('switch', { on: computerUseEnabled })}
                        aria-hidden="true"
                      >
                        <span className="switch-knob" />
                      </span>
                    </button>
                  )
                })()}
                <div className="folder-popover-divider" />
                {(() => {
                  const i = plusItems.findIndex((it) => it.key === 'browser')
                  return (
                    <button
                      type="button"
                      role="menuitem"
                      className={clsx('folder-row', {
                        'is-highlight': plusHighlight === i
                      })}
                      onMouseEnter={() => setPlusHighlight(i)}
                      onClick={() => runPlusItem(i)}
                    >
                      <Globe size={14} />
                      <span className="plus-row-label">Browser</span>
                    </button>
                  )
                })()}
                {(() => {
                  const i = plusItems.findIndex((it) => it.key === 'terminal')
                  return (
                    <button
                      type="button"
                      role="menuitem"
                      className={clsx('folder-row', {
                        'is-highlight': plusHighlight === i
                      })}
                      onMouseEnter={() => setPlusHighlight(i)}
                      onClick={() => runPlusItem(i)}
                    >
                      <SquareTerminal size={14} />
                      <span className="plus-row-label">Terminal</span>
                      <span className="plus-row-hint">⌃`</span>
                    </button>
                  )
                })()}
              </div>
            )}
          </div>
          {computerUseEnabled && cuaPerms?.accessibility === true && (
            <button
              type="button"
              className="icon-btn cua-indicator"
              title="Computer use on"
              aria-label="Computer use on"
              onClick={() => setPlusOpen(true)}
            >
              <MousePointerClick size={13} />
            </button>
          )}
          <div className="folder-chip-wrap" ref={folderRef}>
            {cwdReadOnly ? (
              <span className="folder-chip folder-chip-readonly" title={cwd}>
                <Folder size={13} />
                <span>{cwdBase}</span>
              </span>
            ) : (
              <button
                type="button"
                className="folder-chip"
                onClick={() => {
                  setProjectQuery('')
                  setFolderOpen(!folderOpen)
                }}
                title={cwd}
              >
                <Folder size={13} />
                <span>{cwdBase}</span>
              </button>
            )}
            {folderOpen && !cwdReadOnly && (
              <div className="folder-popover">
                <div className="folder-popover-search">
                  <Search size={12} />
                  <input
                    autoFocus
                    value={projectQuery}
                    onChange={(e) => setProjectQuery(e.target.value)}
                    placeholder="Search projects"
                    spellCheck={false}
                  />
                </div>
                <button
                  type="button"
                  className="folder-row"
                  onClick={() => {
                    setFolderOpen(false)
                    if (workspaceDir) {
                      changeChatCwd(workspaceDir)
                    }
                  }}
                >
                  {projectless ? (
                    <Check size={13} />
                  ) : (
                    <span className="folder-row-check" />
                  )}
                  <span>Without project</span>
                </button>
                <div className="folder-popover-divider" />
                {filteredProjects.map((p) => (
                  <button
                    key={p.cwd}
                    type="button"
                    className="folder-row"
                    title={p.cwd}
                    onMouseEnter={() => warmProjectSoon(p.cwd)}
                    onClick={() => {
                      setFolderOpen(false)
                      changeChatCwd(p.cwd)
                    }}
                  >
                    {cwd === p.cwd ? (
                      <Check size={13} />
                    ) : (
                      <Folder size={13} />
                    )}
                    <span>{p.name}</span>
                  </button>
                ))}
                {filteredProjects.length === 0 && (
                  <div className="folder-popover-empty">No projects</div>
                )}
                <div className="folder-popover-divider" />
                <button type="button" className="folder-row" onClick={() => void chooseFolder()}>
                  <FolderPlus size={13} />
                  <span>Add project…</span>
                </button>
              </div>
            )}
          </div>
        </div>

        <div className="composer-right">
          {(!chat || chat.models.length === 0) && (
            <div className="model-picker-skeleton" aria-hidden="true" />
          )}
          {chat && chat.models.length > 0 && (
            <ModelPicker
              models={chat.models}
              current={chat.model}
              thinkingLevel={chat.thinkingLevel}
              thinkingLevels={chat.availableThinkingLevels}
              disabled={chat.status === 'exited'}
              openSignal={modelSignal}
              onSelect={(provider, modelId) => {
                void useChatStore.getState().setModel(chat.chatId, provider, modelId)
              }}
              onThinkingChange={(level: ThinkingLevel) => {
                void useChatStore.getState().setThinkingLevel(chat.chatId, level)
              }}
            />
          )}
          {chat && <ContextRing chat={chat} />}
          <button
            type="button"
            className={clsx('send-btn', { 'send-active': canSend && !streaming })}
            disabled={sendDisabled}
            title={streaming ? 'Stop' : 'Send'}
            onClick={() => {
              if (streaming) {
                void useChatStore.getState().abort(chat!.chatId)
              } else {
                submit('prompt')
              }
            }}
          >
            {streaming ? <Square size={12} fill="currentColor" /> : <ArrowUp size={15} />}
          </button>
        </div>
      </div>
    </div>
  )
}
