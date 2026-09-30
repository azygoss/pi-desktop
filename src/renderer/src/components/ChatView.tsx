import {
  ArrowDown,
  Check,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  CircleAlert,
  Copy,
  File,
  Layers,
  ListTree,
  Pause,
  Pencil,
  Play,
  RotateCcw,
  Search,
  Square,
  X,
  Zap
} from 'lucide-react'
import {
  Suspense,
  lazy,
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState
} from 'react'
import { flushSync } from 'react-dom'
import clsx from 'clsx'

import type { DisplayBlock, DisplayMessage, ToolRun } from '../../../shared/chat-view'
import type { ImageContent, Model } from '../../../shared/pi-types'
import { parseSkillPrefix } from '../../../shared/skill-prefix'
import {
  findMatches,
  locateOccurrence,
  totalOccurrences,
  type FindMatch
} from '../lib/find'
import { splitMentions } from '../lib/mentions'
import { setSessionArchived } from '../lib/session-actions'
import { Perf } from '../lib/perf'
import { computerGroupApp, summarizeToolRuns } from '../lib/tool-summary'
import { formatDuration } from '../lib/trace'
import { useAppStore } from '../state/app-store'
import { useChatStore, type ChatState } from '../state/chat-store'
import { Composer } from './Composer'
import { Elapsed, LiveDot } from './LiveIndicators'
import { ThinkingBlock } from './ThinkingBlock'
import { DiffStat, StepIcon, ToolCard } from './ToolCard'

// react-markdown + micromark are ~600KB — split out of the main chunk; the
// fallback renders the raw text pre-wrap so content is readable instantly.
const LazyMarkdown = lazy(() => import('./Markdown').then((m) => ({ default: m.Markdown })))

function MarkdownBlock({ text }: { text: string }) {
  return (
    <Suspense fallback={<div className="markdown markdown-fallback">{text}</div>}>
      <LazyMarkdown text={text} />
    </Suspense>
  )
}

function AssistantBlock({
  block,
  run,
  cwd,
  streaming
}: {
  block: DisplayBlock
  run?: ToolRun
  cwd: string
  streaming?: boolean
}) {
  if (block.type === 'text') {
    return <MarkdownBlock text={block.text} />
  }
  if (block.type === 'thinking') {
    return (
      <ThinkingBlock
        text={block.thinking}
        // thinking_end stamps durationMs, so only the open block is live.
        streaming={streaming && block.durationMs === undefined}
        startedAt={block.startedAt}
        durationMs={block.durationMs}
      />
    )
  }
  if (block.type === 'toolCall') {
    const toolRun: ToolRun =
      run ?? {
        toolCallId: block.id,
        name: block.name,
        args: block.arguments,
        status: 'done'
      }
    return <ToolCard run={toolRun} cwd={cwd} />
  }
  if (block.type === 'image') {
    return (
      <img className="msg-image" src={`data:${block.mimeType};base64,${block.data}`} alt="" />
    )
  }
  return null
}

/**
 * Memoized per finalized block: during a stream only the block receiving
 * deltas gets a new object identity, so earlier blocks skip re-parsing.
 */
const MemoAssistantBlock = memo(AssistantBlock)

type ToolCallBlock = Extract<DisplayBlock, { type: 'toolCall' }>
type RenderItem = DisplayBlock | { type: 'toolGroup'; blocks: ToolCallBlock[] }

/**
 * Fold runs of consecutive tool calls into a single group row; a lone call
 * stays a plain card.
 */
function groupToolCalls(blocks: DisplayBlock[]): RenderItem[] {
  const items: RenderItem[] = []
  for (const block of blocks) {
    const last = items[items.length - 1]
    if (block.type !== 'toolCall') {
      items.push(block)
    } else if (last?.type === 'toolGroup') {
      items[items.length - 1] = { type: 'toolGroup', blocks: [...last.blocks, block] }
    } else if (last?.type === 'toolCall') {
      // Second consecutive call: promote the pair into a group.
      items[items.length - 1] = { type: 'toolGroup', blocks: [last, block] }
    } else {
      items.push(block)
    }
  }
  return items
}

/** True when an assistant message has any text to copy. */
function hasAssistantText(message: DisplayMessage): boolean {
  return message.kind === 'assistant' && message.blocks.some((b) => b.type === 'text')
}

/** Plain markdown text of an assistant message (text blocks only). */
function assistantText(message: DisplayMessage): string {
  if (message.kind !== 'assistant') {
    return ''
  }
  return message.blocks
    .filter((b) => b.type === 'text')
    .map((b) => (b.type === 'text' ? b.text : ''))
    .join('\n\n')
    .trim()
}

/**
 * Hover action: copy to clipboard, flip to a check for 1.2s. `text` may be a
 * getter so long turns are only joined when actually copied, not on every
 * streamed frame.
 */
function CopyButton({ text }: { text: string | (() => string) }) {
  const [copied, setCopied] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => () => {
    if (timer.current) {
      clearTimeout(timer.current)
    }
  }, [])
  return (
    <button
      type="button"
      className="icon-btn msg-action"
      title={copied ? 'Copied' : 'Copy'}
      onClick={() => {
        void navigator.clipboard.writeText(typeof text === 'function' ? text() : text)
        setCopied(true)
        if (timer.current) {
          clearTimeout(timer.current)
        }
        timer.current = setTimeout(() => setCopied(false), 1200)
      }}
    >
      {copied ? <Check size={12} /> : <Copy size={12} />}
    </button>
  )
}

/**
 * Collapsed summary for a run of consecutive tool calls: "Ran N tools ·
 * read 2 files, …", live-updating while any of them streams. Expands to the
 * individual cards.
 */
