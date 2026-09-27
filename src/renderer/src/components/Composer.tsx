import { Folder, Plus, Square, ArrowUp, X } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import clsx from 'clsx'

import type { ChatSendMode } from '../../../shared/api'
import type { ImageContent, ThinkingLevel } from '../../../shared/pi-types'
import { useAppStore } from '../state/app-store'
import { useChatStore, type ChatState } from '../state/chat-store'
import { ModelPicker } from './ModelPicker'

const MAX_IMAGES = 8
const IMAGE_MIME = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp'])
const MAX_IMAGE_BYTES = 20 * 1024 * 1024

interface ComposerProps {
  chat: ChatState | null
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

export function Composer({ chat, placeholder, autoFocus, onSend }: ComposerProps) {
  const [text, setText] = useState('')
  const [images, setImages] = useState<ImageContent[]>([])
  const [folderOpen, setFolderOpen] = useState(false)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const folderRef = useRef<HTMLDivElement>(null)

  const projects = useAppStore((s) => s.projects)
  const activeProjectCwd = useAppStore((s) => s.activeProjectCwd)
  const setActiveProjectCwd = useAppStore((s) => s.setActiveProjectCwd)

  const streaming = chat?.status === 'streaming'
  const canSend = text.trim().length > 0 || images.length > 0
  const cwd = chat?.cwd ?? activeProjectCwd ?? ''
  const cwdBase = cwd ? (cwd.split('/').filter(Boolean).pop() ?? cwd) : 'Home'

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

  function submit(mode: ChatSendMode): void {
    if (!canSend || (mode === 'prompt' && streaming)) {
      return
    }
    onSend(text.trim(), images.length > 0 ? images : [], mode)
    setText('')
    setImages([])
    requestAnimationFrame(autosize)
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>): void {
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
    setActiveProjectCwd(cwdPath)
    if (chat && chat.cwd !== cwdPath) {
      void useChatStore.getState().setCwd(chat.chatId, cwdPath)
    }
  }

  async function chooseFolder(): Promise<void> {
    setFolderOpen(false)
    const folder = await window.piDesktop.app.pickFolder()
    if (folder) {
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

      <textarea
        ref={textareaRef}
        className="composer-input"
        value={text}
        onChange={(e) => setText(e.target.value)}
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
            <button
              type="button"
              className="folder-chip"
              onClick={() => setFolderOpen(!folderOpen)}
              title={cwd || 'Home directory'}
            >
              <Folder size={13} />
              <span>{cwdBase}</span>
            </button>
            {folderOpen && (
              <div className="folder-popover">
                {projects.slice(0, 8).map((p) => (
                  <button
                    key={p.cwd || 'other'}
                    type="button"
                    className="folder-row"
                    onClick={() => {
                      setFolderOpen(false)
                      if (p.cwd) {
                        changeChatCwd(p.cwd)
                      }
                    }}
                  >
                    <Folder size={13} />
                    <span>{p.name}</span>
                  </button>
                ))}
                <button type="button" className="folder-row" onClick={() => void chooseFolder()}>
                  <Folder size={13} />
                  <span>Choose folder…</span>
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
