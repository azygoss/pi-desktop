import * as Clipboard from 'expo-clipboard'
import {
  ChevronRight,
  Copy,
  FilePlus,
  FileText,
  Globe,
  Lightbulb,
  ListTree,
  MousePointer2,
  Pencil,
  Search,
  Terminal,
  Wrench,
  type LucideIcon
} from 'lucide-react-native'
import { memo, useMemo, useState, type ReactNode } from 'react'
import { Image, StyleSheet, Text, View } from 'react-native'

import {
  MIN_SHOWN_DURATION_MS,
  changedLines,
  diffLines,
  editEntries,
  formatDuration,
  shellStatusLabel,
  splitShellStatus,
  summarizeToolRuns,
  toolCallSummary,
  toolCategory,
  trimContext,
  type DiffLine,
  type DisplayBlock,
  type ToolCategory,
  type ToolRun
} from '../desktop'
import { useTick } from '../lib/live-clock'
import { fonts, makeStyles, radius, space, TOUCH, useTheme, type Theme } from '../theme'
import { IconButton, Mono, Tap, toast, Txt } from '../ui'

type ToolCall = Extract<DisplayBlock, { type: 'toolCall' }>
type Thinking = Extract<DisplayBlock, { type: 'thinking' }>
type StepState = 'running' | 'error' | 'done'

/** Output and diffs longer than this fold behind "Show all". */
const MAX_LINES = 80
const MAX_ARG_CHARS = 2000

const ICONS: Record<ToolCategory, LucideIcon> = {
  run: Terminal,
  read: FileText,
  edit: Pencil,
  create: FilePlus,
  search: Search,
  browser: Globe,
  computer: MousePointer2,
  other: Wrench
}

const useStyles = makeStyles((t: Theme) => ({
  row: {
    minHeight: TOUCH - 4,
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    paddingVertical: space.xs,
    paddingHorizontal: space.sm,
    borderRadius: radius.md
  },
  open: { backgroundColor: t.surface, borderRadius: radius.md },
  tile: {
    width: 24,
    height: 24,
    borderRadius: radius.sm,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: t.surface
  },
  body: { paddingHorizontal: space.sm, paddingBottom: space.sm, gap: space.sm },
  term: {
    backgroundColor: t.codeBg,
    borderRadius: radius.sm,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: t.border,
    overflow: 'hidden'
  },
  termText: { fontFamily: fonts.mono, fontSize: 12, lineHeight: 17, color: t.text2, padding: space.sm },
  termFoot: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingLeft: space.sm,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: t.border
  },
  diffLine: { fontFamily: fonts.mono, fontSize: 12, lineHeight: 17, color: t.text2, paddingHorizontal: space.sm },
  added: { backgroundColor: t.successSoft, color: t.text },
  removed: { backgroundColor: t.dangerSoft, color: t.text },
  gap: { fontFamily: fonts.mono, fontSize: 12, lineHeight: 17, color: t.muted, paddingHorizontal: space.sm },
  shot: {
    width: '100%',
    height: 200,
    borderRadius: radius.sm,
    backgroundColor: t.codeBg
  },
  thought: { color: t.text2, fontSize: 14, lineHeight: 21 },
  nested: { marginLeft: space.md, borderLeftWidth: StyleSheet.hairlineWidth, borderLeftColor: t.border, paddingLeft: space.xs }
}))

function StepTile({ icon: Icon, state }: { icon: LucideIcon; state: StepState }) {
  const styles = useStyles()
  const theme = useTheme()
  // Blue while running (blinking on the shared 1 Hz clock), coral on failure.
  const tick = useTick(state === 'running')
  const color = state === 'running' ? theme.accent : state === 'error' ? theme.danger : theme.muted
  return (
    <View style={[styles.tile, state === 'running' && tick % 2 === 1 ? { opacity: 0.45 } : null]}>
      <Icon size={13} color={color} strokeWidth={1.9} />
    </View>
  )
}

function DiffStat({ added, removed }: { added: number; removed: number }) {
  if (added === 0 && removed === 0) {
    return null
  }
  return (
    <Text>
      <Mono size={12} tone="success">{`+${added}`}</Mono>
      <Mono size={12} tone="muted"> </Mono>
      <Mono size={12} tone="danger">{`−${removed}`}</Mono>
    </Text>
  )
}

