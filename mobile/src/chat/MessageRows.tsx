import { memo, useState } from 'react'
import { Image, StyleSheet, Text, View } from 'react-native'

import {
  formatDuration,
  parseSkillPrefix,
  shellStatusLabel,
  splitMentions,
  summarizeToolRuns,
  type DisplayBlock,
  type DisplayMessage,
  type ToolRun
} from '../desktop'
import { baseName } from '../lib/format'
import { fonts, makeStyles, radius, space, type Theme } from '../theme'
import { Mono, Pixel, Tap, Txt } from '../ui'
import { Markdown } from './Markdown'
import { DiffStat, ThinkingStep, ToolGroup, ToolStep, WorkRow, type ToolCall } from './ToolStep'

type Assistant = Extract<DisplayMessage, { kind: 'assistant' }>
type User = Extract<DisplayMessage, { kind: 'user' }>

export interface RowActions {
  /** Long-press on a prompt: copy, edit and resend, retry, restore files. */
  onUserMenu(message: User, userIndex: number): void
  /** Long-press on a reply: copy. */
  onAssistantMenu(message: Assistant): void
  onImage(uri: string): void
  onOpenFile(path: string): void
}

const useStyles = makeStyles((t: Theme) => ({
  row: { paddingHorizontal: space.lg, paddingVertical: space.sm },
  user: {
    flexDirection: 'row',
    gap: space.sm,
    backgroundColor: t.userBlock,
    borderRadius: radius.md,
    paddingVertical: space.md,
    paddingHorizontal: space.md
  },
  userText: { color: t.text, fontSize: 16, lineHeight: 24 },
  chip: {
    fontFamily: fonts.mono,
    fontSize: 14,
    color: t.accent
  },
  thumb: { width: 72, height: 72, borderRadius: radius.sm, backgroundColor: t.codeBg },
  steps: { marginHorizontal: -space.sm },
  error: {
    borderLeftWidth: 2,
    borderLeftColor: t.danger,
    paddingLeft: space.md,
    paddingVertical: space.xs
  },
  notice: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  term: {
    backgroundColor: t.codeBg,
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: t.border,
    overflow: 'hidden'
  },
  termText: { fontFamily: fonts.mono, fontSize: 12, lineHeight: 17, color: t.text2, padding: space.md },
  termFoot: {
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: t.border
  },
  workBody: {
    marginLeft: space.md,
    borderLeftWidth: StyleSheet.hairlineWidth,
    borderLeftColor: t.border,
    paddingLeft: space.xs
  }
}))

// ---------------------------------------------------------------------------
// User prompt
// ---------------------------------------------------------------------------

export const UserRow = memo(function UserRow({
  message,
  userIndex,
  actions
}: {
  message: User
  userIndex: number
  actions: RowActions
}) {
  const styles = useStyles()
  const { skills, rest } = parseSkillPrefix(message.text)
  const segments = splitMentions(rest)
  return (
    <View style={styles.row}>
      <Tap
        onLongPress={() => actions.onUserMenu(message, userIndex)}
        delayLongPress={350}
        accessibilityRole="text"
        accessibilityHint="Long press for actions"
        style={styles.user}
      >
        {/* A prompt, not a bubble: a › in the gutter. */}
        <Mono size={16} tone="muted" style={{ lineHeight: 24 }}>
          ›
        </Mono>
        <View style={{ flex: 1, gap: space.sm }}>
          {skills.length > 0 ? (
            <Mono size={12} tone="accent">
              {skills.map((s) => `/skill:${s.name}`).join(' ')}
            </Mono>
          ) : null}
          {rest.trim() ? (
            <Text style={styles.userText} selectable>
              {segments.map((segment, index) =>
                segment.type === 'text' ? (
                  segment.text
                ) : (
                  <Text key={index} style={styles.chip}>
                    {`@${baseName(segment.path)}`}
                  </Text>
                )
              )}
            </Text>
          ) : null}
          {message.images.length > 0 ? (
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space.sm }}>
              {message.images.map((image, index) => {
                const uri = `data:${image.mimeType};base64,${image.data}`
                return (
                  <Tap key={index} label="Open image" onPress={() => actions.onImage(uri)}>
                    <Image source={{ uri }} style={styles.thumb} accessibilityLabel="Attached image" />
                  </Tap>
                )
              })}
            </View>
          ) : null}
          {message.queued ? (
            <Mono size={12} tone="muted">
              queued · waiting for pi to start
            </Mono>
          ) : null}
        </View>
      </Tap>
    </View>
  )
})

// ---------------------------------------------------------------------------
// Assistant message
// ---------------------------------------------------------------------------

type RenderItem = DisplayBlock | { type: 'toolGroup'; calls: ToolCall[] }

