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
const SHOTS = process.env['PI_DESKTOP_SHOT_DIR'] ?? '/tmp/pi-desktop-shots'

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
    { cwd: PROJECT_B, id: 'b2', created: daysAgo(40), text: 'Bump dependencies' }
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
        PI_CODING_AGENT_DIR: agentDir,
        PI_CODING_AGENT_SESSION_DIR: join(agentDir, 'sessions'),
        PI_DESKTOP_USER_DATA_DIR: userDataDir,
        NODE_ENV: 'production'
      }
    })
    page = await app.firstWindow()
    await visible(page, '.composer-input', 30_000)
  }, 60_000)

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
    // Force dark regardless of the host's system appearance.
    await page.evaluate("document.documentElement.dataset.theme = 'dark'")
    await page.waitForTimeout(300)
    await visible(page, '.home-greeting h1')
    const greeting = await page.locator('.home-greeting h1').textContent()
    expect(greeting).toMatch(/Good|mind/)
    // sidebar nests seeded chats under their projects (4 + 2), plus a
    // synthetic user-added project with no chats at all.
    await visible(page, '.sidebar-project')
    expect(await page.locator('.sidebar-project').count()).toBe(4)
    expect(await page.locator('.sidebar-session').count()).toBe(6)
    expect(await page.locator('.sidebar-empty-nested').first().textContent()).toBe('No chats')
    await page.screenshot({ path: join(SHOTS, 'home-dark.png') })
  })

  it('shows the home screen in light theme', async () => {
    await page.evaluate("document.documentElement.dataset.theme = 'light'")
    await page.waitForTimeout(300)
    await page.screenshot({ path: join(SHOTS, 'home-light.png') })
    await page.evaluate("document.documentElement.dataset.theme = 'dark'")
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
    await visible(
      page,
      '.right-panel .panel-tab-label:text-is("E2E Test Page")',
      20_000
    )
    // Screenshot tool returned a real JPEG; expanding the card shows it.
    const shotCard = page.locator('.tool-card', { hasText: 'browser_screenshot' })
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
    await visible(page, '.newtab-tools')
    await page.locator('.newtab-tools .folder-row', { hasText: 'Terminal' }).click()
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
    await visible(page, '.panel-tab-content.is-active .newtab-address input')
    await page.locator('.panel-tab-content.is-active .newtab-address input').fill(pageUrl)
    await page.keyboard.press('Enter')
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
      .locator('.panel-tab-content.is-active .newtab-tools .folder-row', { hasText: 'Diff' })
      .click()
    await visible(page, '.panel-tab-content.is-active .diff-panel')
    await visible(page, '.panel-tab-content.is-active .diff-file', 10_000)
    const paths = await page.locator('.panel-tab-content.is-active .diff-file-path').allTextContents()
    expect(paths).toContain('notes.txt')
    expect(paths).toContain('new-file.txt')
    await page.screenshot({ path: join(SHOTS, 'panel-diff.png') })
  })
})
