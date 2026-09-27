import { ExternalLink, Folder, RefreshCw, X } from 'lucide-react'
import { useEffect, useState } from 'react'
import clsx from 'clsx'

import type { AppInfo, AppSettings } from '../../../shared/api'
import type { PiRuntimeInfo } from '../../../shared/session-types'
import { useAppStore } from '../state/app-store'
import { PiLogo } from './PiLogo'

type Section = 'general' | 'runtime' | 'data' | 'about'

const SECTIONS: { id: Section; label: string }[] = [
  { id: 'general', label: 'General' },
  { id: 'runtime', label: 'Pi Runtime' },
  { id: 'data', label: 'Data' },
  { id: 'about', label: 'About' }
]

const THEMES: { value: AppSettings['theme']; label: string }[] = [
  { value: 'system', label: 'System' },
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' }
]

const RUNTIME_MODES: { value: AppSettings['piRuntime']['mode']; label: string; hint: string }[] = [
  { value: 'auto', label: 'Automatic', hint: 'Use the installed pi, falling back to the bundled one' },
  { value: 'installed', label: 'Installed only', hint: 'Require a pi executable on PATH' },
  { value: 'bundled', label: 'Bundled only', hint: 'Use the pi version shipped with the app' },
  { value: 'custom', label: 'Custom path', hint: 'Point at a specific pi executable' }
]

function shortenHome(path: string): string {
  // The main process already sends display-ready values where privacy matters;
  // for user-chosen paths show a compact basename-centric form.
  const parts = path.split('/')
  return parts.length > 3 ? `…/${parts.slice(-2).join('/')}` : path
}

