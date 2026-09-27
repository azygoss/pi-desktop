/**
 * Hover-intent pi warming: hovering a project row for a beat spawns a warm
 * spare for that cwd, so clicking adopts an already-starting process instead
 * of a cold one. Debounced per cwd and fires once per session — an adopted
 * spare leaves the cwd cold again until the next app run, which is fine:
 * repeating hovers shouldn't spawn a fleet of pi processes.
 */
const timers = new Map<string, ReturnType<typeof setTimeout>>()
const warmed = new Set<string>()

export function warmProjectSoon(cwd: string): void {
  if (!cwd || warmed.has(cwd) || timers.has(cwd)) {
    return
  }
  timers.set(
    cwd,
    setTimeout(() => {
      timers.delete(cwd)
      warmed.add(cwd)
      void window.piDesktop.chat.warm({ cwd }).catch(() => {})
    }, 350)
  )
}