function StepRow({
  icon,
  state,
  name,
  summary,
  right,
  open,
  onToggle,
  label
}: {
  icon: LucideIcon
  state: StepState
  name: string
  summary?: string
  right?: ReactNode
  open: boolean
  onToggle(): void
  label: string
}) {
  const styles = useStyles()
  const theme = useTheme()
  return (
    <Tap
      onPress={onToggle}
      style={styles.row}
      accessibilityLabel={label}
      accessibilityState={{ expanded: open }}
    >
      <StepTile icon={icon} state={state} />
      <Text style={{ flex: 1 }} numberOfLines={1}>
        <Mono size={13} tone={state === 'error' ? 'danger' : 'text'} weight="medium">
          {name}
        </Mono>
        {summary ? <Mono size={13} tone="muted">{`  ${summary}`}</Mono> : null}
      </Text>
      {right}
      <ChevronRight
        size={14}
        color={theme.muted}
        style={{ transform: [{ rotate: open ? '90deg' : '0deg' }] }}
      />
    </Tap>
  )
}

/** Mono text that folds its middle away when long ("Show all N lines"). */
function Folded({ text, tail = false }: { text: string; tail?: boolean }) {
  const styles = useStyles()
  const [all, setAll] = useState(false)
  const lines = useMemo(() => text.split('\n'), [text])
  const long = lines.length > MAX_LINES
  // Shell output: the end is what matters; file content: the start.
  const shown =
    !long || all
      ? text
      : (tail ? lines.slice(-MAX_LINES) : lines.slice(0, MAX_LINES)).join('\n')
  return (
    <>
      {long && !all && tail ? (
        <Tap onPress={() => setAll(true)} style={{ minHeight: TOUCH, justifyContent: 'center' }}>
          <Text style={styles.gap}>{`⋯ show all ${lines.length} lines`}</Text>
        </Tap>
      ) : null}
      <Text style={styles.termText} selectable>
        {shown}
      </Text>
      {long && !all && !tail ? (
        <Tap onPress={() => setAll(true)} style={{ minHeight: TOUCH, justifyContent: 'center' }}>
          <Text style={styles.gap}>{`⋯ show all ${lines.length} lines`}</Text>
        </Tap>
      ) : null}
    </>
  )
}

function resultText(run: ToolRun | undefined): string {
  if (!run) {
    return ''
  }
  if (run.result) {
    return run.result.content
      .filter((b) => b.type === 'text')
      .map((b) => (b.type === 'text' ? b.text : ''))
      .join('\n')
  }
  return run.partialText ?? ''
}

/** A unified diff of an edit: removed and added lines interleaved. */
export const DiffBlock = memo(function DiffBlock({ lines }: { lines: (DiffLine | null)[] }) {
  const styles = useStyles()
  const [all, setAll] = useState(false)
  const shown = all ? lines : lines.slice(0, MAX_LINES)
  return (
    <View style={styles.term}>
      <View style={{ paddingVertical: space.xs }}>
        {shown.map((line, index) =>
          line === null ? (
            <Text key={index} style={styles.gap}>
              ⋯
            </Text>
          ) : (
            <Text
              key={index}
              style={[
                styles.diffLine,
                line.kind === 'added' ? styles.added : line.kind === 'removed' ? styles.removed : null
              ]}
            >
              {`${line.kind === 'added' ? '+' : line.kind === 'removed' ? '−' : ' '} ${line.text}`}
            </Text>
          )
        )}
        {lines.length > MAX_LINES && !all ? (
          <Tap onPress={() => setAll(true)} style={{ minHeight: TOUCH, justifyContent: 'center' }}>
            <Text style={styles.gap}>{`⋯ ${lines.length - MAX_LINES} more lines`}</Text>
          </Tap>
        ) : null}
      </View>
    </View>
  )
})

