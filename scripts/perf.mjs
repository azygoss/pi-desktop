#!/usr/bin/env node
/* global window, document, performance */
// Performance harness for Pi Desktop. Launches the built app
// (out/main/index.js) through Playwright's Electron driver and reports
// timing/memory metrics.
//
//   node scripts/perf.mjs              synthetic mode (fake pi, fake sessions)
//   node scripts/perf.mjs --real       installed pi + real ~/.pi sessions
//   node scripts/perf.mjs --out f.json write metrics JSON to a file
//   node scripts/perf.mjs --userdata d reuse a userData dir (warm caches)
//
// Synthetic mode never touches ~/.pi. Real mode is read-only: it never
// sends prompts, never writes to pi data, and prints numbers only.

import { mkdtemp, mkdir, writeFile, rm, readFile, stat } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron as electron } from 'playwright-core'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const FAKE_PI = join(ROOT, 'test/fixtures/fake-pi.mjs')
const REAL = process.argv.includes('--real')
const OUT_INDEX = process.argv.indexOf('--out')
const OUT_FILE = OUT_INDEX >= 0 ? process.argv[OUT_INDEX + 1] : null
const UD_INDEX = process.argv.indexOf('--userdata')
const USERDATA_DIR = UD_INDEX >= 0 ? process.argv[UD_INDEX + 1] : null

// ---------------------------------------------------------------- helpers

function sessionDirName(cwd) {
  return `--${cwd.replaceAll('/', '-')}--`
}

function makeSession(id, cwd, created, userText, extraMessages = 0) {
  const lines = [
    { type: 'session', version: 3, id, timestamp: created, cwd },
    {
      type: 'message',
      id: `${id}-m1`,
      parentId: null,
      message: { role: 'user', content: userText, timestamp: Date.parse(created) }
    }
  ]
  let parent = `${id}-m1`
  for (let i = 0; i < extraMessages; i++) {
    const mid = `${id}-x${i}`
    lines.push({
      type: 'message',
      id: mid,
      parentId: parent,
      message: {
        role: i % 2 ? 'user' : 'assistant',
        content:
          i % 2
            ? 'synthetic follow-up'
            : [{ type: 'text', text: `Synthetic reply chunk ${i}. `.repeat(8) }],
        timestamp: Date.parse(created) + 5000 + i * 1000
      }
    })
    parent = mid
  }
  return lines
}

/** Seed ~18 sessions / ~70 MB across two projects (mirrors the real set). */
async function seedAgentDir(dir) {
  const sessionsDir = join(dir, 'sessions')
  const daysAgo = (n) => new Date(Date.now() - n * 86400000).toISOString()
  const cwds = ['/Users/example/synthetic-alpha', '/Users/example/synthetic-beta']
  let i = 0
  for (const cwd of cwds) {
    for (let n = 0; n < 8; n++) {
      i += 1
      const id = `perf-${i}`
      await mkdir(join(sessionsDir, sessionDirName(cwd)), { recursive: true })
      // Two oversized sessions like the real profile (~5 MB each).
      const extra = i <= 2 ? 6000 : 0
      const lines = makeSession(id, cwd, daysAgo(i), `Synthetic task ${i}`, extra)
      await writeFile(
        join(sessionsDir, sessionDirName(cwd), `${id}.jsonl`),
        lines.map((l) => JSON.stringify(l)).join('\n') + '\n'
      )
    }
  }
}

