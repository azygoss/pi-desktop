// End-to-end smoke test for Pi Desktop using Playwright's Electron driver.
// Launches the built app (out/main/index.js) against the synthetic fake pi
// fixture and a synthetic PI_CODING_AGENT_DIR. No real pi processes or real
// user data are involved.

import { mkdtemp, mkdir, rm, utimes, writeFile } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron as electron, type ElectronApplication, type Page } from 'playwright-core'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..')
const FAKE_PI = join(ROOT, 'test/fixtures/fake-pi.mjs')
const FAKE_CUA = join(ROOT, 'src/main/cua/__fixtures__/fake-helper.mjs')
const SHOTS = process.env['PI_DESKTOP_SHOT_DIR'] ?? '/tmp/pi-desktop-shots'
const CUA_SHOTS = '/tmp/pi-cua-shots'
const WAVE1_SHOTS = '/tmp/pi-wave1'
const WAVE2_SHOTS = '/tmp/pi-wave2'

const PROJECT_A = '/Users/example/synthetic-alpha'
const PROJECT_B = '/Users/example/synthetic-beta'

const TEST_PAGE = `<!doctype html><html><head><title>E2E Test Page</title></head>
<body><h1>Pi Desktop test page</h1><button id="btn">Click me</button>
<script>document.getElementById('btn').addEventListener('click', (e) => { e.target.textContent = 'Clicked!' })</script>
</body></html>`

function git(cwd: string, args: string[]): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    execFile('git', ['-C', cwd, ...args], (error) => (error ? reject(error) : resolvePromise()))
  })
}

/** Seed a tiny git repo (synthetic basename) with one modified file. */
async function seedGitRepo(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true })
  await git(dir, ['init', '-b', 'main'])
  await writeFile(join(dir, 'notes.txt'), 'line one\nline two\n')
  await git(dir, ['add', 'notes.txt'])
  await git(dir, ['-c', 'user.email=test@example.com', '-c', 'user.name=Test', 'commit', '-m', 'init'])
  await writeFile(join(dir, 'notes.txt'), 'line one\nline two changed\nline three\n')
  await writeFile(join(dir, 'new-file.txt'), 'fresh content\n')
}

function sessionDirName(cwd: string): string {
  return `--${cwd.replaceAll('/', '-')}--`
}

interface SessionLine {
  [key: string]: unknown
}

function makeSession(id: string, cwd: string, created: string, userText: string): SessionLine[] {
  return [
    { type: 'session', version: 3, id, timestamp: created, cwd },
    {
      type: 'message',
      id: `${id}-m1`,
      parentId: null,
      message: { role: 'user', content: userText, timestamp: Date.parse(created) }
    },
    {
      type: 'message',
      id: `${id}-m2`,
      parentId: `${id}-m1`,
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: `Synthetic reply to: ${userText}` }],
        timestamp: Date.parse(created) + 5000
      }
    }
  ]
}

