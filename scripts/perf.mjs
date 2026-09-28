#!/usr/bin/env node
/* global window, document, performance, PerformanceObserver, requestAnimationFrame */
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
const BIG = process.argv.includes('--big')
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

/** Seed 1,000 sessions across 40 projects for the sidebar scale test. */
async function seedBigAgentDir(dir) {
  const sessionsDir = join(dir, 'sessions')
  const daysAgo = (n) => new Date(Date.now() - n * 86400000).toISOString()
  let i = 0
  for (let p = 0; p < 40; p++) {
    const cwd = `/Users/example/synthetic-p${p}`
    const dirPath = join(sessionsDir, sessionDirName(cwd))
    await mkdir(dirPath, { recursive: true })
    for (let n = 0; n < 25; n++) {
      i += 1
      const id = `big-${i}`
      // A few heavy transcripts so the largest-session probe has substance.
      const extra = i <= 3 ? 4000 : 0
      const lines = makeSession(id, cwd, daysAgo(n), `Synthetic task ${i}`, extra)
      await writeFile(
        join(dirPath, `${id}.jsonl`),
        lines.map((l) => JSON.stringify(l)).join('\n') + '\n'
      )
    }
  }
}

/** Snapshot cumulative CPU seconds per pid: {pid: {ppid, seconds}}. */
function cpuTable() {
  return new Promise((resolvePromise) => {
    execFile('ps', ['-Ao', 'pid=,ppid=,time='], (error, stdout) => {
      const map = new Map()
      if (!error) {
        for (const line of stdout.split('\n')) {
          const [cpid, ppid, time] = line.trim().split(/\s+/)
          if (!cpid) continue
          const parts = (time ?? '0').split(':').map(Number)
          const seconds =
            parts.length === 3
              ? parts[0] * 3600 + parts[1] * 60 + parts[2]
              : parts.length === 2
                ? parts[0] * 60 + parts[1]
                : parts[0] || 0
          map.set(Number(cpid), { ppid: Number(ppid), seconds })
        }
      }
      resolvePromise(map)
    })
  })
}