function ToolGroup({
  calls,
  toolRuns,
  cwd
}: {
  calls: ToolCallBlock[]
  toolRuns: Record<string, ToolRun>
  cwd: string
}) {
  const [open, setOpen] = useState(false)
  const runs = calls.map(
    (b) =>
      toolRuns[b.id] ?? {
        toolCallId: b.id,
        name: b.name,
        args: b.arguments,
        status: 'done' as const
      }
  )
  const group = summarizeToolRuns(
    runs.map((r) => ({ name: r.name, args: r.args, status: r.status }))
  )
  const running = group.running > 0
  const errors = group.failed
  // All computer_* against one app: "Used Finder · 6 actions".
  const cuaApp = computerGroupApp(runs.map((r) => ({ name: r.name, args: r.args })))
  const groupLabel =
    cuaApp !== null
      ? running
        ? `Using ${cuaApp}…`
        : `Used ${cuaApp} · ${runs.length} action${runs.length === 1 ? '' : 's'}`
      : running
        ? `Running ${runs.length} tools…`
        : group.text
  return (
    <div
      className={clsx('tool-card', 'tool-group', {
        'tool-error': errors > 0 && !running,
        'is-open': open
      })}
    >
      <button
        type="button"
        className="tool-row"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <StepIcon status={running ? 'running' : errors > 0 ? 'error' : 'done'}>
          <Layers size={12} />
        </StepIcon>
        <span className="tool-name tool-group-label">{groupLabel}</span>
        {!running && group.diff && (
          <DiffStat added={group.diff.added} removed={group.diff.removed} />
        )}
        <span className="tool-group-count">
          {runs.length} tool{runs.length === 1 ? '' : 's'}
        </span>
        {errors > 0 && <span className="tool-group-errors">{errors} failed</span>}
        <span className="tool-status">
          {running && (
            <Elapsed
              since={runs.reduce<number | undefined>(
                (min, r) =>
                  r.status === 'running' && r.startedAt !== undefined
                    ? Math.min(min ?? r.startedAt, r.startedAt)
                    : min,
                undefined
              )}
            />
          )}
        </span>
        <span className="tool-chevron" aria-hidden="true">
          <ChevronRight size={12} />
        </span>
      </button>
      {open && (
        <div className="tool-group-body">
          {calls.map((call) => (
            <ToolCard
              key={call.id}
              run={
                toolRuns[call.id] ?? {
                  toolCallId: call.id,
                  name: call.name,
                  args: call.arguments,
                  status: 'done'
                }
              }
              cwd={cwd}
            />
          ))}
        </div>
      )}
    </div>
  )
}

/** Assistant messages made only of reasoning and tool calls (no prose). */
function isTraceOnly(message: DisplayMessage): boolean {
  return (
    message.kind === 'assistant' &&
    !message.errorMessage &&
    message.blocks.length > 0 &&
    message.blocks.every((b) => b.type === 'thinking' || b.type === 'toolCall')
  )
}

/** Consecutive trace-only messages folded into one work row. */
const WORK_GROUP_MIN = 2

/**
 * A stretch of agent work inside a turn — many small messages that are only
 * thinking and tool calls — folded into one row: "Worked for 2m 10s · Read 4
 * files, ran 3 commands". Open while the turn is live, folded once it
 * settles; the user's toggle wins either way.
 */
function WorkGroup({
  messages,
  toolRuns,
  startedAt,
  endedAt,
  live,
  forceOpen,
  children
}: {
  messages: DisplayMessage[]
  toolRuns: Record<string, ToolRun>
  startedAt?: number
  endedAt?: number
  live: boolean
  forceOpen: boolean
  children: React.ReactNode
}) {
  const [userOpen, setUserOpen] = useState<boolean | null>(null)
  const open = forceOpen || (userOpen ?? live)
  let thoughts = 0
  const runs: { name: string; args: Record<string, unknown>; status: ToolRun['status'] }[] = []
  for (const message of messages) {
    if (message.kind !== 'assistant') {
      continue
    }
    for (const block of message.blocks) {
      if (block.type === 'thinking') {
        thoughts += 1
      } else if (block.type === 'toolCall') {
        const run = toolRuns[block.id]
        runs.push({
          name: run?.name ?? block.name,
          args: run && Object.keys(run.args).length > 0 ? run.args : block.arguments,
          status: run?.status ?? 'done'
        })
      }
    }
  }
  const summary = summarizeToolRuns(runs)
  const running = summary.running > 0
  const span =
    startedAt !== undefined && endedAt !== undefined ? endedAt - startedAt : undefined
  const label = live
    ? 'Working'
    : span !== undefined && span >= 1000
      ? `Worked for ${formatDuration(span)}`
      : 'Worked'
  return (
    <div
      className={clsx('tool-card', 'tool-group', 'work-group', {
        'tool-error': summary.failed > 0 && !running,
        'is-open': open
      })}
    >
      <button
        type="button"
        className="tool-row"
        aria-expanded={open}
        onClick={() => setUserOpen(!open)}
      >
        <StepIcon status={running ? 'running' : summary.failed > 0 ? 'error' : 'done'}>
          <ListTree size={12} />
        </StepIcon>
        <span className="tool-name tool-group-label work-label">{label}</span>
        {runs.length > 0 && <span className="work-summary">{summary.text}</span>}
        {!running && summary.diff && (
          <DiffStat added={summary.diff.added} removed={summary.diff.removed} />
        )}
        {summary.failed > 0 && (
          <span className="tool-group-errors">{summary.failed} failed</span>
        )}
        <span className="work-counts">
          {runs.length > 0 && `${runs.length} ${runs.length === 1 ? 'tool' : 'tools'}`}
          {runs.length > 0 && thoughts > 0 && ' · '}
          {thoughts > 0 && `${thoughts} ${thoughts === 1 ? 'thought' : 'thoughts'}`}
        </span>
        <span className="tool-chevron" aria-hidden="true">
          <ChevronRight size={12} />
        </span>
      </button>
      {open && <div className="work-body">{children}</div>}
    </div>
  )
}

/**
 * Live computer-use strip above the composer: shows what pi is doing in a
 * native app ("Using Finder · Clicked "Save"") with pause/resume and stop.
 */
function CuaActivityStrip({ chat }: { chat: ChatState }) {
  if (!chat.cuaActive) {
    return null
  }
  const activity = chat.cuaActivity
  const paused = chat.cuaPaused === true
  const headline = paused
    ? 'Paused — pi is waiting'
    : `Using ${activity?.app ?? 'an app'}`
  return (
    <div className="cua-strip" role="status">
      <LiveDot className={clsx('cua-strip-dot', { 'is-paused': paused })} />
      <span className="cua-strip-headline">{headline}</span>
      {activity?.summary && !paused && (
        <span className="cua-strip-summary">{activity.summary}</span>
      )}
      <span className="cua-strip-spacer" />
      <button
        type="button"
        className="icon-btn cua-strip-btn"
        title={
          paused
            ? 'Resume (⌃⌥⌘P)'
            : 'Pause computer actions (⌃⌥⌘P)'
        }
        onClick={() => {
          if (paused) {
            void window.piDesktop.cua.resume().catch(() => {})
          } else {
            void window.piDesktop.cua.pause().catch(() => {})
          }
        }}
      >
        {paused ? <Play size={13} /> : <Pause size={13} />}
      </button>
      <button
        type="button"
        className="icon-btn cua-strip-btn"
        title="Stop computer use"
        onClick={() => {
          void window.piDesktop.cua.stop().catch(() => {})
          void useChatStore.getState().abort(chat.chatId).catch(() => {})
        }}
      >
        <Square size={12} />
      </button>
    </div>
  )
}

