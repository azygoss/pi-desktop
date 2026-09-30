import { describe, expect, it } from 'vitest'

import { sigilPattern } from './sigil'

const PATHS = [
  '/Users/example/synthetic-alpha',
  '/Users/example/synthetic-beta',
  '/Users/example/synthetic-gamma',
  '/tmp/a',
  'C:\\work\\project',
  ''
]

describe('sigilPattern', () => {
  it('is deterministic for a path', () => {
    for (const path of PATHS) {
      expect(sigilPattern(path)).toEqual(sigilPattern(path))
    }
  })

  it('mirrors columns and never draws a sparse or solid block', () => {
    for (let i = 0; i < 500; i++) {
      const { cells, hue } = sigilPattern(`/projects/p${i}`)
      expect(cells).toHaveLength(9)
      for (let row = 0; row < 3; row++) {
        expect(cells[row * 3]).toBe(cells[row * 3 + 2])
      }
      const lit = cells.filter(Boolean).length
      expect(lit).toBeGreaterThanOrEqual(3)
      expect(lit).toBeLessThan(9)
      expect(hue).toBeGreaterThanOrEqual(0)
      expect(hue).toBeLessThan(6)
    }
  })

  it('tells neighbouring project names apart', () => {
    const keys = new Set(
      Array.from({ length: 40 }, (_, i) => {
        const { cells, hue } = sigilPattern(`/Users/example/project-${i}`)
        return `${hue}:${cells.map(Number).join('')}`
      })
    )
    expect(keys.size).toBeGreaterThan(20)
  })
})
