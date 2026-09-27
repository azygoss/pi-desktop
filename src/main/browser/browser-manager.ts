import { app, BrowserWindow, WebContentsView, session } from 'electron'
import { join } from 'node:path'
import { existsSync } from 'node:fs'

import type { BrowserRect, BrowserTabState } from '../../shared/api'
import { isAllowedBrowserUrl, normalizeBrowserUrl } from '../../shared/browser-url'

const PARTITION = 'persist:pi-desktop-browser'
const MAX_BROWSER_TABS = 32

export interface BrowserManagerCallbacks {
  /** Push a tab's state to the renderer (url/title/favicon/loading/history). */
  onState(state: BrowserTabState): void
  /** Page requested a new window — the renderer opens a new browser tab. */
  onOpenUrl(url: string): void
  /** A download completed — the renderer shows a toast. */
  onDownload(filename: string): void
}

interface TabRecord {
  view: WebContentsView
  url: string
  title: string
  favicon?: string
  loading: boolean
}

let sessionConfigured = false

/** Lock down the persistent browser partition once per app run. */
function browserSession() {
  const ses = session.fromPartition(PARTITION)
  if (sessionConfigured) {
    return ses
  }
  sessionConfigured = true
  ses.setPermissionRequestHandler((_wc, _permission, callback) => callback(false))
  ses.setPermissionCheckHandler(() => false)
  ses.on('will-download', (_event, item) => {
    const dir = app.getPath('downloads')
    item.setSavePath(uniquePath(dir, item.getFilename()))
    item.once('done', (_e, state) => {
      if (state === 'completed') {
        downloadCallback?.(item.getFilename())
      }
    })
  })
  return ses
}

let downloadCallback: ((filename: string) => void) | null = null

function uniquePath(dir: string, filename: string): string {
  let candidate = join(dir, filename)
  let counter = 1
  while (existsSync(candidate)) {
    const dot = filename.lastIndexOf('.')
    const base = dot > 0 ? filename.slice(0, dot) : filename
    const ext = dot > 0 ? filename.slice(dot) : ''
    candidate = join(dir, `${base} ${counter}${ext}`)
    counter++
  }
  return candidate
}

/**
 * Owns one WebContentsView per browser tab. Views attach to the app's window
 * only while their tab is the visible one — a tab that isn't active, a closed
 * panel or an open DOM overlay removes the view from the content tree so
 * nothing paints over the app's UI.
 */
export class BrowserManager {
  private readonly tabs = new Map<string, TabRecord>()
  /** The tab currently allowed to paint, plus its placeholder rect. */
  private visibleId: string | null = null
  private rect: BrowserRect | null = null
  private overlayOpen = false

  constructor(private readonly callbacks: BrowserManagerCallbacks) {
    downloadCallback = callbacks.onDownload
  }

  private window(): BrowserWindow | null {
    return BrowserWindow.getAllWindows()[0] ?? null
  }

  create(id: string, url?: string): void {
    if (this.tabs.has(id)) {
      return
    }
    if (this.tabs.size >= MAX_BROWSER_TABS) {
      throw new Error('Too many browser tabs')
    }
    browserSession()
    const view = new WebContentsView({
      webPreferences: {
        partition: PARTITION,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        javascript: true
      }
    })
    view.setBackgroundColor('#1a1a19')
    const record: TabRecord = { view, url: '', title: 'New Tab', loading: false }
    this.tabs.set(id, record)
    this.wireEvents(id, record)
    if (url) {
      const target = normalizeBrowserUrl(url)
      if (target) {
        void view.webContents.loadURL(target).catch(() => {})
      }
    }
  }

  navigate(id: string, input: string): void {
    const record = this.require(id)
    const url = normalizeBrowserUrl(input)
    if (!url) {
      throw new Error('Only http(s) and localhost URLs are supported')
    }
    void record.view.webContents.loadURL(url).catch(() => {})
  }

  goBack(id: string): void {
    const record = this.require(id)
    if (record.view.webContents.navigationHistory.canGoBack()) {
      record.view.webContents.navigationHistory.goBack()
    }
  }

  goForward(id: string): void {
    const record = this.require(id)
    if (record.view.webContents.navigationHistory.canGoForward()) {
      record.view.webContents.navigationHistory.goForward()
    }
  }

  reloadOrStop(id: string): void {
    const wc = this.require(id).view.webContents
    if (wc.isLoading()) {
      wc.stop()
    } else {
      wc.reload()
    }
  }

