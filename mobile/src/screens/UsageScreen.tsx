import { memo, useCallback, useEffect, useMemo, useState } from 'react'
import { RefreshControl, ScrollView, StyleSheet, View } from 'react-native'

import type { UsageReport, UsageTotals } from '../desktop'
import { baseName, compactNumber, formatCost } from '../lib/format'
import type { ScreenProps } from '../nav'
import { api, errorText } from '../remote/api'
import { useData } from '../state/data'
import { makeStyles, radius, space, useTheme } from '../theme'
import { Button, Empty, Mono, Pixel, Screen, SectionLabel } from '../ui'

const CHART_HEIGHT = 96
const MAX_ROWS = 12

const useStyles = makeStyles((t) => ({
  content: { padding: space.lg, paddingBottom: space.xxl, gap: space.xl },
  tiles: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm },
  tile: {
    flexGrow: 1,
    flexBasis: '45%',
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: t.border,
    backgroundColor: t.surface,
    paddingHorizontal: space.md,
    paddingVertical: space.md,
    gap: space.xs
  },
  card: {
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: t.border,
    backgroundColor: t.surface,
    padding: space.md
  },
  chart: { height: CHART_HEIGHT, flexDirection: 'row', alignItems: 'flex-end', gap: 2 },
  bar: { flex: 1, backgroundColor: t.accent, borderRadius: 1 },
  axis: { flexDirection: 'row', justifyContent: 'space-between', marginTop: space.sm },
  row: { paddingVertical: space.sm, gap: space.xs + 2 },
  rowHead: { flexDirection: 'row', alignItems: 'baseline', gap: space.md },
  rowName: { flex: 1 },
  track: { height: 3, borderRadius: 1, backgroundColor: t.border, overflow: 'hidden' },
  fill: { height: 3, backgroundColor: t.text2 },
  loading: { flexDirection: 'row', alignItems: 'center', gap: space.sm, padding: space.lg }
}))

function Tile({ label, value }: { label: string; value: string }) {
  const styles = useStyles()
  return (
    <View style={styles.tile} accessible accessibilityLabel={`${label}: ${value}`}>
      <Mono size={12} tone="muted">
        {label}
      </Mono>
      <Mono size={20} tone="text" weight="medium">
        {value}
      </Mono>
    </View>
  )
}

const BreakdownRow = memo(function BreakdownRow({
  name,
  totals,
  max
}: {
  name: string
  totals: UsageTotals
  max: number
}) {
  const styles = useStyles()
  const share = max > 0 ? Math.max(1, Math.round((totals.cost / max) * 100)) : 0
  return (
    <View
      style={styles.row}
      accessible
      accessibilityLabel={`${name}: ${formatCost(totals.cost)}, ${totals.requests} requests`}
    >
      <View style={styles.rowHead}>
        <Mono tone="text" numberOfLines={1} ellipsizeMode="middle" style={styles.rowName}>
          {name}
        </Mono>
        <Mono size={12} tone="muted">
          {compactNumber(totals.input + totals.output)}
        </Mono>
        <Mono>{formatCost(totals.cost)}</Mono>
      </View>
      <View style={styles.track}>
        <View style={[styles.fill, { width: `${share}%` }]} />
      </View>
    </View>
  )
})

function Breakdown({ label, rows }: { label: string; rows: { name: string; totals: UsageTotals }[] }) {
  const styles = useStyles()
  const max = rows.reduce((m, r) => Math.max(m, r.totals.cost), 0)
  if (rows.length === 0) {
    return null
  }
  return (
    <View>
      <SectionLabel>{label}</SectionLabel>
      <View style={styles.card}>
        {rows.map((row) => (
          <BreakdownRow key={row.name} name={row.name} totals={row.totals} max={max} />
        ))}
      </View>
    </View>
  )
}

