#!/usr/bin/env node
/* global window, document, Event */
// Energy harness for Pi Desktop. Launches the built app (out/main/index.js)
// with the window VISIBLE and reports per-process CPU and idle wakeups for
// the phases that matter for battery life:
//
//   home-idle      home view, nothing running
//   chat-idle      a chat open with pi ready, nothing running
//   streaming      a model-paced reply streaming (thinking → markdown/code)
//   streaming-blurred  the same with the window visible but unfocused
//   tool-running   the agent working on a long tool call (nothing streams)
//   after-idle     the same chat after the reply settled
//   panel-idle     after-idle with the right panel (terminal tab) open
//
//   node scripts/energy.mjs                 synthetic (fake pi, fake sessions)
//   node scripts/energy.mjs --seconds 10    phase length (default 8)
//   node scripts/energy.mjs --out f.json    write metrics JSON to a file
//
// Wakeups come from Electron's app.getAppMetrics() (macOS reports
// idleWakeupsPerSecond — the metric Activity Monitor's Energy tab weighs);
// "tree" CPU also counts the pi child processes via ps.

import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron as electron } from 'playwright-core'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const FAKE_PI = join(ROOT, 'test/fixtures/fake-pi.mjs')
const argValue = (flag) => {
  const i = process.argv.indexOf(flag)
  return i >= 0 ? process.argv[i + 1] : null
}
const PHASE_S = Number(argValue('--seconds') ?? 8)
const OUT_FILE = argValue('--out')

function cpuSeconds() {
  return new Promise((resolvePromise) => {
    execFile('ps', ['-Ao', 'pid=,ppid=,time='], (error, stdout) => {
      const map = new Map()
      if (!error) {
        for (const line of stdout.split('\n')) {
          const [pid, ppid, time] = line.trim().split(/\s+/)
          if (!pid) continue
          const parts = (time ?? '0').split(':').map(Number)
          const seconds = parts.length === 2 ? parts[0] * 60 + parts[1] : parts[0] * 3600 + parts[1] * 60 + parts[2]
          map.set(Number(pid), { ppid: Number(ppid), seconds })
        }
      }
      resolvePromise(map)
    })
  })
}

function treeMembers(table, root) {
  const members = new Set([root])
  let grew = true
  while (grew) {
    grew = false
    for (const [pid, info] of table) {
      if (members.has(info.ppid) && !members.has(pid)) {
        members.add(pid)
        grew = true
      }
    }
  }
  return members
}

const round = (n) => Math.round(n * 10) / 10

/**
 * Measure one phase: `during` runs concurrently (e.g. a stream) and the
 * phase lasts at least PHASE_S seconds.
 */
async function measure(app, mainPid, during) {
  // First getAppMetrics() call resets Chromium's per-process CPU counters.
  await app.evaluate(({ app }) => app.getAppMetrics())
  const before = await cpuSeconds()
  const start = Date.now()
  await Promise.all([during ? during() : null, new Promise((r) => setTimeout(r, PHASE_S * 1000))])
  const elapsed = (Date.now() - start) / 1000
  const metrics = await app.evaluate(({ app }) =>
    app.getAppMetrics().map((m) => ({
      type: m.type,
      name: m.name ?? m.serviceName ?? '',
      pid: m.pid,
      cpu: m.cpu.percentCPUUsage,
      wakeups: m.cpu.idleWakeupsPerSecond
    }))
  )
  const after = await cpuSeconds()
  const members = treeMembers(after, mainPid)
  const electronPids = new Set(metrics.map((m) => m.pid))
  let tree = 0
  let children = 0
  for (const pid of members) {
    const delta = Math.max(0, (after.get(pid)?.seconds ?? 0) - (before.get(pid)?.seconds ?? 0))
    tree += delta
    if (!electronPids.has(pid)) children += delta
  }
  // Per-process CPU from ps (percentCPUUsage is normalized differently
  // across Electron versions); wakeups from getAppMetrics.
  const cpuOf = (pid) =>
    (Math.max(0, (after.get(pid)?.seconds ?? 0) - (before.get(pid)?.seconds ?? 0)) / elapsed) * 100
  const byType = {}
  for (const m of metrics) {
    const key = m.type === 'Utility' && m.name ? `Utility:${m.name}` : m.type
    const slot = (byType[key] ??= { cpu: 0, wakeups: 0 })
    slot.cpu = round(slot.cpu + cpuOf(m.pid))
    slot.wakeups = round(slot.wakeups + m.wakeups)
  }
  byType['pi+helpers'] = { cpu: round((children / elapsed) * 100), wakeups: null }
  return {
    seconds: round(elapsed),
    electron_wakeups_per_s: round(metrics.reduce((a, m) => a + m.wakeups, 0)),
    tree_cpu_percent: round((tree / elapsed) * 100),
    child_cpu_percent: round((children / elapsed) * 100),
    by_process: byType
  }
}

async function seed(agentDir) {
  const cwd = '/Users/example/energy-project'
  const dir = join(agentDir, 'sessions', `--${cwd.replaceAll('/', '-')}--`)
  await mkdir(dir, { recursive: true })
  const created = new Date(Date.now() - 3600_000).toISOString()
  const lines = [{ type: 'session', version: 3, id: 'energy-1', timestamp: created, cwd }]
  let parent = null
  for (let i = 0; i < 40; i++) {
    const id = `energy-1-m${i}`
    lines.push({
      type: 'message',
      id,
      parentId: parent,
      message:
        i % 2
          ? {
              role: 'assistant',
              content: [
                {
                  type: 'text',
                  text: `Reply ${i} with **markdown**, \`code\` and a block:\n\n\`\`\`ts\nconst x${i} = ${i}\n\`\`\`\n`
                }
              ],
              timestamp: Date.parse(created) + i * 1000
            }
          : { role: 'user', content: `Synthetic question ${i}`, timestamp: Date.parse(created) + i * 1000 }
    })
    parent = id
  }
  await writeFile(join(dir, 'energy-1.jsonl'), lines.map((l) => JSON.stringify(l)).join('\n') + '\n')
  return cwd
}

