/**
 * Minimal semver-ish comparison — no dependency. Accepts optional `v` prefix,
 * ignores build metadata (`+`), and orders a pre-release below its release
 * (`1.2.0-beta` < `1.2.0`). Returns -1, 0 or 1.
 */
export function compareVersions(a: string, b: string): number {
  const pa = parseVersion(a)
  const pb = parseVersion(b)
  const len = Math.max(pa.nums.length, pb.nums.length)
  for (let i = 0; i < len; i++) {
    const diff = (pa.nums[i] ?? 0) - (pb.nums[i] ?? 0)
    if (diff !== 0) {
      return diff < 0 ? -1 : 1
    }
  }
  if (pa.pre === pb.pre) {
    return 0
  }
  if (pa.pre === '') {
    return 1
  }
  if (pb.pre === '') {
    return -1
  }
  // Identifier-wise compare: numeric identifiers rank below alphanumeric.
  const as = pa.pre.split('.')
  const bs = pb.pre.split('.')
  for (let i = 0; i < Math.max(as.length, bs.length); i++) {
    const x = as[i]
    const y = bs[i]
    if (x === undefined) {
      return -1
    }
    if (y === undefined) {
      return 1
    }
    const xn = Number(x)
    const yn = Number(y)
    if (Number.isFinite(xn) && Number.isFinite(yn)) {
      if (xn !== yn) {
        return xn < yn ? -1 : 1
      }
    } else if (Number.isFinite(xn)) {
      return -1
    } else if (Number.isFinite(yn)) {
      return 1
    } else if (x !== y) {
      return x < y ? -1 : 1
    }
  }
  return 0
}

/** Strip a leading `v`/`V` and return "1.2.3", or null when unparseable. */
export function normalizeVersion(tag: string): string | null {
  const m = /^[vV]?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/.exec(tag.trim())
  return m ? (m[1] ?? null) : null
}

function parseVersion(version: string): { nums: number[]; pre: string } {
  const clean = normalizeVersion(version) ?? version.trim().replace(/^[vV]/, '')
  const [core = '', plus] = clean.split('+', 2)
  void plus // build metadata is ignored for precedence
  const [main = '', pre = ''] = core.split('-', 2)
  const nums = main.split('.').map((p) => {
    const n = Number(p)
    return Number.isFinite(n) ? n : 0
  })
  return { nums, pre }
}