/** Tokens and cost over the last 30 days, as recorded in the session files. */
export function UsageScreen({ navigation }: ScreenProps<'Usage'>) {
  const styles = useStyles()
  const theme = useTheme()
  const workspaceDir = useData((s) => s.appInfo?.workspaceDir)
  const [report, setReport] = useState<UsageReport | null>(null)
  const [error, setError] = useState<string | null>(null)

  const [refreshing, setRefreshing] = useState(false)
  const load = useCallback(() => {
    setError(null)
    return api.sessions
      .usage()
      .then(setReport)
      .catch((e: unknown) => setError(errorText(e)))
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const models = useMemo(
    () =>
      (report?.models ?? [])
        .slice()
        .sort((a, b) => b.cost - a.cost)
        .slice(0, MAX_ROWS)
        .map((m) => ({ name: m.model, totals: m })),
    [report]
  )

  const projects = useMemo(() => {
    // Folders that share a base name stay apart: the key is the row's name.
    const seen = new Map<string, number>()
    return (report?.projects ?? [])
      .slice()
      .sort((a, b) => b.cost - a.cost)
      .slice(0, MAX_ROWS)
      .map((p) => {
        const base = p.cwd === workspaceDir || p.cwd === '' ? 'No project' : baseName(p.cwd)
        const count = (seen.get(base) ?? 0) + 1
        seen.set(base, count)
        return { name: count > 1 ? `${base} (${count})` : base, totals: p }
      })
  }, [report, workspaceDir])

  const days = report?.days ?? []
  const peak = days.reduce((best, d) => (d.cost > best.cost ? d : best), { day: '', cost: 0 })
  const first = days[0]?.day ?? ''
  const last = days[days.length - 1]?.day ?? ''

  let body
  if (error) {
    body = (
      <Empty
        title="Could not load usage"
        detail={error}
        action={<Button title="Retry" onPress={load} />}
      />
    )
  } else if (!report) {
    body = (
      <View style={styles.loading}>
        <Pixel tone="working" />
        <Mono tone="muted">Loading…</Mono>
      </View>
    )
  } else if (report.total.requests === 0) {
    body = (
      <Empty title="No usage recorded" detail="Nothing ran on the computer in the last 30 days." />
    )
  } else {
    body = (
      <ScrollView
        contentContainerStyle={styles.content}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => {
              setRefreshing(true)
              void load().finally(() => setRefreshing(false))
            }}
            tintColor={theme.muted}
            colors={[theme.accent]}
            progressBackgroundColor={theme.raised}
          />
        }
      >
        <View style={styles.tiles}>
          <Tile label="cost" value={formatCost(report.total.cost)} />
          <Tile label="requests" value={compactNumber(report.total.requests)} />
          <Tile label="input tokens" value={compactNumber(report.total.input)} />
          <Tile label="output tokens" value={compactNumber(report.total.output)} />
        </View>

        <View>
          <SectionLabel>Cost per day</SectionLabel>
          <View
            style={styles.card}
            accessible
            accessibilityRole="image"
            accessibilityLabel={`Cost per day over ${days.length} days. Total ${formatCost(
              report.total.cost
            )}${peak.day ? `, highest ${formatCost(peak.cost)} on ${peak.day}` : ''}.`}
          >
            <View style={styles.chart}>
              {days.map((d) => (
                <View
                  key={d.day}
                  style={[
                    styles.bar,
                    {
                      height:
                        peak.cost > 0
                          ? Math.max(1, Math.round((d.cost / peak.cost) * CHART_HEIGHT))
                          : 1
                    },
                    d.cost > 0 ? null : { backgroundColor: theme.faint }
                  ]}
                />
              ))}
            </View>
            <View style={styles.axis}>
              <Mono size={12} tone="muted">
                {first}
              </Mono>
              <Mono size={12} tone="muted">
                {last}
              </Mono>
            </View>
          </View>
        </View>

        <Breakdown label="By model" rows={models} />
        <Breakdown label="By project" rows={projects} />
      </ScrollView>
    )
  }

  return (
    <Screen title="Usage" subtitle="Last 30 days" onBack={() => navigation.goBack()}>
      {body}
    </Screen>
  )
}
