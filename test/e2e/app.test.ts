// End-to-end smoke test for Pi Desktop using Playwright's Electron driver.
// Launches the built app (out/main/index.js) against the synthetic fake pi
// fixture and a synthetic PI_CODING_AGENT_DIR. No real pi processes or real
// user data are involved.

import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
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
  for (const s of sessions) {
    const dirName = sessionDirName(s.cwd)
    await mkdir(join(sessionsDir, dirName), { recursive: true })
    const lines = makeSession(s.id, s.cwd, s.created, s.text)
    await writeFile(
      join(sessionsDir, dirName, `${s.id}.jsonl`),
      lines.map((l) => JSON.stringify(l)).join('\n') + '\n'
    )
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
    // becomes a steer and races the next test's pending-shimmer state.
    await expect
      .poll(async () => {
        const stats = await page.locator('.chat-stats').allTextContents()
        return !stats.some((t) => t.includes('Enter to steer'))
      })
      .toBe(true)
  })

  it('shows the thinking shimmer while a reply starts', async () => {
    // "slow" makes the fake pi pause 2.5s before its first delta, so the
    // pending shimmer row is on screen long enough to capture.
    await page.locator('.composer-input').fill('slow reply please')
    await page.keyboard.press('Enter')
    await visible(page, '.msg-pending .shimmer-text')
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
    expect(await group.locator('.tool-name').textContent()).toContain('Ran 2 tools')
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
    expect(labels.some((l) => l.includes('Add photos & images'))).toBe(true)
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
})
