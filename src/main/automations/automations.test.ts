import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'

import type { Automation } from '../../shared/automations'
import {
  clearAutomationCache,
  deleteAutomation,
  listAutomations,
  markAutomationRun,
  saveAutomation
} from './automation-store'
import { AutomationScheduler } from './scheduler'

beforeEach(async () => {
  process.env['PI_DESKTOP_USER_DATA_DIR'] = await mkdtemp(join(tmpdir(), 'pi-automations-'))
  clearAutomationCache()
})

const input = {
  name: 'Morning triage',
  prompt: 'Summarize new issues',
  cwd: '',
  schedule: { kind: 'interval', minutes: 30 }
}

describe('automation store', () => {
  it('creates, updates, persists and deletes', async () => {
    const created = await saveAutomation(input, 1000)
    expect(created).toMatchObject({ name: 'Morning triage', enabled: true, createdAt: 1000 })
    await markAutomationRun(created.id, 2000)
    const renamed = await saveAutomation({ ...input, id: created.id, name: 'Triage' }, 3000)
    expect(renamed).toMatchObject({ id: created.id, name: 'Triage', lastRunAt: 2000 })

    clearAutomationCache() // re-read from disk
    expect(await listAutomations()).toHaveLength(1)
    await deleteAutomation(created.id)
    expect(await listAutomations()).toEqual([])
  })

  it('restarts the clock when the schedule changes or it is re-enabled', async () => {
    const created = await saveAutomation(input, 1000)
    await markAutomationRun(created.id, 2000)
    const rescheduled = await saveAutomation(
      { ...input, id: created.id, schedule: { kind: 'interval', minutes: 60 } },
      5000
    )
    expect(rescheduled.createdAt).toBe(5000)
    expect(rescheduled.lastRunAt).toBeUndefined()
    await saveAutomation({ ...rescheduled, enabled: false }, 6000)
    const resumed = await saveAutomation({ ...rescheduled, enabled: true }, 9000)
    expect(resumed.createdAt).toBe(9000)
  })

  it('rejects incomplete input', async () => {
    await expect(saveAutomation({ ...input, name: ' ' })).rejects.toThrow(/name/)
    await expect(saveAutomation({ ...input, prompt: '' })).rejects.toThrow(/prompt/)
    await expect(saveAutomation({ ...input, cwd: 'relative/path' })).rejects.toThrow()
    await expect(
      saveAutomation({ ...input, schedule: { kind: 'interval', minutes: 1 } })
    ).rejects.toThrow(/schedule/)
  })
})

describe('AutomationScheduler', () => {
  const automation = (over: Partial<Automation>): Automation => ({
    id: 'a',
    name: 'A',
    prompt: 'p',
    cwd: '',
    schedule: { kind: 'interval', minutes: 10 },
    enabled: true,
    createdAt: 0,
    ...over
  })

  it('runs what is due once and records the run', async () => {
    let list = [automation({}), automation({ id: 'b', enabled: false }), automation({ id: 'c', createdAt: 590_000 })]
    const ran: string[] = []
    const scheduler = new AutomationScheduler({
      list: () => Promise.resolve(list),
      markRun: (id, at) => {
        list = list.map((a) => (a.id === id ? { ...a, lastRunAt: at } : a))
        return Promise.resolve()
      },
      trigger: (a) => {
        ran.push(a.id)
        return true
      },
      now: () => 600_000
    })
    await scheduler.tick()
    await scheduler.tick()
    scheduler.stop()
    expect(ran).toEqual(['a']) // b is disabled, c is not due, a ran only once
    expect(list[0]!.lastRunAt).toBe(600_000)
  })

  it('keeps a run due when nothing can host it', async () => {
    const marked: string[] = []
    const scheduler = new AutomationScheduler({
      list: () => Promise.resolve([automation({})]),
      markRun: (id) => {
        marked.push(id)
        return Promise.resolve()
      },
      trigger: () => false,
      now: () => 600_000
    })
    await scheduler.tick()
    scheduler.stop()
    expect(marked).toEqual([])
  })
})
