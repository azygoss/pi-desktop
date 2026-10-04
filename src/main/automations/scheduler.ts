import { nextRunAt, type Automation } from '../../shared/automations'

/** The timer never sleeps longer than this, so a clock change or a wake
 *  from sleep is noticed within a few minutes. */
const MAX_SLEEP_MS = 5 * 60_000

export interface SchedulerDeps {
  list(): Promise<Automation[]>
  markRun(id: string, at: number): Promise<void>
  /**
   * Start the run; false when it could not start (no window, pi failed) —
   * retried shortly.
   */
  trigger(automation: Automation): boolean | Promise<boolean>
  now?(): number
}

/**
 * Runs due automations while the app is open: one timer aimed at the next
 * due time, re-aimed after every run and whenever the list changes.
 */
export class AutomationScheduler {
  private timer: ReturnType<typeof setTimeout> | null = null
  private stopped = false
  private readonly now: () => number

  constructor(private readonly deps: SchedulerDeps) {
    this.now = deps.now ?? Date.now
  }

  start(): void {
    this.stopped = false
    void this.tick()
  }

  stop(): void {
    this.stopped = true
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
  }

  /** The list changed — look again now. */
  refresh(): void {
    if (!this.stopped) {
      void this.tick()
    }
  }

  /** Run every due automation, then sleep until the next one. */
  async tick(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    if (this.stopped) {
      return
    }
    const now = this.now()
    let soonest = Infinity
    for (const automation of await this.deps.list()) {
      if (!automation.enabled) {
        continue
      }
      let due = nextRunAt(automation)
      if (due <= now) {
        if (await this.deps.trigger(automation)) {
          await this.deps.markRun(automation.id, now)
          due = nextRunAt({ ...automation, lastRunAt: now })
        } else {
          due = now + 30_000 // could not start yet — try again shortly
        }
      }
      soonest = Math.min(soonest, due)
    }
    if (this.stopped || soonest === Infinity) {
      return
    }
    const wait = Math.min(Math.max(soonest - this.now(), 1000), MAX_SLEEP_MS)
    this.timer = setTimeout(() => void this.tick(), wait)
    this.timer.unref?.()
  }
}
