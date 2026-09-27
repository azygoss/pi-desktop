import { PiRpcClient } from './rpc-client'
import { resolvePiRuntime, type PiRuntime, type ResolvePiRuntimeOptions } from './locator'

export interface OpenChatOptions {
  cwd: string
  sessionPath?: string
  extraArgs?: string[]
}

/**
 * One `pi --mode rpc` process per open chat, keyed by chatId. The pi runtime
 * is resolved once and cached; call `refreshRuntime()` to re-resolve (e.g.
 * after the user changes the configured pi path).
 */
export class PiProcessPool {
  private readonly clients = new Map<string, PiRpcClient>()
  private runtime: PiRuntime | null = null
  private runtimePromise: Promise<PiRuntime> | null = null
  private runtimeOptions: ResolvePiRuntimeOptions

  constructor(runtimeOptions: ResolvePiRuntimeOptions = {}) {
    this.runtimeOptions = runtimeOptions
  }

  /**
   * Replace the runtime resolution options and drop the cached runtime, so
   * the next open()/refreshRuntime() resolves with the new settings.
   */
  setRuntimeOptions(options: ResolvePiRuntimeOptions): void {
    this.runtimeOptions = options
    this.runtime = null
    this.runtimePromise = null
  }

  async getRuntime(): Promise<PiRuntime> {
    if (this.runtime) {
      return this.runtime
    }
    if (!this.runtimePromise) {
      this.runtimePromise = resolvePiRuntime(this.runtimeOptions).then((runtime) => {
        this.runtime = runtime
        return runtime
      })
    }
    return this.runtimePromise
  }

  async refreshRuntime(): Promise<PiRuntime> {
    this.runtime = null
    this.runtimePromise = null
    return this.getRuntime()
  }

  /** Open (or reuse) the pi process for a chat. */
  async open(chatId: string, options: OpenChatOptions): Promise<PiRpcClient> {
    const existing = this.clients.get(chatId)
    if (existing?.isRunning) {
      return existing
    }
    const runtime = await this.getRuntime()
    const client = new PiRpcClient({
      runtime,
      cwd: options.cwd,
      sessionPath: options.sessionPath,
      extraArgs: options.extraArgs
    })
    client.on('exit', () => {
      if (this.clients.get(chatId) === client) {
        this.clients.delete(chatId)
      }
    })
    this.clients.set(chatId, client)
    client.start()
    return client
  }

  get(chatId: string): PiRpcClient | undefined {
    return this.clients.get(chatId)
  }

  async close(chatId: string): Promise<void> {
    const client = this.clients.get(chatId)
    this.clients.delete(chatId)
    await client?.stop()
  }

  /** Stop every process; call on app 'before-quit'. */
  async closeAll(): Promise<void> {
    const clients = [...this.clients.values()]
    this.clients.clear()
    await Promise.all(clients.map((client) => client.stop()))
  }
}
