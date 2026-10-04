import { ExternalLink, GitPullRequest, RefreshCw, Wrench } from 'lucide-react-native'
import { memo, useCallback, useEffect, useRef, useState } from 'react'
import { AppState, FlatList, Linking, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'

import {
  fixChecksPrompt,
  summarizeChecks,
  type PrCheck,
  type PrStatus,
  type PullRequest
} from '../desktop'
import type { ScreenProps } from '../nav'
import { api, errorText } from '../remote/api'
import { useChats } from '../state/chats'
import { makeStyles, radius, space, TOUCH } from '../theme'
import {
  Button,
  Empty,
  IconButton,
  Mono,
  Pixel,
  Screen,
  SectionLabel,
  Tap,
  toast,
  Txt,
  type PixelTone
} from '../ui'

const AUTO_REFRESH_MS = 30_000
/** The end of a failed job's log is where the error is. */
const LOG_TAIL_CHARS = 6000

const useStyles = makeStyles((t) => ({
  loading: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: space.sm
  },
  head: { padding: space.lg, gap: space.md },
  words: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: space.md },
  word: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm },
  check: {
    minHeight: TOUCH,
    paddingHorizontal: space.lg,
    paddingVertical: space.sm,
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md
  },
  log: {
    marginHorizontal: space.lg,
    marginBottom: space.md,
    padding: space.md,
    borderRadius: radius.sm,
    backgroundColor: t.codeBg,
    borderWidth: 1,
    borderColor: t.border
  }
}))

const CHECK_PIXEL: Record<PrCheck['state'], PixelTone> = {
  pass: 'ok',
  fail: 'error',
  pending: 'working',
  skipped: 'idle'
}
const CHECK_WORD: Record<PrCheck['state'], string> = {
  pass: 'passed',
  fail: 'failed',
  pending: 'running',
  skipped: 'skipped'
}

type LogState = { phase: 'loading' } | { phase: 'done'; text: string } | { phase: 'error'; text: string }

const CheckRow = memo(function CheckRow({
  check,
  expanded,
  log,
  onToggle
}: {
  check: PrCheck
  expanded: boolean
  log: LogState | undefined
  onToggle(check: PrCheck): void
}) {
  const styles = useStyles()
  const expandable = check.state === 'fail' && !!check.runId
  const body = (
    <>
      <Pixel tone={CHECK_PIXEL[check.state]} />
      <Mono size={13} tone="text" style={{ flex: 1 }} numberOfLines={2}>
        {check.name}
      </Mono>
      <Mono size={12} tone={check.state === 'fail' ? 'danger' : 'muted'}>
        {expandable ? (expanded ? 'hide log' : 'show log') : CHECK_WORD[check.state]}
      </Mono>
    </>
  )
  return (
    <View>
      {expandable ? (
        <Tap
          style={styles.check}
          onPress={() => onToggle(check)}
          label={`${check.name}, failed. ${expanded ? 'Hide' : 'Show'} the log`}
        >
          {body}
        </Tap>
      ) : (
        <View style={styles.check} accessible accessibilityLabel={`${check.name}, ${CHECK_WORD[check.state]}`}>
          {body}
        </View>
      )}
      {expandable && expanded ? (
        <View style={styles.log}>
          {!log || log.phase === 'loading' ? (
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm }}>
              <Pixel tone="working" />
              <Txt size="small" tone="muted">
                Loading the log…
              </Txt>
            </View>
          ) : log.phase === 'error' ? (
            <Txt size="small" tone="danger">
              {log.text}
            </Txt>
          ) : (
            <Mono size={12} tone="text2" selectable>
              {log.text || 'The log is empty.'}
            </Mono>
          )}
        </View>
      ) : null}
    </View>
  )
})

const checkKey = (check: PrCheck, index: number): string => `${index}:${check.name}`
const expandKey = (check: PrCheck): string => `${check.name}|${check.url ?? ''}`