/** Muted hover metadata in the actions row: "GLM 5.3 · 14:02". */
// toLocaleTimeString(…, options) builds a fresh Intl.DateTimeFormat per call —
// the single hottest function while streaming, since every row's meta is
// recomputed each frame. One shared formatter is ~100x cheaper.
const timeFormat = new Intl.DateTimeFormat([], { hour: '2-digit', minute: '2-digit' })

// Rows re-render on every streamed commit; meta strings are cached per
// message object (and per model catalog) so each row compares the same
// string instead of rebuilding it.
const metaCache = new WeakMap<Model[], WeakMap<DisplayMessage, string>>()

function messageMeta(message: DisplayMessage, models: Model[]): string {
  let byMessage = metaCache.get(models)
  if (!byMessage) {
    byMessage = new WeakMap()
    metaCache.set(models, byMessage)
  }
  let meta = byMessage.get(message)
  if (meta === undefined) {
    meta = buildMessageMeta(message, models)
    byMessage.set(message, meta)
  }
  return meta
}

function buildMessageMeta(message: DisplayMessage, models: Model[]): string {
  const parts: string[] = []
  if (message.kind === 'assistant' && message.model) {
    // Sessions persist the model id; show the catalog's display name.
    parts.push(models.find((m) => m.id === message.model)?.name ?? message.model)
  }
  if (message.timestamp) {
    parts.push(timeFormat.format(message.timestamp))
  }
  return parts.join(' · ')
}

/** Render user text with `@path` tokens as inline file chips. */
function UserText({ text }: { text: string }) {
  const segments = splitMentions(text)
  if (segments.length === 1 && segments[0]!.type === 'text') {
    return <>{text}</>
  }
  return (
    <>
      {segments.map((seg, i) =>
        seg.type === 'text' ? (
          <span key={i}>{seg.text}</span>
        ) : (
          <span key={i} className="msg-path-chip" title={seg.path}>
            <File size={11} />
            {basename(seg.path)}
          </span>
        )
      )}
    </>
  )
}

function basename(path: string): string {
  const clean = path.replace(/\/+$/, '')
  const slash = clean.lastIndexOf('/')
  return slash === -1 ? clean : clean.slice(slash + 1)
}

function MessageRow({
  message,
  toolRuns,
  cwd,
  midx,
  userIndex,
  copyFrom,
  turnText,
  meta,
  pinnedActions,
  onFork,
  onRetry
}: {
  message: DisplayMessage
  toolRuns: Record<string, ToolRun>
  cwd: string
  /** Absolute index in the transcript (find-in-chat target). */
  midx: number
  /** Position among user messages; defined for user rows only. */
  userIndex?: number
  /** Text the Copy action writes; omitted when the row has no actions. */
  /** First transcript index of this row's turn; set on the turn's last row
   *  when the turn has text to copy. */
  copyFrom?: number
  /** Joins the turn's text on demand (stable identity). */
  turnText?: (from: number, to: number) => string
  /** Muted "model · time" metadata in the actions row. */
  meta?: string
  /** Keep the actions row visible without hover (last assistant turn). */
  pinnedActions?: boolean
  onFork?: (userIndex: number) => void
  /** Retry handler; set only on the last assistant message. */
  onRetry?: () => void
}) {
  const homeDir = useAppStore((s) => s.appInfo?.homeDir ?? '')
  if (message.kind === 'user') {
    // `/skill:name` messages arrive as <skill> XML + typed text — show chips
    // for the invocations and hide the injected instructions by default.
    const { skills, rest } = parseSkillPrefix(message.text)
    const tilde = (p: string) =>
      homeDir && homeDir !== '/' && p.startsWith(homeDir) ? `~${p.slice(homeDir.length)}` : p
    return (
      <div className="msg-user-row fade-in" data-midx={midx}>
        <div className="msg-user">
          {skills.length > 0 && (
            <div className="skill-chips">
              {skills.map((skill, i) => (
                <span key={i} className="skill-chip" title={tilde(skill.location)}>
                  <Zap size={11} />
                  {skill.name}
                </span>
              ))}
            </div>
          )}
          {message.images.map((img: ImageContent, i: number) => (
            <img
              key={i}
              className="msg-image"
              src={`data:${img.mimeType};base64,${img.data}`}
              alt=""
            />
          ))}
          {rest && (
            <span className="msg-user-text">
              <UserText text={rest} />
            </span>
          )}
          {skills.some((s) => s.body) && (
            <details className="skill-details">
              <summary>Show skill instructions</summary>
              {skills
                .filter((s) => s.body)
                .map((s, i) => (
                  <pre key={i} className="skill-body">
                    {s.body}
                  </pre>
                ))}
            </details>
          )}
          {message.queued && <span className="msg-queued">queued — waiting for pi</span>}
        </div>
        <div className="msg-actions">
          <CopyButton text={rest || message.text} />
          {onFork !== undefined && userIndex !== undefined && (
            <button
              type="button"
              className="icon-btn msg-action"
              title="Edit & resend"
              onClick={() => onFork(userIndex)}
            >
              <Pencil size={12} />
            </button>
          )}
          {meta && <span className="msg-meta">{meta}</span>}
        </div>
      </div>
    )
  }
  if (message.kind === 'assistant') {
    const items = groupToolCalls(message.blocks)
    return (
      <div className="msg-assistant fade-in" data-midx={midx}>
        {items.map((item, i) =>
          item.type === 'toolGroup' ? (
            <ToolGroup
              key={`tg-${item.blocks[0]!.id}`}
              calls={item.blocks}
              toolRuns={toolRuns}
              cwd={cwd}
            />
          ) : (
            <MemoAssistantBlock
              key={i}
              block={item}
              run={item.type === 'toolCall' ? toolRuns[item.id] : undefined}
              cwd={cwd}
              streaming={message.streaming}
            />
          )
        )}
        {message.errorMessage && <div className="msg-error">{message.errorMessage}</div>}
        {!message.streaming && (copyFrom !== undefined || onRetry || meta) && (
          <div className={clsx('msg-actions', { 'is-pinned': pinnedActions })}>
            {copyFrom !== undefined && turnText && (
              <CopyButton text={() => turnText(copyFrom, midx)} />
            )}
            {onRetry && (
              <button
                type="button"
                className="icon-btn msg-action"
                title="Retry"
                onClick={onRetry}
              >
                <RotateCcw size={12} />
              </button>
            )}
            {meta && <span className="msg-meta">{meta}</span>}
          </div>
        )}
      </div>
    )
  }
  if (message.kind === 'bash') {
    const run: ToolRun = {
      toolCallId: message.key,
      name: 'bash',
      args: { command: message.command },
      status: message.cancelled || (message.exitCode ?? 0) !== 0 ? 'error' : 'done',
      // Same trailing status line pi's bash tool writes, so the terminal
      // card shows "exit N" / "aborted" for `!command` runs too.
      result: {
        content: [
          {
            type: 'text',
            text: message.cancelled
              ? `${message.output}\n\nCommand aborted`
              : (message.exitCode ?? 0) !== 0
                ? `${message.output}\n\nCommand exited with code ${message.exitCode}`
                : message.output
          }
        ]
      }
    }
    return (
      <div data-midx={midx}>
        <ToolCard run={run} cwd={cwd} className="fade-in" />
      </div>
    )
  }
  return (
    <div className={`msg-notice msg-notice-${message.tone} fade-in`} data-midx={midx}>
      <span>{message.text}</span>
    </div>
  )
}