export function SettingsModal() {
  const closeSettings = useAppStore((s) => s.closeSettings)
  const appSettings = useAppStore((s) => s.appSettings)
  const updateAppSettings = useAppStore((s) => s.updateAppSettings)
  const runtimeInfo = useAppStore((s) => s.runtimeInfo)

  const [section, setSection] = useState<Section>('general')
  const [appInfo, setAppInfo] = useState<AppInfo | null>(null)
  const [displayName, setDisplayName] = useState(appSettings.displayName ?? '')
  const [refreshing, setRefreshing] = useState(false)

  useEffect(() => {
    void window.piDesktop.app
      .getAppInfo()
      .then(setAppInfo)
      .catch(() => {})
  }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        closeSettings()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [closeSettings])

  function setTheme(theme: AppSettings['theme']): void {
    void updateAppSettings({ theme })
  }

  function setRuntimeMode(mode: AppSettings['piRuntime']['mode']): void {
    void updateAppSettings({ piRuntime: { ...appSettings.piRuntime, mode } })
  }

  async function pickCustomPath(): Promise<void> {
    const path = await window.piDesktop.app.pickFile().catch(() => null)
    if (path) {
      void updateAppSettings({
        piRuntime: { ...appSettings.piRuntime, mode: 'custom', customPath: path }
      })
    }
  }

  async function pickDefaultFolder(): Promise<void> {
    const folder = await window.piDesktop.app.pickFolder().catch(() => null)
    if (folder) {
      void updateAppSettings({ defaultCwd: folder })
    }
  }

  function commitDisplayName(): void {
    const name = displayName.trim()
    if (name !== (appSettings.displayName ?? '')) {
      void updateAppSettings({ displayName: name || undefined })
    }
  }

  async function redetectRuntime(): Promise<void> {
    setRefreshing(true)
    try {
      const info: PiRuntimeInfo = await window.piDesktop.runtime.refresh()
      useAppStore.setState({ runtimeInfo: info, piAvailable: true })
    } catch {
      useAppStore.setState({ runtimeInfo: null, piAvailable: false })
    } finally {
      setRefreshing(false)
    }
  }

  function unhide(cwd: string): void {
    void updateAppSettings({
      hiddenProjects: appSettings.hiddenProjects.filter((p) => p !== cwd)
    })
  }

  return (
    <div className="settings-overlay" onClick={closeSettings}>
      <div
        className="settings-modal"
        role="dialog"
        aria-label="Settings"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="settings-nav">
          <div className="settings-nav-title">Settings</div>
          {SECTIONS.map((s) => (
            <button
              key={s.id}
              type="button"
              className={clsx('settings-nav-item', { 'is-active': section === s.id })}
              onClick={() => setSection(s.id)}
            >
              {s.label}
            </button>
          ))}
        </div>

        <div className="settings-body">
          <button
            type="button"
            className="icon-btn settings-close"
            title="Close"
            onClick={closeSettings}
          >
            <X size={15} />
          </button>

          {section === 'general' && (
            <div className="settings-section">
              <h2>General</h2>
              <div className="settings-row">
                <div>
                  <div className="settings-label">Theme</div>
                  <div className="settings-hint">Appearance of the app</div>
                </div>
                <div className="settings-segmented">
                  {THEMES.map((t) => (
                    <button
                      key={t.value}
                      type="button"
                      className={clsx('settings-segment', {
                        'is-active': appSettings.theme === t.value
                      })}
                      onClick={() => setTheme(t.value)}
                    >
                      {t.label}
                    </button>
                  ))}
                </div>
              </div>
              <div className="settings-row">
                <div>
                  <div className="settings-label">Display name</div>
                  <div className="settings-hint">Used in the greeting</div>
                </div>
                <input
                  className="settings-input"
                  value={displayName}
                  onChange={(e) => setDisplayName(e.target.value)}
                  onBlur={commitDisplayName}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      commitDisplayName()
                    }
                  }}
                  placeholder="Your name"
                  spellCheck={false}
                />
              </div>
              <div className="settings-row">
                <div>
                  <div className="settings-label">Default folder</div>
                  <div className="settings-hint">Working directory for new chats</div>
                </div>
                <div className="settings-path-row">
                  <span className="settings-path" title={appSettings.defaultCwd ?? ''}>
                    {appSettings.defaultCwd ? shortenHome(appSettings.defaultCwd) : 'Home'}
                  </span>
                  <button type="button" className="ui-btn" onClick={() => void pickDefaultFolder()}>
                    Choose…
                  </button>
                  {appSettings.defaultCwd && (
                    <button
                      type="button"
                      className="ui-btn"
                      onClick={() => void updateAppSettings({ defaultCwd: undefined })}
                    >
                      Clear
                    </button>
                  )}
                </div>
              </div>
            </div>
          )}

          {section === 'runtime' && (
            <div className="settings-section">
              <h2>Pi Runtime</h2>
              {RUNTIME_MODES.map((m) => (
                <label key={m.value} className="settings-radio">
                  <input
                    type="radio"
                    name="pi-runtime-mode"
                    checked={appSettings.piRuntime.mode === m.value}
                    onChange={() => setRuntimeMode(m.value)}
                  />
                  <div>
                    <div className="settings-label">{m.label}</div>
                    <div className="settings-hint">{m.hint}</div>
                  </div>
                </label>
              ))}
              {appSettings.piRuntime.mode === 'custom' && (
                <div className="settings-row">
                  <div>
                    <div className="settings-label">pi executable</div>
                    <div className="settings-hint">
                      {appSettings.piRuntime.customPath ?? 'Not set'}
                    </div>
                  </div>
                  <button type="button" className="ui-btn" onClick={() => void pickCustomPath()}>
                    Choose…
                  </button>
                </div>
              )}
              <div className="settings-row">
                <div>
                  <div className="settings-label">Detected runtime</div>
                  <div className="settings-hint">
                    {runtimeInfo
                      ? `${runtimeInfo.kind} · pi ${runtimeInfo.version ?? '?'} · ${runtimeInfo.command}`
                      : 'No pi runtime found'}
                  </div>
                </div>
                <button
                  type="button"
                  className="ui-btn"
                  disabled={refreshing}
                  onClick={() => void redetectRuntime()}
                >
                  <RefreshCw size={12} /> Re-detect
                </button>
              </div>
              <div className="settings-note">Runtime changes apply to newly opened chats.</div>
            </div>
          )}

          {section === 'data' && (
            <div className="settings-section">
              <h2>Data</h2>
              <div className="settings-row">
                <div>
                  <div className="settings-label">pi config folder</div>
                  <div className="settings-hint">{appInfo?.agentDirDisplay ?? '…'}</div>
                </div>
                <button
                  type="button"
                  className="ui-btn"
                  onClick={() => void window.piDesktop.app.openAgentDir()}
                >
                  <Folder size={12} /> Open
                </button>
              </div>
              <div className="settings-row settings-row-top">
                <div>
                  <div className="settings-label">Hidden projects</div>
                  <div className="settings-hint">Hidden from the sidebar, not deleted</div>
                </div>
                <div className="settings-hidden-list">
                  {appSettings.hiddenProjects.length === 0 && (
                    <span className="settings-hint">None</span>
                  )}
                  {appSettings.hiddenProjects.map((cwd) => (
                    <div key={cwd} className="settings-hidden-item">
                      <span className="settings-path" title={cwd}>
                        {shortenHome(cwd)}
                      </span>
                      <button
                        type="button"
                        className="ui-btn"
                        onClick={() => unhide(cwd)}
                      >
                        Unhide
                      </button>
                    </div>
                  ))}
                </div>
              </div>
              <div className="settings-note">
                Pi Desktop reads pi settings and sessions from this folder but never reads
                auth.json — authentication is managed by pi itself.
              </div>
            </div>
          )}

          {section === 'about' && (
            <div className="settings-section settings-about">
              <PiLogo size={40} />
              <h2>Pi Desktop</h2>
              <div className="settings-hint">
                Version {appInfo?.version ?? '?'} · MIT License
              </div>
              <div className="settings-note">
                A desktop GUI for the pi coding agent. pi is by Earendil — Pi Desktop is a
                community project and not affiliated with pi.
              </div>
              <button
                type="button"
                className="ui-btn"
                onClick={() => window.open('https://github.com/azygoss/pi-desktop', '_blank')}
              >
                <ExternalLink size={12} /> GitHub
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