function ToolDetail({
  call,
  run,
  category,
  onImage
}: {
  call: ToolCall
  run: ToolRun | undefined
  category: ToolCategory
  onImage?(uri: string): void
}) {
  const styles = useStyles()
  const args = run && Object.keys(run.args).length > 0 ? run.args : call.arguments
  const text = resultText(run)
  const images = run?.result?.content.filter((b) => b.type === 'image') ?? []

  if (category === 'run') {
    const { output, status } = splitShellStatus(text)
    const command = typeof args['command'] === 'string' ? args['command'] : ''
    return (
      <View style={styles.term}>
        <Text style={[styles.termText, { paddingBottom: 0 }]} selectable>
          <Text style={{ color: styles.gap.color }}>$ </Text>
          {command}
        </Text>
        {output.trim() ? <Folded text={output.replace(/\n+$/, '')} tail /> : <View style={{ height: space.sm }} />}
        <View style={styles.termFoot}>
          <Mono
            size={12}
            tone={
              run?.status === 'running'
                ? 'accent'
                : status || run?.status === 'error'
                  ? 'danger'
                  : 'success'
            }
          >
            {run?.status === 'running' ? 'running' : status ? shellStatusLabel(status) : run?.status === 'error' ? 'failed' : 'exit 0'}
          </Mono>
          <IconButton
            icon={Copy}
            label="Copy output"
            size={14}
            tone="muted"
            style={{ height: 40 }}
            onPress={() => {
              void Clipboard.setStringAsync(output)
              toast('Copied')
            }}
          />
        </View>
      </View>
    )
  }

  if (category === 'edit') {
    const entries = editEntries(args)
    if (entries.length > 0) {
      return (
        <>
          {entries.map((entry, index) => (
            <DiffBlock
              key={index}
              lines={trimContext(diffLines(entry.oldText ?? '', entry.newText ?? ''))}
            />
          ))}
          {run?.status === 'error' && text ? <Text style={styles.termText}>{text}</Text> : null}
        </>
      )
    }
  }

  if (category === 'create' && typeof args['content'] === 'string') {
    return (
      <>
        <DiffBlock
          lines={(args['content'] as string)
            .replace(/\n$/, '')
            .split('\n')
            .map((line) => ({ kind: 'added' as const, text: line }))}
        />
        {run?.status === 'error' && text ? <Text style={styles.termText}>{text}</Text> : null}
      </>
    )
  }

  const argText = JSON.stringify(args, null, 2)
  return (
    <>
      {argText !== '{}' && category !== 'read' ? (
        <View style={styles.term}>
          <Text style={styles.termText} selectable>
            {argText.length > MAX_ARG_CHARS ? `${argText.slice(0, MAX_ARG_CHARS)}\n⋯` : argText}
          </Text>
        </View>
      ) : null}
      {images.map((image, index) =>
        image.type === 'image' ? (
          <Tap
            key={index}
            label="Open screenshot"
            onPress={() => onImage?.(`data:${image.mimeType};base64,${image.data}`)}
          >
            <Image
              source={{ uri: `data:${image.mimeType};base64,${image.data}` }}
              style={styles.shot}
              resizeMode="contain"
              accessibilityLabel="Screenshot from the tool"
            />
          </Tap>
        ) : null
      )}
      {text.trim() ? (
        <View style={styles.term}>
          <Folded text={text.replace(/\n+$/, '')} />
        </View>
      ) : null}
    </>
  )
}

function stateOf(run: ToolRun | undefined, live: boolean): StepState {
  if (!run) {
    // No run yet: pi is still writing the call (live) or the session was
    // reopened without its result.
    return live ? 'running' : 'done'
  }
  return run.status
}

function editStat(category: ToolCategory, args: Record<string, unknown>): { added: number; removed: number } | null {
  if (category === 'edit') {
    let added = 0
    let removed = 0
    for (const entry of editEntries(args)) {
      const change = changedLines(entry.oldText, entry.newText)
      added += change.added.length
      removed += change.removed.length
    }
    return { added, removed }
  }
  if (category === 'create' && typeof args['content'] === 'string') {
    return { added: (args['content'] as string).replace(/\n$/, '').split('\n').length, removed: 0 }
  }
  return null
}

/** One tool call: a one-line row that opens into its detail. */
export const ToolStep = memo(function ToolStep({
  call,
  run,
  cwd,
  live,
  onImage,
  onOpenFile
}: {
  call: ToolCall
  run: ToolRun | undefined
  cwd: string
  live: boolean
  onImage?(uri: string): void
  onOpenFile?(path: string): void
}) {
  const styles = useStyles()
  const [open, setOpen] = useState(false)
  const name = run?.name ?? call.name
  const args = run && Object.keys(run.args).length > 0 ? run.args : call.arguments
  const category = toolCategory(name)
  const state = stateOf(run, live)
  const details = (run?.result?.details ?? undefined) as Record<string, unknown> | undefined
  const summary = toolCallSummary(name, args, cwd, details)
  const stat = state === 'running' ? null : editStat(category, args)
  const duration =
    run?.durationMs !== undefined && run.durationMs >= MIN_SHOWN_DURATION_MS
      ? formatDuration(run.durationMs)
      : ''
  const path = typeof args['path'] === 'string' ? args['path'] : typeof args['file_path'] === 'string' ? args['file_path'] : undefined
  return (
    <View style={open ? styles.open : null}>
      <StepRow
        icon={ICONS[category]}
        state={state}
        // A shell step reads as its command; the rest as tool + target.
        name={category === 'run' && summary ? summary : name}
        summary={category === 'run' ? undefined : summary}
        open={open}
        onToggle={() => setOpen(!open)}
        label={`${name} ${summary}, ${state}`}
        right={
          <>
            {stat ? <DiffStat added={stat.added} removed={stat.removed} /> : null}
            {duration ? (
              <Mono size={12} tone="muted">
                {duration}
              </Mono>
            ) : null}
          </>
        }
      />
      {open ? (
        <View style={styles.body}>
          <ToolDetail call={call} run={run} category={category} onImage={onImage} />
          {path && onOpenFile && (category === 'read' || category === 'edit' || category === 'create') ? (
            <Tap onPress={() => onOpenFile(path)} style={{ minHeight: 40, justifyContent: 'center' }}>
              <Txt size="small" tone="accent">
                Open file
              </Txt>
            </Tap>
          ) : null}
        </View>
      ) : null}
    </View>
  )
})

