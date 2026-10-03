import { execFile } from 'node:child_process'
import { stat } from 'node:fs/promises'
import { join } from 'node:path'

/** An app a project folder can be opened in. */
export interface OpenTarget {
  id: string
  label: string
  /** macOS application name passed to `open -a`. */
  app: string
}

/** Editors and terminals probed in /Applications (macOS). */
const MAC_CANDIDATES: OpenTarget[] = [
  { id: 'vscode', label: 'VS Code', app: 'Visual Studio Code' },
  { id: 'cursor', label: 'Cursor', app: 'Cursor' },
  { id: 'zed', label: 'Zed', app: 'Zed' },
  { id: 'windsurf', label: 'Windsurf', app: 'Windsurf' },
  { id: 'xcode', label: 'Xcode', app: 'Xcode' },
  { id: 'iterm', label: 'iTerm', app: 'iTerm' },
  { id: 'ghostty', label: 'Ghostty', app: 'Ghostty' },
  { id: 'warp', label: 'Warp', app: 'Warp' }
]

const TERMINAL: OpenTarget = { id: 'terminal', label: 'Terminal', app: 'Terminal' }

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

let cached: { at: number; targets: OpenTarget[] } | null = null
const CACHE_MS = 60_000

/**
 * Installed apps that can open a folder. macOS only for now; other platforms
 * get an empty list (the menu still offers the file manager).
 */
export async function listOpenTargets(
  platform: NodeJS.Platform = process.platform,
  appDirs: string[] = ['/Applications', '/System/Applications/Utilities']
): Promise<OpenTarget[]> {
  if (platform !== 'darwin') {
    return []
  }
  if (cached && Date.now() - cached.at < CACHE_MS) {
    return cached.targets
  }
  const found: OpenTarget[] = []
  for (const candidate of [...MAC_CANDIDATES, TERMINAL]) {
    for (const dir of appDirs) {
      if (await exists(join(dir, `${candidate.app}.app`))) {
        found.push(candidate)
        break
      }
    }
  }
  cached = { at: Date.now(), targets: found }
  return found
}

/** Test hook. */
export function clearOpenTargetCache(): void {
  cached = null
}

/** Open `cwd` in a target app via `open -a` (no shell involved). */
export function openInTarget(target: OpenTarget, cwd: string): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    execFile('open', ['-a', target.app, cwd], { timeout: 10_000 }, (error) => {
      if (error) {
        reject(new Error(`Could not open ${target.label}`))
      } else {
        resolvePromise()
      }
    })
  })
}
