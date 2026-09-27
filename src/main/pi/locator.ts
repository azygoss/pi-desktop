import { execFile } from 'node:child_process'
import { access, readFile, realpath } from 'node:fs/promises'
import { homedir } from 'node:os'
import { delimiter, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export interface PiRuntime {
  kind: 'installed' | 'custom' | 'bundled'
  command: string
  args: string[]
  /** Extra environment the pi child process needs (merged over process.env). */
  env: Record<string, string>
  version: string | null
}

export interface ResolvePiRuntimeOptions {
  /** Path to a user-configured pi executable. Wins over everything when valid. */
  customPath?: string
  /**
   * Runtime selection mode from app settings. 'installed'/'bundled' restrict
   * resolution to that source only; 'auto' (default) tries installed then
   * bundled; 'custom' behaves like auto but expects customPath to be set.
   */
  mode?: 'auto' | 'installed' | 'bundled' | 'custom'
  /** Prefer the bundled pi over an installed one. */
  preferBundled?: boolean
  /** App root used to locate the bundled dependency (defaults to cwd). */
  appPath?: string
  /** Injectable dependencies for testing. */
  deps?: Partial<LocatorDeps>
}

export interface LocatorDeps {
  platform: NodeJS.Platform
  env: NodeJS.ProcessEnv
  homeDir: string
  /** Login shell used to recover the user's PATH (e.g. `/bin/zsh`). */
  shell: string | undefined
  isExecutable(filePath: string): Promise<boolean>
  /** Run `<command> --version` and return raw stdout, or null on any failure. */
  readVersion(
    command: string,
    args: string[],
    env?: Record<string, string>
  ): Promise<string | null>
  /** Run the login shell and return the PATH it prints, or null on failure. */
  readLoginShellPath(): Promise<string | null>
  /** Resolve the bundled CLI entry (`dist/bundle/cli.js`), or null if absent. */
  resolveBundledCli(): Promise<{ cliPath: string; version: string | null } | null>
}

const COMMON_BIN_DIRS = [
  '/opt/homebrew/bin',
  '/usr/local/bin',
  '~/.bun/bin',
  '~/.local/bin',
  '~/.npm-global/bin',
  '~/.volta/bin'
]

const VERSION_TIMEOUT_MS = 5000
const SHELL_PATH_TIMEOUT_MS = 5000

function execText(
  file: string,
  args: string[],
  timeoutMs: number,
  env?: Record<string, string>
): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    execFile(
      file,
      args,
      { timeout: timeoutMs, maxBuffer: 1024 * 1024, env: env ?? process.env },
      (error, stdout) => {
        if (error) {
          reject(error)
        } else {
          resolvePromise(stdout)
        }
      }
    )
  })
}

function asarUnpackedPath(filePath: string): string {
  return filePath.replace(/app\.asar([/\\]|$)/g, 'app.asar.unpacked$1')
}

async function findPackageRoot(startDir: string): Promise<string | null> {
  let dir = startDir
  for (;;) {
    try {
      const raw = await readFile(join(dir, 'package.json'), 'utf8')
      if (raw.includes('"@earendil-works/pi-coding-agent"')) {
        return dir
      }
    } catch {
      // keep walking up
    }
    const parent = resolve(dir, '..')
    if (parent === dir) {
      return null
    }
    dir = parent
  }
}

