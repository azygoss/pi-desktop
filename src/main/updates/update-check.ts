import { app } from 'electron'
import { compareVersions, normalizeVersion } from './semver'

/**
 * Release check against the GitHub releases API. All failures — network,
 * timeout, 404 while no release exists yet, malformed JSON — resolve to null
 * and are never thrown.
 */

const RELEASE_URL =
  'https://api.github.com/repos/azygoss/pi-desktop/releases/latest'
const RELEASE_PREFIX = 'https://github.com/azygoss/pi-desktop/'
const TIMEOUT_MS = 5000

export interface UpdateInfo {
  version: string
  url: string
}

export interface UpdateCheckDeps {
  fetchImpl?: typeof fetch
  /** Current app version; defaults to app.getVersion(). */
  currentVersion?: string
  /** Release endpoint override (e2e only, PI_DESKTOP_UPDATE_URL). */
  url?: string
}

/** The release endpoint; overridable only in e2e runs. */
function endpoint(override?: string): string {
  if (process.env['PI_DESKTOP_E2E'] === '1') {
    return override ?? process.env['PI_DESKTOP_UPDATE_URL'] ?? RELEASE_URL
  }
  return RELEASE_URL
}

/** Running version; un-packaged e2e launches report Electron's own version. */
function currentVersion(override?: string): string {
  if (override) {
    return override
  }
  if (process.env['PI_DESKTOP_E2E'] === '1' && process.env['PI_DESKTOP_APP_VERSION']) {
    return process.env['PI_DESKTOP_APP_VERSION']
  }
  return app?.getVersion?.() ?? '0.0.0'
}

export type UpdateCheckResult =
  | { status: 'update-available'; version: string; url: string }
  | { status: 'up-to-date' }
  | { status: 'unavailable' }

/** Parsed and repo-prefix-validated latest release, or a failure kind. */
type LatestRelease =
  | { kind: 'release'; version: string; url: string }
  | { kind: 'invalid' }
  | { kind: 'error' }

async function fetchLatest(deps: UpdateCheckDeps): Promise<LatestRelease> {
  const doFetch = deps.fetchImpl ?? fetch
  try {
    const response = await doFetch(endpoint(deps.url), {
      headers: { 'user-agent': 'pi-desktop update-check' },
      signal: AbortSignal.timeout(TIMEOUT_MS)
    })
    if (!response.ok) {
      return { kind: 'error' }
    }
    const body = (await response.json()) as {
      tag_name?: unknown
      html_url?: unknown
    }
    if (typeof body.tag_name !== 'string' || typeof body.html_url !== 'string') {
      return { kind: 'invalid' }
    }
    const latest = normalizeVersion(body.tag_name)
    if (!latest || !body.html_url.startsWith(RELEASE_PREFIX)) {
      return { kind: 'invalid' }
    }
    return { kind: 'release', version: latest, url: body.html_url }
  } catch {
    return { kind: 'error' }
  }
}

/**
 * Fetch the latest release and compare it to the running version.
 * Returns the newer release info, or null when up-to-date or on any failure.
 */
export async function checkForUpdate(deps: UpdateCheckDeps = {}): Promise<UpdateInfo | null> {
  const latest = await fetchLatest(deps)
  if (latest.kind !== 'release') {
    return null
  }
  const current = currentVersion(deps.currentVersion)
  return compareVersions(latest.version, current) > 0
    ? { version: latest.version, url: latest.url }
    : null
}

/**
 * Detailed check for the "Check now" button — distinguishes a failed fetch
 * from a clean "up to date".
 */
export async function checkForUpdateResult(
  deps: UpdateCheckDeps = {}
): Promise<UpdateCheckResult> {
  const latest = await fetchLatest(deps)
  if (latest.kind === 'error') {
    return { status: 'unavailable' }
  }
  if (latest.kind !== 'release') {
    return { status: 'unavailable' }
  }
  const current = currentVersion(deps.currentVersion)
  return compareVersions(latest.version, current) > 0
    ? { status: 'update-available', version: latest.version, url: latest.url }
    : { status: 'up-to-date' }
}

/**
 * Holds the last-known update so late-joining renderers (and relaunches within
 * the same process) can query it, and broadcasts new finds to all windows.
 */
export class UpdateChecker {
  private info: UpdateInfo | null = null

  constructor(
    private readonly deps: UpdateCheckDeps = {},
    private readonly onFound?: (info: UpdateInfo) => void
  ) {}

  get current(): UpdateInfo | null {
    return this.info
  }

  /** Silent background check: only broadcasts when something newer exists. */
  async run(): Promise<void> {
    const info = await checkForUpdate(this.deps)
    if (info) {
      this.info = info
      this.onFound?.(info)
    }
  }

  /** Manual check (Settings → Check now): reports failure vs up-to-date. */
  async checkNow(): Promise<UpdateCheckResult> {
    const result = await checkForUpdateResult(this.deps)
    if (result.status === 'update-available') {
      this.info = { version: result.version, url: result.url }
      this.onFound?.(this.info)
    }
    return result
  }
}