function PrHead({
  pr,
  canFix,
  fixing,
  onFix
}: {
  pr: PullRequest
  canFix: boolean
  fixing: boolean
  onFix(): void
}) {
  const styles = useStyles()
  const summary = summarizeChecks(pr.checks)
  const failing = pr.checks.filter((c) => c.state === 'fail').length
  const state = pr.state === 'MERGED' ? 'Merged' : pr.state === 'CLOSED' ? 'Closed' : pr.draft ? 'Draft' : 'Open'
  const review =
    pr.reviewDecision === 'APPROVED'
      ? 'Approved'
      : pr.reviewDecision === 'CHANGES_REQUESTED'
        ? 'Changes requested'
        : pr.reviewDecision === 'REVIEW_REQUIRED'
          ? 'Review required'
          : null
  return (
    <View style={styles.head}>
      <View style={{ gap: space.xs }}>
        <Mono size={13} tone="muted">
          #{pr.number}
        </Mono>
        <Txt size="heading" weight="semibold">
          {pr.title}
        </Txt>
      </View>
      <View style={styles.words}>
        <Txt size="small" tone="text2">
          {state}
        </Txt>
        {review ? (
          <Txt size="small" tone={pr.reviewDecision === 'CHANGES_REQUESTED' ? 'warning' : 'text2'}>
            {review}
          </Txt>
        ) : null}
        {summary === 'pending' ? (
          <View style={styles.word}>
            <Pixel tone="working" />
            <Txt size="small" tone="accent">
              running
            </Txt>
          </View>
        ) : summary === 'failing' ? (
          <View style={styles.word}>
            <Pixel tone="error" />
            <Txt size="small" tone="danger">
              {failing} failing
            </Txt>
          </View>
        ) : summary === 'passing' ? (
          <View style={styles.word}>
            <Pixel tone="ok" />
            <Txt size="small" tone="success">
              passing
            </Txt>
          </View>
        ) : null}
      </View>
      <View style={styles.actions}>
        {canFix ? (
          <Button title="Ask pi to fix" kind="primary" icon={Wrench} busy={fixing} onPress={onFix} />
        ) : null}
        {pr.url ? (
          <Button
            title="Open on GitHub"
            icon={ExternalLink}
            onPress={() => {
              Linking.openURL(pr.url).catch((e: unknown) => toast(errorText(e)))
            }}
          />
        ) : null}
      </View>
      {pr.checks.length > 0 ? <SectionLabel style={{ marginBottom: 0, marginTop: space.sm }}>Checks</SectionLabel> : null}
    </View>
  )
}