/** Sum RSS (kB) of the whole process tree rooted at `pid` via ps. */
function treeRssKb(pid) {
  return new Promise((resolvePromise) => {
    execFile('ps', ['-Ao', 'pid=,ppid=,rss='], (error, stdout) => {
      if (error) {
        resolvePromise(0)
        return
      }
      const children = new Map()
      const rss = new Map()
      for (const line of stdout.split('\n')) {
        const [cpid, ppid, crss] = line.trim().split(/\s+/)
        if (!cpid) continue
        rss.set(Number(cpid), Number(crss) || 0)
        const list = children.get(Number(ppid)) ?? []
        list.push(Number(cpid))
        children.set(Number(ppid), list)
      }
      let total = 0
      const stack = [pid]
      const seen = new Set()
      while (stack.length) {
        const p = stack.pop()
        if (seen.has(p)) continue
        seen.add(p)
        total += rss.get(p) ?? 0
        for (const child of children.get(p) ?? []) stack.push(child)
      }
      resolvePromise(total)
    })
  })
}

async function waitMs(page, fn, timeout, label) {
  const start = Date.now()
  for (;;) {
    if (await page.evaluate(fn)) return Date.now() - start
    if (Date.now() - start > timeout) throw new Error(`timeout waiting for ${label}`)
    await page.waitForTimeout(100)
  }
}

// ---------------------------------------------------------------- main

const results = { mode: REAL ? 'real' : 'synthetic', startedAt: new Date().toISOString() }
let agentDir = null
let userDataDir = null
let app = null

