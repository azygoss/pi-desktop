import { toast } from '../state/toast-store'

/** A slow snapshot must not hold a prompt back for long. */
const CHECKPOINT_TIMEOUT_MS = 4000

function errorText(e: unknown): string {
  return (e instanceof Error ? e.message : String(e)).replace(
    /^Error invoking remote method [^:]+: (Error: )?/,
    ''
  )
}

/** Snapshot the project's files before a prompt; null when there is nothing to snapshot. */
export function takeCheckpoint(cwd: string): Promise<string | null> {
  if (!cwd || !window.piDesktop.checkpoints) {
    return Promise.resolve(null)
  }
  return Promise.race([
    window.piDesktop.checkpoints.create({ cwd }).catch(() => null),
    new Promise<null>((resolve) => setTimeout(() => resolve(null), CHECKPOINT_TIMEOUT_MS))
  ])
}

function describe(restored: number, trashed: number): string {
  const parts: string[] = []
  if (restored > 0) {
    parts.push(`${restored} ${restored === 1 ? 'file' : 'files'} restored`)
  }
  if (trashed > 0) {
    parts.push(`${trashed} moved to Trash`)
  }
  return parts.join(', ')
}

async function restore(cwd: string, checkpoint: string, undoable: boolean): Promise<void> {
  try {
    const result = await window.piDesktop.checkpoints.restore({ cwd, checkpoint })
    if (result.restored === 0 && result.trashed === 0) {
      toast('The files already match that point')
      return
    }
    toast(
      describe(result.restored, result.trashed),
      undoable
        ? { action: { label: 'Undo', run: () => void restore(cwd, result.undo, false) } }
        : undefined
    )
  } catch (e) {
    toast(`Could not restore: ${errorText(e)}`)
  }
}

/**
 * Put the project's files back to how they were before a prompt. The chat
 * itself is not rewound; "Edit & resend" does that.
 */
export async function restoreCheckpoint(cwd: string, checkpoint: string): Promise<void> {
  const choice = await window.piDesktop.app.confirmDialog({
    title: 'Restore the files to before this prompt?',
    message:
      'Every change made to the project since then is undone, including your own edits. Files created since are moved to the Trash. The conversation stays as it is.',
    buttons: ['Restore Files', 'Cancel'],
    danger: true
  })
  if (choice === 0) {
    await restore(cwd, checkpoint, true)
  }
}
