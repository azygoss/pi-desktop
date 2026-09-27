import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { readSettings } from './settings'
import { getAgentDir, getSessionsDir } from '../sessions/paths'

let dir: string
let env: NodeJS.ProcessEnv

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'pi-desktop-settings-'))
  env = { PI_CODING_AGENT_DIR: dir }
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('paths', () => {
  it('honours PI_CODING_AGENT_DIR and derives the sessions dir', () => {
    expect(getAgentDir(env)).toBe(dir)
    expect(getSessionsDir(env)).toBe(join(dir, 'sessions'))
  })

  it('honours PI_CODING_AGENT_SESSION_DIR and expands ~', () => {
    const e = { PI_CODING_AGENT_DIR: dir, PI_CODING_AGENT_SESSION_DIR: '~/custom-sessions' }
    expect(getSessionsDir(e)).toBe(join(homedir(), 'custom-sessions'))
  })
})

describe('readSettings', () => {
  it('returns whitelisted fields only', async () => {
    await writeFile(
      join(dir, 'settings.json'),
      JSON.stringify({
        defaultProvider: 'anthropic',
        defaultModel: 'model-id',
        defaultThinkingLevel: 'high',
        theme: 'dark',
        verbose: true,
        secretish: 'should-not-leak'
      })
    )
    const settings = await readSettings(env)
    expect(settings).toEqual({
      defaultProvider: 'anthropic',
      defaultModel: 'model-id',
      defaultThinkingLevel: 'high',
      theme: 'dark'
    })
  })

  it('returns {} when settings.json is missing or malformed', async () => {
    expect(await readSettings(env)).toEqual({})
    await writeFile(join(dir, 'settings.json'), '{oops')
    expect(await readSettings(env)).toEqual({})
  })

  it('ignores non-string values', async () => {
    await writeFile(join(dir, 'settings.json'), JSON.stringify({ theme: 42, defaultModel: 'm' }))
    expect(await readSettings(env)).toEqual({ defaultModel: 'm' })
  })
})
