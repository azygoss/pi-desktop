import type { PiRuntimeInfo, PiSettings, ProjectSummary, SessionSummary } from './session-types'

/** Typed API exposed on `window.piDesktop` by the preload script. */
export interface PiDesktopApi {
  runtime: {
    info(): Promise<PiRuntimeInfo>
  }
  sessions: {
    list(): Promise<SessionSummary[]>
    /** Subscribe to session-index changes; returns an unsubscribe function. */
    onChanged(callback: () => void): () => void
  }
  projects: {
    list(): Promise<ProjectSummary[]>
  }
  settings: {
    get(): Promise<PiSettings>
  }
  app: {
    getUserFirstName(): Promise<string>
  }
}