/** Fraction of one core used by the process tree over `ms` milliseconds. */
async function treeCpuFraction(pid, ms) {
  const before = await cpuTable()
  const members = new Set([pid])
  // First pass doesn't know the tree yet; collect children seen in `before`.
  for (const [p, info] of before) {
    if (members.has(info.ppid)) members.add(p)
  }
  await new Promise((r) => setTimeout(r, ms))
  const after = await cpuTable()
  // Expand the tree fully using the second snapshot.
  let grew = true
  while (grew) {
    grew = false
    for (const [p, info] of after) {
      if (members.has(info.ppid) && !members.has(p)) {
        members.add(p)
        grew = true
      }
    }
  }
  let delta = 0
  for (const p of members) {
    const a = before.get(p)?.seconds ?? after.get(p)?.seconds ?? 0
    const b = after.get(p)?.seconds ?? 0
    delta += Math.max(0, b - a)
  }
  return delta / (ms / 1000)
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
    if (BIG) {
      await seedBigAgentDir(agentDir)
    } else {
      await seedAgentDir(agentDir)
    }
    userDataDir = USERDATA_DIR ?? (await mkdtemp(join(tmpdir(), 'pi-desktop-perf-ud-')))
    await writeFile(
      join(userDataDir, 'settings.json'),
      JSON.stringify({
        displayName: 'Perf',
        // Projects are collapsed by default; expand the seeded ones so the
        // session rows are clickable below.
        expandedProjects: [
          '/Users/example/synthetic-alpha',
          '/Users/example/synthetic-beta'
        ]
      })
    )
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

  // --- expand collapsed projects so session rows are clickable --------------
  if (REAL) {
    // Real settings start collapsed; expand every project once.
    const rows = page.locator('.sidebar-project-row')
    const n = await rows.count()
    for (let i = 0; i < n; i++) {
      await rows.nth(i).click()
    }
    await page.waitForTimeout(300)
  }

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

  // --- IPC throughput + frame health during a fast stream (synthetic only) --
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
      // Frame health probes for the duration of the stream.
      window.__longTasks = []
      try {
        new PerformanceObserver((list) => {
          for (const e of list.getEntries()) window.__longTasks.push(Math.round(e.duration))
        }).observe({ type: 'longtask', buffered: false })
      } catch {
        // longtask unsupported — leave the list empty
      }
      window.__frames = []
      window.__rafLive = true
      let last
      const loop = (t) => {
        if (last !== undefined) window.__frames.push(t - last)
        last = t
        if (window.__rafLive) requestAnimationFrame(loop)
      }
      requestAnimationFrame(loop)
      window.__piCommits = {}
    })
    const input = page.locator('.composer-input')
    await input.fill('stream perf')
    await input.press('Enter')
    await page.waitForFunction(() => window.__perfCount?.settled === true, {
      timeout: 60_000
    })
    const c = await page.evaluate(() => {
      window.__rafLive = false
      return {
        count: window.__perfCount,
        longTasks: window.__longTasks,
        frames: window.__frames,
        commits: window.__piCommits ?? {}
      }
    })
    const seconds = (c.count.end - c.count.start) / 1000
    results.ipc_messages = c.count.events
    results.ipc_msgs_per_sec = seconds > 0 ? Math.round(c.count.events / seconds) : 0
    const frames = c.frames.slice().sort((a, b) => a - b)
    results.longtasks_over_50ms = c.longTasks.filter((d) => d > 50).length
    results.longtasks_ms = c.longTasks
    if (frames.length > 0) {
      const p95 = frames[Math.min(frames.length - 1, Math.floor(frames.length * 0.95))]
      results.frame_avg_ms = Math.round((frames.reduce((a, b) => a + b, 0) / frames.length) * 10) / 10
      results.frame_p95_ms = Math.round(p95 * 10) / 10
    }
    results.react_commits = c.commits
  }

  // --- largest session: transcript read time (real mode, numbers only) ------
  if (REAL) {
    const biggest = await page.evaluate(async () => {
      const list = await window.piDesktop.sessions.list()
      return list.reduce(
        (a, b) => ((a?.messageCount ?? 0) >= (b?.messageCount ?? 0) ? a : b),
        null
      )
    })
    if (biggest) {
      results.largest_session_messages = biggest.messageCount
      results.transcript_largest_ipc_ms = await page.evaluate(async (p) => {
        const t = performance.now()
        await window.piDesktop.chat.readTranscript({ sessionPath: p })
        return Math.round(performance.now() - t)
      }, biggest.path)

      // Render time in the real UI: reveal every "Show N more" row, click
      // the session, then measure click → first message and click → row
      // count stability (the transcript window caps at the latest entries).
      const moreRows = page.locator('.sidebar-item-muted', { hasText: 'Show ' })
      for (let guard = 0; guard < 20 && (await moreRows.count()) > 0; guard++) {
        await moreRows.first().click()
        await page.waitForTimeout(100)
      }
      const rows = page.locator('.sidebar-session')
      const n = await rows.count()
      let target = -1
      for (let i = 0; i < n; i++) {
        if ((await rows.nth(i).getAttribute('data-session-path')) === biggest.path) {
          target = i
          break
        }
      }
      if (target >= 0) {
        const t = Date.now()
        await rows.nth(target).click()
        await page.waitForSelector('.msg-user-row, .msg-assistant', {
          state: 'visible',
          timeout: 60_000
        })
        results.largest_session_first_message_ms = Date.now() - t
        const msgRows = page.locator('.msg-user-row, .msg-assistant')
        let prev = -1
        let stableAt = Date.now()
        let rendered = 0
        while (Date.now() - stableAt < 800 && Date.now() - t < 30_000) {
          rendered = await msgRows.count()
          if (rendered !== prev) {
            prev = rendered
            stableAt = Date.now()
          }
          await page.waitForTimeout(120)
        }
        results.largest_session_render_ms = Date.now() - t
        results.largest_session_rows_rendered = rendered
      }
    }
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

  // --- scroll frames on the open chat ---------------------------------------
  await page.evaluate(() => {
    const scroller = document.querySelector('.chat-scroll, .chat-messages, main')
    if (!scroller) {
      window.__scrollFrames = null
      return
    }
    window.__scrollFrames = []
    window.__rafLive = true
    let last
    const loop = (t) => {
      if (last !== undefined) window.__scrollFrames.push(t - last)
      last = t
      if (window.__rafLive) requestAnimationFrame(loop)
    }
    requestAnimationFrame(loop)
  })
  const scroller = page.locator('.chat-scroll, .chat-messages, main').first()
  if (await scroller.count()) {
    for (let i = 0; i < 6; i++) {
      await scroller.evaluate((el, i) => {
        el.scrollTop = i % 2 === 0 ? 0 : el.scrollHeight
      }, i)
      await page.waitForTimeout(150)
    }
  }
  const scrollFrames = await page.evaluate(() => {
    window.__rafLive = false
    return window.__scrollFrames ?? []
  })
  if (scrollFrames.length > 0) {
    const sorted = scrollFrames.slice().sort((a, b) => a - b)
    results.scroll_frame_p95_ms =
      Math.round(sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))] * 10) / 10
  }

  // --- idle CPU with the window hidden ---------------------------------------
  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0]?.hide()
  })
  await page.waitForTimeout(1000)
  results.idle_cpu_hidden_percent =
    Math.round((await treeCpuFraction(mainPid, 4000)) * 1000) / 10
  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0]?.show()
  })
  results.mode_big = BIG
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
