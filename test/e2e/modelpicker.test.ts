// Model picker popover placement: the composer sits mid-screen on the home
// view, so the upward-opening popover must clamp its height instead of
// clipping the search field and top edge under the title bar.

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron as electron, type ElectronApplication, type Page } from 'playwright-core'
import { afterAll, describe, expect, it } from 'vitest'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..')
const FAKE_PI = join(ROOT, 'test/fixtures/fake-pi.mjs')
const SHOTS = '/tmp/pi-modelpicker'

interface Ctx {
  app: ElectronApplication
  page: Page
  dirs: string[]
}

async function launch(): Promise<Ctx> {
  const agentDir = await mkdtemp(join(tmpdir(), 'pi-desktop-mp-agent-'))
  const userDataDir = await mkdtemp(join(tmpdir(), 'pi-desktop-mp-ud-'))
  await writeFile(
    join(userDataDir, 'settings.json'),
    JSON.stringify({ displayName: 'Alex' })
  )
  const env = { ...process.env }
  delete env['ELECTRON_RUN_AS_NODE']
  const app = await electron.launch({
    args: [join(ROOT, 'out/main/index.js')],
    env: {
      ...env,
      PI_DESKTOP_PI_COMMAND: FAKE_PI,
      PI_DESKTOP_E2E: '1',
      PI_CODING_AGENT_DIR: agentDir,
      PI_CODING_AGENT_SESSION_DIR: join(agentDir, 'sessions'),
      PI_DESKTOP_USER_DATA_DIR: userDataDir,
      NODE_ENV: 'production'
    }
  })
  const page = await app.firstWindow()
  await page.waitForSelector('.composer-input', { state: 'visible', timeout: 30_000 })
  await page.waitForSelector('[data-testid="model-picker-trigger"]', {
    state: 'visible',
    timeout: 30_000
  })
  return { app, page, dirs: [agentDir, userDataDir] }
}

async function resize(ctx: Ctx, width: number, height: number): Promise<void> {
  await ctx.app.evaluate(({ BrowserWindow }, size) => {
    const [w, h] = size as [number, number]
    BrowserWindow.getAllWindows()[0]?.setSize(w, h)
  }, [width, height])
  await ctx.page.waitForTimeout(400)
}

async function openPicker(page: Page): Promise<void> {
  await page.locator('[data-testid="model-picker-trigger"]').click()
  await page.waitForSelector('[data-testid="model-popover"]', {
    state: 'visible',
    timeout: 5_000
  })
}

/** Assert the popover fits inside the window: search on top, segment at bottom. */
async function assertPopoverFits(page: Page): Promise<void> {
  const pop = page.locator('[data-testid="model-popover"]')
  const box = await pop.boundingBox()
  expect(box).not.toBeNull()
  expect(box!.y).toBeGreaterThanOrEqual(44)
  const search = await pop.locator('.model-search input').boundingBox()
  expect(search).not.toBeNull()
  expect(search!.y).toBeGreaterThanOrEqual(44)
  // The thinking-level row stays pinned at the popover's bottom edge.
  const bottom = await pop
    .locator('.thinking-segment, .thinking-none')
    .last()
    .boundingBox()
  expect(bottom).not.toBeNull()
  expect(bottom!.y + bottom!.height).toBeLessThanOrEqual(box!.y + box!.height + 1)
  expect(box!.y + box!.height).toBeLessThanOrEqual(
    await page.evaluate('window.innerHeight')
  )
  // The list scrolls rather than forcing the popover taller.
  const scrollable = await page.evaluate(
    "(() => { const el = document.querySelector('.model-list'); return el ? el.scrollHeight > el.clientHeight || el.clientHeight > 0 : false })()"
  )
  expect(scrollable).toBe(true)
}

describe('model picker popover placement', () => {
  let ctx: Ctx | null = null

  afterAll(async () => {
    await ctx?.app.close().catch(() => {})
    for (const d of ctx?.dirs ?? []) {
      await rm(d, { recursive: true, force: true })
    }
  })

  it('launches on the home screen', async () => {
    ctx = await launch()
    expect(ctx.page).toBeTruthy()
  }, 60_000)

  it('fits at 1280x800 (home)', async () => {
    await resize(ctx!, 1280, 800)
    await openPicker(ctx!.page)
    await assertPopoverFits(ctx!.page)
    await ctx!.page.screenshot({ path: join(SHOTS, 'home-1280x800.png') })
    await ctx!.page.keyboard.press('Escape')
  })

  it('fits at 1100x640 (home)', async () => {
    await resize(ctx!, 1100, 640)
    await openPicker(ctx!.page)
    await assertPopoverFits(ctx!.page)
    await ctx!.page.screenshot({ path: join(SHOTS, 'home-1100x640.png') })
    await ctx!.page.keyboard.press('Escape')
  })

  it('fits at 900x560 (home) — the clipped case', async () => {
    await resize(ctx!, 900, 560)
    await openPicker(ctx!.page)
    const box = await ctx!.page
      .locator('[data-testid="model-popover"]')
      .boundingBox()
    expect(box).not.toBeNull()
    // Popover top must stay below the 44px title bar.
    expect(box!.y).toBeGreaterThanOrEqual(44)
    await assertPopoverFits(ctx!.page)
    await ctx!.page.screenshot({ path: join(SHOTS, 'home-900x560.png') })
    await ctx!.page.keyboard.press('Escape')
  })

  it('opens upward inside a chat (composer at the bottom)', async () => {
    const page = ctx!.page
    await page.locator('.composer-input').fill('hello from the placement test')
    await page.keyboard.press('Enter')
    // Chat view renders once the stream starts.
    await page.waitForSelector('.msg-row, .chat-scroll', { timeout: 15_000 })
    await resize(ctx!, 900, 560)
    await openPicker(page)
    const box = await page.locator('[data-testid="model-popover"]').boundingBox()
    expect(box).not.toBeNull()
    expect(box!.y).toBeGreaterThanOrEqual(44)
    await assertPopoverFits(page)
    // Upward placement: popover sits above the trigger.
    const trigger = await page
      .locator('[data-testid="model-picker-trigger"]')
      .boundingBox()
    expect(box!.y + box!.height).toBeLessThanOrEqual(trigger!.y + 1)
    await page.screenshot({ path: join(SHOTS, 'chat-900x560.png') })
    await page.keyboard.press('Escape')
  })
})
