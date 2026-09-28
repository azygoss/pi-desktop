import { EventEmitter } from 'node:events'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { spawn, type ChildProcess } from 'node:child_process'
import { app } from 'electron'

/**
 * Supervisor for the Swift dictation helper
 * (resources/dictation-helper → bin/pi-desktop-dictation). JSONL over stdio:
 * request/response commands correlate by `id`; recognition events stream
 * without an id and are forwarded to listeners. The helper is spawned lazily
 * on first use and killed after 5 minutes idle or when recording stops.
 */

const DEFAULT_TIMEOUT_MS = 15_000
const IDLE_KILL_MS = 5 * 60 * 1000

export interface DictationEvent {
  event: string
  text?: string
  rms?: number
  message?: string
}

export interface DictationServiceDeps {
  helperPath?: string
  spawn?: (cmd: string, args: string[]) => ChildProcess
}

interface Pending {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

export class DictationService {
  private process: ChildProcess | null = null
  private buffer = ''
  private nextId = 1
  private readonly pending = new Map<number, Pending>()
  private idleTimer: ReturnType<typeof setTimeout> | null = null
  private readonly emitter = new EventEmitter()
  /** True between a successful `start` and stopped/cancelled/crash. */
  private recording_ = false

  constructor(private readonly deps: DictationServiceDeps = {}) {
    this.emitter.setMaxListeners(50)
  }

  get recording(): boolean {
    return this.recording_
  }

  /** The helper binary exists and we're on macOS (explicit overrides exempt
   *  the platform check so tests can run a stand-in anywhere). */
  available(): boolean {
    const override = this.deps.helperPath || process.env['PI_DESKTOP_DICTATION_HELPER']
    if (override) {
      return existsSync(override)
    }
    return process.platform === 'darwin' && existsSync(this.helperPath())
  }

  private helperPath(): string {
    if (this.deps.helperPath) {
      return this.deps.helperPath
    }
    if (process.env['PI_DESKTOP_DICTATION_HELPER']) {
      return process.env['PI_DESKTOP_DICTATION_HELPER']
    }
    if (app?.isPackaged) {
      return join(process.resourcesPath, 'dictation-helper', 'pi-desktop-dictation')
    }
    return join(import.meta.dirname, '../../resources/dictation-helper/bin/pi-desktop-dictation')
  }

  onEvent(listener: (event: DictationEvent) => void): () => void {
    this.emitter.on('dictation', listener)
    return () => this.emitter.off('dictation', listener)
  }

  private emitEvent(event: DictationEvent): void {
    this.emitter.emit('dictation', event)
  }

  dispose(): void {
    this.killProcess()
    this.emitter.removeAllListeners()
  }

  private killProcess(): void {
    const proc = this.process
    this.process = null
    if (proc) {
      proc.kill()
    }
    this.rejectAll(new Error('dictation helper exited'))
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
      throw new Error('dictation helper is not available')
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
    proc.on('exit', () => {
      if (this.process === proc) {
        this.process = null
      }
      this.recording_ = false
      this.rejectAll(new Error('dictation helper exited'))
      this.emitEvent({ event: 'error', message: 'Dictation stopped unexpectedly' })
    })
    proc.on('error', () => {
      if (this.process === proc) {
        this.process = null
      }
      this.recording_ = false
      this.rejectAll(new Error('dictation helper failed to start'))
    })
    this.process = proc
    return proc
  }

  private onLine(line: string): void {
    let message: { id?: unknown; ok?: boolean; result?: unknown; error?: unknown; event?: unknown }
    try {
      message = JSON.parse(line) as typeof message
    } catch {
      return
    }
    // Streaming recognition events carry no id.
    if (typeof message.event === 'string' && message.id === undefined) {
      if (message.event === 'stopped' || message.event === 'cancelled' || message.event === 'error') {
        this.recording_ = false
      }
      this.emitEvent(message as unknown as DictationEvent)
      if (this.pending.size === 0) {
        this.scheduleIdleKill()
      }
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
        new Error(typeof message.error === 'string' ? message.error : 'dictation helper error')
      )
    }
    if (this.pending.size === 0 && !this.recording_) {
      this.scheduleIdleKill()
    }
  }

  /** Id-correlated command (permissions, locales, start, stop, cancel). */
  async call(
    cmd: string,
    args: Record<string, unknown> = {},
    timeoutMs = DEFAULT_TIMEOUT_MS
  ): Promise<unknown> {
    const proc = this.ensureProcess()
    const id = this.nextId++
    return new Promise((resolvePromise, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`dictation helper timeout: ${cmd}`))
      }, timeoutMs)
      this.pending.set(id, { resolve: resolvePromise, reject, timer })
      proc.stdin!.write(JSON.stringify({ id, cmd, args }) + '\n')
      if (this.idleTimer) {
        clearTimeout(this.idleTimer)
        this.idleTimer = null
      }
    })
  }

  /** Start recording; resolves once the helper acknowledged. */
  async start(args: { locale?: string; autoStop?: boolean }): Promise<void> {
    await this.call('start', args, 30_000)
    this.recording_ = true
  }

  /** Finish recognition and emit the final transcript. */
  async stop(): Promise<void> {
    if (!this.process) {
      return
    }
    await this.call('stop', {}, 10_000).catch(() => {})
  }

  /** Abort without committing any partial transcript. */
  async cancel(): Promise<void> {
    this.recording_ = false
    if (!this.process) {
      return
    }
    await this.call('cancel', {}, 10_000).catch(() => {})
  }
}
