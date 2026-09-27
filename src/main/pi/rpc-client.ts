import { spawn, type ChildProcess } from 'node:child_process'
import { EventEmitter } from 'node:events'
import type {
  ExtensionUiRequest,
  ExtensionUiResponse,
  PiEvent,
  PiRpcCommand,
  PiRpcResponse
} from '../../shared/pi-types'

// Accept forward-compatible command objects so newer pi commands do not
// require a client update.
export type PiRpcWireCommand = PiRpcCommand | ({ type: string } & Record<string, unknown>)
import type { PiRuntime } from './locator'
import { createJsonlReader } from './jsonl'

export interface PiRpcClientOptions {
  runtime: PiRuntime
  cwd: string
  sessionPath?: string
  extraArgs?: string[]
}

export interface PiRpcExit {
  code: number | null
  signal: NodeJS.Signals | null
}

export interface PiRpcProtocolError {
  line: string
  error: string
}

interface PendingRequest {
  command: string
  resolve: (data: unknown) => void
  reject: (error: Error) => void
  timer: NodeJS.Timeout
}

const STDERR_BUFFER_LINES = 200
const KILL_GRACE_MS = 3000

export interface PiRpcClientEvents {
  event: (event: PiEvent) => void
  'ui-request': (request: ExtensionUiRequest) => void
  stderr: (line: string) => void
  exit: (exit: PiRpcExit) => void
  'protocol-error': (error: PiRpcProtocolError) => void
}

/**
 * JSONL RPC client for one `pi --mode rpc` child process. One instance per
 * chat; correlate requests via the auto-assigned `id` field.
 */
export class PiRpcClient {
  private readonly emitter = new EventEmitter()
  private readonly options: PiRpcClientOptions
  private process: ChildProcess | null = null
  private pending = new Map<string, PendingRequest>()
  private requestCounter = 0
  private stderrLines: string[] = []
  private exited = false

  constructor(options: PiRpcClientOptions) {
    this.options = options
  }

  on<K extends keyof PiRpcClientEvents>(event: K, listener: PiRpcClientEvents[K]): this {
    this.emitter.on(event, listener)
    return this
  }

  once<K extends keyof PiRpcClientEvents>(event: K, listener: PiRpcClientEvents[K]): this {
    this.emitter.once(event, listener)
    return this
  }

  off<K extends keyof PiRpcClientEvents>(event: K, listener: PiRpcClientEvents[K]): this {
    this.emitter.off(event, listener)
    return this
  }

  private emit<K extends keyof PiRpcClientEvents>(
    event: K,
    ...args: Parameters<PiRpcClientEvents[K]>
  ): void {
    this.emitter.emit(event, ...args)
  }

  get pid(): number | undefined {
    return this.process?.pid
  }

  get isRunning(): boolean {
    return this.process !== null && !this.exited
  }

  /** Recent stderr lines, kept for diagnostics (never the RPC payload). */
  get stderrTail(): readonly string[] {
    return this.stderrLines
  }

  start(): void {
    if (this.process) {
      throw new Error('PiRpcClient is already started')
    }
    const { runtime, cwd, sessionPath, extraArgs } = this.options
    const args = [
      ...runtime.args,
      '--mode',
      'rpc',
      ...(sessionPath ? ['--session', sessionPath] : []),
      ...(extraArgs ?? [])
    ]
    const child = spawn(runtime.command, args, {
      cwd,
      env: { ...process.env, ...runtime.env },
      stdio: ['pipe', 'pipe', 'pipe']
    })
    this.process = child

    const stdoutReader = createJsonlReader((line) => this.handleLine(line))
    child.stdout?.on('data', (chunk: Buffer) => stdoutReader.push(chunk))
    child.stdout?.on('end', () => stdoutReader.end())

    const stderrReader = createJsonlReader((line) => this.handleStderr(line))
    child.stderr?.on('data', (chunk: Buffer) => stderrReader.push(chunk))
    child.stderr?.on('end', () => stderrReader.end())

    child.on('error', (error) => {
      this.handleExit(null, null, error)
    })
    child.on('exit', (code, signal) => {
      this.handleExit(code, signal)
    })
  }

