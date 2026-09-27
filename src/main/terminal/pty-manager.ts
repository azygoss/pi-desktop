import { chmodSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'

import type { IPty } from 'node-pty'

import type { TerminalSpawnInput } from '../../shared/api'

const FLUSH_MS = 16
const FLUSH_BYTES = 64 * 1024
const MAX_INPUT_BYTES = 1024 * 1024

export interface PtyCallbacks {
  onData(id: string, data: string): void
  onExit(id: string, exitCode: number, signal?: number): void
}

export interface PtySpawnOptions extends TerminalSpawnInput {
  /**
   * Child environment, computed in the main process (login-shell env for
   * plain terminals, the resolved pi runtime env for pi TUI tabs). The
   * renderer never supplies env values.
   */
  env: Record<string, string>
}

interface PtyRecord {
  pty: IPty
  buffer: string
  timer: NodeJS.Timeout | null
}

/**
 * Owns node-pty child processes for terminal tabs. Output is batched (flush
 * every ~16ms or 64KB) to keep IPC traffic low; input goes straight through.
 */
export class PtyManager {
  private readonly records = new Map<string, PtyRecord>()

  constructor(private readonly callbacks: PtyCallbacks) {}

  /** Spawn a terminal. Empty `argv` spawns the login shell. */
  async spawn(input: PtySpawnOptions): Promise<{ id: string }> {
    if (this.records.has(input.id)) {
      throw new Error(`Terminal ${input.id} already exists`)
    }
    ensureSpawnHelper()
    const { spawn } = await import('node-pty')
    const argv = input.argv && input.argv.length > 0 ? input.argv : null
    const command = argv ? argv[0]! : shellPath()
    const args = argv ? argv.slice(1) : ['-l']

    const child = spawn(command, args, {
      name: 'xterm-256color',
      cwd: input.cwd,
      env: input.env,
      cols: clamp(input.cols, 20, 500, 120),
      rows: clamp(input.rows, 4, 200, 30)
    })

    const record: PtyRecord = { pty: child, buffer: '', timer: null }
    this.records.set(input.id, record)

    child.onData((data) => {
      record.buffer += data
      if (record.buffer.length >= FLUSH_BYTES) {
        this.flush(input.id)
      } else if (!record.timer) {
        record.timer = setTimeout(() => this.flush(input.id), FLUSH_MS)
      }
    })
    child.onExit(({ exitCode, signal }) => {
      this.flush(input.id)
      this.records.delete(input.id)
      this.callbacks.onExit(input.id, exitCode, signal)
    })

    if (input.initialInput) {
      // The pty line discipline buffers input written before the program is
      // ready to read it, so this is safe to write immediately.
      child.write(input.initialInput.slice(0, MAX_INPUT_BYTES))
    }
    return { id: input.id }
  }

  has(id: string): boolean {
    return this.records.has(id)
  }

  write(id: string, data: string): void {
    if (data.length > MAX_INPUT_BYTES) {
      data = data.slice(0, MAX_INPUT_BYTES)
    }
    this.records.get(id)?.pty.write(data)
  }

  resize(id: string, cols: number, rows: number): void {
    this.records.get(id)?.pty.resize(clamp(cols, 20, 500, 120), clamp(rows, 4, 200, 30))
  }

  async kill(id: string): Promise<void> {
    const record = this.records.get(id)
    if (!record) {
      return
    }
    this.records.delete(id)
    try {
      record.pty.kill()
    } catch {
      // already gone
    }
  }

  async killAll(): Promise<void> {
    const ids = [...this.records.keys()]
    await Promise.all(ids.map((id) => this.kill(id)))
  }

  private flush(id: string): void {
    const record = this.records.get(id)
    if (!record) {
      return
    }
    if (record.timer) {
      clearTimeout(record.timer)
      record.timer = null
    }
    if (record.buffer.length > 0) {
      const data = record.buffer
      record.buffer = ''
      this.callbacks.onData(id, data)
    }
  }
}

const require_ = createRequire(import.meta.url)
let helperFixed = false

/**
 * node-pty spawns a `spawn-helper` binary for each pty. Some installs lose
 * the executable bit (pnpm store hardlinks, asar extraction); restore it
 * lazily — without it every spawn fails with `posix_spawnp failed`.
 */
function ensureSpawnHelper(): void {
  if (helperFixed || process.platform === 'win32') {
    return
  }
  helperFixed = true
  try {
    const pkgDir = dirname(require_.resolve('node-pty/package.json')).replace(
      'app.asar',
      'app.asar.unpacked'
    )
    // Prebuilds layout and the build/Release layout produced by
    // @electron/rebuild during packaging.
    for (const helper of [
      join(pkgDir, 'prebuilds', `${process.platform}-${process.arch}`, 'spawn-helper'),
      join(pkgDir, 'build', 'Release', 'spawn-helper')
    ]) {
      try {
        chmodSync(helper, 0o755)
      } catch {
        // not present in this layout
      }
    }
  } catch {
    // node-pty unresolvable — spawn will surface a clear error either way.
  }
}

function shellPath(): string {
  return process.env['SHELL'] || (process.platform === 'win32' ? 'cmd.exe' : '/bin/zsh')
}

function clamp(value: number | undefined, min: number, max: number, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return fallback
  }
  return Math.max(min, Math.min(max, Math.floor(value)))
}