/** A reasoning block: "Thought for 12s", opening into the text. */
export const ThinkingStep = memo(function ThinkingStep({
  block,
  live
}: {
  block: Thinking
  live: boolean
}) {
  const styles = useStyles()
  const [open, setOpen] = useState(false)
  const thinking = live && block.durationMs === undefined && block.startedAt !== undefined
  const label = thinking
    ? 'Thinking'
    : block.durationMs !== undefined && block.durationMs >= 1000
      ? `Thought for ${formatDuration(block.durationMs)}`
      : 'Thought'
  // A one-line peek at the reasoning without opening it.
  const peek = block.thinking.trim().split('\n').pop()?.slice(0, 80)
  return (
    <View style={open ? styles.open : null}>
      <StepRow
        icon={Lightbulb}
        state={thinking ? 'running' : 'done'}
        name={label}
        summary={open ? undefined : peek}
        open={open}
        onToggle={() => setOpen(!open)}
        label={label}
      />
      {open ? (
        <View style={styles.body}>
          <Text style={styles.thought} selectable>
            {block.thinking.trim() || '…'}
          </Text>
        </View>
      ) : null}
    </View>
  )
})

/** Consecutive tool calls folded into one row with a count and diff stats. */
export const ToolGroup = memo(function ToolGroup({
  calls,
  toolRuns,
  cwd,
  live,
  onImage,
  onOpenFile
}: {
  calls: ToolCall[]
  toolRuns: Record<string, ToolRun>
  cwd: string
  live: boolean
  onImage?(uri: string): void
  onOpenFile?(path: string): void
}) {
  const styles = useStyles()
  const [userOpen, setUserOpen] = useState<boolean | null>(null)
  const summary = summarizeToolRuns(
    calls.map((call) => {
      const run = toolRuns[call.id]
      return {
        name: run?.name ?? call.name,
        args: run && Object.keys(run.args).length > 0 ? run.args : call.arguments,
        status: run?.status ?? (live ? 'running' : 'done')
      }
    })
  )
  const running = summary.running > 0
  const open = userOpen ?? false
  return (
    <View>
      <StepRow
        icon={ListTree}
        state={running ? 'running' : summary.failed > 0 ? 'error' : 'done'}
        name={summary.text}
        open={open}
        onToggle={() => setUserOpen(!open)}
        label={`${summary.text}, ${calls.length} tools`}
        right={
          <>
            {!running && summary.diff ? (
              <DiffStat added={summary.diff.added} removed={summary.diff.removed} />
            ) : null}
            <Mono size={12} tone="muted">{`${calls.length}`}</Mono>
          </>
        }
      />
      {open ? (
        <View style={styles.nested}>
          {calls.map((call) => (
            <ToolStep
              key={call.id}
              call={call}
              run={toolRuns[call.id]}
              cwd={cwd}
              live={live}
              onImage={onImage}
              onOpenFile={onOpenFile}
            />
          ))}
        </View>
      ) : null}
    </View>
  )
})

/** The shared header row of a folded stretch of work (see MessageRows). */
export function WorkRow({
  label,
  summary,
  state,
  open,
  onToggle,
  right
}: {
  label: string
  summary?: string
  state: StepState
  open: boolean
  onToggle(): void
  right?: ReactNode
}) {
  return (
    <StepRow
      icon={ListTree}
      state={state}
      name={label}
      summary={summary}
      open={open}
      onToggle={onToggle}
      label={`${label} ${summary ?? ''}`}
      right={right}
    />
  )
}

export { DiffStat }
export type { ToolCall }
