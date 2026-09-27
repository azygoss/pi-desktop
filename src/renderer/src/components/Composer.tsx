import { Check, Folder, FolderPlus, Plus, Search, Square, ArrowUp, X } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import clsx from 'clsx'

import type { ChatSendMode } from '../../../shared/api'
import type { ImageContent, ThinkingLevel } from '../../../shared/pi-types'
import { executeAppCommand } from '../lib/app-commands'
import {
  filterSlashCommands,
  findAppCommand,
  flattenSlashGroups,
  parseSlashSend,
  slashQuery
} from '../lib/slash-commands'
import { useAppStore } from '../state/app-store'
import { useChatStore, type ChatState } from '../state/chat-store'
import { ModelPicker } from './ModelPicker'

const MAX_IMAGES = 8
const IMAGE_MIME = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp'])
const MAX_IMAGE_BYTES = 20 * 1024 * 1024

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

export function Composer({ chat, isChat, placeholder, autoFocus, onSend }: ComposerProps) {
  const [text, setText] = useState('')
  const [images, setImages] = useState<ImageContent[]>([])
  const [folderOpen, setFolderOpen] = useState(false)
  const [slashHighlight, setSlashHighlight] = useState(0)
  const [slashDismissed, setSlashDismissed] = useState(false)
  const [modelSignal, setModelSignal] = useState(0)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const folderRef = useRef<HTMLDivElement>(null)

  const projects = useAppStore((s) => s.projects)
  const workspaceDir = useAppStore((s) => s.appInfo?.workspaceDir ?? '')
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
  const canSend = text.trim().length > 0 || images.length > 0
  const cwd = chat?.cwd ?? workspaceDir
  const projectless = cwd === '' || cwd === workspaceDir
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

  async function addFiles(files: Iterable<File>): Promise<void> {
    const results = await Promise.all([...files].map(fileToImage))
    setImages((prev) =>
      [...prev, ...results.filter((i): i is ImageContent => i !== null)].slice(0, MAX_IMAGES)
    )
  }

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
      onSend(value, images.length > 0 ? images : [], mode)
    }
    setText('')
    setImages([])
    requestAnimationFrame(autosize)
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>): void {
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
      className={clsx('composer', { 'is-streaming': streaming })}
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        e.preventDefault()
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
      {images.length > 0 && (
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
          setSlashDismissed(false)
          setSlashHighlight(0)
        }}
        onKeyDown={onKeyDown}
        placeholder={placeholder ?? 'How can I help you today?'}
        rows={1}
        spellCheck={false}
      />

      <div className="composer-bar">
        <div className="composer-left">
          <button
            type="button"
            className="icon-btn"
            title="Attach image"
            onClick={() => fileRef.current?.click()}
          >
            <Plus size={16} />
          </button>
          <input
            ref={fileRef}
            type="file"
            accept="image/png,image/jpeg,image/gif,image/webp"
            multiple
            hidden
            onChange={(e) => {
              if (e.target.files) {
                void addFiles(e.target.files)
              }
              e.target.value = ''
            }}
          />
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
