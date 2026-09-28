import { describe, expect, it } from 'vitest'
import { compareVersions, normalizeVersion } from './semver'

describe('normalizeVersion', () => {
  it('strips a v prefix and validates semver shape', () => {
    expect(normalizeVersion('v1.2.3')).toBe('1.2.3')
    expect(normalizeVersion('0.4.0')).toBe('0.4.0')
    expect(normalizeVersion('v0.4.0-beta.1')).toBe('0.4.0-beta.1')
    expect(normalizeVersion('release-2024')).toBeNull()
    expect(normalizeVersion('')).toBeNull()
    expect(normalizeVersion('1.2')).toBeNull()
  })
})

describe('compareVersions', () => {
  it('orders numeric components', () => {
    expect(compareVersions('0.4.0', '0.3.0')).toBe(1)
    expect(compareVersions('0.3.0', '0.4.0')).toBe(-1)
    expect(compareVersions('1.0.0', '0.99.9')).toBe(1)
    expect(compareVersions('0.10.0', '0.9.0')).toBe(1)
    expect(compareVersions('v0.4.0', '0.4.0')).toBe(0)
  })

  it('treats missing components as zero', () => {
    expect(compareVersions('1.2', '1.2.0')).toBe(0)
    expect(compareVersions('1.2.1', '1.2')).toBe(1)
  })

  it('orders pre-releases below their release', () => {
    expect(compareVersions('1.0.0-beta', '1.0.0')).toBe(-1)
    expect(compareVersions('1.0.0-beta.2', '1.0.0-beta.1')).toBe(1)
    expect(compareVersions('1.0.0-alpha', '1.0.0-beta')).toBe(-1)
  })
})
