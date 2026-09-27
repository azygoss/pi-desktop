// End-to-end smoke test for Pi Desktop using Playwright's Electron driver.
// Launches the built app (out/main/index.js) against the synthetic fake pi
// fixture and a synthetic PI_CODING_AGENT_DIR. No real pi processes or real
// user data are involved.

import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
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

describe('Pi Desktop e2e', () => {
  let app: ElectronApplication
  let page: Page
  let agentDir: string

  beforeAll(async () => {
    agentDir = await mkdtemp(join(tmpdir(), 'pi-desktop-e2e-'))
    await seedAgentDir(agentDir)
    await mkdir(SHOTS, { recursive: true })

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
        NODE_ENV: 'production'
      }
    })
    page = await app.firstWindow()
    await visible(page, '.composer-input', 30_000)
  }, 60_000)

  afterAll(async () => {
    await app?.close()
    if (agentDir) {
      await rm(agentDir, { recursive: true, force: true })
    }
  })

  it('shows the home screen with greeting and composer (dark)', async () => {
    // Force dark regardless of the host's system appearance.
    await page.evaluate("document.documentElement.dataset.theme = 'dark'")
    await page.waitForTimeout(300)
    await visible(page, '.home-greeting h1')
    const greeting = await page.locator('.home-greeting h1').textContent()
    expect(greeting).toMatch(/Good|mind/)
    // sidebar lists seeded chats grouped by project
    await visible(page, '.sidebar-session')
    expect(await page.locator('.sidebar-session').count()).toBe(6)
    await page.screenshot({ path: join(SHOTS, 'home-dark.png') })
  })

  it('shows the home screen in light theme', async () => {
    await page.evaluate("document.documentElement.dataset.theme = 'light'")
    await page.waitForTimeout(300)
    await page.screenshot({ path: join(SHOTS, 'home-light.png') })
    await page.evaluate("document.documentElement.dataset.theme = 'dark'")
  })

  it('opens the model picker', async () => {
    // The home draft chat provides models via the fake pi.
    await visible(page, '[data-testid="model-picker-trigger"]')
    await page.locator('[data-testid="model-picker-trigger"]').click()
    await visible(page, '[data-testid="model-popover"]')
    await visible(page, '.model-row')
    await page.screenshot({ path: join(SHOTS, 'model-picker.png') })
    await page.keyboard.press('Escape')
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

  it('collapses the sidebar', async () => {
    await page.keyboard.press('Meta+b')
    await page.waitForSelector('.sidebar', { state: 'hidden', timeout: 5_000 })
    // nav buttons move into the main pane's top strip
    await visible(page, '.main-topbar .nav-buttons', 5_000)
    await page.screenshot({ path: join(SHOTS, 'sidebar-collapsed.png') })
  })
})
