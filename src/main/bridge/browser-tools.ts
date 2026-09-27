import type { Debugger, WebContents } from 'electron'

import type { BrowserManager } from '../browser/browser-manager'
import { isAllowedBrowserUrl, normalizeBrowserUrl } from '../../shared/browser-url'

const NAV_TIMEOUT_MS = 30_000
const EVAL_TIMEOUT_MS = 10_000
const VISIBLE_WAIT_MS = 4_000
const SNAPSHOT_MAX_CHARS = 12_000
const EVAL_MAX_CHARS = 8_000
const CONSOLE_BUFFER_MAX = 200
const WAIT_POLL_MS = 250
const WAIT_DEFAULT_TIMEOUT_MS = 15_000
const WAIT_MAX_MS = 60_000
const SCREENSHOT_MAX_WIDTH = 1280

/** Roles worth assigning a stable ref to (clickable/typeable elements). */
const INTERACTIVE_ROLES = new Set([
  'button',
  'link',
  'textbox',
  'searchbox',
  'checkbox',
  'radio',
  'radiobutton',
  'combobox',
  'listbox',
  'option',
  'menuitem',
  'menuitemcheckbox',
  'menuitemradio',
  'tab',
  'switch',
  'slider',
  'spinbutton',
  'treeitem'
])

interface AxNode {
  nodeId: string
  parentId?: string
  ignored?: boolean
  role?: { value?: string }
  name?: { value?: string }
  value?: { value?: unknown }
  backendDOMNodeId?: number
  childIds?: string[]
  properties?: { name: string; value: { value?: unknown } }[]
}

interface ConsoleEntry {
  kind: string
  text: string
}

interface CdpSession {
  webContents: WebContents
  consoleBuffer: ConsoleEntry[]
  requestUrls: Map<number, string>
  listenerAttached: boolean
}

const KEY_DEFS: Record<string, { key: string; code: string; vk: number; text?: string }> = {
  enter: { key: 'Enter', code: 'Enter', vk: 13, text: '\r' },
  tab: { key: 'Tab', code: 'Tab', vk: 9 },
  escape: { key: 'Escape', code: 'Escape', vk: 27 },
  backspace: { key: 'Backspace', code: 'Backspace', vk: 8 },
  delete: { key: 'Delete', code: 'Delete', vk: 46 },
  arrowup: { key: 'ArrowUp', code: 'ArrowUp', vk: 38 },
  arrowdown: { key: 'ArrowDown', code: 'ArrowDown', vk: 40 },
  arrowleft: { key: 'ArrowLeft', code: 'ArrowLeft', vk: 37 },
  arrowright: { key: 'ArrowRight', code: 'ArrowRight', vk: 39 },
  home: { key: 'Home', code: 'Home', vk: 36 },
  end: { key: 'End', code: 'End', vk: 35 },
  pageup: { key: 'PageUp', code: 'PageUp', vk: 33 },
  pagedown: { key: 'PageDown', code: 'PageDown', vk: 34 },
  ' ': { key: ' ', code: 'Space', vk: 32, text: ' ' }
}

