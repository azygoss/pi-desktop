// Wave 4 e2e: first-run onboarding, update check and dictation, each against
// its own Electron launch with synthetic fixtures only.
//
//   PI_FAKE_NO_MODELS=1      fake pi reports an empty model catalog
//   PI_FAKE_PI_DIE=1         fake pi exits immediately (runtime failure)
//   PI_DESKTOP_DICTATION_HELPER  fake dictation helper (fake-dictation.mjs)
//   PI_DESKTOP_UPDATE_URL    release-check endpoint override (local server)

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron as electron, type ElectronApplication, type Page } from 'playwright-core'
import { afterAll, describe, expect, it } from 'vitest'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..')
const FAKE_PI = join(ROOT, 'test/fixtures/fake-pi.mjs')
const FAKE_DICTATION = join(ROOT, 'src/main/dictation/__fixtures__/fake-dictation.mjs')
const SHOTS = '/tmp/pi-wave4'

interface Ctx {
  app: ElectronApplication
  page: Page
  dirs: string[]
}

async function launch(extraEnv: Record<string, string> = {}): Promise<Ctx> {
  const agentDir = await mkdtemp(join(tmpdir(), 'pi-desktop-w4-agent-'))
  const userDataDir = await mkdtemp(join(tmpdir(), 'pi-desktop-w4-ud-'))
  // Synthetic display name so greeting/footer never show a real user name.
  await writeFile(
    join(userDataDir, 'settings.json'),
    JSON.stringify({ displayName: 'Alex' })
  )
  // Empty sessions dir — a genuine first run.
  const dictHelper = join(agentDir, 'fake-dictation.sh')
  await writeFile(
    dictHelper,
    `#!/bin/sh\nexec "${process.execPath}" "${FAKE_DICTATION}"\n`,
    { mode: 0o755 }
  )
  const env = { ...process.env }
  delete env['ELECTRON_RUN_AS_NODE']
  const app = await electron.launch({
    args: [join(ROOT, 'out/main/index.js')],
    env: {
      ...env,
      PI_DESKTOP_PI_COMMAND: FAKE_PI,
      PI_DESKTOP_DICTATION_HELPER: dictHelper,
      PI_DESKTOP_E2E: '1',
      PI_CODING_AGENT_DIR: agentDir,
      PI_CODING_AGENT_SESSION_DIR: join(agentDir, 'sessions'),
      PI_DESKTOP_USER_DATA_DIR: userDataDir,
      PI_DESKTOP_APP_VERSION: '0.3.0',
      NODE_ENV: 'production',
      ...extraEnv
    }
  })
  const page = await app.firstWindow()
  return { app, page, dirs: [agentDir, userDataDir] }
}

async function close(ctx: Ctx): Promise<void> {
  await ctx.app?.close().catch(() => {})
  for (const d of ctx.dirs) {
    await rm(d, { recursive: true, force: true })
  }
}

async function shot(page: Page, name: string): Promise<void> {
  await page.screenshot({ path: join(SHOTS, name) })
}

async function visible(page: Page, selector: string, timeout = 15_000): Promise<void> {
  await page.waitForSelector(selector, { state: 'visible', timeout })
}

/** Poll a locator's text until it matches or the deadline passes. */
async function waitForText(
  page: Page,
  selector: string,
  re: RegExp,
  timeout = 15_000
): Promise<void> {
  const deadline = Date.now() + timeout
  for (;;) {
    const text = (await page.locator(selector).first().textContent()) ?? ''
    if (re.test(text)) {
      return
    }
    if (Date.now() > deadline) {
      throw new Error(`"${selector}" did not show ${re} within ${timeout}ms; got "${text}"`)
    }
    await page.waitForTimeout(250)
  }
}

async function openSettings(page: Page): Promise<void> {
  await page.locator('.sidebar-footer .icon-btn').last().click()
  await visible(page, '.settings-modal')
}

async function closeSettings(page: Page): Promise<void> {
  await page.locator('.settings-close').click()
  await page.waitForSelector('.settings-modal', { state: 'detached', timeout: 5_000 })
}

