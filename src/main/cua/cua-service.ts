import { EventEmitter } from 'node:events'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { spawn, type ChildProcess } from 'node:child_process'
import { app } from 'electron'

/**
 * Thin supervisor for the Swift computer-use helper
 * (resources/cua-helper → bin/pi-desktop-cua). JSONL over stdio, one request
 * in flight per id, sequential execution inside the helper. The helper is
 * spawned lazily on the first call and killed after 5 minutes idle; a crash
 * rejects pending requests and the next call respawns it.
 */

const DEFAULT_TIMEOUT_MS = 15_000
const IDLE_KILL_MS = 5 * 60 * 1000

const TIMEOUTS: Record<string, number> = {
  app_state: 20_000,
  launch: 10_000,
  activate: 10_000
}

/** Commands that drive input or mutate UI — gated by pause/stop. */
const READ_ONLY_COMMANDS = new Set(['permissions', 'list_apps', 'app_state', 'screenshot'])

export interface CuaActivity {
  chatId?: string
  phase: 'start' | 'end' | 'paused' | 'resumed'
  cmd: string
  app?: string
  summary: string
}

export interface CuaServiceDeps {
  /** Override helper path (tests); defaults to env/packaged/dev locations. */
  helperPath?: string
  /** Override spawn — tests inject a fake child. */
  spawn?: (cmd: string, args: string[]) => ChildProcess
}

interface Pending {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

export class CuaService {
  private process: ChildProcess | null = null
  private buffer = ''
  private nextId = 1
  private readonly pending = new Map<number, Pending>()
  private idleTimer: ReturnType<typeof setTimeout> | null = null
  private paused_ = false
  private pauseWaiters: { resolve(): void; reject(e: Error): void }[] = []
  private readonly emitter = new EventEmitter()

  constructor(private readonly deps: CuaServiceDeps = {}) {
    this.emitter.setMaxListeners(50)
  }

  get paused(): boolean {
    return this.paused_
  }

  /** The helper binary exists and we're on macOS (explicit overrides exempt
   *  the platform check so tests can run a stand-in anywhere). */
  available(): boolean {
    const override = this.deps.helperPath || process.env['PI_DESKTOP_CUA_HELPER']
    if (override) {
      return existsSync(override)
    }
    return process.platform === 'darwin' && existsSync(this.helperPath())
  }

  private helperPath(): string {
    if (this.deps.helperPath) {
      return this.deps.helperPath
    }
    if (process.env['PI_DESKTOP_CUA_HELPER']) {
      return process.env['PI_DESKTOP_CUA_HELPER']
    }
    if (app?.isPackaged) {
      return join(process.resourcesPath, 'cua-helper', 'pi-desktop-cua')
    }
    return join(import.meta.dirname, '../../resources/cua-helper/bin/pi-desktop-cua')
  }

  onActivity(listener: (event: CuaActivity) => void): () => void {
    this.emitter.on('activity', listener)
    return () => this.emitter.off('activity', listener)
  }

  emitActivity(event: CuaActivity): void {
    this.emitter.emit('activity', event)
  }

  /** Block action commands until resume() (or reject them via abortAll). */
  pause(): void {
    if (this.paused_) {
      return
    }
    this.paused_ = true
    this.emitActivity({ phase: 'paused', cmd: '', summary: 'Paused' })
  }

  resume(): void {
    if (!this.paused_) {
      return
    }
    this.paused_ = false
    this.emitActivity({ phase: 'resumed', cmd: '', summary: 'Resumed' })
    for (const waiter of this.pauseWaiters.splice(0)) {
      waiter.resolve()
    }
  }

  /** Stop gate: reject everything queued behind the pause or in flight. */
  abortAll(message = 'Computer use stopped by the user'): void {
    const error = new Error(message)
    for (const waiter of this.pauseWaiters.splice(0)) {
      waiter.reject(error)
    }
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(error)
    }
    this.pending.clear()
    // The gate stays where it was — resume() is the renderer's job.
  }

  dispose(): void {
    this.abortAll('Pi Desktop is quitting')
    this.killProcess()
    this.emitter.removeAllListeners()
  }