  close(id: string): void {
    const record = this.tabs.get(id)
    if (!record) {
      return
    }
    this.tabs.delete(id)
    if (this.visibleId === id) {
      this.visibleId = null
      this.detach(record.view)
    }
    try {
      record.view.webContents.close()
    } catch {
      // already gone
    }
  }

  /**
   * Which tab is allowed to paint and where. `id: null` hides all views.
   * The rect is window-relative CSS pixels reported by the renderer's
   * placeholder element.
   */
  setVisible(id: string | null, rect?: BrowserRect): void {
    this.visibleId = id && this.tabs.has(id) ? id : null
    if (rect && this.visibleId) {
      this.rect = sanitizeRect(rect)
    }
    this.applyVisibility()
  }

  setOverlayOpen(open: boolean): void {
    this.overlayOpen = open
    this.applyVisibility()
  }

  /** Whether the given tab's view is attached (needed by the CDP bridge). */
  isVisible(id: string): boolean {
    return this.visibleId === id && !this.overlayOpen
  }

  /** The view for a tab — used by the CDP bridge (section E). */
  getView(id: string): WebContentsView | undefined {
    return this.tabs.get(id)?.view
  }

  has(id: string): boolean {
    return this.tabs.has(id)
  }

  /** All open browser tabs — used by the browser_tabs bridge tool. */
  list(): { id: string; url: string; title: string }[] {
    return [...this.tabs.entries()].map(([id, record]) => ({
      id,
      url: record.view.webContents.getURL() || record.url,
      title: record.view.webContents.getTitle() || record.title
    }))
  }

  closeAll(): void {
    for (const id of [...this.tabs.keys()]) {
      this.close(id)
    }
  }

  private require(id: string): TabRecord {
    const record = this.tabs.get(id)
    if (!record) {
      throw new Error('Unknown browser tab')
    }
    return record
  }

  private applyVisibility(): void {
    const win = this.window()
    for (const [id, record] of this.tabs) {
      const shouldShow = id === this.visibleId && !this.overlayOpen && !!win && !!this.rect
      if (shouldShow && win && this.rect) {
        if (!isAttached(win, record.view)) {
          win.contentView.addChildView(record.view)
        }
        record.view.setBounds(this.rect)
      } else {
        this.detach(record.view)
      }
    }
  }

  private detach(view: WebContentsView): void {
    const win = this.window()
    if (win && isAttached(win, view)) {
      win.contentView.removeChildView(view)
    }
  }

  private emit(id: string): void {
    const record = this.tabs.get(id)
    if (!record) {
      return
    }
    const wc = record.view.webContents
    this.callbacks.onState({
      id,
      url: wc.getURL() || record.url,
      title: wc.getTitle() || record.title,
      favicon: record.favicon,
      loading: wc.isLoading(),
      canGoBack: wc.navigationHistory.canGoBack(),
      canGoForward: wc.navigationHistory.canGoForward()
    })
  }

  private wireEvents(id: string, record: TabRecord): void {
    const wc = record.view.webContents

    wc.setWindowOpenHandler(({ url }) => {
      if (isAllowedBrowserUrl(url)) {
        this.callbacks.onOpenUrl(url)
      }
      return { action: 'deny' }
    })
    wc.on('will-navigate', (event, url) => {
      if (!isAllowedBrowserUrl(url)) {
        event.preventDefault()
      }
    })
    const refresh = (): void => this.emit(id)
    wc.on('did-navigate', (_e, url) => {
      record.url = url
      refresh()
    })
    wc.on('did-navigate-in-page', (_e, url) => {
      record.url = url
      refresh()
    })
    wc.on('page-title-updated', (_e, title) => {
      record.title = title
      refresh()
    })
    wc.on('page-favicon-updated', (_e, favicons) => {
      record.favicon = favicons[0]
      refresh()
    })
    wc.on('did-start-loading', refresh)
    wc.on('did-stop-loading', refresh)
    wc.on('render-process-gone', refresh)
    wc.on('destroyed', () => {
      this.tabs.delete(id)
    })
  }
}

function isAttached(win: BrowserWindow | null, view: WebContentsView): boolean {
  return !!win && win.contentView.children.includes(view)
}

function sanitizeRect(rect: BrowserRect): BrowserRect {
  const num = (v: number, max: number): number =>
    Number.isFinite(v) ? Math.max(0, Math.min(max, Math.round(v))) : 0
  return {
    x: num(rect.x, 16384),
    y: num(rect.y, 16384),
    width: num(rect.width, 16384),
    height: num(rect.height, 16384)
  }
}
