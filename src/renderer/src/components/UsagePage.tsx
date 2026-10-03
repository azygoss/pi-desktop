import { useEffect, useState } from 'react'

import type { UsageReport, UsageTotals } from '../../../shared/api'
import { useAppStore } from '../state/app-store'

function tokens(n: number): string {
  if (n < 1000) {
    return `${n}`
  }
  if (n < 1_000_000) {
    return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`
  }
  return `${(n / 1_000_000).toFixed(1)}M`
}

function money(n: number): string {
  return `$${n.toFixed(n > 0 && n < 0.01 ? 4 : 2)}`
}

// The app's UI is English; month names follow it rather than the system locale.
const dayFormat = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' })

function dayLabel(day: string): string {
  const [y, m, d] = day.split('-').map(Number)
  return dayFormat.format(new Date(y!, m! - 1, d!))
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="usage-stat">
      <div className="usage-stat-value">{value}</div>
      <div className="usage-stat-label">{label}</div>
    </div>
  )
}

function Table({
  title,
  rows
}: {
  title: string
  rows: ({ name: string; hint?: string } & UsageTotals)[]
}) {
  if (rows.length === 0) {
    return null
  }
  return (
    <div className="usage-table">
      <div className="usage-table-head">
        <span>{title}</span>
        <span>Requests</span>
        <span>Tokens out</span>
        <span>Cost</span>
      </div>
      {rows.map((row) => (
        <div key={row.name} className="usage-table-row" title={row.hint}>
          <span className="usage-table-name">{row.name}</span>
          <span>{row.requests}</span>
          <span>{tokens(row.output)}</span>
          <span>{money(row.cost)}</span>
        </div>
      ))}
    </div>
  )
}

/**
 * Settings → Usage: what the last 30 days cost, read from pi's session
 * files (the usage pi recorded with each reply), by day, model and project.
 */
export function UsagePage() {
  const [report, setReport] = useState<UsageReport | null>(null)
  const [failed, setFailed] = useState(false)
  const workspaceDir = useAppStore((s) => s.appInfo?.workspaceDir ?? '')
  const models = useAppStore((s) => s.sessions.length) // re-read when sessions change

  useEffect(() => {
    let cancelled = false
    void window.piDesktop.sessions
      .usage()
      .then((r) => {
        if (!cancelled) {
          setReport(r)
        }
      })
      .catch(() => {
        if (!cancelled) {
          setFailed(true)
        }
      })
    return () => {
      cancelled = true
    }
  }, [models])

  if (failed) {
    return <div className="settings-note">Usage could not be read.</div>
  }
  if (!report) {
    return <div className="settings-note">Reading sessions…</div>
  }
  if (report.total.requests === 0) {
    return <div className="settings-note">No usage recorded in the last 30 days.</div>
  }

  // Bars show cost; providers that report no cost fall back to output tokens.
  const byCost = report.total.cost > 0
  const value = (d: UsageTotals): number => (byCost ? d.cost : d.output)
  const peak = Math.max(...report.days.map(value), 0)
  const projectName = (cwd: string): string =>
    !cwd || cwd === workspaceDir ? 'Without project' : (cwd.split('/').filter(Boolean).pop() ?? cwd)

  return (
    <div className="usage-page" data-testid="usage-page">
      <div className="usage-stats">
        <Stat label="Cost, 30 days" value={money(report.total.cost)} />
        <Stat label="Requests" value={`${report.total.requests}`} />
        <Stat label="Tokens in" value={tokens(report.total.input)} />
        <Stat label="Tokens out" value={tokens(report.total.output)} />
      </div>
      <div className="usage-chart" role="img" aria-label={byCost ? 'Cost per day' : 'Output tokens per day'}>
        {report.days.map((d) => (
          <div
            key={d.day}
            className="usage-bar-slot"
            title={`${dayLabel(d.day)} — ${money(d.cost)}, ${tokens(d.output)} tokens out, ${d.requests} requests`}
          >
            <div
              className="usage-bar"
              style={{ height: peak > 0 ? `${Math.max(value(d) > 0 ? 3 : 0, (value(d) / peak) * 100)}%` : 0 }}
            />
          </div>
        ))}
      </div>
      <div className="usage-chart-axis">
        <span>{dayLabel(report.days[0]!.day)}</span>
        <span>{byCost ? 'cost per day' : 'tokens out per day'}</span>
        <span>{dayLabel(report.days[report.days.length - 1]!.day)}</span>
      </div>
      <Table title="Model" rows={report.models.map((m) => ({ ...m, name: m.model }))} />
      <Table
        title="Project"
        rows={report.projects.map((p) => ({ ...p, name: projectName(p.cwd), hint: p.cwd }))}
      />
      <div className="settings-note">
        Read from the usage pi records in each session file. Sessions you deleted are not counted.
      </div>
    </div>
  )
}