const results = { phase_seconds: PHASE_S, startedAt: new Date().toISOString(), phases: {} }
let app = null
let agentDir = null
let userDataDir = null

try {
  agentDir = await mkdtemp(join(tmpdir(), 'pi-desktop-energy-agent-'))
  userDataDir = await mkdtemp(join(tmpdir(), 'pi-desktop-energy-ud-'))
  const cwd = await seed(agentDir)
  await writeFile(
    join(userDataDir, 'settings.json'),
    JSON.stringify({
      displayName: 'Energy',
      expandedProjects: [cwd],
      onboarding: { dismissedAt: Date.now() },
      updates: { check: false }
    })
  )
  const env = { ...process.env }
  delete env['ELECTRON_RUN_AS_NODE']
  env['NODE_ENV'] = 'production'
  env['PI_DESKTOP_PI_COMMAND'] = FAKE_PI
  env['PI_CODING_AGENT_DIR'] = agentDir
  env['PI_CODING_AGENT_SESSION_DIR'] = join(agentDir, 'sessions')
  env['PI_DESKTOP_USER_DATA_DIR'] = userDataDir

  app = await electron.launch({ args: [join(ROOT, 'out/main/index.js')], env })
  const mainPid = app.process().pid
  const page = await app.firstWindow()
  await page.waitForSelector('.composer-input', { state: 'visible', timeout: 60_000 })
  // Let startup work (warm spare, session scan) finish before measuring.
  await page.waitForTimeout(6000)

  results.phases['home-idle'] = await measure(app, mainPid)

  await page.locator('.sidebar-session').first().click()
  await page.waitForSelector('.msg-assistant', { state: 'visible', timeout: 60_000 })
  await page.waitForFunction(() => !document.querySelector('.composer-status'), null, {
    timeout: 30_000
  }).catch(() => {})
  await page.waitForTimeout(3000)
  results.phases['chat-idle'] = await measure(app, mainPid)

  await page.evaluate(() => {
    window.__settled = false
    window.piDesktop.chat.onEvent((payload) => {
      if ((payload?.events ?? []).some((e) => e?.type === 'agent_settled')) window.__settled = true
    })
  })
  const input = page.locator('.composer-input')
  await input.fill(`paced stream for ${PHASE_S}s`)
  await input.press('Enter')
  results.phases['streaming'] = await measure(app, mainPid, () =>
    page.waitForFunction(() => window.__settled === true, null, { timeout: 120_000 })
  )

  // Same stream with the window visible but not focused (pi working while
  // you are in another app): commits drop to 10/s.
  await page.waitForTimeout(1000)
  await page.evaluate(() => {
    window.__settled = false
  })
  await input.fill(`paced stream for ${PHASE_S}s`)
  await input.press('Enter')
  // Playwright emulates focus for every page, so real window blur never
  // reaches it; send the event the renderer listens for instead.
  await page.evaluate(() => window.dispatchEvent(new Event('blur')))
  results.phases['streaming-blurred'] = await measure(app, mainPid, () =>
    page.waitForFunction(() => window.__settled === true, null, { timeout: 120_000 })
  )
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))

  await page.waitForTimeout(1000)
  await page.evaluate(() => {
    window.__settled = false
  })
  await input.fill(`long tool for ${PHASE_S + 2}s`)
  await input.press('Enter')
  await page.waitForSelector('.tool-card', { state: 'visible', timeout: 30_000 })
  await page.waitForTimeout(1000)
  results.phases['tool-running'] = await measure(app, mainPid)
  await page.waitForFunction(() => window.__settled === true, null, { timeout: 120_000 })

  await page.waitForTimeout(2000)
  results.phases['after-idle'] = await measure(app, mainPid)

  await page.keyboard.press('Meta+Alt+b')
  await page.waitForTimeout(3000)
  results.phases['panel-idle'] = await measure(app, mainPid)
} finally {
  if (app) await app.close().catch(() => {})
  if (agentDir) await rm(agentDir, { recursive: true, force: true })
  if (userDataDir) await rm(userDataDir, { recursive: true, force: true })
}

if (!OUT_FILE) console.log(JSON.stringify(results, null, 2))
for (const [name, r] of Object.entries(results.phases)) {
  const parts = Object.entries(r.by_process)
    .filter(([, v]) => v.cpu > 0 || v.wakeups > 0)
    .map(([k, v]) => `${k} ${v.cpu}%${v.wakeups === null ? '' : `/${v.wakeups}w`}`)
  console.error(
    `${name.padEnd(13)} ${String(r.tree_cpu_percent).padStart(5)}% cpu  ${String(r.electron_wakeups_per_s).padStart(4)} wakeups/s  ${parts.join('  ')}`
  )
}
if (OUT_FILE) {
  await mkdir(dirname(OUT_FILE), { recursive: true })
  await writeFile(OUT_FILE, JSON.stringify(results, null, 2) + '\n')
  console.error(`wrote ${OUT_FILE}`)
}