/**
 * Rows re-render only when their own message object or a tool run they
 * display changes — during streaming, deltas replace just the streaming
 * message so every other row keeps its reference and skips render.
 */
const MemoMessageRow = memo(
  MessageRow,
  (prev, next) => {
    if (
      prev.message !== next.message ||
      prev.userIndex !== next.userIndex ||
      prev.onFork !== next.onFork ||
      prev.onRetry !== next.onRetry ||
      prev.midx !== next.midx ||
      prev.cwd !== next.cwd ||
      prev.copyFrom !== next.copyFrom ||
      prev.turnText !== next.turnText ||
      prev.meta !== next.meta ||
      prev.pinnedActions !== next.pinnedActions
    ) {
      return false
    }
    if (prev.toolRuns === next.toolRuns) {
      return true
    }
    const m = prev.message
    if (m.kind === 'assistant') {
      for (const block of m.blocks) {
        if (block.type === 'toolCall' && prev.toolRuns[block.id] !== next.toolRuns[block.id]) {
          return false
        }
      }
    }
    return true
  }
)

function UiRequestDialog({ chat }: { chat: ChatState }) {
  const request = chat.uiRequest
  const [value, setValue] = useState('')
  const respond = useChatStore.getState().respondUi

  // Display-only methods: acknowledge immediately so the extension never hangs.
  useEffect(() => {
    if (
      request &&
      (request.method === 'setStatus' ||
        request.method === 'setWidget' ||
        request.method === 'setTitle' ||
        request.method === 'set_editor_text' ||
        request.method === 'notify')
    ) {
      respond(chat.chatId, { id: request.id })
    }
  }, [request, chat.chatId, respond])

  if (!request || request.method !== 'select' && request.method !== 'confirm' &&
      request.method !== 'input' && request.method !== 'editor') {
    return null
  }

  if (request.method === 'confirm') {
    return (
      <div className="ui-dialog">
        <div className="ui-dialog-title">{request.title ?? 'Confirm'}</div>
        {request.message && <div className="ui-dialog-body">{request.message}</div>}
        <div className="ui-dialog-actions">
          <button
            type="button"
            className="ui-btn"
            onClick={() =>
              respond(chat.chatId, { id: request.id, confirmed: false, cancelled: true })
            }
          >
            Cancel
          </button>
          <button
            type="button"
            className="ui-btn ui-btn-primary"
            onClick={() => respond(chat.chatId, { id: request.id, confirmed: true })}
          >
            Confirm
          </button>
        </div>
      </div>
    )
  }
  if (request.method === 'select') {
    return (
      <div className="ui-dialog">
        <div className="ui-dialog-title">{request.title ?? 'Select'}</div>
        <div className="ui-dialog-options">
          {request.options.map((opt) => (
            <button
              key={opt}
              type="button"
              className="ui-btn"
              onClick={() => respond(chat.chatId, { id: request.id, value: opt })}
            >
              {opt}
            </button>
          ))}
          <button
            type="button"
            className="ui-btn"
            onClick={() => respond(chat.chatId, { id: request.id, cancelled: true })}
          >
            Cancel
          </button>
        </div>
      </div>
    )
  }
  // input / editor
  const prefill = request.method === 'editor' ? request.prefill : undefined
  return (
    <div className="ui-dialog">
      <div className="ui-dialog-title">{request.title ?? 'Input'}</div>
      {request.method === 'input' ? (
        <input
          className="ui-dialog-input"
          value={value || (prefill ?? '')}
          onChange={(e) => setValue(e.target.value)}
          placeholder={request.placeholder}
          autoFocus
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              respond(chat.chatId, { id: request.id, value: value || (prefill ?? '') })
            } else if (e.key === 'Escape') {
              respond(chat.chatId, { id: request.id, cancelled: true })
            }
          }}
        />
      ) : (
        <textarea
          className="ui-dialog-input"
          rows={6}
          defaultValue={prefill ?? ''}
          autoFocus
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              respond(chat.chatId, { id: request.id, cancelled: true })
            }
          }}
        />
      )}
      <div className="ui-dialog-actions">
        <button
          type="button"
          className="ui-btn"
          onClick={() => respond(chat.chatId, { id: request.id, cancelled: true })}
        >
          Cancel
        </button>
        <button
          type="button"
          className="ui-btn ui-btn-primary"
          onClick={() =>
            respond(chat.chatId, { id: request.id, value: value || (prefill ?? '') })
          }
        >
          OK
        </button>
      </div>
    </div>
  )
}