function keyDef(name: string): { key: string; code: string; vk: number; text?: string } | null {
  const normalized = name.trim().toLowerCase()
  if (normalized === 'space') {
    return KEY_DEFS[' ']!
  }
  if (KEY_DEFS[normalized]) {
    return KEY_DEFS[normalized]!
  }
  if (name.length === 1) {
    return {
      key: name,
      code: name.match(/[a-z]/i) ? `Key${name.toUpperCase()}` : '',
      vk: name.toUpperCase().charCodeAt(0),
      text: name
    }
  }
  return null
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}\n… (truncated, ${text.length} chars total)` : text
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms))
}

/**
 * Implements the pi extension's browser_* tools over the in-app browser's
 * WebContentsView debugger (CDP 1.3). Each chat owns one "agent" tab; tool
 * calls create/focus it (renderer is notified so the panel opens) and the
 * debugger attaches lazily.
 */
export class BrowserToolBridge {
  /** ref → backendDOMNodeId, valid until the next navigation or snapshot. */
  private readonly refs = new Map<string, Map<string, number>>()
  private readonly sessions = new Map<string, CdpSession>()

  constructor(
    private readonly browser: BrowserManager,
    private readonly notifyAgentTab: (id: string, chatId: string, action: 'open' | 'close') => void
  ) {}

  agentTabId(chatId: string): string {
    return `agent-${chatId}`
  }

  async call(chatId: string, tool: string, params: Record<string, unknown>): Promise<unknown> {
    switch (tool) {
      case 'browser_open':
        return this.open(chatId, params)
      case 'browser_tabs':
        return this.tabs(chatId)
      case 'browser_close':
        return this.close(chatId)
      case 'browser_snapshot':
        return this.snapshot(chatId)
      case 'browser_click':
        return this.click(chatId, params)
      case 'browser_type':
        return this.type(chatId, params)
      case 'browser_press':
        return this.press(chatId, params)
      case 'browser_scroll':
        return this.scroll(chatId, params)
      case 'browser_screenshot':
        return this.screenshot(chatId, params)
      case 'browser_evaluate':
        return this.evaluate(chatId, params)
      case 'browser_console':
        return this.console(chatId)
      case 'browser_wait':
        return this.wait(chatId, params)
      default:
        throw new Error(`Unknown browser tool: ${tool}`)
    }
  }

  /** Create the chat's agent tab if needed and tell the renderer to show it. */
  private async ensureTab(chatId: string) {
    const id = this.agentTabId(chatId)
    if (!this.browser.has(id)) {
      this.browser.create(id)
    }
    // Tell the renderer to open the panel and focus this tab — screenshots
    // and clicks only make sense when the view is actually painted.
    this.notifyAgentTab(id, chatId, 'open')
    const deadline = Date.now() + VISIBLE_WAIT_MS
    while (Date.now() < deadline && !this.browser.isVisible(id)) {
      await sleep(50)
    }
    const record = this.browser.getView(id)
    if (!record) {
      throw new Error('Browser tab is not available')
    }
    return { id, webContents: record.webContents }
  }

  private async session(tabId: string): Promise<CdpSession> {
    const view = this.browser.getView(tabId)
    if (!view) {
      this.sessions.delete(tabId)
      throw new Error('Browser tab was closed')
    }
    const wc = view.webContents
    let session = this.sessions.get(tabId)
    if (!session || session.webContents !== wc) {
      session = { webContents: wc, consoleBuffer: [], requestUrls: new Map(), listenerAttached: false }
      this.sessions.set(tabId, session)
    }
    const dbg: Debugger = wc.debugger
    if (!dbg.isAttached()) {
      try {
        dbg.attach('1.3')
      } catch (error) {
        throw new Error(
          `Could not attach debugger: ${error instanceof Error ? error.message : error}`,
          { cause: error }
        )
      }
    }
    if (!session.listenerAttached) {
      session.listenerAttached = true
      this.enableDomains(dbg).catch(() => {})
      dbg.on('detach', () => {
        session.listenerAttached = false
      })
      dbg.on('message', (_e, method, params) => this.onCdpMessage(session!, method, params))
    }
    return session
  }

  private async enableDomains(dbg: Debugger): Promise<void> {
    for (const method of ['Runtime.enable', 'Log.enable', 'Network.enable', 'Page.enable']) {
      try {
        await dbg.sendCommand(method)
      } catch {
        // Domains that the embedded version lacks are skipped; tools degrade.
      }
    }
  }

  private onCdpMessage(session: CdpSession, method: string, params: unknown): void {
    const p = params as Record<string, unknown>
    if (method === 'Runtime.consoleAPICalled') {
      const args = (p['args'] as { value?: unknown; description?: string }[] | undefined) ?? []
      this.pushConsole(session, `console.${String(p['type'])}`, args.map((a) => a.value ?? a.description ?? '').join(' '))
    } else if (method === 'Runtime.exceptionThrown') {
      const detail = p['exceptionDetails'] as
        | { text?: string; exception?: { description?: string } }
        | undefined
      this.pushConsole(session, 'exception', detail?.exception?.description ?? detail?.text ?? 'Uncaught exception')
    } else if (method === 'Log.entryAdded') {
      const entry = p['entry'] as { level?: string; text?: string } | undefined
      if (entry && (entry.level === 'error' || entry.level === 'warning')) {
        this.pushConsole(session, `log.${entry.level}`, entry.text ?? '')
      }
    } else if (method === 'Network.requestWillBeSent') {
      const id = p['requestId'] as number | undefined
      const url = (p['request'] as { url?: string } | undefined)?.url
      if (typeof id === 'number' && typeof url === 'string') {
        if (session.requestUrls.size > 500) {
          session.requestUrls.clear()
        }
        session.requestUrls.set(id, url)
      }
    } else if (method === 'Network.loadingFailed') {
      const id = p['requestId'] as number | undefined
      const url = typeof id === 'number' ? session.requestUrls.get(id) : undefined
      const errorText = typeof p['errorText'] === 'string' ? p['errorText'] : 'failed'
      if (url && !errorText.includes('ERR_ABORTED')) {
        this.pushConsole(session, 'network', `${url} — ${errorText}`)
      }
    }
  }

  private pushConsole(session: CdpSession, kind: string, text: string): void {
    session.consoleBuffer.push({ kind, text: text.slice(0, 2000) })
    if (session.consoleBuffer.length > CONSOLE_BUFFER_MAX) {
      session.consoleBuffer.splice(0, session.consoleBuffer.length - CONSOLE_BUFFER_MAX)
    }
  }

  private async send(
    tabId: string,
    method: string,
    params: Record<string, unknown> = {}
  ): Promise<unknown> {
    const session = await this.session(tabId)
    const dbg = session.webContents.debugger
    try {
      return await dbg.sendCommand(method, params)
    } catch (error) {
      if (!dbg.isAttached()) {
        session.listenerAttached = false
      }
      throw error instanceof Error ? error : new Error(String(error))
    }
  }

  private requireRef(tabId: string, params: Record<string, unknown>): number {
    const ref = typeof params['ref'] === 'string' ? params['ref'] : ''
    const nodeId = this.refs.get(tabId)?.get(ref)
    if (!nodeId) {
      throw new Error(
        `Unknown element ref "${ref}". Run browser_snapshot to list current refs — they are invalidated by navigation.`
      )
    }
    return nodeId
  }

  // --- tools -----------------------------------------------------------------

  private async open(chatId: string, params: Record<string, unknown>): Promise<unknown> {
    const { id, webContents } = await this.ensureTab(chatId)
    const action = typeof params['action'] === 'string' ? params['action'] : undefined
    const url = typeof params['url'] === 'string' ? params['url'] : undefined

    if (action) {
      const history = webContents.navigationHistory
      if (action === 'back' && history.canGoBack()) {
        history.goBack()
      } else if (action === 'forward' && history.canGoForward()) {
        history.goForward()
      } else if (action === 'reload') {
        webContents.reload()
      } else if (action !== 'reload') {
        throw new Error(`Cannot go ${action} — no such history entry`)
      }
      await this.waitForLoad(webContents)
    } else if (url) {
      const target = normalizeBrowserUrl(url)
      if (!target || !isAllowedBrowserUrl(target)) {
        throw new Error('Only http(s) and localhost URLs are supported')
      }
      // Loading clears snapshot refs.
      this.refs.delete(id)
      const timeout = sleep(NAV_TIMEOUT_MS).then(() => {
        throw new Error(`Timed out loading ${target} after ${NAV_TIMEOUT_MS / 1000}s`)
      })
      await Promise.race([webContents.loadURL(target), timeout])
    } else {
      throw new Error('browser_open needs either url or action')
    }

    const finalUrl = webContents.getURL()
    const title = webContents.getTitle()
    const snapshot = await this.snapshot(chatId).catch(() => null)
    return {
      text:
        `Opened ${finalUrl}\nTitle: ${title}` +
        (snapshot ? `\n\n${(snapshot as { text: string }).text}` : ''),
      details: { url: finalUrl, title }
    }
  }

  private async waitForLoad(webContents: WebContents): Promise<void> {
    if (!webContents.isLoading()) {
      return
    }
    await Promise.race([
      new Promise<void>((resolvePromise) => webContents.once('did-stop-loading', resolvePromise)),
      sleep(NAV_TIMEOUT_MS)
    ])
  }

  private tabs(chatId: string): unknown {
    const agentId = this.agentTabId(chatId)
    const list = this.browser.list()
    const lines = list.map(
      (t) => `${t.id === agentId ? '* ' : '  '}${t.id}: ${t.title || 'New Tab'} — ${t.url || 'about:blank'}`
    )
    return {
      text: list.length ? lines.join('\n') : 'No browser tabs open.',
      details: { tabs: list }
    }
  }

  private async close(chatId: string): Promise<unknown> {
    const id = this.agentTabId(chatId)
    this.refs.delete(id)
    this.sessions.delete(id)
    if (!this.browser.has(id)) {
      return { text: 'No agent browser tab is open.' }
    }
    this.browser.close(id)
    this.notifyAgentTab(id, chatId, 'close')
    return { text: 'Closed the browser tab.' }
  }

  private async snapshot(chatId: string): Promise<unknown> {
    const { id } = await this.ensureTab(chatId)
    const result = (await this.send(id, 'Accessibility.getFullAXTree')) as
      | { nodes?: AxNode[] }
      | undefined
    const nodes = result?.nodes ?? []
    if (nodes.length === 0) {
      return { text: 'The page exposes no accessibility tree yet.', details: {} }
    }

    const byId = new Map(nodes.map((n) => [n.nodeId, n]))
    const root = nodes.find((n) => !n.parentId || !byId.has(n.parentId)) ?? nodes[0]!
    const refMap = new Map<string, number>()
    let refCounter = 0
    const lines: string[] = []

    const describe = (node: AxNode, depth: number): void => {
      if (lines.join('\n').length > SNAPSHOT_MAX_CHARS) {
        return
      }
      const role = node.role?.value ?? ''
      const name = node.name?.value ?? ''
      const isInteractive = INTERACTIVE_ROLES.has(role)
      const meaningful = isInteractive || name || ['heading', 'dialog', 'form', 'main', 'navigation'].includes(role)
      if (meaningful && !node.ignored) {
        let line = `${'  '.repeat(Math.min(depth, 12))}${role || 'node'}`
        if (name) {
          line += ` "${name.slice(0, 80)}"`
        }
        const value = node.value?.value
        if (value !== undefined && value !== '') {
          line += ` = ${JSON.stringify(value).slice(0, 60)}`
        }
        if (isInteractive && node.backendDOMNodeId) {
          const ref = `e${++refCounter}`
          refMap.set(ref, node.backendDOMNodeId)
          line = `${'  '.repeat(Math.min(depth, 12))}${ref} ${line.trimStart()}`
        }
        lines.push(line)
      }
      for (const childId of node.childIds ?? []) {
        const child = byId.get(childId)
        if (child) {
          describe(child, meaningful ? depth + 1 : depth)
        }
      }
    }
    describe(root, 0)

    this.refs.set(id, refMap)
    let text = lines.join('\n')
    if (text.length > SNAPSHOT_MAX_CHARS) {
      text = `${text.slice(0, SNAPSHOT_MAX_CHARS)}\n… (snapshot truncated)`
    }
    return {
      text: text || 'Empty page snapshot.',
      details: { refCount: refCounter }
    }
  }

  private async click(chatId: string, params: Record<string, unknown>): Promise<unknown> {
    const { id } = await this.ensureTab(chatId)
    const backendNodeId = this.requireRef(id, params)
    await this.send(id, 'DOM.scrollIntoViewIfNeeded', { backendNodeId }).catch(() => {})
    const quads = (await this.send(id, 'DOM.getContentQuads', { backendNodeId })) as
      | { quads?: number[][] }
      | undefined
    const quad = quads?.quads?.[0]
    if (!quad || quad.length < 8) {
      throw new Error('Element has no clickable area (hidden or detached)')
    }
    const x = (quad[0]! + quad[2]! + quad[4]! + quad[6]!) / 4
    const y = (quad[1]! + quad[3]! + quad[5]! + quad[7]!) / 4
    for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased'] as const) {
      await this.send(id, 'Input.dispatchMouseEvent', {
        type,
        x,
        y,
        button: 'left',
        clickCount: 1
      })
    }
    return { text: `Clicked ${String(params['ref'])} at (${Math.round(x)}, ${Math.round(y)})` }
  }

  private async type(chatId: string, params: Record<string, unknown>): Promise<unknown> {
    const { id } = await this.ensureTab(chatId)
    const backendNodeId = this.requireRef(id, params)
    const text = typeof params['text'] === 'string' ? params['text'] : ''
    if (params['clear'] === true) {
      await this.send(id, 'DOM.focus', { backendNodeId }).catch(() => {})
      await this.dispatchKey(id, { key: 'a', code: 'KeyA', vk: 65 }, 4) // ⌘A
      await this.dispatchKey(id, { key: 'Backspace', code: 'Backspace', vk: 8 })
    } else {
      await this.send(id, 'DOM.focus', { backendNodeId }).catch(() => {})
    }
    await this.send(id, 'Input.insertText', { text })
    if (params['submit'] === true) {
      await this.dispatchKey(id, KEY_DEFS['enter']!)
    }
    return { text: `Typed ${text.length} chars into ${String(params['ref'])}` }
  }

  private async press(chatId: string, params: Record<string, unknown>): Promise<unknown> {
    const { id } = await this.ensureTab(chatId)
    const name = typeof params['key'] === 'string' ? params['key'] : ''
    const def = keyDef(name)
    if (!def) {
      throw new Error(`Unknown key "${name}"`)
    }
    await this.dispatchKey(id, def)
    return { text: `Pressed ${def.key}` }
  }

  private async dispatchKey(
    tabId: string,
    def: { key: string; code: string; vk: number; text?: string },
    modifiers = 0
  ): Promise<void> {
    const base = {
      key: def.key,
      code: def.code,
      windowsVirtualKeyCode: def.vk,
      nativeVirtualKeyCode: def.vk,
      modifiers
    }
    await this.send(tabId, 'Input.dispatchKeyEvent', {
      ...base,
      type: def.text ? 'keyDown' : 'rawKeyDown',
      ...(def.text ? { text: def.text } : {})
    })
    await this.send(tabId, 'Input.dispatchKeyEvent', { ...base, type: 'keyUp' })
  }

  private async scroll(chatId: string, params: Record<string, unknown>): Promise<unknown> {
    const { id } = await this.ensureTab(chatId)
    const ref = typeof params['ref'] === 'string' ? params['ref'] : undefined
    if (ref) {
      const backendNodeId = this.requireRef(id, params)
      await this.send(id, 'DOM.scrollIntoViewIfNeeded', { backendNodeId })
      return { text: `Scrolled ${ref} into view` }
    }
    const direction = typeof params['direction'] === 'string' ? params['direction'] : 'down'
    const amount = typeof params['amount'] === 'number' && params['amount'] > 0 ? params['amount'] : 600
    const delta =
      direction === 'up'
        ? ([0, -amount] as const)
        : direction === 'down'
          ? ([0, amount] as const)
          : direction === 'left'
            ? ([-amount, 0] as const)
            : direction === 'right'
              ? ([amount, 0] as const)
              : null
    if (!delta) {
      throw new Error(`Unknown scroll direction "${direction}"`)
    }
    const [dx, dy] = delta
    await this.evaluateExpression(id, `window.scrollBy(${dx}, ${dy})`)
    return { text: `Scrolled ${direction} ${amount}px` }
  }

  private async screenshot(chatId: string, params: Record<string, unknown>): Promise<unknown> {
    const { id, webContents } = await this.ensureTab(chatId)
    const fullPage = params['fullPage'] === true
    const bounds = this.browser.getView(id)?.getBounds()
    const viewWidth = bounds?.width ?? 0
    const viewHeight = bounds?.height ?? 0
    let clip: Record<string, number> | undefined
    if (fullPage) {
      const metrics = (await this.send(id, 'Page.getLayoutMetrics')) as {
        cssContentSize?: { width: number; height: number }
      }
      const content = metrics?.cssContentSize
      if (content) {
        clip = {
          x: 0,
          y: 0,
          width: Math.min(content.width, SCREENSHOT_MAX_WIDTH * 2),
          height: Math.min(content.height, 16384),
          scale: 1
        }
      }
    } else if (viewWidth > SCREENSHOT_MAX_WIDTH) {
      clip = {
        x: 0,
        y: 0,
        width: viewWidth,
        height: viewHeight,
        scale: SCREENSHOT_MAX_WIDTH / viewWidth
      }
    }
    const shot = (await this.send(id, 'Page.captureScreenshot', {
      format: 'jpeg',
      quality: 70,
      ...(clip ? { clip } : {})
    })) as { data?: string }
    if (!shot?.data) {
      throw new Error('Screenshot capture returned no data')
    }
    const url = webContents.getURL()
    const title = webContents.getTitle()
    return {
      text: `Screenshot of ${title || url}`,
      image: { data: shot.data, mimeType: 'image/jpeg' },
      details: { url, title }
    }
  }

  private async evaluate(chatId: string, params: Record<string, unknown>): Promise<unknown> {
    const { id } = await this.ensureTab(chatId)
    const expression = typeof params['expression'] === 'string' ? params['expression'] : ''
    if (!expression) {
      throw new Error('browser_evaluate needs an expression')
    }
    const value = await this.evaluateExpression(id, expression)
    return { text: truncate(JSON.stringify(value) ?? String(value), EVAL_MAX_CHARS) }
  }

  private async evaluateExpression(tabId: string, expression: string): Promise<unknown> {
    const timeout = sleep(EVAL_TIMEOUT_MS).then(() => {
      throw new Error('Evaluation timed out after 10s')
    })
    const result = (await Promise.race([
      this.send(tabId, 'Runtime.evaluate', {
        expression,
        returnByValue: true,
        awaitPromise: true
      }),
      timeout
    ])) as { result?: { value?: unknown; description?: string }; exceptionDetails?: { text?: string; exception?: { description?: string } } }
    if (result.exceptionDetails) {
      throw new Error(
        `Evaluation failed: ${result.exceptionDetails.exception?.description ?? result.exceptionDetails.text ?? 'error'}`
      )
    }
    return result.result?.value ?? result.result?.description ?? null
  }

  private async console(chatId: string): Promise<unknown> {
    const { id } = await this.ensureTab(chatId)
    const session = this.sessions.get(id)
    const entries = session ? [...session.consoleBuffer] : []
    if (session) {
      session.consoleBuffer.length = 0
      session.requestUrls.clear()
    }
    return {
      text: entries.length
        ? entries.map((e) => `[${e.kind}] ${e.text}`).join('\n')
        : 'No console output since the last call.',
      details: { count: entries.length }
    }
  }

  private async wait(chatId: string, params: Record<string, unknown>): Promise<unknown> {
    const { id } = await this.ensureTab(chatId)
    const text = typeof params['text'] === 'string' ? params['text'] : undefined
    const ms = typeof params['ms'] === 'number' ? params['ms'] : undefined
    const timeoutMs =
      typeof params['timeoutMs'] === 'number' && params['timeoutMs'] > 0
        ? Math.min(params['timeoutMs'], WAIT_MAX_MS)
        : WAIT_DEFAULT_TIMEOUT_MS

    if (text) {
      const deadline = Date.now() + timeoutMs
      const needle = JSON.stringify(text)
      while (Date.now() < deadline) {
        const found = await this.evaluateExpression(
          id,
          `document.body ? document.body.innerText.includes(${needle}) : false`
        ).catch(() => false)
        if (found === true) {
          return { text: `Text appeared: ${text}` }
        }
        await sleep(WAIT_POLL_MS)
      }
      throw new Error(`Timed out waiting for text "${text}" after ${timeoutMs}ms`)
    }
    await sleep(Math.min(ms ?? 1000, WAIT_MAX_MS))
    return { text: `Waited ${ms ?? 1000}ms` }
  }
}
