import { useEffect, useRef } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'

import type { PanelTab } from '../state/panel-store'

import '@xterm/xterm/css/xterm.css'

function cssVar(name: string, fallback: string): string {
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim()
  return value || fallback
}

function terminalTheme(): Record<string, string> {
  return {
    background: cssVar('--bg', '#1a1a19'),
    foreground: cssVar('--text', '#e8e4dd'),
    cursor: cssVar('--accent', '#e07856'),
    selectionBackground: cssVar('--surface-hover', '#33302c')
  }
}

type TerminalTabData = Extract<PanelTab, { kind: 'terminal' }>

/**
 * One xterm instance bound to a main-process pty. Spawned once per tab; the
 * terminal keeps running while the panel or tab is hidden.
 */
export function TerminalView({ tab }: { tab: TerminalTabData }) {
  const hostRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const host = hostRef.current
    if (!host) {
      return
    }
    const term = new Terminal({
      fontFamily: 'ui-monospace, SF Mono, Menlo, monospace',
      fontSize: 12,
      lineHeight: 1.25,
      cursorBlink: true,
      theme: terminalTheme(),
      scrollback: 10_000,
      allowProposedApi: true
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(host)
    fit.fit()

    // WebGL renderer where available; skipped under automation so tests can
    // read .xterm-rows from the DOM renderer.
    let webgl: import('@xterm/addon-webgl').WebglAddon | null = null
    if (!navigator.webdriver) {
      void import('@xterm/addon-webgl')
        .then(({ WebglAddon }) => {
          if (term.element) {
            webgl = new WebglAddon()
            term.loadAddon(webgl)
          }
        })
        .catch(() => {})
    }

    const spawned = window.piDesktop.terminal.spawn({
      id: tab.id,
      cwd: tab.spec.cwd,
      argv: tab.spec.argv,
      profile: tab.spec.profile,
      initialInput: tab.spec.initialInput,
      cols: term.cols,
      rows: term.rows
    })
    spawned.catch((e) => term.writeln(`\r\nCould not start terminal: ${String(e)}`))

    const offData = window.piDesktop.terminal.onData(({ id, data }) => {
      if (id === tab.id) {
        term.write(data)
      }
    })
    const offInput = term.onData((data) => {
      void window.piDesktop.terminal.write({ id: tab.id, data })
    })

    const resize = new ResizeObserver(() => {
      if (host.offsetParent === null) {
        return // hidden — fit again when visible
      }
      fit.fit()
      void window.piDesktop.terminal.resize({ id: tab.id, cols: term.cols, rows: term.rows })
    })
    resize.observe(host)

    // Follow the app theme when it changes.
    const themeObserver = new MutationObserver(() => {
      term.options.theme = terminalTheme()
    })
    themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme']
    })

    return () => {
      resize.disconnect()
      themeObserver.disconnect()
      offInput.dispose()
      offData()
      webgl?.dispose()
      term.dispose()
      // The pty survives view teardown only if the tab still exists; killing
      // here matches "close = terminate".
      void window.piDesktop.terminal.kill({ id: tab.id }).catch(() => {})
    }
  }, [tab.id]) // eslint-disable-line react-hooks/exhaustive-deps

  return <div className="terminal-view" ref={hostRef} />
}
