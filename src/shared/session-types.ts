export interface SessionSummary {
  id: string
  path: string
  cwd: string
  name?: string
  title: string
  /** ISO timestamp from the session header. */
  created: string
  /** File mtime as ISO timestamp. */
  modified: string
  messageCount: number
  parentSessionPath?: string
}

export interface ProjectSummary {
  cwd: string
  name: string
  sessionCount: number
  lastModified: string
  /** A git worktree the app created for isolated, parallel work. */
  worktree?: boolean
}

/**
 * Whitelisted subset of pi's settings.json (docs/settings.md). auth.json,
 * models.json, models-store.json and mcp.json are never read.
 */
export interface PiSettings {
  defaultProvider?: string
  defaultModel?: string
  defaultThinkingLevel?: string
  theme?: string
}

export interface PiRuntimeInfo {
  kind: 'installed' | 'custom' | 'bundled'
  version: string | null
  /** Executable basename only — never a full path. */
  command: string
}
