/**
 * The message an `ipcRenderer.invoke` rejection carries:
 * "Error invoking remote method '<channel>': Error: <message>". This module
 * is shared with React Native — no DOM or Node APIs.
 */
const IPC_PREFIX = /^Error invoking remote method (?:'[^']*'|[^:]+): (Error: )?/

/** A rejected IPC call's real message, for toasts and error rows. */
export function ipcErrorMessage(error: unknown, fallback = 'Something went wrong'): string {
  const raw =
    error instanceof Error ? error.message : typeof error === 'string' ? error : undefined
  if (raw === undefined) {
    return fallback
  }
  return raw.replace(IPC_PREFIX, '')
}