/** Rows rendered immediately when opening a long transcript; older rows
 * mount in chunks as the user scrolls up so first paint stays fast. */
const INITIAL_RENDER_ROWS = 60
const RENDER_CHUNK_ROWS = 80

/** HighlightRegistry isn't in older TS DOM libs. */
function highlightRegistry(): Map<string, Highlight> | undefined {
  return (CSS as unknown as { highlights?: Map<string, Highlight> }).highlights
}

function clearFindHighlights(): void {
  const registry = highlightRegistry()
  registry?.delete('find')
  registry?.delete('find-current')
}

/**
 * Build Highlight ranges for every occurrence of `query` inside mounted
 * message rows. The row containing the active match additionally feeds the
 * stronger 'find-current' highlight.
 */
function applyFindHighlights(
  root: HTMLElement,
  matches: FindMatch[],
  query: string,
  currentMessageIndex: number | undefined,
  occurrenceInMessage: number
): void {
  const registry = highlightRegistry()
  if (!registry) {
    return
  }
  if (!query) {
    clearFindHighlights()
    return
  }
  const q = query.toLowerCase()
  const ranges: Range[] = []
  let current: Range | null = null
  for (const match of matches) {
    const row = root.querySelector(`[data-midx="${match.messageIndex}"]`)
    if (!row) {
      continue
    }
    const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT)
    const rowRanges: Range[] = []
    let node: Node | null
    while ((node = walker.nextNode())) {
      const text = node.textContent ?? ''
      const lower = text.toLowerCase()
      let pos = 0
      while ((pos = lower.indexOf(q, pos)) !== -1) {
        const range = new Range()
        range.setStart(node, pos)
        range.setEnd(node, pos + q.length)
        rowRanges.push(range)
        pos += q.length
      }
    }
    if (match.messageIndex === currentMessageIndex && rowRanges.length > 0) {
      current = rowRanges[Math.min(occurrenceInMessage, rowRanges.length - 1)]!
    }
    ranges.push(...rowRanges)
  }
  registry.set('find', new Highlight(...ranges))
  if (current) {
    registry.set('find-current', new Highlight(current))
  } else {
    registry.delete('find-current')
  }
}

/**
 * The compact ⌘F bar pinned top-right of the chat pane.
 */
function FindBar({
  query,
  onQuery,
  count,
  total,
  onPrev,
  onNext,
  onClose,
  inputRef
}: {
  query: string
  onQuery: (q: string) => void
  /** 0-based index of the current occurrence. */
  count: number
  total: number
  onPrev: () => void
  onNext: () => void
  onClose: () => void
  inputRef: React.RefObject<HTMLInputElement | null>
}) {
  return (
    <div className="find-bar" role="search">
      <Search size={12} className="find-bar-icon" />
      <input
        ref={inputRef}
        className="find-bar-input"
        value={query}
        onChange={(e) => onQuery(e.target.value)}
        placeholder="Find in chat"
        spellCheck={false}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault()
            if (e.shiftKey) {
              onPrev()
            } else {
              onNext()
            }
          } else if (e.key === 'Escape') {
            e.preventDefault()
            onClose()
          }
        }}
      />
      <span className="find-bar-count">
        {query ? (total > 0 ? `${count + 1} of ${total}` : 'No results') : ''}
      </span>
      <button
        type="button"
        className="icon-btn find-bar-btn"
        title="Previous match (⇧Enter)"
        disabled={total === 0}
        onClick={onPrev}
      >
        <ChevronUp size={13} />
      </button>
      <button
        type="button"
        className="icon-btn find-bar-btn"
        title="Next match (Enter)"
        disabled={total === 0}
        onClick={onNext}
      >
        <ChevronDown size={13} />
      </button>
      <button
        type="button"
        className="icon-btn find-bar-btn"
        title="Close (Esc)"
        onClick={onClose}
      >
        <X size={13} />
      </button>
    </div>
  )
}