/** Fold runs of consecutive tool calls into one group; a lone call stays a row. */
function groupToolCalls(blocks: DisplayBlock[]): RenderItem[] {
  const items: RenderItem[] = []
  for (const block of blocks) {
    const last = items[items.length - 1]
    if (block.type !== 'toolCall') {
      items.push(block)
    } else if (last?.type === 'toolGroup') {
      items[items.length - 1] = { type: 'toolGroup', calls: [...last.calls, block] }
    } else if (last?.type === 'toolCall') {
      items[items.length - 1] = { type: 'toolGroup', calls: [last, block] }
    } else {
      items.push(block)
    }
  }
  return items
}

function AssistantBody({
  message,
  toolRuns,
  cwd,
  live,
  actions
}: {
  message: Assistant
  toolRuns: Record<string, ToolRun>
  cwd: string
  live: boolean
  actions: RowActions
}) {
  const styles = useStyles()
  const streaming = live && message.streaming === true
  return (
    <View style={{ gap: space.sm }}>
      {groupToolCalls(message.blocks).map((item, index) => {
        switch (item.type) {
          case 'text':
            return item.text.trim() ? (
              <Tap
                key={index}
                accessibilityRole="text"
                onLongPress={() => actions.onAssistantMenu(message)}
                delayLongPress={350}
                android_ripple={null}
              >
                <Markdown text={item.text} selectable={!streaming} />
              </Tap>
            ) : null
          case 'thinking':
            return (
              <View key={index} style={styles.steps}>
                <ThinkingStep block={item} live={streaming} />
              </View>
            )
          case 'toolCall':
            return (
              <View key={index} style={styles.steps}>
                <ToolStep
                  call={item}
                  run={toolRuns[item.id]}
                  cwd={cwd}
                  live={live}
                  onImage={actions.onImage}
                  onOpenFile={actions.onOpenFile}
                />
              </View>
            )
          case 'toolGroup':
            return (
              <View key={index} style={styles.steps}>
                <ToolGroup
                  calls={item.calls}
                  toolRuns={toolRuns}
                  cwd={cwd}
                  live={live}
                  onImage={actions.onImage}
                  onOpenFile={actions.onOpenFile}
                />
              </View>
            )
          case 'image':
            return (
              <Tap
                key={index}
                label="Open image"
                onPress={() => actions.onImage(`data:${item.mimeType};base64,${item.data}`)}
              >
                <Image
                  source={{ uri: `data:${item.mimeType};base64,${item.data}` }}
                  style={{ width: '100%', height: 200, borderRadius: radius.sm }}
                  resizeMode="contain"
                  accessibilityLabel="Image in the reply"
                />
              </Tap>
            )
        }
      })}
      {message.errorMessage ? (
        <View style={styles.error}>
          <Txt size="small" tone="danger" selectable>
            {message.errorMessage}
          </Txt>
        </View>
      ) : message.stopReason === 'aborted' ? (
        <Mono size={12} tone="muted">
          stopped
        </Mono>
      ) : null}
    </View>
  )
}

/** Only the runs this message's tool calls point at matter for a re-render. */
function sameRuns(
  message: Assistant,
  a: Record<string, ToolRun>,
  b: Record<string, ToolRun>
): boolean {
  for (const block of message.blocks) {
    if (block.type === 'toolCall' && a[block.id] !== b[block.id]) {
      return false
    }
  }
  return true
}

interface AssistantRowProps {
  message: Assistant
  toolRuns: Record<string, ToolRun>
  cwd: string
  live: boolean
  actions: RowActions
}

export const AssistantRow = memo(
  function AssistantRow(props: AssistantRowProps) {
    const styles = useStyles()
    return (
      <View style={styles.row}>
        <AssistantBody {...props} />
      </View>
    )
  },
  (prev, next) =>
    prev.message === next.message &&
    prev.cwd === next.cwd &&
    prev.live === next.live &&
    prev.actions === next.actions &&
    sameRuns(next.message, prev.toolRuns, next.toolRuns)
)

// ---------------------------------------------------------------------------
// Work group
// ---------------------------------------------------------------------------

interface WorkGroupRowProps {
  messages: Assistant[]
  toolRuns: Record<string, ToolRun>
  cwd: string
  live: boolean
  startedAt?: number
  endedAt?: number
  actions: RowActions
}

/**
 * A stretch of agent work — many small messages that are only thinking and
 * tool calls — as one row: "Worked for 2m 10s · read 4 files, ran 3
 * commands". Open while the turn is live, folded once it settles; the user's
 * toggle wins either way.
 */