function defaultDeps(appPath: string): LocatorDeps {
  return {
    platform: process.platform,
    env: process.env,
    homeDir: homedir(),
    shell: process.env['SHELL'],

    async isExecutable(filePath) {
      try {
        await access(filePath, this.platform === 'win32' ? undefined : 1) // X_OK
        return true
      } catch {
        return false
      }
    },

    async readVersion(command, args, env) {
      try {
        return await execText(command, [...args, '--version'], VERSION_TIMEOUT_MS, {
          ...process.env,
          ...env
        } as Record<string, string>)
      } catch {
        return null
      }
    },

    async readLoginShellPath() {
      const shell = this.shell
      if (!shell || this.platform === 'win32') {
        return null
      }
      try {
        const out = await execText(shell, ['-ilc', 'printf "%s" "$PATH"'], SHELL_PATH_TIMEOUT_MS)
        return out.length > 0 ? out : null
      } catch {
        return null
      }
    },

    async resolveBundledCli() {
      // The package's "exports" map is import-only and does not expose
      // ./package.json, so locate the package root directly instead.
      const candidates: string[] = [
        join(appPath, 'node_modules', '@earendil-works', 'pi-coding-agent')
      ]
      try {
        const resolved = import.meta.resolve('@earendil-works/pi-coding-agent')
        if (resolved.startsWith('file:')) {
          const root = await findPackageRoot(dirname(fileURLToPath(resolved)))
          if (root) {
            candidates.unshift(root)
          }
        }
      } catch {
        // import.meta.resolve unavailable or package not resolvable
      }

      for (const candidate of candidates) {
        // In packaged builds the app runs out of app.asar; the dependency must
        // be shipped unpacked so pi can spawn as a child process.
        const packageRoot = asarUnpackedPath(candidate)
        const cliPath = join(packageRoot, 'dist', 'bundle', 'cli.js')
        try {
          await access(cliPath)
        } catch {
          continue
        }
        let version: string | null = null
        try {
          const pkg = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8')) as {
            version?: string
          }
          version = typeof pkg.version === 'string' ? pkg.version : null
        } catch {
          // version stays null
        }
        return { cliPath, version }
      }
      return null
    }
  }
}

// ---------------------------------------------------------------------------
// Pure helpers (exported for tests)
// ---------------------------------------------------------------------------

/** Parse a semver-ish version out of `pi --version` output. */
export function parsePiVersion(output: string): string | null {
  const match = output.match(/\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?/)
  return match ? match[0] : null
}

/** Merge PATH strings and extra dirs, deduped, first occurrence wins. */
export function mergePathEntries(
  platform: NodeJS.Platform,
  homeDir: string,
  ...sources: (string | null | undefined)[]
): string {
  const sep = platform === 'win32' ? ';' : delimiter
  const seen = new Set<string>()
  const dirs: string[] = []
  const addDir = (dir: string) => {
    const expanded = dir.startsWith('~') ? join(homeDir, dir.slice(1)) : dir
    if (expanded && !seen.has(expanded)) {
      seen.add(expanded)
      dirs.push(expanded)
    }
  }
  for (const source of sources) {
    if (!source) {
      continue
    }
    for (const dir of source.split(sep)) {
      if (dir) {
        addDir(dir)
      }
    }
  }
  for (const dir of COMMON_BIN_DIRS) {
    addDir(dir)
  }
  return dirs.join(sep)
}

