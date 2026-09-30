import { describe, expect, it } from 'vitest'

import { providerLabel } from './providers'

describe('providerLabel', () => {
  it('names known providers', () => {
    expect(providerLabel('openai')).toBe('OpenAI')
    expect(providerLabel('github-copilot')).toBe('GitHub Copilot')
  })

  it('title-cases unknown ids', () => {
    expect(providerLabel('local')).toBe('Local')
    expect(providerLabel('my-local_llm')).toBe('My Local Llm')
  })
})