  /**
   * Stop an idle helper so the next call starts a fresh one. A process keeps
   * the permission state it saw at launch for some AX calls, so after the
   * user grants access a new helper is the reliable way to pick it up.
   */
  recycle(): void {
    if (this.pending.size === 0 && this.process) {
      this.killProcess()
    }
  }

  private killProcess(): void {
    const proc = this.process
    this.process = null
    if (proc) {
      proc.kill()
    }
    this.rejectAll(new Error('cua helper exited'))
  }

  private rejectAll(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(error)
    }
    this.pending.clear()
  }

  private scheduleIdleKill(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer)
    }
    this.idleTimer = setTimeout(() => {
      if (this.pending.size === 0) {
        this.killProcess()
      }
    }, IDLE_KILL_MS)
    this.idleTimer.unref?.()
  }

  private ensureProcess(): ChildProcess {
    if (this.process && !this.process.killed) {
      return this.process
    }
    const path = this.helperPath()
    if (!this.available()) {
      throw new Error('computer-use helper is not available')
    }
    const spawnFn =
      this.deps.spawn ?? ((cmd: string, args: string[]) => spawn(cmd, args, { stdio: ['pipe', 'pipe', 'inherit'] }))
    const proc = spawnFn(path, [])
    this.buffer = ''
    proc.stdout!.on('data', (chunk: Buffer) => {
      this.buffer += chunk.toString('utf8')
      // Strict JSONL: split on \n only (U+2028/2029 are valid inside JSON).
      let index = this.buffer.indexOf('\n')
      while (index >= 0) {
        let line = this.buffer.slice(0, index)
        this.buffer = this.buffer.slice(index + 1)
        if (line.endsWith('\r')) {
          line = line.slice(0, -1)
        }
        if (line.trim()) {
          this.onLine(line)
        }
        index = this.buffer.indexOf('\n')
      }
    })
    // Only the current helper's death fails what is pending: a recycled
    // one exits after its replacement may already hold new requests.
    proc.on('exit', () => {
      if (this.process === proc) {
        this.process = null
        this.rejectAll(new Error('cua helper exited'))
      }
    })
    proc.on('error', () => {
      if (this.process === proc) {
        this.process = null
        this.rejectAll(new Error('cua helper failed to start'))
      }
    })
    this.process = proc
    return proc
  }

  private onLine(line: string): void {
    let message: { id?: unknown; ok?: boolean; result?: unknown; error?: unknown }
    try {
      message = JSON.parse(line) as typeof message
    } catch {
      return
    }
    const id = typeof message.id === 'number' ? message.id : undefined
    if (id === undefined) {
      return
    }
    const pending = this.pending.get(id)
    if (!pending) {
      return
    }
    this.pending.delete(id)
    clearTimeout(pending.timer)
    if (message.ok === true) {
      pending.resolve(message.result)
    } else {
      pending.reject(
        new Error(typeof message.error === 'string' ? message.error : 'helper error')
      )
    }
    if (this.pending.size === 0) {
      this.scheduleIdleKill()
    }
  }

  /**
   * Call a helper command. Read-only commands pass through while paused;
   * action commands wait for resume() and reject on abortAll().
   */
  async call(
    cmd: string,
    args: Record<string, unknown> = {},
    opts: { timeoutMs?: number; chatId?: string } = {}
  ): Promise<unknown> {
    if (!READ_ONLY_COMMANDS.has(cmd)) {
      await this.waitWhilePaused()
    }
    const proc = this.ensureProcess()
    const id = this.nextId++
    const timeoutMs = opts.timeoutMs ?? TIMEOUTS[cmd] ?? DEFAULT_TIMEOUT_MS
    return new Promise((resolvePromise, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`cua helper timeout: ${cmd}`))
      }, timeoutMs)
      this.pending.set(id, { resolve: resolvePromise, reject, timer })
      proc.stdin!.write(JSON.stringify({ id, cmd, args }) + '\n')
      if (this.idleTimer) {
        clearTimeout(this.idleTimer)
        this.idleTimer = null
      }
    })
  }

  private waitWhilePaused(): Promise<void> {
    if (!this.paused_) {
      return Promise.resolve()
    }
    return new Promise((resolvePromise, reject) => {
      this.pauseWaiters.push({ resolve: resolvePromise, reject })
    })
  }
}