try {
  const env = { ...process.env }
  delete env['ELECTRON_RUN_AS_NODE']
  env['NODE_ENV'] = 'production'
  env['PI_DESKTOP_PERF'] = '1'

  if (REAL) {
    // Read-only: real pi binary, real session dir, throwaway userData so no
    // app state lands in the user's config either.
    delete env['PI_DESKTOP_PI_COMMAND']
    delete env['PI_CODING_AGENT_DIR']
    delete env['PI_CODING_AGENT_SESSION_DIR']
    userDataDir = USERDATA_DIR ?? (await mkdtemp(join(tmpdir(), 'pi-desktop-perf-ud-')))
  } else {
    agentDir = await mkdtemp(join(tmpdir(), 'pi-desktop-perf-agent-'))
    await seedAgentDir(agentDir)
    userDataDir = USERDATA_DIR ?? (await mkdtemp(join(tmpdir(), 'pi-desktop-perf-ud-')))
    await writeFile(join(userDataDir, 'settings.json'), JSON.stringify({ displayName: 'Perf' }))
    env['PI_DESKTOP_PI_COMMAND'] = FAKE_PI
    env['PI_CODING_AGENT_DIR'] = agentDir
    env['PI_CODING_AGENT_SESSION_DIR'] = join(agentDir, 'sessions')
  }
  env['PI_DESKTOP_USER_DATA_DIR'] = userDataDir

  // --- launch -------------------------------------------------------------
  const t0 = Date.now()
  app = await electron.launch({ args: [join(ROOT, 'out/main/index.js')], env })
  const mainPid = app.process().pid

  let stderrBuf = ''
  app.process().stderr.on('data', (d) => {
    stderrBuf += d.toString()
  })

  const page = await app.firstWindow()
  results.launch_to_window_ms = Date.now() - t0

  // --- composer interactive with a model ----------------------------------
  await page.waitForSelector('.composer-input', { state: 'visible', timeout: 60_000 })

  const paint = await page.evaluate(() => {
    const fcp = performance
      .getEntriesByType('paint')
      .find((e) => e.name === 'first-contentful-paint')
    return { timeOrigin: performance.timeOrigin, fcp: fcp ? fcp.startTime : null }
  })
  results.first_contentful_paint_ms =
    paint.fcp === null ? null : Math.round(paint.timeOrigin + paint.fcp - t0)
  await waitMs(
    page,
    () => {
      const name = document.querySelector('.model-picker-name')
      const input = document.querySelector('.composer-input')
      if (!name || !input) return false
      const text = name.textContent?.trim() ?? ''
      return text.length > 0 && text !== 'No models' && text !== 'Select model'
    },
    90_000,
    'composer with model'
  )
  results.composer_with_model_ms = Date.now() - t0

  // --- renderer JS at startup ----------------------------------------------
  // file:// loads produce no resource-timing entries, so measure the eager
  // graph directly: <script src> + <link rel="modulepreload"> in index.html.
  {
    const html = await readFile(join(ROOT, 'out/renderer/index.html'), 'utf8')
    const assets = new Set()
    for (const m of html.matchAll(/(?:src|href)="([^"]+\.js)"/g)) {
      assets.add(m[1].replace(/^\.\//, '').replace(/^\//, ''))
    }
    let total = 0
    let main = 0
    for (const asset of assets) {
      const size = (await stat(join(ROOT, 'out/renderer', asset))).size
      total += size
      if (asset.includes('index-')) main = size
    }
    results.js = { total_bytes: total, main_chunk_bytes: main }
  }

  // --- sessions list (cold parse time from main stderr) --------------------
  const scan = stderrBuf.match(/perf sessions-scan ms=(\d+) files=(\d+)/)
  results.sessions_scan_ms = scan ? Number(scan[1]) : null
  results.sessions_files = scan ? Number(scan[2]) : null
  results.sessions_list_ipc_ms = await page.evaluate(async () => {
    const t = performance.now()
    await window.piDesktop.sessions.list()
    return Math.round(performance.now() - t)
  })

  // --- open a past session -> first message rendered ------------------------
  const hasSessions = await page.evaluate(
    () => document.querySelectorAll('.sidebar-session').length
  )
  if (hasSessions > 0) {
    const openStart = Date.now()
    await page.locator('.sidebar-session').first().click()
    await page.waitForSelector('.msg-assistant, .msg-user-row', {
      state: 'visible',
      timeout: 60_000
    })
    results.session_open_ms = Date.now() - openStart
  }

  // --- IPC throughput during a fast stream (synthetic only) ------------------
  if (!REAL) {
    await page.evaluate(() => {
      window.__perfCount = { events: 0, start: 0, end: 0, settled: false }
      window.piDesktop.chat.onEvent((payload) => {
        const c = window.__perfCount
        if (c.start === 0) c.start = performance.now()
        c.events += 1
        c.end = performance.now()
        const events = payload?.events ?? (payload?.event ? [payload.event] : [])
        if (events.some((e) => e?.type === 'agent_settled')) c.settled = true
      })
    })
    const input = page.locator('.composer-input')
    await input.fill('stream perf')
    await input.press('Enter')
    await page.waitForFunction(() => window.__perfCount?.settled === true, {
      timeout: 60_000
    })
    const c = await page.evaluate(() => window.__perfCount)
    const seconds = (c.end - c.start) / 1000
    results.ipc_messages = c.events
    results.ipc_msgs_per_sec = seconds > 0 ? Math.round(c.events / seconds) : 0
  }

  // --- RSS after opening several chats --------------------------------------
  const rows = page.locator('.sidebar-session')
  const count = Math.min(await rows.count(), 6)
  for (let i = 0; i < count; i++) {
    await rows.nth(i).click()
    await page.waitForTimeout(300)
  }
  await page.waitForTimeout(REAL ? 20_000 : 5_000) // let pi children spawn
  results.rss_after_open_mb = Math.round((await treeRssKb(mainPid)) / 1024)
  await page.waitForTimeout(15_000) // short idle for eviction sweep
  results.rss_after_idle_mb = Math.round((await treeRssKb(mainPid)) / 1024)
} finally {
  if (app) await app.close().catch(() => {})
  if (agentDir) await rm(agentDir, { recursive: true, force: true })
  // A --userdata dir is reused across runs for warm-cache measurements.
  if (userDataDir && !USERDATA_DIR) {
    await rm(userDataDir, { recursive: true, force: true })
  }
}

// ---------------------------------------------------------------- report

console.log(JSON.stringify(results, null, 2))
if (OUT_FILE) {
  await mkdir(dirname(OUT_FILE), { recursive: true })
  await writeFile(OUT_FILE, JSON.stringify(results, null, 2) + '\n')
  console.error(`wrote ${OUT_FILE}`)
}
