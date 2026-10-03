import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'

import type { UsageReport, UsageTotals } from '../../shared/api'
import { createJsonlReader } from '../pi/jsonl'

const MAX_CONCURRENT = 8

/** One assistant request found in a session file. */
interface UsageRow {
  day: string
  model: string
  input: number
  output: number
  cost: number
}

interface FileUsage {
  mtimeMs: number
  size: number
  cwd: string
  rows: UsageRow[]
}

const cache = new Map<string, FileUsage>()

function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

/** Local calendar day (YYYY-MM-DD) of an epoch-ms timestamp. */
export function localDay(ms: number): string {
  const d = new Date(ms)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

function parseFile(filePath: string): Promise<{ cwd: string; rows: UsageRow[] }> {
  return new Promise((resolvePromise) => {
    let cwd = ''
    let first = true
    const rows: UsageRow[] = []
    const reader = createJsonlReader((line) => {
      if (first) {
        first = false
        try {
          const header = JSON.parse(line) as { type?: unknown; cwd?: unknown }
          if (header.type === 'session' && typeof header.cwd === 'string') {
            cwd = header.cwd
          }
        } catch {
          // not a header — fall through to the usage check
        }
      }
      // Only assistant messages carry usage; skip parsing everything else.
      if (!line.includes('"usage"')) {
        return
      }
      try {
        const entry = JSON.parse(line) as {
          type?: unknown
          message?: {
            role?: unknown
            model?: unknown
            timestamp?: unknown
            usage?: {
              input?: unknown
              output?: unknown
              cacheRead?: unknown
              cacheWrite?: unknown
              cost?: { total?: unknown }
            }
          }
        }
        const message = entry.message
        if (entry.type !== 'message' || message?.role !== 'assistant' || !message.usage) {
          return
        }
        const usage = message.usage
        rows.push({
          day: localDay(num(message.timestamp)),
          model: typeof message.model === 'string' ? message.model : 'unknown',
          input: num(usage.input) + num(usage.cacheRead) + num(usage.cacheWrite),
          output: num(usage.output),
          cost: num(usage.cost?.total)
        })
      } catch {
        // malformed line — skip
      }
    })
    const stream = createReadStream(filePath)
    stream.on('data', (chunk: Buffer | string) => reader.push(chunk))
    stream.on('end', () => {
      reader.end()
      resolvePromise({ cwd, rows })
    })
    stream.on('error', () => resolvePromise({ cwd, rows }))
  })
}

async function fileUsage(filePath: string): Promise<FileUsage | null> {
  let info
  try {
    info = await stat(filePath)
  } catch {
    return null
  }
  const cached = cache.get(filePath)
  if (cached && cached.mtimeMs === info.mtimeMs && cached.size === info.size) {
    return cached
  }
  const parsed = await parseFile(filePath)
  const entry: FileUsage = { mtimeMs: info.mtimeMs, size: info.size, ...parsed }
  cache.set(filePath, entry)
  return entry
}

function emptyTotals(): UsageTotals {
  return { cost: 0, input: 0, output: 0, requests: 0 }
}

function add(totals: UsageTotals, row: UsageRow): void {
  totals.cost += row.cost
  totals.input += row.input
  totals.output += row.output
  totals.requests += 1
}

/**
 * Tokens and cost recorded in session files over the last `days` days,
 * by day, model and project. Parsed files are cached by mtime, so reopening
 * the report only reads sessions that changed.
 */
export async function usageReport(
  files: string[],
  days = 30,
  now: number = Date.now()
): Promise<UsageReport> {
  const usages: (FileUsage | null)[] = new Array(files.length).fill(null)
  let next = 0
  await Promise.all(
    Array.from({ length: Math.min(MAX_CONCURRENT, files.length) }, async () => {
      while (next < files.length) {
        const index = next++
        usages[index] = await fileUsage(files[index]!)
      }
    })
  )
  for (const key of cache.keys()) {
    if (!files.includes(key)) {
      cache.delete(key)
    }
  }

  const dayKeys: string[] = []
  for (let i = days - 1; i >= 0; i--) {
    dayKeys.push(localDay(now - i * 86_400_000))
  }
  const byDay = new Map(dayKeys.map((day) => [day, emptyTotals()]))
  const byModel = new Map<string, UsageTotals>()
  const byProject = new Map<string, UsageTotals>()
  const total = emptyTotals()
  for (const usage of usages) {
    if (!usage) {
      continue
    }
    for (const row of usage.rows) {
      const day = byDay.get(row.day)
      if (!day) {
        continue // outside the window
      }
      add(day, row)
      add(total, row)
      let model = byModel.get(row.model)
      if (!model) {
        byModel.set(row.model, (model = emptyTotals()))
      }
      add(model, row)
      let project = byProject.get(usage.cwd)
      if (!project) {
        byProject.set(usage.cwd, (project = emptyTotals()))
      }
      add(project, row)
    }
  }
  const ranked = <K extends string>(map: Map<string, UsageTotals>, key: K) =>
    [...map.entries()]
      .map(([name, totals]) => ({ [key]: name, ...totals }) as Record<K, string> & UsageTotals)
      .sort((a, b) => b.cost - a.cost || b.output - a.output)
      .slice(0, 12)
  return {
    days: dayKeys.map((day) => ({ day, ...byDay.get(day)! })),
    models: ranked(byModel, 'model'),
    projects: ranked(byProject, 'cwd'),
    total
  }
}

/** Test hook. */
export function clearUsageCache(): void {
  cache.clear()
}
