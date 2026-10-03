import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'

import { clearUsageCache, localDay, usageReport } from './usage'

const NOW = new Date(2026, 5, 15, 12).getTime()
const DAY = 86_400_000

function assistant(model: string, at: number, output: number, cost: number): unknown {
  return {
    type: 'message',
    message: {
      role: 'assistant',
      model,
      timestamp: at,
      content: [],
      usage: { input: 100, output, cacheRead: 50, cacheWrite: 0, cost: { total: cost } }
    }
  }
}

async function session(dir: string, name: string, cwd: string, entries: unknown[]): Promise<string> {
  const file = join(dir, `${name}.jsonl`)
  const lines = [{ type: 'session', version: 3, id: name, cwd }, ...entries]
  await writeFile(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n')
  return file
}

describe('usageReport', () => {
  beforeEach(() => clearUsageCache())

  it('sums requests by day, model and project inside the window', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pi-usage-'))
    const a = await session(dir, 'a', '/Users/example/alpha', [
      { type: 'message', message: { role: 'user', content: 'hi', timestamp: NOW } },
      assistant('model-x', NOW, 200, 0.5),
      assistant('model-y', NOW - DAY, 100, 0.25),
      assistant('model-x', NOW - 60 * DAY, 999, 9) // outside 30 days
    ])
    const b = await session(dir, 'b', '/Users/example/beta', [assistant('model-x', NOW, 10, 1)])
    const report = await usageReport([a, b], 30, NOW)

    expect(report.days).toHaveLength(30)
    expect(report.days.at(-1)).toMatchObject({ day: localDay(NOW), cost: 1.5, requests: 2 })
    expect(report.days.at(-2)).toMatchObject({ cost: 0.25, output: 100 })
    expect(report.total).toEqual({ cost: 1.75, input: 450, output: 310, requests: 3 })
    expect(report.models.map((m) => m.model)).toEqual(['model-x', 'model-y'])
    expect(report.projects[0]).toMatchObject({ cwd: '/Users/example/beta', cost: 1 })
  })

  it('is empty without sessions', async () => {
    const report = await usageReport([], 7, NOW)
    expect(report.days).toHaveLength(7)
    expect(report.total.requests).toBe(0)
    expect(report.models).toEqual([])
  })
})
