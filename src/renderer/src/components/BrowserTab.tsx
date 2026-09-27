import {
  ArrowLeft,
  ArrowRight,
  Bot,
  FileDiff,
  Globe,
  RotateCw,
  TerminalSquare,
  X
} from 'lucide-react'
import { useEffect, useRef, useState } from 'react'

import type { LocalServer } from '../../../shared/api'
import { usePanelStore, type PanelTab } from '../state/panel-store'
import { toast } from '../state/toast-store'

type BrowserTabData = Extract<PanelTab, { kind: 'browser' }>

/**
 * Toolbar + placeholder for a browser tab. The actual page is painted by a
 * WebContentsView in the main process; the placeholder's rect is pushed over
 * IPC (rAF-throttled) so the view tracks layout exactly.
 */
export function BrowserTab({ tab, active }: { tab: BrowserTabData; active: boolean }) {
  const hostRef = useRef<HTMLDivElement>(null)
  const [address, setAddress] = useState(tab.url)
  // While the panel animates its width the WebContentsView stays hidden;
  // the final rect is pushed when `animating` clears.
  const animating = usePanelStore((s) => s.animating)

  // Keep the address bar in sync with navigations coming from main
  // (derived-state-during-render pattern; user edits set lastUrl too).
  const [lastUrl, setLastUrl] = useState(tab.url)
  if (tab.url !== lastUrl) {
    setLastUrl(tab.url)
    setAddress(tab.url)
  }

  useEffect(() => {
    if (!active || animating) {
      return
    }
    const host = hostRef.current
    if (!host) {
      return
    }
    let raf = 0
    const push = (): void => {
      const r = host.getBoundingClientRect()
      void window.piDesktop.browser
        .setVisible({
          id: tab.id,
          rect: { x: r.x, y: r.y, width: r.width, height: r.height }
        })
        .catch(() => {})
    }
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(raf)
      raf = requestAnimationFrame(push)
    })
    observer.observe(host)
    push()
    return () => {
      observer.disconnect()
      cancelAnimationFrame(raf)
    }
  }, [active, animating, tab.id])

  function submit(): void {
    const value = address.trim()
    if (!value) {
      return
    }
    void window.piDesktop.browser.navigate({ id: tab.id, url: value }).catch((e) => {
      toast(e instanceof Error ? e.message : 'Could not open that URL')
    })
  }

  return (
    <div className="browser-tab">
      <div className="browser-toolbar">
        <button
          type="button"
          className="icon-btn"
          disabled={!tab.canGoBack}
          title="Back"
          onClick={() => void window.piDesktop.browser.goBack({ id: tab.id })}
        >
          <ArrowLeft size={13} />
        </button>
        <button
          type="button"
          className="icon-btn"
          disabled={!tab.canGoForward}
          title="Forward"
          onClick={() => void window.piDesktop.browser.goForward({ id: tab.id })}
        >
          <ArrowRight size={13} />
        </button>
        <button
          type="button"
          className="icon-btn"
          title={tab.loading ? 'Stop' : 'Reload'}
          onClick={() => void window.piDesktop.browser.reloadOrStop({ id: tab.id })}
        >
          {tab.loading ? <X size={13} /> : <RotateCw size={13} />}
        </button>
        <div className="browser-address">
          {tab.agentChatId ? <Bot size={12} /> : <Globe size={12} />}
          <input
            value={address}
            onChange={(e) => setAddress(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                submit()
              }
            }}
            placeholder="Search or enter a URL"
            spellCheck={false}
            aria-label="Address"
          />
        </div>
        {tab.loading && <span className="browser-loading" aria-label="Loading" />}
      </div>
      <div className="browser-viewport" ref={hostRef} />
    </div>
  )
}

/** Compact "localhost:3000" label for a recent/server URL. */
function urlLabel(url: string): string {
  try {
    const u = new URL(url)
    return u.host + (u.pathname === '/' ? '' : u.pathname)
  } catch {
    return url
  }
}

/** The "+" tab page: omnibox plus sections (local servers, tools, recent). */
export function NewTabPage({
  onNavigate,
  onTerminal,
  onDiff,
  cwd
}: {
  onNavigate(url: string): void
  onTerminal(): void
  onDiff(): void
  cwd: string
}) {
  const [address, setAddress] = useState('')
  const [servers, setServers] = useState<LocalServer[]>([])
  const [diffFiles, setDiffFiles] = useState<number | null>(null)
  const recentUrls = usePanelStore((s) => s.recentUrls)

  // Refresh the dev-server list every time the page mounts.
  useEffect(() => {
    let alive = true
    window.piDesktop.app
      .localServers()
      .then((list) => {
        if (alive) {
          setServers(list)
        }
      })
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [])

  // Show "N files changed" next to Diff when the cwd is a dirty repo.
  useEffect(() => {
    let alive = true
    window.piDesktop.diff
      .status({ cwd })
      .then((result) => {
        if (!alive || !result.isRepo) {
          return
        }
        const changed =
          (result.diffText.match(/^diff --git /gm) ?? []).length +
          result.untracked.length
        setDiffFiles(changed)
      })
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [cwd])

  return (
    <div className="newtab-page">
      <div className="newtab-inner">
        <div className="browser-address newtab-omnibox">
          <Globe size={14} />
          <input
            autoFocus
            value={address}
            onChange={(e) => setAddress(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && address.trim()) {
                onNavigate(address.trim())
              }
            }}
            placeholder="Search or enter a URL"
            spellCheck={false}
            aria-label="Address"
          />
          <kbd className="kbd">⌘L</kbd>
        </div>

        {servers.length > 0 && (
          <section className="newtab-section">
            <div className="newtab-label">Local servers</div>
            {servers.map((server) => (
              <button
                key={server.port}
                type="button"
                className="newtab-row"
                onClick={() => onNavigate(`http://localhost:${server.port}`)}
              >
                <Globe size={13} className="newtab-row-icon" />
                <span className="newtab-row-name">localhost:{server.port}</span>
                <span className="newtab-row-meta">{server.command}</span>
              </button>
            ))}
          </section>
        )}

        <section className="newtab-section">
          <div className="newtab-label">Tools</div>
          <button type="button" className="newtab-row" onClick={onTerminal}>
            <TerminalSquare size={13} className="newtab-row-icon" />
            <span className="newtab-row-name">Terminal</span>
            <kbd className="kbd">⌃`</kbd>
          </button>
          <button type="button" className="newtab-row" onClick={onDiff}>
            <FileDiff size={13} className="newtab-row-icon" />
            <span className="newtab-row-name">Diff</span>
            {diffFiles !== null && diffFiles > 0 && (
              <span className="newtab-row-meta">
                {diffFiles} file{diffFiles === 1 ? '' : 's'} changed
              </span>
            )}
          </button>
        </section>

        {recentUrls.length > 0 && (
          <section className="newtab-section">
            <div className="newtab-label">Recent</div>
            {recentUrls.slice(0, 5).map((url) => (
              <button
                key={url}
                type="button"
                className="newtab-row"
                title={url}
                onClick={() => onNavigate(url)}
              >
                <Globe size={13} className="newtab-row-icon" />
                <span className="newtab-row-name">{urlLabel(url)}</span>
              </button>
            ))}
          </section>
        )}
      </div>
    </div>
  )
}