/** The pull request of the project's branch: state, checks, failed logs. */
export function PrScreen({ navigation, route }: ScreenProps<'Pr'>) {
  const { cwd, chatId } = route.params
  const styles = useStyles()
  const insets = useSafeAreaInsets()
  const [status, setStatus] = useState<PrStatus | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [pulling, setPulling] = useState(false)
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})
  const [logs, setLogs] = useState<Record<string, LogState>>({})
  const [fixing, setFixing] = useState(false)
  const [appActive, setAppActive] = useState(AppState.currentState === 'active')
  const mounted = useRef(true)
  const request = useRef(0)
  const headSha = useRef<string | undefined>(undefined)

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  const load = useCallback(
    async (quiet = false): Promise<void> => {
      const id = ++request.current
      try {
        const next = await api.pr.status(cwd)
        if (!mounted.current || request.current !== id) {
          return
        }
        // A new push re-runs the jobs: logs fetched for the old commit are stale.
        if (headSha.current !== undefined && headSha.current !== next.pr?.headSha) {
          setLogs({})
          setExpanded({})
        }
        headSha.current = next.pr?.headSha
        setStatus(next)
        setError(null)
      } catch (e) {
        if (!mounted.current || request.current !== id) {
          return
        }
        if (quiet) {
          return
        }
        setError(errorText(e))
      }
    },
    [cwd]
  )

  useEffect(() => {
    void load()
  }, [load])

  useEffect(() => {
    const sub = AppState.addEventListener('change', (state) => setAppActive(state === 'active'))
    return () => sub.remove()
  }, [])

  const pending = !!status?.pr?.checks.some((c) => c.state === 'pending')
  useEffect(() => {
    if (!pending || !appActive) {
      return
    }
    const timer = setInterval(() => void load(true), AUTO_REFRESH_MS)
    return () => clearInterval(timer)
  }, [pending, appActive, load])

  const refresh = useCallback(() => {
    setPulling(true)
    void load().finally(() => {
      if (mounted.current) {
        setPulling(false)
      }
    })
  }, [load])

  const fetchLog = useCallback(
    (runId: string): void => {
      setLogs((prev) => ({ ...prev, [runId]: { phase: 'loading' } }))
      api.pr.failedLog(cwd, runId).then(
        (text) => {
          if (mounted.current) {
            setLogs((prev) => ({ ...prev, [runId]: { phase: 'done', text: text.slice(-LOG_TAIL_CHARS).trim() } }))
          }
        },
        (e: unknown) => {
          if (mounted.current) {
            setLogs((prev) => ({ ...prev, [runId]: { phase: 'error', text: errorText(e) } }))
          }
        }
      )
    },
    [cwd]
  )

  const logsRef = useRef(logs)
  logsRef.current = logs
  const toggle = useCallback(
    (check: PrCheck): void => {
      const runId = check.runId
      if (!runId) {
        return
      }
      // Jobs of one workflow run share its id (and its log): what is open
      // is tracked per check, so one tap opens one row.
      const key = expandKey(check)
      setExpanded((prev) => ({ ...prev, [key]: !prev[key] }))
      const known = logsRef.current[runId]
      if (!known || known.phase === 'error') {
        fetchLog(runId)
      }
    },
    [fetchLog]
  )

  const pr = status?.pr
  const askFix = async (): Promise<void> => {
    if (!pr || !chatId || fixing) {
      return
    }
    setFixing(true)
    const runId = pr.checks.find((c) => c.state === 'fail' && c.runId)?.runId
    let log = ''
    if (runId) {
      const known = logs[runId]
      // Without the log the prompt still names the failing checks.
      log =
        known?.phase === 'done' ? known.text : await api.pr.failedLog(cwd, runId).catch(() => '')
    }
    if (!mounted.current) {
      return
    }
    setFixing(false)
    useChats.getState().seedComposer(chatId, fixChecksPrompt(pr, log))
    toast('The request is in the composer')
    navigation.goBack()
  }

  const renderItem = useCallback(
    ({ item }: { item: PrCheck }) => (
      <CheckRow
        check={item}
        expanded={!!item.runId && !!expanded[expandKey(item)]}
        log={item.runId ? logs[item.runId] : undefined}
        onToggle={toggle}
      />
    ),
    [expanded, logs, toggle]
  )

  const retry = <Button title="Retry" onPress={() => void load()} />
  const canFix = !!chatId && !!pr && pr.checks.some((c) => c.state === 'fail')
  return (
    <Screen
      title="Pull request"
      subtitle={pr ? `#${pr.number}` : undefined}
      onBack={() => navigation.goBack()}
      right={<IconButton icon={RefreshCw} label="Refresh" onPress={refresh} />}
      bottomInset={false}
    >
      {!status && error ? (
        <Empty icon={GitPullRequest} title="Could not load the pull request" detail={error} action={retry} />
      ) : !status ? (
        <View style={styles.loading}>
          <Pixel tone="working" />
          <Txt size="small" tone="muted">
            Loading…
          </Txt>
        </View>
      ) : !status.available ? (
        <Empty
          icon={GitPullRequest}
          title="GitHub CLI not available"
          detail={error ?? 'gh must be installed and signed in on the computer.'}
          action={retry}
        />
      ) : !pr ? (
        <Empty
          icon={GitPullRequest}
          title="No pull request for this branch"
          detail={error ?? undefined}
          action={<Button title="Refresh" onPress={() => void load()} />}
        />
      ) : (
        <FlatList
          data={pr.checks}
          keyExtractor={checkKey}
          renderItem={renderItem}
          refreshing={pulling}
          onRefresh={refresh}
          ListHeaderComponent={
            <>
              {error ? (
                <Txt size="small" tone="danger" style={{ paddingHorizontal: space.lg, paddingTop: space.md }}>
                  {error}
                </Txt>
              ) : null}
              <PrHead pr={pr} canFix={canFix} fixing={fixing} onFix={() => void askFix()} />
            </>
          }
          ListEmptyComponent={
            <Txt size="small" tone="muted" style={{ paddingHorizontal: space.lg }}>
              This pull request has no checks.
            </Txt>
          }
          contentContainerStyle={{ paddingBottom: insets.bottom + space.lg }}
        />
      )}
    </Screen>
  )
}
