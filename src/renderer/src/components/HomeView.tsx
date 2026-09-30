import { Check, ExternalLink, RotateCcw, Terminal } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'

import type { CuaPermissions } from '../../../shared/api'
import { openPiTerminal } from '../state/panel-store'
import { useAppStore } from '../state/app-store'
import { useChatStore } from '../state/chat-store'
import { Composer } from './Composer'
import { PiLogo } from './PiLogo'
import { ProjectSigil, ScratchSigil } from './Pixels'
import { isProjectless, openSession, relativeTime } from './Sidebar'

const PROVIDERS_DOCS_URL = 'https://pi.dev/docs/latest/providers'

function runtimeLine(info: { kind: string; version: string | null } | null): string {
  if (!info) {
    return 'No pi runtime found'
  }
  const source =
    info.kind === 'installed' ? 'installed' : info.kind === 'custom' ? 'custom' : 'bundled'
  return `Using ${source} pi ${info.version ?? '?'}`
}

export function HomeView() {
  const piAvailable = useAppStore((s) => s.piAvailable)
  const runtimeInfo = useAppStore((s) => s.runtimeInfo)
  const workspaceDir = useAppStore((s) => s.appInfo?.workspaceDir ?? '')
  const navigate = useAppStore((s) => s.navigate)

  const [draftId] = useState(() => crypto.randomUUID())
  const sentRef = useRef(false)
  const chat = useChatStore((s) => s.chats[draftId])

  // Eagerly spawn a draft pi process so the composer has models/state. Drafts
  // run in the app scratch dir ("Without project") and do not create session
  // files until the first prompt. Closed on unmount unless a message was sent.
  useEffect(() => {
    if (!piAvailable || !workspaceDir) {
      return
    }
    void useChatStore
      .getState()
      .ensureChat(draftId, { cwd: workspaceDir })
      .catch(() => {})
    return () => {
      if (!sentRef.current) {
        void useChatStore.getState().closeChat(draftId)
      }
    }
  }, [draftId, piAvailable, workspaceDir])

  // pi started but reported no usable models (get_available_models empty):
  // nothing is signed in. The card replaces the heading/composer area.
  const noModels = chat?.piReady === true && chat.models.length === 0
  // pi failed to start entirely: show the error with a retry path.
  const runtimeError = chat?.status === 'error'

  return (
    <div className="home-view">
      <div className="home-center">
        {!piAvailable ? (
          <div className="install-card">
            <p>
              <strong>pi is not installed.</strong> Install the pi coding agent to use
              Pi Desktop:
            </p>
            <code>curl -fsSL https://pi.dev/install.sh | sh</code>
            <button
              type="button"
              className="ui-btn"
              onClick={() => void useAppStore.getState().init()}
            >
              <RotateCcw size={12} /> Retry
            </button>
          </div>
        ) : runtimeError ? (
          <div className="install-card" data-testid="runtime-error-card">
            <PiLogo size={28} />
            <h1>pi could not start</h1>
            <p>{chat?.error ?? 'The pi process failed to start.'}</p>
            {chat?.stderrTail && chat.stderrTail.length > 0 && (
              <details className="install-card-details">
                <summary>Show details</summary>
                <pre>{chat.stderrTail.join('\n')}</pre>
              </details>
            )}
            <div className="install-card-actions">
              <button
                type="button"
                className="ui-btn"
                onClick={() =>
                  void useChatStore
                    .getState()
                    .ensureChat(draftId, { cwd: workspaceDir })
                    .catch(() => {})
                }
              >
                <RotateCcw size={12} /> Retry
              </button>
              <button
                type="button"
                className="ui-btn"
                onClick={() => useAppStore.getState().openSettings('runtime')}
              >
                Settings → Pi Runtime
              </button>
            </div>
            <span className="runtime-line">{runtimeLine(runtimeInfo)}</span>
          </div>
        ) : noModels ? (
          <div className="install-card" data-testid="no-models-card">
            <PiLogo size={28} />
            <h1>Connect a model provider</h1>
            <p>
              Pi needs a model to work. Log in to a subscription or add an API
              key.
            </p>
            <div className="install-card-actions">
              <button
                type="button"
                className="ui-btn"
                onClick={() =>
                  void openPiTerminal(workspaceDir, 'login', '').catch(() => {})
                }
              >
                <Terminal size={12} /> Log in with pi
              </button>
              <button
                type="button"
                className="ui-btn"
                onClick={() =>
                  void window.piDesktop.app.openExternal(PROVIDERS_DOCS_URL)
                }
              >
                <ExternalLink size={12} /> Add an API key
              </button>
              <button
                type="button"
                className="ui-btn"
                onClick={() => void useChatStore.getState().refresh(draftId).catch(() => {})}
              >
                <RotateCcw size={12} /> Refresh
              </button>
            </div>
            <span className="runtime-line">{runtimeLine(runtimeInfo)}</span>
          </div>
        ) : (
          <>
            <div className="home-greeting">
              <PiLogo size={22} />
              <h1>What should pi work on?</h1>
            </div>
            <Composer
              chat={chat ?? null}
              autoFocus
              onSend={(message, images, mode) => {
                sentRef.current = true
                void useChatStore
                  .getState()
                  .send(draftId, message, images, mode)
                  .catch(() => {})
                navigate({ kind: 'chat', chatId: draftId })
              }}
            />
            <div className="home-hints" aria-hidden="true">
              <span>
                <kbd>/</kbd> commands
              </span>
              <span>
                <kbd>@</kbd> files
              </span>
              <span>
                <kbd>⌘K</kbd> palette
              </span>
              <span>
                <kbd>⌃`</kbd> terminal
              </span>
            </div>
            <WelcomeChecklist modelCount={chat?.models.length ?? 0} />
            <RecentChats />
          </>
        )}
      </div>
    </div>
  )
}

const RECENT_LIMIT = 5

/**
 * The last few chats across every project, so picking up yesterday's work
 * is one click from the home screen.
 */
function RecentChats() {
  const sessions = useAppStore((s) => s.sessions)
  const sessionMeta = useAppStore((s) => s.sessionMeta)
  const sessionsLoaded = useAppStore((s) => s.sessionsLoaded)
  const workspaceDir = useAppStore((s) => s.appInfo?.workspaceDir ?? '')
  const recent = useMemo(
    () =>
      sessions
        .filter((s) => sessionMeta[s.path]?.archived === undefined)
        .slice(0, RECENT_LIMIT),
    [sessions, sessionMeta]
  )
  if (!sessionsLoaded || recent.length === 0) {
    return null
  }
  return (
    <section className="home-recent" aria-label="Recent chats">
      <div className="home-recent-head">
        <span className="label-mono">Recent</span>
        <span className="home-recent-rule" />
      </div>
      {recent.map((session) => {
        const projectless = isProjectless(session.cwd, workspaceDir)
        const project = projectless
          ? 'no project'
          : (session.cwd.split('/').filter(Boolean).pop() ?? session.cwd)
        return (
          <button
            key={session.path}
            type="button"
            className="home-recent-row"
            title={session.title}
            onClick={() => openSession(session)}
          >
            {projectless ? <ScratchSigil size={12} /> : <ProjectSigil seed={session.cwd} size={12} />}
            <span className="home-recent-title">{session.title}</span>
            <span className="home-recent-project">{project}</span>
            <span className="home-recent-time">{relativeTime(session.modified)}</span>
          </button>
        )
      })}
    </section>
  )
}

/**
 * One-time first-run checklist under the composer. Hidden once dismissed or
 * for users who already have sessions (they've used pi before).
 */
function WelcomeChecklist({ modelCount }: { modelCount: number }) {
  const appSettings = useAppStore((s) => s.appSettings)
  const sessionsLoaded = useAppStore((s) => s.sessionsLoaded)
  const sessions = useAppStore((s) => s.sessions)
  const runtimeInfo = useAppStore((s) => s.runtimeInfo)
  const updateAppSettings = useAppStore((s) => s.updateAppSettings)
  const [cuaPerms, setCuaPerms] = useState<CuaPermissions | null>(null)

  useEffect(() => {
    let cancelled = false
    void window.piDesktop.cua
      ?.permissions()
      .then((p) => {
        if (!cancelled) {
          setCuaPerms(p)
        }
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [])

  if (
    !sessionsLoaded ||
    sessions.length > 0 ||
    appSettings.onboarding?.dismissedAt !== undefined
  ) {
    return null
  }

  const dismiss = () =>
    void updateAppSettings({ onboarding: { dismissedAt: Date.now() } })

  return (
    <div className="onboarding-card" data-testid="onboarding-card">
      <div className="onboarding-heading">Getting started</div>
      <div className="onboarding-row">
        <Check size={12} className="onboarding-check" />
        <span className="onboarding-label">Pi runtime</span>
        <span className="onboarding-value">
          {runtimeInfo
            ? `pi ${runtimeInfo.version ?? '?'} · ${runtimeInfo.kind}`
            : 'not found'}
        </span>
      </div>
      <div className="onboarding-row">
        {modelCount > 0 ? (
          <Check size={12} className="onboarding-check" />
        ) : (
          <span className="onboarding-dot" />
        )}
        <span className="onboarding-label">Models</span>
        <span className="onboarding-value">
          {modelCount > 0
            ? `${modelCount} available`
            : 'none — use /login or add an API key'}
        </span>
      </div>
      <div className="onboarding-row">
        {cuaPerms?.available && cuaPerms.accessibility ? (
          <Check size={12} className="onboarding-check" />
        ) : (
          <span className="onboarding-dot" />
        )}
        <span className="onboarding-label">Computer use</span>
        {cuaPerms?.available && cuaPerms.accessibility ? (
          <span className="onboarding-value">granted</span>
        ) : cuaPerms?.available === false ? (
          <span className="onboarding-value">not available</span>
        ) : (
          <span className="onboarding-value">
            Optional ·{' '}
            <button
              type="button"
              className="ui-btn onboarding-grant"
              onClick={() =>
                void window.piDesktop.cua
                  ?.requestPermissions()
                  .then(setCuaPerms)
                  .catch(() => {})
              }
            >
              Grant
            </button>
          </span>
        )}
      </div>
      <button type="button" className="ui-btn onboarding-done" onClick={dismiss}>
        Done
      </button>
    </div>
  )
}