describe('wave 4: update check + dictation + welcome checklist', () => {
  let ctx: Ctx | null = null
  let server: Server | null = null

  afterAll(async () => {
    if (ctx) {
      await close(ctx)
    }
    server?.close()
  })

  it('serves the synthetic release manifest', async () => {
    server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(
        JSON.stringify({
          tag_name: 'v9.9.9',
          html_url: 'https://github.com/azygoss/pi-desktop/releases/tag/v9.9.9'
        })
      )
    })
    await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r))
    const updateUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}/latest`
    ctx = await launch({ PI_DESKTOP_UPDATE_URL: updateUrl })
    await ctx.page.waitForSelector('.composer-input', { state: 'visible', timeout: 30_000 })
    expect(ctx.page).toBeTruthy()
  }, 60_000)

  it('shows the first-run welcome checklist and dismisses it', async () => {
    const page = ctx!.page
    await visible(page, '[data-testid="onboarding-card"]')
    const card = page.locator('[data-testid="onboarding-card"]')
    const text = await card.textContent()
    expect(text).toContain('Getting started')
    expect(text).toContain('Pi runtime')
    expect(text).toContain('Models')
    expect(text).toContain('Computer use')
    expect(text).toMatch(/Optional · Grant|granted|not available/)
    await shot(page, 'welcome-checklist.png')
    await card.getByRole('button', { name: 'Done' }).click()
    await page.waitForSelector('[data-testid="onboarding-card"]', {
      state: 'detached',
      timeout: 5_000
    })
  })

  it('shows the update pill after Check now and dismisses it', async () => {
    const page = ctx!.page
    await openSettings(page)
    try {
      await page.locator('[data-testid="settings-update-row"] .ui-btn').click()
      await waitForText(
        page,
        '[data-testid="settings-update-row"] .settings-hint',
        /Update available/
      )
      await shot(page, 'settings-updates.png')
    } finally {
      await closeSettings(page)
    }
    await visible(page, '[data-testid="update-pill"]')
    const pillText = await page.locator('[data-testid="update-pill"]').textContent()
    expect(pillText).toContain('Update 9.9.9')
    await shot(page, 'update-pill.png')
    await page.locator('[data-testid="update-pill"] .update-pill-dismiss').click()
    await page.waitForSelector('[data-testid="update-pill"]', {
      state: 'detached',
      timeout: 5_000
    })
  })

  it('dictates: mic records, shows a ghost partial and commits the final', async () => {
    const page = ctx!.page
    await visible(page, '.mic-btn')
    const input = page.locator('.composer-input')
    const mic = page.locator('.mic-btn')
    await page.locator('.composer').screenshot({ path: join(SHOTS, 'mic-idle.png') })
    await mic.click()
    await page.waitForSelector('.mic-btn.is-recording', { timeout: 5_000 })
    // Fake helper streams partials; the last stays as ghost text.
    await waitForText(page, '.composer-ghost .ghost-text', /hello/, 5_000)
    await page.locator('.composer').screenshot({ path: join(SHOTS, 'dictation-ghost.png') })
    await shot(page, 'dictation-recording.png')
    // Stop → the final transcript commits at the caret.
    await mic.click()
    await page.waitForFunction(
      () =>
        (document.querySelector('.composer-input') as HTMLTextAreaElement)?.value ===
        'hello pi desktop',
      undefined,
      { timeout: 5_000 }
    )
    // Ghost after existing text: partial lands after the caret.
    await input.fill('fix the ')
    await mic.click()
    await waitForText(page, '.composer-ghost .ghost-text', /hello/, 5_000)
    await page
      .locator('.composer')
      .screenshot({ path: join(SHOTS, 'dictation-ghost-with-text.png') })
    await mic.click()
    await page.waitForFunction(
      () =>
        (document.querySelector('.composer-input') as HTMLTextAreaElement)?.value ===
        'fix the hello pi desktop',
      undefined,
      { timeout: 5_000 }
    )
    // Wrapped case: long text puts the ghost on the second line.
    await input.fill(
      'this is a fairly long first line of text that should definitely wrap onto a second line '
    )
    await mic.click()
    await waitForText(page, '.composer-ghost .ghost-text', /hello/, 5_000)
    await page
      .locator('.composer')
      .screenshot({ path: join(SHOTS, 'dictation-ghost-wrapped.png') })
    await mic.click()
    await page.waitForFunction(
      () =>
        (document.querySelector('.composer-input') as HTMLTextAreaElement)?.value.endsWith(
          'hello pi desktop'
        ),
      undefined,
      { timeout: 5_000 }
    )
    await input.fill('')
  })

  it('esc cancels a dictation partial without committing', async () => {
    const page = ctx!.page
    const input = page.locator('.composer-input')
    await input.fill('draft ')
    const mic = page.locator('.mic-btn')
    await mic.click()
    await waitForText(page, '.composer-ghost .ghost-text', /hello/, 5_000)
    await input.press('Escape')
    await page.waitForSelector('.composer-ghost', { state: 'detached', timeout: 5_000 })
    // Small wait to be sure no late final lands.
    await page.waitForTimeout(300)
    expect(await input.evaluate((el) => (el as HTMLTextAreaElement).value)).toBe('draft ')
  })

  it('shows the dictation locale row in General settings', async () => {
    const page = ctx!.page
    await openSettings(page)
    await visible(page, '[data-testid="settings-dictation-row"]')
    try {
      const options = await page
        .locator('[data-testid="settings-dictation-row"] select option')
        .allTextContents()
      expect(options).toContain('en-US')
      expect(options).toContain('tr-TR')
      await shot(page, 'settings-dictation.png')
    } finally {
      await closeSettings(page)
    }
  })
})

describe('wave 4: no models onboarding', () => {
  it('shows the connect-a-provider card with a refresh path', async () => {
    const ctx = await launch({ PI_FAKE_NO_MODELS: '1' })
    try {
      const page = ctx.page
      await visible(page, '[data-testid="no-models-card"]', 30_000)
      const card = page.locator('[data-testid="no-models-card"]')
      const text = await card.textContent()
      expect(text).toContain('Connect a model provider')
      await visible(page, '[data-testid="no-models-card"] button')
      const buttons = await card.locator('button').allTextContents()
      expect(buttons.join(' ')).toContain('Log in with pi')
      expect(buttons.join(' ')).toContain('Add an API key')
      expect(buttons.join(' ')).toContain('Refresh')
      const runtime = await card.locator('.runtime-line').textContent()
      expect(runtime).toContain('pi')
      await shot(page, 'no-models-card.png')
    } finally {
      await close(ctx)
    }
  }, 60_000)
})

describe('wave 4: pi runtime failure', () => {
  it('shows the error card with details and retry', async () => {
    const ctx = await launch({ PI_FAKE_PI_DIE: '1' })
    try {
      const page = ctx.page
      await visible(page, '[data-testid="runtime-error-card"]', 30_000)
      const card = page.locator('[data-testid="runtime-error-card"]')
      const buttons = await card.locator('button').allTextContents()
      expect(buttons.join(' ')).toContain('Retry')
      expect(buttons.join(' ')).toContain('Settings → Pi Runtime')
      await shot(page, 'runtime-error-card.png')
    } finally {
      await close(ctx)
    }
  }, 60_000)
})