export const WorkGroupRow = memo(
  function WorkGroupRow({ messages, toolRuns, cwd, live, startedAt, endedAt, actions }: WorkGroupRowProps) {
    const styles = useStyles()
    const [userOpen, setUserOpen] = useState<boolean | null>(null)
    const open = userOpen ?? live
    let thoughts = 0
    const runs: { name: string; args: Record<string, unknown>; status: ToolRun['status'] }[] = []
    for (const message of messages) {
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
    const span = startedAt !== undefined && endedAt !== undefined ? endedAt - startedAt : undefined
    const label = live
      ? 'Working'
      : span !== undefined && span >= 1000
        ? `Worked for ${formatDuration(span)}`
        : 'Worked'
    const counts = [
      runs.length > 0 ? `${runs.length} ${runs.length === 1 ? 'tool' : 'tools'}` : '',
      thoughts > 0 ? `${thoughts} ${thoughts === 1 ? 'thought' : 'thoughts'}` : ''
    ]
      .filter(Boolean)
      .join(' · ')
    return (
      <View style={[styles.row, { paddingVertical: space.xs }]}>
        <View style={styles.steps}>
          <WorkRow
            label={label}
            summary={runs.length > 0 ? summary.text : counts}
            state={running ? 'running' : summary.failed > 0 ? 'error' : 'done'}
            open={open}
            onToggle={() => setUserOpen(!open)}
            right={
              !running && summary.diff ? (
                <DiffStat added={summary.diff.added} removed={summary.diff.removed} />
              ) : undefined
            }
          />
          {open ? (
            <View style={styles.workBody}>
              {messages.map((message) => (
                <View key={message.key} style={{ paddingHorizontal: space.sm, paddingVertical: space.xs }}>
                  <AssistantBody
                    message={message}
                    toolRuns={toolRuns}
                    cwd={cwd}
                    live={live}
                    actions={actions}
                  />
                </View>
              ))}
            </View>
          ) : null}
        </View>
      </View>
    )
  },
  (prev, next) =>
    prev.live === next.live &&
    prev.cwd === next.cwd &&
    prev.endedAt === next.endedAt &&
    prev.actions === next.actions &&
    prev.messages.length === next.messages.length &&
    next.messages.every(
      (message, index) =>
        message === prev.messages[index] && sameRuns(message, prev.toolRuns, next.toolRuns)
    )
)

// ---------------------------------------------------------------------------
// Shell run, notice, turn meta
// ---------------------------------------------------------------------------

/** A `!command` the user ran: the same terminal card as a shell step, opened. */
export const BashRow = memo(function BashRow({
  message
}: {
  message: Extract<DisplayMessage, { kind: 'bash' }>
}) {
  const styles = useStyles()
  const failed = !message.running && (message.cancelled || (message.exitCode ?? 0) !== 0)
  const lines = message.output.replace(/\n+$/, '').split('\n')
  const output = lines.length > 120 ? `⋯\n${lines.slice(-120).join('\n')}` : lines.join('\n')
  return (
    <View style={styles.row}>
      <View style={styles.term}>
        <Text style={[styles.termText, output.trim() ? { paddingBottom: 0 } : null]} selectable>
          <Text style={{ opacity: 0.6 }}>$ </Text>
          {message.command}
        </Text>
        {output.trim() ? (
          <Text style={styles.termText} selectable>
            {output}
          </Text>
        ) : null}
        <View style={styles.termFoot}>
          <Mono size={12} tone={message.running ? 'accent' : failed ? 'danger' : 'success'}>
            {message.running
              ? 'running'
              : message.cancelled
                ? shellStatusLabel({ kind: 'aborted' })
                : shellStatusLabel({ kind: 'exit', code: message.exitCode ?? 0 })}
          </Mono>
        </View>
      </View>
    </View>
  )
})

export const NoticeRow = memo(function NoticeRow({
  message
}: {
  message: Extract<DisplayMessage, { kind: 'notice' }>
}) {
  const styles = useStyles()
  const [open, setOpen] = useState(false)
  const line = (
    <View style={styles.notice}>
      <Pixel tone={message.tone === 'error' ? 'error' : 'idle'} size={6} />
      <Mono size={12} tone={message.tone === 'error' ? 'danger' : 'muted'} style={{ flex: 1 }}>
        {message.text}
        {message.detail ? (open ? '  ▾' : '  ▸') : ''}
      </Mono>
    </View>
  )
  return (
    <View style={styles.row}>
      {message.detail ? (
        <Tap
          onPress={() => setOpen(!open)}
          accessibilityState={{ expanded: open }}
          style={{ minHeight: 40, justifyContent: 'center' }}
        >
          {line}
        </Tap>
      ) : (
        line
      )}
      {open && message.detail ? (
        <View style={{ marginTop: space.sm }}>
          <Markdown text={message.detail} />
        </View>
      ) : null}
    </View>
  )
})

/** "model · 14:02 · 1.8k tokens out · $0.04" under a finished turn. */
export const MetaRow = memo(function MetaRow({ text }: { text: string }) {
  const styles = useStyles()
  return (
    <View style={[styles.row, { paddingTop: 0 }]}>
      <Mono size={12} tone="muted">
        {text}
      </Mono>
    </View>
  )
})
