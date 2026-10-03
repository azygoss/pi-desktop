import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { app } from 'electron'

/**
 * Pi Desktop's own data root: Electron userData, overridable with
 * PI_DESKTOP_USER_DATA_DIR for tests. Never inside ~/.pi.
 */
export function appUserDataDir(): string {
  return process.env['PI_DESKTOP_USER_DATA_DIR'] || app.getPath('userData')
}

/**
 * Shared scratch directory for "project-less" chats. Pi groups sessions by
 * cwd, so a session is project-less iff its cwd equals this directory.
 */
export function workspaceDir(): string {
  return join(appUserDataDir(), 'workspace')
}

/** Where git worktrees created for projects live (`<repo>/<slug>` inside). */
export function worktreesDir(): string {
  return join(appUserDataDir(), 'worktrees')
}

export async function ensureWorkspaceDir(): Promise<string> {
  const dir = workspaceDir()
  await mkdir(dir, { recursive: true })
  return dir
}
