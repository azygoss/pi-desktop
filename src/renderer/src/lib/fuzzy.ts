/**
 * Small subsequence fuzzy scorer for the command palette. Higher is better;
 * returns -1 when the query is not a subsequence of the text. Bonuses reward
 * contiguous runs, word starts and short targets.
 */
export function fuzzyScore(query: string, text: string): number {
  const q = query.trim().toLowerCase()
  const t = text.toLowerCase()
  if (!q) {
    return 0
  }
  if (!t) {
    return -1
  }

  let score = 0
  let ti = 0
  let lastMatch = -1
  let run = 0
  for (const qc of q) {
    const at = t.indexOf(qc, ti)
    if (at < 0) {
      return -1
    }
    if (at === lastMatch + 1) {
      run += 1
      score += 4 + run * 2 // contiguous run bonus
    } else {
      run = 0
      score += 1
    }
    const prev = at > 0 ? t[at - 1]! : ''
    if (at === 0) {
      score += 10 // starts-with bonus
    } else if (' /_-:.·'.includes(prev)) {
      score += 5 // word-boundary bonus
    } else if (qc !== qc.toLowerCase() && text[at] === text[at]!.toUpperCase()) {
      score += 3
    }
    ti = at + 1
    lastMatch = at
  }
  // Prefer shorter targets and earlier first matches.
  score -= t.length * 0.05
  score -= (t.indexOf(q[0]!) || 0) * 0.1
  return score
}

/** Rank `items` by fuzzy score against `query`; input order preserved on ties. */
export function fuzzyFilter<T>(
  query: string,
  items: T[],
  text: (item: T) => string
): T[] {
  const q = query.trim()
  if (!q) {
    return items
  }
  return items
    .map((item, index) => ({ item, index, score: fuzzyScore(q, text(item)) }))
    .filter((r) => r.score >= 0)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map((r) => r.item)
}