function pathDirs(pathValue: string, platform: NodeJS.Platform): string[] {
  const sep = platform === 'win32' ? ';' : delimiter
  return pathValue.split(sep).filter((dir) => dir.length > 0)
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

async function findInstalledPi(deps: LocatorDeps, mergedPath: string): Promise<string | null> {
  const names = deps.platform === 'win32' ? ['pi.cmd', 'pi.exe', 'pi'] : ['pi']
  for (const dir of pathDirs(mergedPath, deps.platform)) {
    for (const name of names) {
      const candidate = join(dir, name)
      if (await deps.isExecutable(candidate)) {
        return candidate
      }
    }
  }
  return null
}

async function buildRuntime(
  kind: PiRuntime['kind'],
  command: string,
  args: string[],
  deps: LocatorDeps,
  mergedPath: string
): Promise<PiRuntime | null> {
  const env: Record<string, string> = { PATH: mergedPath }
  if (kind === 'bundled') {
    env['ELECTRON_RUN_AS_NODE'] = '1'
  }
  // The version probe must run with the same env the child will get: the
  // merged PATH makes `#!/usr/bin/env node` shebangs work in clean GUI
  // environments, and ELECTRON_RUN_AS_NODE=1 turns the Electron binary into
  // plain Node for the bundled CLI — without it the probe spawns a whole
  // second app instance.
  const versionOutput = await deps.readVersion(command, args, env)
  const version = versionOutput === null ? null : parsePiVersion(versionOutput)
  if (version === null) {
    return null
  }
  return { kind, command, args, env, version }
}

let cachedLoginShellEnv: Promise<Record<string, string>> | null = null

/**
 * Environment for terminal tabs and spawned tools: the process env plus the
 * login-shell merged PATH (so GUI-launched apps find user tools). Strips
 * ELECTRON_RUN_AS_NODE — terminals must never inherit the Electron-as-Node
 * switch the bundled pi runtime uses.
 */
export function loginShellEnv(): Promise<Record<string, string>> {
  if (!cachedLoginShellEnv) {
    cachedLoginShellEnv = (async () => {
      const deps = defaultDeps(process.cwd())
      const loginPath = await deps.readLoginShellPath()
      const env = { ...process.env } as Record<string, string>
      delete env['ELECTRON_RUN_AS_NODE']
      env['PATH'] = mergePathEntries(
        deps.platform,
        deps.homeDir,
        loginPath,
        deps.env['PATH'] ?? deps.env['Path']
      )
      return env
    })()
  }
  return cachedLoginShellEnv
}

export async function resolvePiRuntime(opts: ResolvePiRuntimeOptions = {}): Promise<PiRuntime> {
  const deps: LocatorDeps = { ...defaultDeps(opts.appPath ?? process.cwd()), ...opts.deps }

  const loginPath = await deps.readLoginShellPath()
  const envPath = deps.env['PATH'] ?? deps.env['Path']
  const mergedPath = mergePathEntries(deps.platform, deps.homeDir, loginPath, envPath)

  // 1. Custom path wins when valid.
  const requestedCustomPath = opts.customPath
  if (requestedCustomPath) {
    const customPath = await realpath(requestedCustomPath).catch(() => requestedCustomPath)
    const runtime = await buildRuntime('custom', customPath, [], deps, mergedPath)
    if (runtime) {
      return runtime
    }
  }

  const installed = async (): Promise<PiRuntime | null> => {
    const piPath = await findInstalledPi(deps, mergedPath)
    if (!piPath) {
      return null
    }
    return buildRuntime('installed', piPath, [], deps, mergedPath)
  }

  const bundled = async (): Promise<PiRuntime | null> => {
    const bundled = await deps.resolveBundledCli()
    if (!bundled) {
      return null
    }
    const runtime = await buildRuntime('bundled', process.execPath, [bundled.cliPath], deps, mergedPath)
    if (runtime) {
      return runtime
    }
    // `node cli.js --version` may fail if the bundled Node is too old; keep the
    // package version as a fallback so the runtime is still usable.
    return {
      kind: 'bundled',
      command: process.execPath,
      args: [bundled.cliPath],
      env: { PATH: mergedPath, ELECTRON_RUN_AS_NODE: '1' },
      version: bundled.version
    }
  }

  const attempts =
    opts.mode === 'installed'
      ? [installed]
      : opts.mode === 'bundled'
        ? [bundled]
        : opts.preferBundled
          ? [bundled, installed]
          : [installed, bundled]
  for (const attempt of attempts) {
    const runtime = await attempt()
    if (runtime) {
      return runtime
    }
  }

  const modeNote =
    opts.mode === 'installed'
      ? ' (runtime mode: installed — bundled fallback disabled)'
      : opts.mode === 'bundled'
        ? ' (runtime mode: bundled — installed fallback disabled)'
        : ''
  throw new Error(
    'No pi runtime found: no valid custom path, no pi executable on PATH, and the bundled @earendil-works/pi-coding-agent is unavailable' +
      modeNote
  )
}