export function ChatView({ chatId }: { chatId: string }) {
  const chat = useChatStore((s) => s.chats[chatId])
  const scrollRef = useRef<HTMLDivElement>(null)
  const stickRef = useRef(true)
  // While a jump-initiated scroll is animating its intermediate scroll
  // events must not clear the pin — the animation's target decides it.
  const jumpAnimRef = useRef(false)
  const [showJump, setShowJump] = useState(false)
  // Accent dot on the jump button: new streamed content arrived while the
  // user was scrolled up.
  const [newContent, setNewContent] = useState(false)
  // rowsWindow.chatId keeps the count scoped: switching chats starts over at
  // INITIAL_RENDER_ROWS without a reset effect.
  const [rowsWindow, setRowsWindow] = useState({ chatId, rows: INITIAL_RENDER_ROWS })
  const renderRows =
    rowsWindow.chatId === chatId ? rowsWindow.rows : INITIAL_RENDER_ROWS
  const navigate = useAppStore((s) => s.navigate)
  const archived = useAppStore((s) =>
    chat?.sessionPath ? s.sessionMeta[chat.sessionPath]?.archived !== undefined : false
  )

  // Find-in-chat (⌘F): query is debounced so highlighting doesn't churn per
  // keystroke; findOrdinal is the global occurrence index across messages.
  const [findOpen, setFindOpen] = useState(false)
  const [findQuery, setFindQuery] = useState('')
  const [debouncedQuery, setDebouncedQuery] = useState('')
  const [findOrdinal, setFindOrdinal] = useState(0)
  const findInputRef = useRef<HTMLInputElement>(null)

  const messageCountForWindow = chat?.messages.length ?? 0
  // Windowed transcript: only the latest rows mount at first. Scrolling near
  // the top expands the window; Chromium's overflow-anchor keeps the viewport
  // steady while rows mount above.
  useEffect(() => {
    if (messageCountForWindow === 0) {
      return
    }
    const el = scrollRef.current
    if (el && el.scrollTop < 480 && renderRows < messageCountForWindow) {
      // Older content already sits against the top edge (short transcript tail).
      setRowsWindow((s) => {
        const base = s.chatId === chatId ? s.rows : INITIAL_RENDER_ROWS
        return { chatId, rows: Math.min(base + RENDER_CHUNK_ROWS, messageCountForWindow) }
      })
    }
  }, [chatId, renderRows, messageCountForWindow])

  const onScroll = useCallback(() => {
    const el = scrollRef.current
    if (!el) {
      return
    }
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight
    const nearBottom = distance < 80
    if (!jumpAnimRef.current) {
      stickRef.current = nearBottom
    }
    if (nearBottom) {
      setNewContent(false)
    }
    setShowJump(distance > 200)
    // Scrolling up mounts the next chunk of older rows immediately instead of
    // waiting for an idle callback.
    if (el.scrollTop < 480) {
      setRowsWindow((s) => {
        const base = s.chatId === chatId ? s.rows : INITIAL_RENDER_ROWS
        return base < messageCountForWindow
          ? { chatId, rows: Math.min(base + RENDER_CHUNK_ROWS, messageCountForWindow) }
          : s
      })
    }
  }, [chatId, messageCountForWindow])

  // Bookkeeping for idle eviction in main: this chat is the visible one.
  // Also clears the unread marker a finished background run left behind.
  useEffect(() => {
    void window.piDesktop.chat.focus({ chatId }).catch(() => {})
    useChatStore.getState().markRead(chatId)
  }, [chatId])

  // Copy for a whole assistant turn, joined only when the button is used.
  const turnText = useCallback(
    (from: number, to: number) => {
      const messages = useChatStore.getState().chats[chatId]?.messages ?? []
      return messages
        .slice(from, to + 1)
        .map(assistantText)
        .filter(Boolean)
        .join('\n\n')
    },
    [chatId]
  )

  // Stable identity: an inline closure would defeat row memoization.
  const onForkMessage = useCallback(
    (userIdx: number) => {
      void useChatStore
        .getState()
        .forkFromUserMessage(chatId, userIdx)
        .catch(() => {})
    },
    [chatId]
  )

  const messageCount = chat?.messages.length ?? 0
  const streaming = chat?.status === 'streaming'
  // Follow the bottom while the user is there. A ResizeObserver on the
  // column (and the viewport) pins the scroll whenever the content or the
  // viewport changes size — streamed text, a new message, and also growth
  // that happens after React's commit (lazy markdown, code highlighting,
  // images), which a message-driven effect never saw: sessions used to open
  // hundreds of pixels short of the bottom. Observer callbacks run after
  // layout and before paint, so each change costs no extra frame. When the
  // user has scrolled up (stick=false) we never yank them down — the jump
  // button's dot marks new streamed content instead.
  const pinColumn = useCallback((column: HTMLDivElement | null) => {
    const el = column?.parentElement
    if (!column || !el) {
      return
    }
    const observer = new ResizeObserver(() => {
      if (stickRef.current && !jumpAnimRef.current) {
        el.scrollTop = el.scrollHeight
      }
    })
    observer.observe(column)
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    if (stickRef.current || !streaming) {
      return
    }
    const raf = requestAnimationFrame(() => setNewContent(true))
    return () => cancelAnimationFrame(raf)
  }, [chat, messageCount, streaming])

  // Jump to the very bottom/top: expand the window synchronously first so
  // the target row is mounted before scrolling.
  const jumpTo = useCallback(
    (where: 'top' | 'bottom') => {
      const el = scrollRef.current
      if (!el) {
        return
      }
      flushSync(() => setRowsWindow({ chatId, rows: messageCount }))
      const distance = el.scrollHeight - el.scrollTop - el.clientHeight
      const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches
      const instant =
        where === 'top' || reduceMotion || distance > el.clientHeight * 3
      el.scrollTo({
        top: where === 'bottom' ? el.scrollHeight : 0,
        behavior: instant ? 'auto' : 'smooth'
      })
      // Keep the pin decision frozen until the programmatic scroll finishes
      // (Chromium fires 'scrollend'; the timeout covers instant jumps).
      jumpAnimRef.current = true
      let cleared = false
      const clearAnim = () => {
        if (!cleared) {
          cleared = true
          jumpAnimRef.current = false
        }
      }
      el.addEventListener('scrollend', clearAnim, { once: true })
      setTimeout(clearAnim, 900)
      stickRef.current = where === 'bottom'
      if (where === 'bottom') {
        setNewContent(false)
        setShowJump(false)
      }
    },
    [chatId, messageCount]
  )

  // Keyboard: ⌘↓/⌘↑ jump (unless the composer has text), ⌘F opens find.
  useEffect(() => {
    const composerBusy = () => {
      const ta = document.querySelector<HTMLTextAreaElement>('.composer-input')
      return document.activeElement === ta && (ta?.value ?? '') !== ''
    }
    const onKeyDown = (e: KeyboardEvent) => {
      if (!e.metaKey || e.ctrlKey || e.altKey) {
        return
      }
      if (e.key === 'f' && !e.shiftKey) {
        e.preventDefault()
        setFindOpen(true)
        requestAnimationFrame(() => findInputRef.current?.focus())
      } else if (e.key === 'ArrowDown' && !e.shiftKey && !composerBusy()) {
        e.preventDefault()
        jumpTo('bottom')
      } else if (e.key === 'ArrowUp' && !e.shiftKey && !composerBusy()) {
        e.preventDefault()
        jumpTo('top')
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [jumpTo])

  // The Edit → Find… menu item and the palette dispatch this event.
  useEffect(() => {
    const open = () => {
      setFindOpen(true)
      requestAnimationFrame(() => findInputRef.current?.focus())
    }
    window.addEventListener('pi-desktop:find-in-chat', open)
    return () => window.removeEventListener('pi-desktop:find-in-chat', open)
  }, [])

  // Debounce the find query.
  useEffect(() => {
    if (!findOpen) {
      return
    }
    const timer = setTimeout(() => {
      setDebouncedQuery(findQuery)
      setFindOrdinal(0)
    }, 120)
    return () => clearTimeout(timer)
  }, [findOpen, findQuery])

  const matches = useMemo(
    () =>
      findOpen && debouncedQuery && chat
        ? findMatches(chat.messages, chat.toolRuns, debouncedQuery, chat.cwd)
        : [],
    [findOpen, debouncedQuery, chat]
  )
  const matchTotal = totalOccurrences(matches)
  const currentOrdinal = Math.min(findOrdinal, Math.max(0, matchTotal - 1))
  const currentTarget =
    matchTotal > 0 ? locateOccurrence(matches, currentOrdinal) : null

  const closeFind = useCallback(() => {
    setFindOpen(false)
    setFindQuery('')
    setDebouncedQuery('')
    setFindOrdinal(0)
    clearFindHighlights()
    document.querySelector<HTMLTextAreaElement>('.composer-input')?.focus()
  }, [])

  // Clear highlights when the bar unmounts.
  useEffect(() => () => clearFindHighlights(), [])

  // Navigate to the current match: expand the window so its row mounts.
  useEffect(() => {
    if (!findOpen || !currentTarget || !chat) {
      return
    }
    const targetIdx = matches[currentTarget.matchIndex]!.messageIndex
    const hidden = chat.messages.length - renderRows
    if (targetIdx < hidden) {
      const raf = requestAnimationFrame(() =>
        setRowsWindow({ chatId, rows: chat.messages.length - targetIdx })
      )
      return () => cancelAnimationFrame(raf)
    }
  }, [findOpen, currentTarget, matches, chat, renderRows, chatId])

  // Scroll to the current row and paint the highlights. Highlights repaint
  // on every publish (new streamed matches appear live), but the scroll only
  // happens when the navigated target changes — otherwise every delta would
  // yank the viewport back.
  const findNavRef = useRef('')
  useEffect(() => {
    const el = scrollRef.current
    if (!el) {
      return
    }
    if (!findOpen || !debouncedQuery) {
      clearFindHighlights()
      findNavRef.current = ''
      return
    }
    const raf = requestAnimationFrame(() => {
      const targetIdx =
        currentTarget !== null
          ? matches[currentTarget.matchIndex]!.messageIndex
          : undefined
      applyFindHighlights(
        el,
        matches,
        debouncedQuery,
        targetIdx,
        currentTarget?.occurrenceInMessage ?? 0
      )
      if (targetIdx !== undefined) {
        const navKey = `${debouncedQuery}:${currentOrdinal}`
        if (findNavRef.current !== navKey) {
          findNavRef.current = navKey
          const reduceMotion = window
            .matchMedia('(prefers-reduced-motion: reduce)')
            .matches
          el.querySelector(`[data-midx="${targetIdx}"]`)?.scrollIntoView({
            block: 'center',
            behavior: reduceMotion ? 'auto' : 'smooth'
          })
        }
      }
    })
    return () => cancelAnimationFrame(raf)
  }, [findOpen, debouncedQuery, currentOrdinal, currentTarget, matches, renderRows])

  const goFind = useCallback(
    (delta: 1 | -1) => {
      if (matchTotal === 0) {
        return
      }
      setFindOrdinal((o) => (o + delta + matchTotal) % matchTotal)
    },
    [matchTotal]
  )

  if (!chat) {
    return (
      <div className="chat-view">
        <div className="chat-empty">
          <p>Chat is not open.</p>
          <button type="button" className="ui-btn" onClick={() => navigate({ kind: 'home' })}>
            Back home
          </button>
        </div>
      </div>
    )
  }

  const hiddenRows = Math.max(0, chat.messages.length - renderRows)
  // Fork indices count user messages across the whole transcript, so start
  // at however many live in the windowed-off head.
  let userIndex = -1
  if (hiddenRows > 0) {
    for (const m of chat.messages.slice(0, hiddenRows)) {
      if (m.kind === 'user') {
        userIndex += 1
      }
    }
  }
  // Retry is offered only on the last assistant message of the transcript.
  const canFork = chat.sessionPath && chat.status !== 'streaming'
  let lastAssistantMidx = -1
  for (let i = chat.messages.length - 1; i >= 0; i--) {
    const m = chat.messages[i]!
    if (m.kind === 'assistant' && !m.streaming) {
      lastAssistantMidx = i
      break
    }
  }

  // Before the first token lands there is no assistant block to render yet —
  // show a "Thinking · Ns" status so the stream doesn't look stalled.
  const lastMessage = chat.messages.at(-1)
  const awaitingFirstToken =
    chat.status === 'streaming' &&
    (!lastMessage ||
      (lastMessage.kind === 'assistant' && lastMessage.blocks.length === 0) ||
      lastMessage.kind === 'user' ||
      lastMessage.kind === 'notice')

  return (
    <div className="chat-view">
      {archived && (
        <div className="archived-banner" role="status">
          <span>This chat is archived</span>
          <button
            type="button"
            className="ui-btn archived-banner-btn"
            onClick={() =>
              void setSessionArchived(chat.sessionPath!, false)
            }
          >
            Unarchive
          </button>
        </div>
      )}
      <div className="chat-scroll" ref={scrollRef} onScroll={onScroll}>
        <div className="chat-column" ref={pinColumn}>
          {chat.hasEarlier && (
            <div className="msg-load-earlier-wrap">
              <button
                type="button"
                className="ui-btn msg-load-earlier"
                onClick={() =>
                  void useChatStore.getState().loadEarlier(chatId).catch(() => {})
                }
              >
                Load earlier messages
              </button>
            </div>
          )}
          {hiddenRows > 0 && (
            <div className="msg-window-note" aria-hidden="true">
              …
            </div>
          )}
          {(() => {
            // Consecutive assistant messages form one turn: its actions row
            // renders once, after the turn's last message, and reveals on
            // hover anywhere in the turn.
            const rowItems: (
              | { kind: 'turn'; midxs: number[] }
              | { kind: 'row'; midx: number }
            )[] = []
            for (let i = hiddenRows; i < chat.messages.length; i++) {
              const last = rowItems[rowItems.length - 1]
              if (chat.messages[i]!.kind === 'assistant') {
                if (last?.kind === 'turn') {
                  last.midxs.push(i)
                } else {
                  rowItems.push({ kind: 'turn', midxs: [i] })
                }
              } else {
                rowItems.push({ kind: 'row', midx: i })
              }
            }
            return rowItems.map((item) => {
              if (item.kind === 'turn') {
                const turnMidx = item.midxs[item.midxs.length - 1]!
                const turnLast = chat.messages[turnMidx]!
                const isLastTurn = turnMidx === chat.messages.length - 1
                const hasCopy = item.midxs.some((mi) => hasAssistantText(chat.messages[mi]!))
                const meta = messageMeta(turnLast, chat.models)
                const retryUserIdx = userIndex >= 0 ? userIndex : undefined
                const renderRow = (midx: number, k: number) => {
                  const m = chat.messages[midx]!
                  const isLast = k === item.midxs.length - 1
                  return (
                    <Perf key={m.key} id="MessageRow">
                      <MemoMessageRow
                        message={m}
                        toolRuns={chat.toolRuns}
                        cwd={chat.cwd}
                        midx={midx}
                        copyFrom={isLast && hasCopy ? item.midxs[0] : undefined}
                        turnText={turnText}
                        meta={isLast ? meta : undefined}
                        pinnedActions={isLast && isLastTurn}
                        onRetry={
                          canFork &&
                          isLast &&
                          isLastTurn &&
                          turnMidx === lastAssistantMidx &&
                          retryUserIdx !== undefined
                            ? () => {
                                stickRef.current = true
                                void useChatStore
                                  .getState()
                                  .retryFromUserMessage(chatId, retryUserIdx)
                                  .catch(() => {})
                              }
                            : undefined
                        }
                      />
                    </Perf>
                  )
                }
                // Fold runs of reasoning/tool-only messages into work rows.
                // The turn's last message stays out: it carries the actions.
                const parts: React.ReactNode[] = []
                let run: number[] = []
                const flush = (): void => {
                  if (run.length >= WORK_GROUP_MIN) {
                    const first = chat.messages[run[0]!]!
                    const next = chat.messages[run[run.length - 1]! + 1]
                    const ks = run.map((mi) => item.midxs.indexOf(mi))
                    parts.push(
                      <WorkGroup
                        key={`work-${first.key}`}
                        messages={run.map((mi) => chat.messages[mi]!)}
                        toolRuns={chat.toolRuns}
                        startedAt={first.timestamp}
                        endedAt={next?.timestamp}
                        live={streaming && isLastTurn}
                        forceOpen={findOpen}
                      >
                        {run.map((mi, j) => renderRow(mi, ks[j]!))}
                      </WorkGroup>
                    )
                  } else {
                    for (const mi of run) {
                      parts.push(renderRow(mi, item.midxs.indexOf(mi)))
                    }
                  }
                  run = []
                }
                item.midxs.forEach((midx, k) => {
                  if (k < item.midxs.length - 1 && isTraceOnly(chat.messages[midx]!)) {
                    run.push(midx)
                    return
                  }
                  flush()
                  parts.push(renderRow(midx, k))
                })
                flush()
                return (
                  <div className="msg-turn" key={`turn-${turnLast.key}`}>
                    {parts}
                  </div>
                )
              }
              const midx = item.midx
              const m = chat.messages[midx]!
              const idx = m.kind === 'user' ? ++userIndex : undefined
              return (
                <Perf key={m.key} id="MessageRow">
                  <MemoMessageRow
                    message={m}
                    toolRuns={chat.toolRuns}
                    cwd={chat.cwd}
                    midx={midx}
                    userIndex={idx}
                    meta={messageMeta(m, chat.models)}
                    onFork={canFork ? onForkMessage : undefined}
                  />
                </Perf>
              )
            })
          })()}
          {awaitingFirstToken && (
            <div className="msg-pending" aria-live="polite">
              <LiveDot className="composer-status-dot" />
              <span>Thinking</span>
              {chat.runStartedAt !== undefined && (
                <>
                  <span aria-hidden="true">·</span>
                  <Elapsed since={chat.runStartedAt} />
                </>
              )}
            </div>
          )}
          {chat.error && chat.status !== 'exited' && (
            <div className="msg-notice msg-notice-error">
              <span>{chat.error}</span>
              {chat.status === 'error' && (
                <button
                  type="button"
                  className="ui-btn"
                  onClick={() =>
                    void useChatStore
                      .getState()
                      .ensureChat(chatId, { cwd: chat.cwd, sessionPath: chat.sessionPath })
                      .catch(() => {})
                  }
                >
                  <RotateCcw size={12} /> Retry
                </button>
              )}
            </div>
          )}
          {chat.status === 'exited' && (
            <div className="exit-card">
              <div className="exit-card-head">
                <CircleAlert size={15} />
                <div className="exit-card-text">
                  <div className="exit-card-title">
                    {chat.error ?? 'The pi process exited.'}
                  </div>
                  <div className="exit-card-sub">
                    The transcript stays here — restart pi to keep chatting.
                  </div>
                </div>
                <button
                  type="button"
                  className="ui-btn"
                  onClick={() =>
                    void useChatStore
                      .getState()
                      .ensureChat(chatId, { cwd: chat.cwd, sessionPath: chat.sessionPath })
                      .catch(() => {})
                  }
                >
                  <RotateCcw size={12} /> Restart pi
                </button>
              </div>
              {chat.stderrTail && chat.stderrTail.length > 0 && (
                <details className="exit-card-details">
                  <summary>Show details</summary>
                  <pre className="exit-card-stderr">{chat.stderrTail.join('\n')}</pre>
                </details>
              )}
            </div>
          )}
        </div>
      </div>

      <button
        type="button"
        className={showJump ? 'jump-btn is-visible' : 'jump-btn'}
        aria-hidden={!showJump}
        tabIndex={showJump ? 0 : -1}
        title="Jump to bottom (⌘↓)"
        onClick={() => jumpTo('bottom')}
      >
        <ArrowDown size={15} />
        {newContent && <span className="jump-dot" />}
      </button>

      {findOpen && (
        <FindBar
          query={findQuery}
          onQuery={setFindQuery}
          count={currentOrdinal}
          total={matchTotal}
          onPrev={() => goFind(-1)}
          onNext={() => goFind(1)}
          onClose={closeFind}
          inputRef={findInputRef}
        />
      )}

      <UiRequestDialog chat={chat} />

      <div className="chat-composer-dock">
        <CuaActivityStrip chat={chat} />
        <Perf id="Composer">
          <Composer
            chat={chat}
            isChat
            onSend={(message, images, mode) => {
              // Sending always re-pins to the bottom — the user's own message
              // and the pending/streaming rows belong in view.
              stickRef.current = true
              void useChatStore.getState().send(chatId, message, images, mode).catch(() => {})
            }}
          />
        </Perf>
        {streaming && (
          <div className="chat-stats">
            Enter to steer · ⌥Enter to queue a follow-up
          </div>
        )}
      </div>
    </div>
  )
}
