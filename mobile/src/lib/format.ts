/** "now", "5m", "3h", "2d", "4mo" since an ISO timestamp. */
export function relativeTime(iso: string | number): string {
  const then = typeof iso === 'number' ? iso : new Date(iso).getTime()
  if (Number.isNaN(then)) {
    return ''
  }
  const minutes = Math.floor((Date.now() - then) / 60000)
  if (minutes < 1) {
    return 'now'
  }
  if (minutes < 60) {
    return `${minutes}m`
  }
  const hours = Math.floor(minutes / 60)
  if (hours < 24) {
    return `${hours}h`
  }
  const days = Math.floor(hours / 24)
  if (days < 30) {
    return `${days}d`
  }
  return `${Math.floor(days / 30)}mo`
}

/** 1234 → "1.2k", 1_250_000 → "1.3M". */
export function compactNumber(n: number): string {
  if (n < 1000) {
    return String(Math.round(n))
  }
  if (n < 1_000_000) {
    return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`
  }
  return `${(n / 1_000_000).toFixed(1)}M`
}

export function formatCost(cost: number): string {
  if (cost <= 0) {
    return '$0'
  }
  return cost < 0.01 ? '<$0.01' : `$${cost.toFixed(2)}`
}

/** Last path segment; "~" for the home directory itself. */
export function baseName(path: string, homeDir?: string): string {
  if (homeDir && path === homeDir) {
    return '~'
  }
  const parts = path.split('/').filter(Boolean)
  return parts[parts.length - 1] ?? path
}

/** A path with the home directory collapsed to "~". */
export function tildePath(path: string, homeDir?: string): string {
  return homeDir && homeDir !== '/' && path.startsWith(homeDir)
    ? `~${path.slice(homeDir.length)}`
    : path
}
