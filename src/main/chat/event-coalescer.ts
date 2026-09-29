import type { PiEvent } from '../../shared/pi-types'

/**
 * Buffers `message_update` deltas and emits them as one IPC payload per
 * flush window. Any non-delta event flushes immediately so ordering is
 * preserved end to end (deltas of a message always arrive before its
 * `message_end`). `dispose` drops the timer without emitting.
 *
 * The 32ms window matches the renderer's ~30fps commit cap: a shorter one
 * only adds IPC wakeups the renderer would batch again anyway.
 */
export class EventCoalescer {
  private buffer: PiEvent[] = []
  private timer: ReturnType<typeof setTimeout> | null = null

  constructor(
    private readonly emit: (events: PiEvent[]) => void,
    private readonly intervalMs = 32
  ) {}

  push(event: PiEvent): void {
    this.buffer.push(event)
    if (event.type === 'message_update') {
      if (!this.timer) {
        this.timer = setTimeout(() => this.flush(), this.intervalMs)
        this.timer.unref?.()
      }
      return
    }
    this.flush()
  }

  flush(): void {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    if (this.buffer.length === 0) {
      return
    }
    const events = this.buffer
    this.buffer = []
    this.emit(events)
  }

  dispose(): void {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    this.buffer = []
  }
}
