/** Minimal cross-platform path helpers for renderer-side display math. */

export function isAbsolute(path: string): boolean {
  return path.startsWith('/') || /^[A-Za-z]:[\\/]/.test(path)
}

/** Naive join sufficient for user-facing path display and pi cwd use. */
export function joinPath(base: string, segment: string): string {
  const sep = base.includes('\\') && !base.includes('/') ? '\\' : '/'
  return base.endsWith(sep) ? `${base}${segment}` : `${base}${sep}${segment}`
}
