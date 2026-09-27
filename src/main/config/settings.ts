import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { getAgentDir } from '../sessions/paths'

import type { PiSettings } from '../../shared/session-types'

export type { PiSettings } from '../../shared/session-types'

export async function readSettings(
  env: NodeJS.ProcessEnv = process.env
): Promise<PiSettings> {
  const settingsPath = join(getAgentDir(env), 'settings.json')
  let raw: string
  try {
    raw = await readFile(settingsPath, 'utf8')
  } catch {
    return {}
  }

  let parsed: Record<string, unknown>
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>
  } catch {
    return {}
  }
  if (parsed === null || typeof parsed !== 'object') {
    return {}
  }

  const settings: PiSettings = {}
  for (const key of [
    'defaultProvider',
    'defaultModel',
    'defaultThinkingLevel',
    'theme'
  ] as const) {
    const value = parsed[key]
    if (typeof value === 'string') {
      settings[key] = value
    }
  }
  return settings
}
