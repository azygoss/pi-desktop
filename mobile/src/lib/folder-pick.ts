import type { Nav } from '../nav'

let resolver: ((path: string | null) => void) | null = null

/**
 * Open the folder browser and resolve to the chosen absolute path on the
 * computer (null when the user backs out).
 */
export function pickFolder(navigation: Nav, title: string): Promise<string | null> {
  resolver?.(null)
  navigation.navigate('FolderPicker', { title })
  return new Promise((resolve) => {
    resolver = resolve
  })
}

/** Called by the FolderPicker screen: with a path on choose, null on leave. */
export function resolveFolder(path: string | null): void {
  const resolve = resolver
  resolver = null
  resolve?.(path)
}