  /** Send a command and resolve with its `data` (undefined when absent). */
  request<T = unknown>(
    command: PiRpcWireCommand,
    options: { timeoutMs?: number } = {}
  ): Promise<T | undefined> {
    const { timeoutMs = 30000 } = options
    if (!this.process?.stdin?.writable || this.exited) {
      return Promise.reject(new Error('pi process is not running'))
    }
    const id = `req-${++this.requestCounter}`
    const wire = { ...command, id }

    return new Promise<T | undefined>((resolvePromise, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`pi request "${command.type}" timed out after ${timeoutMs}ms`))
      }, timeoutMs)
      timer.unref?.()

      this.pending.set(id, {
        command: command.type,
        resolve: resolvePromise as (data: unknown) => void,
        reject,
        timer
      })
      this.process!.stdin!.write(JSON.stringify(wire) + '\n')
    })
  }

  /** Respond to an `extension_ui_request` dialog (select/confirm/input/editor). */
  respondUi(response: Omit<ExtensionUiResponse, 'type'>): void {
    this.sendRaw({ type: 'extension_ui_response', ...response })
  }

  /** Fire-and-forget write of a raw command object. */
  sendRaw(command: Record<string, unknown>): void {
    if (!this.process?.stdin?.writable || this.exited) {
      return
    }
    this.process.stdin.write(JSON.stringify(command) + '\n')
  }

  /** Graceful shutdown: SIGTERM, then SIGKILL after a grace period. */
  async stop(): Promise<void> {
    const child = this.process
    if (!child || this.exited) {
      return
    }
    const exitedPromise = new Promise<void>((resolvePromise) => {
      if (this.exited) {
        resolvePromise()
        return
      }
      this.once('exit', () => resolvePromise())
    })
    child.kill('SIGTERM')
    const killer = setTimeout(() => {
      if (!this.exited) {
        child.kill('SIGKILL')
      }
    }, KILL_GRACE_MS)
    killer.unref?.()
    await exitedPromise
    clearTimeout(killer)
  }

  private handleLine(line: string): void {
    let message: Record<string, unknown>
    try {
      message = JSON.parse(line) as Record<string, unknown>
    } catch (error) {
      this.emit('protocol-error', {
        line,
        error: error instanceof Error ? error.message : String(error)
      })
      return
    }

    const id = typeof message['id'] === 'string' ? message['id'] : undefined
    const pending = id !== undefined ? this.pending.get(id) : undefined
    if (message['type'] === 'response' && pending) {
      this.pending.delete(id!)
      clearTimeout(pending.timer)
      const response = message as unknown as PiRpcResponse
      if (response.success) {
        pending.resolve(response.data)
      } else {
        pending.reject(new Error(response.error ?? `pi command "${response.command}" failed`))
      }
      return
    }

    const event = message as unknown as PiEvent
    if (event.type === 'extension_ui_request') {
      this.emit('ui-request', event as ExtensionUiRequest)
    }
    this.emit('event', event)
  }

  private handleStderr(line: string): void {
    this.stderrLines.push(line)
    if (this.stderrLines.length > STDERR_BUFFER_LINES) {
      this.stderrLines.splice(0, this.stderrLines.length - STDERR_BUFFER_LINES)
    }
    this.emit('stderr', line)
  }

  private handleExit(code: number | null, signal: NodeJS.Signals | null, error?: Error): void {
    if (this.exited) {
      return
    }
    this.exited = true
    const reason =
      error ?? new Error(`pi process exited (code ${code ?? 'null'}, signal ${signal ?? 'null'})`)
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(reason)
    }
    this.pending.clear()
    this.emit('exit', { code, signal })
  }
}