async function seedAgentDir(dir: string): Promise<void> {
  const sessionsDir = join(dir, 'sessions')
  const daysAgo = (n: number) => new Date(Date.now() - n * 86400000).toISOString()
  const sessions: { cwd: string; id: string; created: string; text: string }[] = [
    { cwd: PROJECT_A, id: 'a1', created: daysAgo(0), text: 'Fix flaky router test' },
    { cwd: PROJECT_A, id: 'a2', created: daysAgo(0), text: 'Add retry to fetch client' },
    { cwd: PROJECT_A, id: 'a3', created: daysAgo(1), text: 'Refactor session parser' },
    { cwd: PROJECT_A, id: 'a4', created: daysAgo(9), text: 'Profile startup time' },
    { cwd: PROJECT_B, id: 'b1', created: daysAgo(0), text: 'Document release steps' },
    { cwd: PROJECT_B, id: 'b2', created: daysAgo(40), text: 'Bump dependencies' },
    {
      cwd: PROJECT_B,
      id: 'b3',
      created: daysAgo(0),
      // pi expands /skill:name into a <skill> XML prefix on the user
      // message; titles and bubbles must show only the typed remainder.
      text: '<skill name="synthetic-skill" location="/Users/example/.pi/skills/synthetic-skill/SKILL.md">Synthetic skill instructions.</skill> Explain the fixture'
    }
  ]
  // The sidebar orders sessions by file mtime. Files written back to back
  // share a millisecond, which left the order (and which row hides behind
  // "Show 1 more") to chance — stagger mtimes so list order is sidebar order.
  const now = Date.now()
  for (const [i, s] of sessions.entries()) {
    const dirName = sessionDirName(s.cwd)
    await mkdir(join(sessionsDir, dirName), { recursive: true })
    const lines = makeSession(s.id, s.cwd, s.created, s.text)
    const file = join(sessionsDir, dirName, `${s.id}.jsonl`)
    await writeFile(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n')
    const mtime = new Date(now - i * 1000)
    await utimes(file, mtime, mtime)
  }
}

async function visible(page: Page, selector: string, timeout = 15_000): Promise<void> {
  await page.waitForSelector(selector, { state: 'visible', timeout })
}

/**
 * Poll the active terminal's rows for text matching `re`. String/regex
 * selectors inside the CSP-protected renderer are unreliable here, so we
 * read row text over the wire instead.
 */
async function waitForTerminalText(page: Page, re: RegExp, timeout = 20_000): Promise<void> {
  const rows = page.locator('.panel-tab-content.is-active .xterm-rows')
  const deadline = Date.now() + timeout
  for (;;) {
    const texts = await rows.allTextContents()
    if (texts.some((t) => re.test(t))) {
      return
    }
    if (Date.now() > deadline) {
      throw new Error(`terminal did not show ${re} within ${timeout}ms`)
    }
    await page.waitForTimeout(250)
  }
}

describe('Pi Desktop e2e', () => {
  let app: ElectronApplication
  let page: Page
  let agentDir: string
  let userDataDir: string
  let repoDir: string
  let server: Server
  let pageUrl: string

  beforeAll(async () => {
    agentDir = await mkdtemp(join(tmpdir(), 'pi-desktop-e2e-'))
    await seedAgentDir(agentDir)
    await mkdir(SHOTS, { recursive: true })
    await mkdir(CUA_SHOTS, { recursive: true })
    await mkdir(WAVE1_SHOTS, { recursive: true })
    await mkdir(WAVE2_SHOTS, { recursive: true })

    // The helper override must be an executable file; wrap the .mjs fixture.
    const cuaHelper = join(agentDir, 'fake-cua-helper.sh')
    await writeFile(
      cuaHelper,
      `#!/bin/sh\nexec "${process.execPath}" "${FAKE_CUA}"\n`,
      { mode: 0o755 }
    )

    // Synthetic git repo for the diff panel (basename shows in the UI).
    repoDir = join(await mkdtemp(join(tmpdir(), 'pi-e2e-repo-')), 'synthetic-repo')
    await seedGitRepo(repoDir)
    // A spaced filename exercises the @"…" quoting path for attachments.
    await writeFile(join(repoDir, 'attach me.txt'), 'synthetic attachment\n')

    // Local static page for the browser panel.
    server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' })
      res.end(TEST_PAGE)
    })
    await new Promise<void>((resolvePromise) => server.listen(0, '127.0.0.1', resolvePromise))
    const port = (server.address() as { port: number }).port
    pageUrl = `http://127.0.0.1:${port}/`

    // Synthetic app settings so screenshots show a fake display name. New
    // chats run in the app scratch dir and show "Without project", so no
    // real directory path can leak into screenshots.
    userDataDir = await mkdtemp(join(tmpdir(), 'pi-desktop-e2e-ud-'))
    await writeFile(
      join(userDataDir, 'settings.json'),
      JSON.stringify({
        displayName: 'Alex',
        // Projects are collapsed by default; expand the seeded ones so the
        // session rows underneath them are visible to the assertions.
        expandedProjects: [PROJECT_A, PROJECT_B],
        projects: [
          {
            cwd: '/Users/example/synthetic-gamma',
            addedAt: '2024-01-01T00:00:00Z'
          },
          {
            cwd: repoDir,
            addedAt: '2024-01-02T00:00:00Z'
          }
        ]
      })
    )

    // Strip ELECTRON_RUN_AS_NODE: if inherited it forces the Electron binary
    // into plain Node mode and the app never starts.
    const env = { ...process.env }
    delete env['ELECTRON_RUN_AS_NODE']

    app = await electron.launch({
      args: [join(ROOT, 'out/main/index.js')],
      env: {
        ...env,
        PI_DESKTOP_PI_COMMAND: FAKE_PI,
        PI_DESKTOP_CUA_HELPER: cuaHelper,
        PI_DESKTOP_E2E: '1',
        PI_CODING_AGENT_DIR: agentDir,
        PI_CODING_AGENT_SESSION_DIR: join(agentDir, 'sessions'),
        PI_DESKTOP_PICK_FILES: join(repoDir, 'attach me.txt'),
        PI_DESKTOP_USER_DATA_DIR: userDataDir,
        NODE_ENV: 'production'
      }
    })
    page = await app.firstWindow()
    await visible(page, '.composer-input', 30_000)
  }, 60_000)

  /** Switch the app theme through the real settings IPC so main's
   *  nativeTheme (which drives the vibrancy material) and the renderer's
   *  data-theme move together. */
  async function setTheme(theme: 'light' | 'dark'): Promise<void> {
    await page.evaluate(`window.piDesktop.appSettings.update({ theme: '${theme}' })`)
    await page.evaluate(`document.documentElement.dataset.theme = '${theme}'`)
    await page.waitForTimeout(300)
  }

  /** nativeTheme as seen in the main process. */
  async function nativeThemeState(): Promise<{ themeSource: string; dark: boolean }> {
    return app.evaluate(({ nativeTheme }) => ({
      themeSource: nativeTheme.themeSource,
      dark: nativeTheme.shouldUseDarkColors
    }))
  }

  /** Wait until the current run settles (no steer hint under the composer). */
  async function waitForSettled(): Promise<void> {
    await expect
      .poll(
        async () => {
          const stats = await page.locator('.chat-stats').allTextContents()
          return !stats.some((t) => t.includes('Enter to steer'))
        },
        { timeout: 40_000 }
      )
      .toBe(true)
  }

  afterAll(async () => {
    await app?.close()
    server?.close()
    if (agentDir) {
      await rm(agentDir, { recursive: true, force: true })
    }
    if (userDataDir) {
      await rm(userDataDir, { recursive: true, force: true })
    }
    if (repoDir) {
      await rm(dirname(repoDir), { recursive: true, force: true })
    }
  })

  it('shows the home screen with greeting and composer (dark)', async () => {
    // Force dark regardless of the host's system appearance; the setting
    // must reach nativeTheme so the vibrancy material matches.
    await setTheme('dark')
    expect(await nativeThemeState()).toEqual({ themeSource: 'dark', dark: true })
    await visible(page, '.home-greeting h1')
    const greeting = await page.locator('.home-greeting h1').textContent()
    expect(greeting).toMatch(/Good|mind/)
    // sidebar nests seeded chats under their projects (4 + 3), plus a
    // synthetic user-added project with no chats at all. Expanded projects
    // cap at 3 chats with a "Show N more" row, so alpha shows 3, beta 3.
    await visible(page, '.sidebar-project')
    expect(await page.locator('.sidebar-project').count()).toBe(4)
    expect(await page.locator('.sidebar-session').count()).toBe(6)
    expect(await page.locator('.sidebar-item-muted').first().textContent()).toBe('Show 1 more…')
    // Toggling a project collapses it and persists that choice.
    const alphaRow = page.locator('.sidebar-project-row', { hasText: 'synthetic-alpha' })
    const sessionCount = () => page.locator('.sidebar-session').count()
    await alphaRow.click()
    await expect.poll(sessionCount).toBe(3)
    await alphaRow.click()
    await expect.poll(sessionCount).toBe(6)
    // Expand the empty user-added project to see its "No chats" row.
    await page
      .locator('.sidebar-project-row', { hasText: 'synthetic-gamma' })
      .click()
    await expect
      .poll(() => page.locator('.sidebar-empty-nested').first().textContent())
      .toBe('No chats')
    await page.screenshot({ path: join(SHOTS, 'home-dark.png') })
  })

  it('shows the home screen in light theme', async () => {
    // App-light while the host runs dark: themeSource must override the
    // system appearance or the sidebar material renders as a dark wash.
    await setTheme('light')
    expect(await nativeThemeState()).toEqual({ themeSource: 'light', dark: false })
    await page.screenshot({ path: join(SHOTS, 'home-light.png') })
    await setTheme('dark')
  })

  it('opens the composer project picker', async () => {
    await visible(page, '.folder-chip')
    expect(await page.locator('.folder-chip').textContent()).toContain('Without project')
    await page.locator('.folder-chip').click()
    await visible(page, '.folder-popover')
    const rows = await page.locator('.folder-popover .folder-row').allTextContents()
    expect(rows.some((r) => r.includes('Without project'))).toBe(true)
    expect(rows.some((r) => r.includes('synthetic-alpha'))).toBe(true)
    await page.screenshot({ path: join(SHOTS, 'project-picker.png') })
    // click outside the popover to dismiss it
    await page.locator('.composer-input').click()
  })

  it('opens the model picker', async () => {
    // The home draft chat provides models via the fake pi. Select the
    // no-reasoning model so the picker and composer show the muted
    // "No reasoning" state.
    await visible(page, '[data-testid="model-picker-trigger"]')
    await page.locator('[data-testid="model-picker-trigger"]').click()
    await visible(page, '[data-testid="model-popover"]')
    await visible(page, '.model-row')
    await page.locator('.model-row', { hasText: 'Synthetic Haiku' }).click()
    await page.waitForSelector('[data-testid="model-popover"]', {
      state: 'detached',
      timeout: 5_000
    })
    // Reopen so the shot shows the selection check, the row hints and the
    // muted "No reasoning" state (the hint renders inside the popover).
    await page.locator('[data-testid="model-picker-trigger"]').click()
    await visible(page, '[data-testid="model-popover"]')
    await visible(page, '.thinking-none')
    await visible(page, '.model-row .model-row-hint')
    await page.screenshot({ path: join(SHOTS, 'model-picker.png') })
    await page.keyboard.press('Escape')
  })

  it('opens the slash command palette', async () => {
    await page.locator('.composer-input').fill('/')
    await visible(page, '.slash-popover')
    await visible(page, '.slash-row')
    await page.screenshot({ path: join(SHOTS, 'slash-palette.png') })
    await page.locator('.composer-input').fill('')
    await page.keyboard.press('Escape')
  })

  it('opens the settings modal', async () => {
    await page.locator('.sidebar-footer .icon-btn').last().click()
    await visible(page, '.settings-modal')
    await visible(page, '.settings-segmented')
    await page.screenshot({ path: join(SHOTS, 'settings-modal.png') })
    await page.keyboard.press('Escape')
    await page.waitForSelector('.settings-modal', { state: 'detached', timeout: 5_000 })
  })

  it('opens the command palette and runs a chat search', async () => {
    await page.keyboard.press('Meta+k')
    await visible(page, '.palette-modal')
    await page.screenshot({ path: join(SHOTS, 'palette.png') })
    await page.locator('.palette-input').fill('flaky')
    await visible(page, '.palette-row')
    expect(await page.locator('.palette-row').first().textContent()).toContain(
      'Fix flaky router test'
    )
    await page.keyboard.press('Enter')
    // The palette closed and navigated into that session.
    await page.waitForSelector('.palette-modal', { state: 'detached', timeout: 5_000 })
    await visible(page, '.msg-user-row', 15_000)
    // Back home for the next test.
    await page.keyboard.press('Meta+n')
    await visible(page, '.home-greeting')
  })

  it('sends a prompt and renders a streamed reply with a tool card', async () => {
    await page.locator('.composer-input').fill('Write a file and show the result')
    await page.keyboard.press('Enter')
    // navigated to chat view; wait for the scripted reply to complete
    await visible(page, '.tool-card', 30_000)
    // expand the tool card
    await page.locator('.tool-row').first().click()
    await visible(page, '.tool-detail')
    // final assistant text present
    const lastMarkdown = await page.locator('.markdown').last().textContent()
    expect(lastMarkdown).toContain('Done')
    await page.screenshot({ path: join(SHOTS, 'chat-toolcard.png') })
    // Wait for the run to fully settle — sending while still streaming
    // becomes a steer and races the next test's pending-status state.
    await expect
      .poll(async () => {
        const stats = await page.locator('.chat-stats').allTextContents()
        return !stats.some((t) => t.includes('Enter to steer'))
      })
      .toBe(true)
  })

  it('shows the pending status with a run timer while a reply starts', async () => {
    // "slow" makes the fake pi pause 2.5s before its first delta, so the
    // pending row is on screen long enough to capture.
    await page.locator('.composer-input').fill('slow reply please')
    await page.keyboard.press('Enter')
    await visible(page, '.msg-pending .elapsed')
    // 'visible' only means rendered — wait until the pending row is actually
    // inside the scroll viewport before shooting.
    // Poll the box via CDP only — page-side JS predicates hit the CSP ban
    // on eval. Electron pages have no fixed viewport, so take the window's
    // content height from main. The composer fade can overlay the row's
    // bottom edge, so any vertical intersection with the window counts.
    const viewHeight = await app.evaluate(({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows()[0]
      return win ? win.getContentSize()[1]! : 0
    })
    // Wheel the transcript to the bottom so the pending row is in view even
    // if the auto-scroll pin lost a race with the stream flush.
    await page.locator('.chat-scroll').hover()
    await page.mouse.wheel(0, 2000)
    const pending = page.locator('.msg-pending')
    await expect
      .poll(
        async () => {
          if ((await pending.count()) === 0) {
            return false
          }
          const box = await pending.boundingBox().catch(() => null)
          return !!box && box.y + box.height > 0 && box.y < viewHeight
        },
        { timeout: 5_000, interval: 100 }
      )
      .toBe(true)
    await page.screenshot({ path: join(SHOTS, 'chat-streaming.png') })
    // Let the reply finish; the scripted answer includes a markdown table.
    await visible(page, '.markdown .table-scroll table', 30_000)
    await page.screenshot({ path: join(SHOTS, 'chat-markdown.png') })
    // The host runs a dark system appearance, so app-light here exercises
    // the opposite-appearance vibrancy case.
    await setTheme('light')
    await page.screenshot({ path: join(SHOTS, 'chat-markdown-light.png') })
    await setTheme('dark')
  })

  it('renders a skill invocation as a chip, not raw XML', async () => {
    // Session b3's first user message starts with a <skill> block: the
    // sidebar title and the bubble show only what the user typed.
    const row = page.locator('.sidebar-session', { hasText: 'Explain the fixture' })
    await row.waitFor({ state: 'visible', timeout: 10_000 })
    await row.click()
    await visible(page, '.skill-chip')
    expect(await page.locator('.skill-chip').textContent()).toContain('synthetic-skill')
    expect(await page.locator('.msg-user-text').first().textContent()).toBe(
      'Explain the fixture'
    )
    expect(await page.locator('.skill-details').count()).toBe(1)
    await page.screenshot({ path: join(SHOTS, 'skill-chip.png') })
    // Back home so the next test starts a fresh chat.
    await page.keyboard.press('Meta+n')
    await visible(page, '.home-greeting')
  })

  it('drives the in-app browser via the pi browser tools', async () => {
    // Still on the chat view from the previous test. The fake pi sees the
    // bridge env vars and issues real browser_open/browser_screenshot calls
    // through the loopback bridge — the same path the shipped extension uses.
    await page.locator('.composer-input').fill(`open ${pageUrl} in the browser`)
    await page.keyboard.press('Enter')
    await visible(page, '.tool-card', 30_000)
    // The bridge opened the panel and focused the chat's agent tab; the page
    // title proves the WebContentsView actually loaded the local test page.
    // Agent tab labels carry the "Pi · " prefix.
    await visible(
      page,
      '.right-panel .panel-tab-label:text-is("Pi · E2E Test Page")',
      20_000
    )
    // The two consecutive browser calls collapse into a group row.
    const group = page.locator('.tool-group')
    await visible(page, '.tool-group .tool-row', 20_000)
    expect(await group.locator('.tool-name').textContent()).toContain(
      'Used the browser (2 actions)'
    )
    await page.screenshot({ path: join(SHOTS, 'chat-toolgroup.png') })
    await group.locator('.tool-row').first().click()
    // Screenshot tool returned a real JPEG; expanding the card shows it.
    const shotCard = page.locator('.tool-group .tool-card', {
      hasText: 'browser_screenshot'
    })
    await shotCard.locator('.tool-row').waitFor({ state: 'visible', timeout: 20_000 })
    await shotCard.locator('.tool-row').click()
    await visible(page, '.tool-card .tool-image img', 10_000)
    const src = await page.locator('.tool-card .tool-image img').getAttribute('src')
    expect(src).toMatch(/^data:image\/jpeg;base64,/)
    await page.screenshot({ path: join(SHOTS, 'chat-browser-tools.png') })
  })

  it('shows the /session info modal', async () => {
    await page.locator('.composer-input').fill('/session')
    await visible(page, '.slash-popover')
    // Enter would complete the highlighted row instead; click /session.
    await page.locator('.slash-row', { hasText: '/session' }).click()
    await visible(page, '.cmd-modal')
    await visible(page, '.session-info')
    await visible(page, '.session-path')
    await page.screenshot({ path: join(SHOTS, 'session-modal.png') })
    await page.keyboard.press('Escape')
    await page.waitForSelector('.cmd-modal', { state: 'detached', timeout: 5_000 })
  })

  it('collapses the sidebar', async () => {
    await page.keyboard.press('Meta+b')
    await page.waitForSelector('.sidebar', { state: 'hidden', timeout: 5_000 })
    // nav buttons move into the main pane's top strip
    await visible(page, '.main-topbar .nav-buttons', 5_000)
    await page.screenshot({ path: join(SHOTS, 'sidebar-collapsed.png') })
  })

  it('opens the right panel and runs a terminal command', async () => {
    if (!(await page.locator('.right-panel').isVisible())) {
      await page.keyboard.press('Meta+Alt+b')
      await visible(page, '.right-panel')
    }
    // The browser-tools test may have left an agent tab open, so open a
    // fresh new-tab page via "+" before picking the Terminal tool.
    await page.locator('.panel-tab-add').click()
    await visible(page, '.newtab-inner')
    await page.locator('.newtab-row', { hasText: 'Terminal' }).click()
    await visible(
      page,
      '.panel-tab-content.is-active .terminal-view .xterm',
      20_000
    )
    // Wait for the login shell prompt (any output = shell is ready).
    await waitForTerminalText(page, /\S/)
    await page.locator('.panel-tab-content.is-active .terminal-view').click()
    // Sanitize the prompt so screenshots never show the real user@host.
    await page.keyboard.type("PS1='> '")
    await page.keyboard.press('Enter')
    await page.keyboard.type('clear')
    await page.keyboard.press('Enter')
    await page.keyboard.type('echo hello')
    await page.keyboard.press('Enter')
    await waitForTerminalText(page, /hello/)
    await page.screenshot({ path: join(SHOTS, 'panel-terminal.png') })
  })

  it('opens a browser tab on a local page', async () => {
    await page.locator('.panel-tab-add').click()
    await visible(page, '.panel-tab-content.is-active .newtab-omnibox input')
    // The omnibox is a fixed-height single-line input, not a stretched box.
    const box = await page
      .locator('.panel-tab-content.is-active .newtab-omnibox')
      .boundingBox()
    expect(box?.height ?? 0).toBeLessThanOrEqual(48)
    // Local servers are populated via lsof — on a busy machine the list
    // caps at 8, so our test server may not always make the cut; assert the
    // section shows real listeners, and prefer clicking its row when ours
    // is present.
    const localSection = page.locator('.panel-tab-content.is-active .newtab-section', {
      hasText: 'Local servers'
    })
    await expect
      .poll(() => localSection.locator('.newtab-row').count(), { timeout: 10_000 })
      .toBeGreaterThan(0)
    // Drag the panel to its minimum width (320) — no new-tab element may
    // stick out of the panel's box. Dispatch real PointerEvents on the
    // resize handle so the capture logic runs end to end.
    await page.evaluate(`(() => {
      const h = document.querySelector('.panel-resize-handle')
      if (!h) return
      const r = h.getBoundingClientRect()
      const cx = r.x + r.width / 2
      const cy = r.y + 20
      const opts = { bubbles: true, pointerId: 7, isPrimary: true }
      h.dispatchEvent(new PointerEvent('pointerdown', { ...opts, clientX: cx, clientY: cy }))
      h.dispatchEvent(new PointerEvent('pointermove', { ...opts, clientX: cx + 300, clientY: cy }))
      h.dispatchEvent(new PointerEvent('pointerup', { ...opts, clientX: cx + 300, clientY: cy }))
    })()`)
    await expect
      .poll(async () => (await page.locator('.right-panel').boundingBox())?.width ?? 0, {
        timeout: 5_000
      })
      .toBeLessThanOrEqual(330)
    const panelBox = await page.locator('.right-panel').boundingBox()
    const parts = page.locator(
      '.panel-tab-content.is-active .newtab-inner, ' +
        '.panel-tab-content.is-active .newtab-omnibox, ' +
        '.panel-tab-content.is-active .newtab-section, ' +
        '.panel-tab-content.is-active .newtab-row'
    )
    for (let i = 0, n = await parts.count(); i < n; i++) {
      const box = await parts.nth(i).boundingBox()
      if (!box || !panelBox) {
        continue
      }
      expect(box.x).toBeGreaterThanOrEqual(panelBox.x - 1)
      expect(box.x + box.width).toBeLessThanOrEqual(panelBox.x + panelBox.width + 1)
    }
    await page.screenshot({ path: join(SHOTS, 'panel-newtab.png') })
    const port = new URL(pageUrl).port
    const localRow = localSection.locator('.newtab-row', { hasText: `:${port}` })
    if ((await localRow.count()) > 0) {
      await localRow.click()
    } else {
      await page
        .locator('.panel-tab-content.is-active .newtab-omnibox input')
        .fill(pageUrl)
      await page.keyboard.press('Enter')
    }
    await visible(page, '.panel-tab-content.is-active .browser-toolbar')
    // WebContentsView paints outside the DOM; the tab title proves the page
    // loaded and pushed state back over IPC.
    await visible(
      page,
      '.right-panel .panel-tab-label:text-is("E2E Test Page")',
      15_000
    )
    await page.waitForTimeout(400)
    await page.screenshot({ path: join(SHOTS, 'panel-browser.png') })
  })

  it('shows the diff tab for a git project', async () => {
    // Open a draft chat inside the synthetic repo project (re-expand the
    // sidebar first — the previous test collapsed it).
    await page.keyboard.press('Meta+b')
    await visible(page, '.sidebar')
    await page.keyboard.press('Meta+n')
    const project = page.locator('.sidebar-project', { hasText: 'synthetic-repo' })
    await project.hover()
    await project.locator('button[title="New chat in this project"]').click()
    await page.waitForSelector('.composer-input')

    await page.locator('.panel-tab-add').click()
    await page
      .locator('.panel-tab-content.is-active .newtab-row', { hasText: 'Diff' })
      .click()
    await visible(page, '.panel-tab-content.is-active .diff-panel')
    await visible(page, '.panel-tab-content.is-active .diff-file', 10_000)
    const paths = await page.locator('.panel-tab-content.is-active .diff-file-path').allTextContents()
    expect(paths).toContain('notes.txt')
    expect(paths).toContain('new-file.txt')
    await page.screenshot({ path: join(SHOTS, 'panel-diff.png') })
  })

  it('opens the plus menu (not a file dialog) with keyboard nav', async () => {
    const plusBtn = page.locator('button[title="Add files and more"]')
    await visible(page, '.composer-input')
    await plusBtn.click()
    await visible(page, '.plus-popover')
    const labels = await page.locator('.plus-popover .plus-row-label').allTextContents()
    expect(labels.some((l) => l.includes('Add photos & files'))).toBe(true)
    expect(labels.some((l) => l.includes('Computer use'))).toBe(true)
    expect(labels.some((l) => l.includes('Browser'))).toBe(true)
    expect(labels.some((l) => l.includes('Terminal'))).toBe(true)
    // The computer-use row reports live status (fake helper grants AX).
    await visible(page, '.plus-row-sub:text("Control Mac apps")', 10_000)
    // Keyboard navigation highlights rows; Escape closes.
    await page.keyboard.press('ArrowDown')
    const highlighted = await page
      .locator('.plus-popover .folder-row.is-highlight')
      .textContent()
    expect(highlighted).toContain('Computer use')
    // Let the pop-in animation finish so the menu is fully opaque.
    await page.waitForTimeout(300)
    await page.screenshot({ path: join(CUA_SHOTS, 'plus-menu-dark.png') })
    await setTheme('light')
    await page.waitForTimeout(300)
    await page.screenshot({ path: join(CUA_SHOTS, 'plus-menu-light.png') })
    await page.keyboard.press('Escape')
    await page.waitForSelector('.plus-popover', { state: 'detached', timeout: 5_000 })
    await setTheme('dark')
    // Browser item opens the right panel.
    await plusBtn.click()
    await visible(page, '.plus-popover')
    await page.locator('.plus-popover .folder-row', { hasText: 'Browser' }).click()
    await visible(page, '.right-panel .newtab-inner', 10_000)
  })

  it('toggles computer use from the plus menu', async () => {
    const plusBtn = page.locator('button[title="Add files and more"]')
    await plusBtn.click()
    await visible(page, '.plus-popover')
    await visible(page, '.plus-row-sub:text("Control Mac apps")', 10_000)
    const row = page.locator('.plus-popover .plus-cua-row')
    await expect.poll(() => row.locator('.switch').getAttribute('class')).toContain('on')
    await row.click()
    // Toast announces the deferred effect; the switch flips on reopen.
    await visible(page, '.toast', 5_000)
    await expect
      .poll(async () => {
        const v = await page.evaluate(
          `window.piDesktop.appSettings.get().then(s => s.computerUse.enabled)`
        )
        return v
      })
      .toBe(false)
    // Toggle back on for the rest of the suite.
    await plusBtn.click()
    await visible(page, '.plus-popover')
    await page.locator('.plus-popover .plus-cua-row').click()
    await expect
      .poll(async () =>
        page.evaluate(
          `window.piDesktop.appSettings.get().then(s => s.computerUse.enabled)`
        )
      )
      .toBe(true)
  })

  it('shows the live computer-use activity strip with pause/stop', async () => {
    // Activity must arrive while the turn is live: a 'start' after the
    // turn's agent_end flush is correctly discarded by the store. Send the
    // fake pi's scripted 2.5s-delayed reply so the turn is still streaming.
    await page.locator('.composer-input').fill('slow reply please')
    await page.keyboard.press('Enter')
    await visible(page, '.msg-pending', 15_000)
    await page.evaluate(
      `window.piDesktop.cua.testActivity({
        phase: 'start', cmd: 'computer_click', app: 'Finder',
        summary: 'Clicked "Save"'
      })`
    )
    await visible(page, '.cua-strip')
    expect(await page.locator('.cua-strip-headline').textContent()).toBe(
      'Using Finder'
    )
    expect(await page.locator('.cua-strip-summary').textContent()).toContain(
      'Clicked'
    )
    await page.screenshot({ path: join(CUA_SHOTS, 'cua-strip.png') })
    // Pause flips the strip copy.
    await page.locator('button[title^="Pause computer actions"]').click()
    await visible(page, '.cua-strip-headline:text("Paused — pi is waiting")')
    await page.screenshot({ path: join(CUA_SHOTS, 'cua-strip-paused.png') })
    // Resume returns to the live state.
    await page.locator('button[title^="Resume"]').click()
    await visible(page, '.cua-strip-headline:text("Using Finder")')
    // Stop aborts the turn; the resulting agent_end clears the strip.
    await page.locator('button[title="Stop computer use"]').click()
    await page.waitForSelector('.cua-strip', { state: 'detached', timeout: 8_000 })
    // Let the scripted reply settle so the next test starts clean.
    await expect
      .poll(async () => {
        const stats = await page.locator('.chat-stats').allTextContents()
        return !stats.some((t) => t.includes('Enter to steer'))
      })
      .toBe(true)
  })

  it('shows the Computer use settings section', async () => {
    await page.locator('.sidebar-footer .icon-btn').last().click()
    await visible(page, '.settings-modal')
    await page
      .locator('.settings-nav-item', { hasText: 'Computer use' })
      .click()
    await visible(page, '.perm-pill', 10_000)
    // Fake helper reports both permissions granted.
    await expect
      .poll(() => page.locator('.perm-pill.is-granted').count(), { timeout: 10_000 })
      .toBe(2)
    await page.screenshot({ path: join(CUA_SHOTS, 'settings-cua.png') })
    await page.keyboard.press('Escape')
    await page.waitForSelector('.settings-modal', { state: 'detached', timeout: 5_000 })
  })

  // --- Wave 1: chat core UX --------------------------------------------------

  it('groups consecutive tools with a natural summary, diff stats and a failure count', async () => {
    await page.locator('.composer-input').fill('group tools please')
    await page.keyboard.press('Enter')
    await visible(page, '.tool-group', 30_000)
    // The group header flips from "Running N tools…" to the natural summary
    // once the last tool settles.
    await expect
      .poll(() => page.locator('.tool-group .tool-name').textContent(), {
        timeout: 30_000
      })
      .toBe('Edited a file, created a file, ran a command')
    await visible(page, '.tool-group-diff')
    expect(await page.locator('.diff-add-count').textContent()).toBe('+6')
    expect(await page.locator('.diff-del-count').textContent()).toBe('−2')
    expect(await page.locator('.tool-group-errors').textContent()).toContain(
      '1 failed'
    )
    await page.screenshot({ path: join(WAVE1_SHOTS, 'tool-group.png') })
    await setTheme('light')
    await page.screenshot({ path: join(WAVE1_SHOTS, 'tool-group-light.png') })
    await setTheme('dark')
    // The group expands to the individual tool cards.
    await page.locator('.tool-group > .tool-row').first().click()
    await visible(page, '.tool-group-body .tool-card')
    await waitForSettled()
  })

  it('finds text in the chat with Meta+F and navigates matches', async () => {
    await page.keyboard.press('Meta+f')
    await visible(page, '.find-bar')
    await page.locator('.find-bar-input').fill('Done')
    // 120ms debounce, then the match counter resolves.
    await expect
      .poll(() => page.locator('.find-bar-count').textContent(), { timeout: 5_000 })
      .toMatch(/^\d+ of \d+$/)
    const count = (await page.locator('.find-bar-count').textContent())!
    const total = Number(count.split(' of ')[1])
    await page.screenshot({ path: join(WAVE1_SHOTS, 'find-bar.png') })
    // Enter advances to the next match, wrapping at the end.
    await page.locator('.find-bar-input').press('Enter')
    await expect
      .poll(() => page.locator('.find-bar-count').textContent())
      .toBe(`${total > 1 ? 2 : 1} of ${total}`)
    // Escape closes the bar and returns focus to the composer.
    await page.locator('.find-bar-input').press('Escape')
    await page.waitForSelector('.find-bar', { state: 'detached', timeout: 5_000 })
    await expect
      .poll(() =>
        page.evaluate('document.activeElement?.className ?? ""')
      )
      .toContain('composer-input')
  })

  it('shows copy actions on user and assistant messages', async () => {
    const userRow = page.locator('.msg-user-row').last()
    await userRow.hover()
    const copy = page.locator('.msg-user-row .msg-actions button[title="Copy"]').last()
    await visible(page, '.msg-user-row .msg-actions button[title="Copy"]')
    await page.screenshot({ path: join(WAVE1_SHOTS, 'msg-actions-user.png') })
    // Copy flips into a transient check state.
    await copy.click()
    await visible(page, '.msg-user-row .msg-actions button[title="Copied"]')
    const assistant = page.locator('.msg-assistant').last()
    await assistant.hover()
    await visible(page, '.msg-assistant .msg-actions button[title="Copy"]')
    await page.screenshot({ path: join(WAVE1_SHOTS, 'msg-actions-assistant.png') })
  })

  it('shows the jump-to-bottom button with a new-content dot', async () => {
    const scroller = page.locator('.chat-scroll')
    // The transcript is long by now; scroll to the top so the button shows.
    await scroller.hover()
    for (let i = 0; i < 8; i++) {
      await page.mouse.wheel(0, -3000)
      await page.waitForTimeout(80)
    }
    await visible(page, '.jump-btn.is-visible', 10_000)
    // Start a streamed reply (send pins to bottom), then scroll up mid-stream:
    // new content sets the accent dot on the jump button.
    await page.locator('.composer-input').fill('slow reply please')
    await page.keyboard.press('Enter')
    await scroller.hover()
    for (let i = 0; i < 8; i++) {
      await page.mouse.wheel(0, -3000)
      await page.waitForTimeout(80)
    }
    await visible(page, '.jump-dot', 20_000)
    await page.screenshot({ path: join(WAVE1_SHOTS, 'jump-dot.png') })
    // The button jumps back to the bottom.
    await page.locator('.jump-btn').click()
    await expect
      .poll(() =>
        page.evaluate(
          '(() => { const el = document.querySelector(".chat-scroll"); return el.scrollHeight - el.scrollTop - el.clientHeight })()'
        )
      )
      .toBeLessThan(120)
    await waitForSettled()
    // ⌘↑ / ⌘↓ jump to top/bottom while the composer is empty.
    await page.keyboard.press('Meta+ArrowUp')
    await expect
      .poll(() =>
        page.evaluate('document.querySelector(".chat-scroll").scrollTop')
      )
      .toBeLessThan(60)
    await page.keyboard.press('Meta+ArrowDown')
    await expect
      .poll(() =>
        page.evaluate(
          '(() => { const el = document.querySelector(".chat-scroll"); return el.scrollHeight - el.scrollTop - el.clientHeight })()'
        )
      )
      .toBeLessThan(120)
  })

  it('shows the context ring and usage popover', async () => {
    await visible(page, '.ctx-ring', 15_000)
    expect(await page.locator('.ctx-ring').getAttribute('aria-label')).toBe(
      '78% of context used'
    )
    await page.locator('.ctx-ring').click()
    await visible(page, '.ctx-popover')
    expect(await page.locator('.ctx-popover-strong').textContent()).toBe(
      '156.6k / 200k (78%)'
    )
    const popover = await page.locator('.ctx-popover').textContent()
    expect(popover).toContain('Session cost')
    expect(popover).toContain('Input')
    expect(popover).toContain('Output')
    await visible(page, '.ctx-compact')
    // Let the popover animation settle before shooting.
    await page.waitForTimeout(350)
    await page.screenshot({ path: join(WAVE1_SHOTS, 'ctx-popover.png') })
    await setTheme('light')
    await page.screenshot({ path: join(WAVE1_SHOTS, 'ctx-popover-light.png') })
    await setTheme('dark')
    await page.keyboard.press('Escape')
    // Composer close-ups at ~40% (muted) and ~80% (warning): the fake pi
    // honours a `ctxNN` percent hint in the prompt.
    await page.locator('.composer-input').fill('ctx40 please')
    await page.keyboard.press('Enter')
    await waitForSettled()
    await expect
      .poll(() => page.locator('.ctx-ring').getAttribute('aria-label'), {
        timeout: 10_000
      })
      .toBe('40% of context used')
    await page.locator('.composer').screenshot({
      path: join(WAVE1_SHOTS, 'ctx-ring-40.png')
    })
    await page.locator('.composer-input').fill('ctx80 please')
    await page.keyboard.press('Enter')
    await waitForSettled()
    await expect
      .poll(() => page.locator('.ctx-ring').getAttribute('aria-label'), {
        timeout: 10_000
      })
      .toBe('80% of context used')
    await page.locator('.composer').screenshot({
      path: join(WAVE1_SHOTS, 'ctx-ring-80.png')
    })
  })

  it('retries the last assistant reply via fork on a saved session', async () => {
    // Any saved session works — the expanded projects cap at 3 rows and the
    // order of same-day seeds isn't stable, so take the first visible one.
    const row = page.locator('.sidebar-session').first()
    await row.waitFor({ state: 'visible', timeout: 10_000 })
    await row.click()
    await visible(page, '.msg-assistant')
    const userText = (await page.locator('.msg-user-row').first().textContent())!
    await page.locator('.msg-assistant').last().hover()
    await visible(
      page,
      '.msg-assistant .msg-actions button[title="Retry"]',
      10_000
    )
    await page.screenshot({ path: join(WAVE1_SHOTS, 'msg-actions-retry.png') })
    await page
      .locator('.msg-assistant .msg-actions button[title="Retry"]')
      .last()
      .click()
    // Fork resends the preceding user message's own text.
    await expect
      .poll(() => page.locator('.msg-user-row').count(), { timeout: 15_000 })
      .toBe(2)
    expect(await page.locator('.msg-user-row').last().textContent()).toContain(
      userText.trim().replace(/[\d: ]+$/, '').slice(0, 30)
    )
    await waitForSettled()
    // Back home for the settings test.
    await page.keyboard.press('Meta+n')
    await visible(page, '.home-greeting')
  })

  it('shows the notifications toggle in General settings', async () => {
    await page.locator('.sidebar-footer .icon-btn').last().click()
    await visible(page, '.settings-modal')
    await page.locator('.settings-nav-item', { hasText: 'General' }).click()
    const row = page.locator('.settings-row', { hasText: 'Notify when pi' })
    await visible(page, '.settings-row:has-text("Notify when pi")')
    // The switch defaults on.
    expect(await row.locator('.switch').getAttribute('aria-checked')).toBe('true')
    await page.screenshot({ path: join(WAVE1_SHOTS, 'settings-notifications.png') })
    await page.keyboard.press('Escape')
    await page.waitForSelector('.settings-modal', { state: 'detached', timeout: 5_000 })
  })

  // --- Wave 2: sessions organization ----------------------------------------

  /** Absolute paths of the seeded sessions, via the real sessions index IPC. */
  async function sessionPaths(): Promise<string[]> {
    return page.evaluate(
      'window.piDesktop.sessions.list().then(list => list.map(s => s.path))'
    )
  }

  async function setMeta(path: string, patch: string): Promise<void> {
    await page.evaluate(
      `window.piDesktop.sessionMeta.set({ sessionPath: ${JSON.stringify(path)}, patch: ${patch} })`
    )
  }

  it('pins sessions into a Pinned section and hides archived ones', async () => {
    const paths = await sessionPaths()
    const a1 = paths.find((p) => p.endsWith('/a1.jsonl'))!
    const a2 = paths.find((p) => p.endsWith('/a2.jsonl'))!
    const b2 = paths.find((p) => p.endsWith('/b2.jsonl'))!
    await setMeta(a1, '{ pinned: true }')
    await setMeta(a2, '{ pinned: true }')
    await visible(page, '.sidebar-section-header:has-text("Pinned")')
    // Two pinned rows, each carrying the muted project suffix.
    await expect
      .poll(() => page.locator('.sidebar-item-suffix').allTextContents())
      .toEqual(['synthetic-alpha', 'synthetic-alpha'])
    // The pin glyph marks them inside the project list too. Alpha caps at
    // three rows — expand its overflow so both pinned rows are mounted.
    await page
      .locator('.sidebar-item-muted', { hasText: 'Show ' })
      .first()
      .click()
    await expect
      .poll(() => page.locator('.pin-glyph').count())
      .toBeGreaterThanOrEqual(2)
    // Archive an old beta chat: it leaves every section and lands in Archived.
    const rowsBefore = await page.locator('.sidebar-session').count()
    await setMeta(b2, '{ archived: true }')
    await visible(page, '.sidebar-archived')
    await expect
      .poll(() => page.locator('.sidebar-session').count())
      .toBe(rowsBefore - 1)
    expect(await page.locator('.sidebar-archived').textContent()).toContain('Archived')
    // Sidebar search surfaces archived chats with an "Archived" tag.
    await page
      .locator('.sidebar-item', { hasText: 'Search' })
      .first()
      .click()
    await visible(page, '.sidebar-search input')
    await page.locator('.sidebar-search input').fill('Bump dependencies')
    await visible(page, '.sidebar-item-suffix:has-text("Archived")')
    await page.screenshot({ path: join(WAVE2_SHOTS, 'sidebar-archived-search.png') })
    await page.locator('.sidebar-search input').press('Escape')
    await page.waitForSelector('.sidebar-search input', { state: 'detached' })
  })

  it('lists archived chats in a searchable modal and unarchives them', async () => {
    await page.locator('.sidebar-archived').click()
    await visible(page, '.archived-list')
    await visible(page, '.archived-row')
    await page.waitForTimeout(350) // let the modal animation settle
    await page.screenshot({ path: join(WAVE2_SHOTS, 'archived-modal.png') })
    // Search narrows the list.
    await page.locator('.archived-search input').fill('no such chat')
    await expect.poll(() => page.locator('.archived-row').count()).toBe(0)
    await page.locator('.archived-search input').fill('')
    await expect.poll(() => page.locator('.archived-row').count()).toBe(1)
    // Unarchive restores the chat to its project.
    await page.locator('.archived-row .ui-btn', { hasText: 'Unarchive' }).click()
    await expect.poll(() => page.locator('.archived-row').count()).toBe(0)
    await page.keyboard.press('Escape')
    await page.waitForSelector('.archived-list', { state: 'detached' })
    await page.waitForSelector('.sidebar-archived', { state: 'detached' })
  })

  it('opens an archived chat behind a banner without auto-unarchiving', async () => {
    const paths = await sessionPaths()
    const b2 = paths.find((p) => p.endsWith('/b2.jsonl'))!
    await setMeta(b2, '{ archived: true }')
    await page.locator('.sidebar-archived').click()
    await page.locator('.archived-row').first().click()
    await visible(page, '.archived-banner')
    expect(await page.locator('.archived-banner').textContent()).toContain(
      'This chat is archived'
    )
    // Opening did not unarchive — the Archived row is still there.
    await visible(page, '.sidebar-archived')
    await page.screenshot({ path: join(WAVE2_SHOTS, 'archived-banner.png') })
    // Archiving the open chat via the palette navigates home + Undo toast.
    await page.keyboard.press('Meta+k')
    await visible(page, '.palette-input')
    await page.locator('.palette-input').fill('Unarchive chat')
    await page.locator('.palette-row', { hasText: 'Unarchive chat' }).first().click()
    await page.waitForSelector('.archived-banner', { state: 'detached' })
    await page.waitForSelector('.sidebar-archived', { state: 'detached' })
    // Now archive it again through the palette → toast with Undo.
    await page.keyboard.press('Meta+k')
    await visible(page, '.palette-input')
    await page.locator('.palette-input').fill('Archive chat')
    await page.locator('.palette-row', { hasText: 'Archive chat' }).first().click()
    await visible(page, '.toast:has-text("Chat archived")')
    await visible(page, '.home-greeting')
    await page.screenshot({ path: join(WAVE2_SHOTS, 'undo-toast.png') })
    await page.locator('.toast-action', { hasText: 'Undo' }).click()
    await page.waitForSelector('.sidebar-archived', { state: 'detached' })
  })

  it('shows needs-input, streaming, error and unread status dots', async () => {
    const openSession = async (title: string) => {
      const row = page.locator('.sidebar-session', { hasText: title }).first()
      try {
        await row.waitFor({ state: 'attached', timeout: 15_000 })
      } catch {
        // Diagnostic: capture what the sidebar actually showed.
        const sidebar = await page.locator('.sidebar').textContent().catch(() => 'n/a')
        await page.screenshot({ path: join(WAVE2_SHOTS, 'status-dots-fail.png') })
        throw new Error(`session row "${title}" not found; sidebar="${sidebar}"`)
      }
      await row.click()
      await visible(page, '.composer-input')
    }
    const home = async () => {
      await page.keyboard.press('Meta+n')
      await visible(page, '.home-greeting')
    }
    // Error: 'fail please' rejects the prompt response.
    await openSession('Refactor session parser')
    await page.locator('.composer-input').fill('fail please')
    await page.keyboard.press('Enter')
    await visible(
      page,
      '.sidebar-session:has-text("Refactor session parser") .error-dot'
    )
    await home()
    // Unread: a run that settles while another chat is on screen.
    await openSession('Explain the fixture')
    await page.locator('.composer-input').fill('slow reply please')
    await page.keyboard.press('Enter')
    await home()
    await visible(
      page,
      '.sidebar-session:has-text("Explain the fixture") .unread-dot',
      15_000
    )
    // Needs input: 'ask me please' leaves a pending confirm request.
    await openSession('Fix flaky router test')
    await page.locator('.composer-input').fill('ask me please')
    await page.keyboard.press('Enter')
    await visible(page, '.ui-dialog')
    await visible(
      page,
      '.sidebar-session:has-text("Fix flaky router test") .input-dot'
    )
    // Streaming: a fresh 'slow' run while the others keep their dots.
    await openSession('Add retry to fetch client')
    await page.locator('.composer-input').fill('slow reply please')
    await page.keyboard.press('Enter')
    await visible(
      page,
      '.sidebar-session:has-text("Add retry to fetch client") .live-dot'
    )
    // All four states visible at once; the pinned section sits on top.
    await page.screenshot({ path: join(WAVE2_SHOTS, 'sidebar-status.png') })
    await setTheme('light')
    await page.screenshot({ path: join(WAVE2_SHOTS, 'sidebar-status-light.png') })
    await setTheme('dark')
    // Clean up: answer the pending request and let runs settle.
    await openSession('Fix flaky router test')
    await page.locator('.ui-dialog .ui-btn-primary').click()
    await page.waitForSelector('.ui-dialog', { state: 'detached', timeout: 10_000 })
    await home()
    await page.waitForTimeout(3500)
  })

  // --- Wave 3: composer power -----------------------------------------------

  it('completes @file mentions inside a project chat', async () => {
    // New chat, then attach it to the synthetic-repo project.
    await page.keyboard.press('Meta+n')
    await visible(page, '.composer-input')
    await page.locator('.folder-chip').click()
    await visible(page, '.folder-popover')
    await page.locator('.folder-row', { hasText: 'synthetic-repo' }).click()
    await expect
      .poll(() => page.locator('.folder-chip').textContent())
      .toContain('synthetic-repo')
    // '@' opens the mention popover over the real repo file list.
    await page.locator('.composer-input').fill('look at @not')
    await visible(page, '.mention-popover')
    await expect
      .poll(() => page.locator('.mention-row').allTextContents())
      .toEqual(expect.arrayContaining([expect.stringContaining('notes.txt')]))
    await page.screenshot({ path: join(WAVE2_SHOTS, 'mention-popover.png') })
    await page.keyboard.press('Enter')
    await expect
      .poll(() => page.locator('.composer-input').inputValue())
      .toBe('look at @notes.txt ')
    // Escape path: another mention then dismiss.
    await page.locator('.composer-input').fill('@x')
    await visible(page, '.mention-popover')
    await page.keyboard.press('Escape')
    await page.waitForSelector('.mention-popover', { state: 'detached' })
    await page.locator('.composer-input').fill('')
  })

  it('attaches files via the plus menu and renders @path chips in the bubble', async () => {
    const plusBtn = page.locator('button[title="Add files and more"]')
    await plusBtn.click()
    await visible(page, '.plus-popover')
    await page
      .locator('.plus-popover .folder-row', { hasText: 'Add photos & files' })
      .click()
    // The stubbed dialog returns 'attach me.txt' inside the repo cwd.
    await visible(page, '.file-chip')
    expect(await page.locator('.file-chip-name').textContent()).toBe('attach me.txt')
    await page.screenshot({ path: join(WAVE2_SHOTS, 'file-chips-composer.png') })
    await page.locator('.composer-input').fill('check this file')
    await page.keyboard.press('Enter')
    await waitForSettled()
    // The bubble carries an inline chip for the quoted relative path.
    const chip = page.locator('.msg-path-chip').last()
    await visible(page, '.msg-path-chip')
    expect(await chip.textContent()).toContain('attach me.txt')
    expect(await chip.getAttribute('title')).toBe('attach me.txt')
    await chip.scrollIntoViewIfNeeded()
    await page.waitForTimeout(300)
    await page.screenshot({ path: join(WAVE2_SHOTS, 'msg-file-chips.png') })
    // No chip for a plain @name mention.
    await page.locator('.composer-input').fill('thanks @reviewer')
    await page.keyboard.press('Enter')
    await waitForSettled()
    const lastUser = page.locator('.msg-user-row').last()
    expect(await lastUser.locator('.msg-path-chip').count()).toBe(0)
  })
})
