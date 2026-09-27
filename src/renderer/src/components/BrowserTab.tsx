import { ArrowLeft, ArrowRight, Bot, Globe, RotateCw, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import clsx from 'clsx'

import type { PanelTab } from '../state/panel-store'
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

  // Keep the address bar in sync with navigations coming from main
  // (derived-state-during-render pattern; user edits set lastUrl too).
  const [lastUrl, setLastUrl] = useState(tab.url)
  if (tab.url !== lastUrl) {
    setLastUrl(tab.url)
    setAddress(tab.url)
  }

  useEffect(() => {
    if (!active) {
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
  }, [active, tab.id])

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

/** The "+" tab page: URL bar plus the tools list (Terminal, Diff). */
export function NewTabPage({
  onNavigate,
  onTerminal,
  onDiff
}: {
  onNavigate(url: string): void
  onTerminal(): void
  onDiff(): void
}) {
  const [address, setAddress] = useState('')

  return (
    <div className="newtab-page">
      <div className={clsx('browser-address', 'newtab-address')}>
        <Globe size={12} />
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
      </div>
      <div className="newtab-tools">
        <div className="newtab-tools-label">Tools</div>
        <button type="button" className="folder-row" onClick={onTerminal}>
          <span className="newtab-tool-name">Terminal</span>
          <kbd className="kbd">⌃`</kbd>
        </button>
        <button type="button" className="folder-row" onClick={onDiff}>
          <span className="newtab-tool-name">Diff</span>
        </button>
      </div>
    </div>
  )
}
