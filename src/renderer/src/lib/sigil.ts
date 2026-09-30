/**
 * Project sigils: a deterministic 3×3 pixel pattern (mirrored left↔right)
 * and a hue index derived from the project path. Rendered by
 * components/Pixels.tsx.
 */

const SIGIL_HUES = 6

/** FNV-1a over the path: stable across launches and platforms. */
function hash(text: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

/** 3×3 cell mask (row-major) mirrored left↔right, plus a hue index. */
export function sigilPattern(seed: string): { cells: boolean[]; hue: number } {
  const h = hash(seed)
  let bits = h & 0b111111
  const filled = [0, 1, 2, 3, 4, 5].filter((b) => bits & (1 << b)).length
  // Too sparse reads as noise, a full block as a plain square.
  if (filled < 3) {
    bits |= 0b101010
  } else if (bits === 0b111111) {
    bits = 0b101111
  }
  const cells: boolean[] = []
  for (let row = 0; row < 3; row++) {
    const left = (bits >> row) & 1
    const mid = (bits >> (row + 3)) & 1
    cells.push(left === 1, mid === 1, left === 1)
  }
  return { cells, hue: (h >>> 8) % SIGIL_HUES }
}
