import { execFile } from 'node:child_process'
import { userInfo } from 'node:os'

/** A listening TCP port that looks like a local dev server. */
export interface LocalServer {
  port: number
  /** Process name as reported by lsof (e.g. 'node', 'ruby'). */
  command: string
  /** HTML <title> when the server returned one within the probe budget. */
  title?: string
}

const MAX_SERVERS = 8
const MAX_PROBES = 16
const LSOF_TIMEOUT_MS = 2000
const HTTP_TIMEOUT_MS = 400
const TITLE_BYTES = 16 * 1024
const CACHE_MS = 5000
/** IANA ephemeral/dynamic port range — random client sockets, not servers. */
const EPHEMERAL_START = 49152

/** Process names (lsof truncates to ~9 chars) that are never dev servers. */
const EXCLUDED_COMMANDS = new Set([
  'electron',
  'pi deskto',
  'pi desktop',
  'pi',
  'pi helper',
  // macOS Control Center (AirPlay receivers on 5000/7000) answers HTTP.
  'controlce'
])

export interface LsofExclusions {
  ports?: ReadonlySet<number>
  pids?: ReadonlySet<number>
}

/**
 * Parse `lsof -nP -iTCP -sTCP:LISTEN` output into unique servers.
 * Lines look like:
 *   node  1234 user  23u  IPv4 0x…  0t0  TCP 127.0.0.1:5173 (LISTEN)
 * `command` may contain spaces when truncated ("Pi Deskt"), so the port is
 * matched from the end of the line; command and pid come from the first two
 * whitespace-separated fields.
 */
export function parseLsofListeners(
  output: string,
  exclude: LsofExclusions = {}
): LocalServer[] {
  const excludePorts = exclude.ports ?? new Set<number>()
  const excludePids = exclude.pids ?? new Set<number>()
  const seen = new Set<number>()
  const servers: LocalServer[] = []
  for (const line of output.split('\n')) {
    const portMatch = /:(\d+)\s+\(LISTEN\)\s*$/.exec(line)
    if (!portMatch) {
      continue
    }
    const port = Number(portMatch[1])
    // Ephemeral ports are client-side sockets that happen to hold a listener
    // briefly; real dev servers live below the dynamic range.
    if (!Number.isInteger(port) || port < 1024 || port >= EPHEMERAL_START) {
      continue
    }
    if (seen.has(port) || excludePorts.has(port)) {
      continue
    }
    const fields = line.trim().split(/\s+/)
    const pid = Number(fields[1])
    if (excludePids.has(pid)) {
      continue
    }
    const command = (fields[0] ?? '').toLowerCase()
    if (EXCLUDED_COMMANDS.has(command)) {
      continue
    }
    seen.add(port)
    servers.push({ port, command: fields[0] ?? 'process' })
  }
  servers.sort((a, b) => b.port - a.port)
  return servers
}

function execFileText(command: string, args: string[], timeout: number): Promise<string> {
  return new Promise((resolvePromise) => {
    execFile(command, args, { timeout }, (error, stdout) => {
      resolvePromise(error ? '' : stdout)
    })
  })
}

/**
 * PIDs belonging to this app: the main process plus every descendant
 * (helpers, pi children). Their listeners (devtools, bridge, MCP) are noise.
 */
async function ownTreePids(): Promise<Set<number>> {
  const out = await execFileText('ps', ['-eo', 'pid=,ppid='], LSOF_TIMEOUT_MS)
  const parentOf = new Map<number, number>()
  for (const line of out.split('\n')) {
    const [pidRaw, ppidRaw] = line.trim().split(/\s+/)
    const pid = Number(pidRaw)
    const ppid = Number(ppidRaw)
    if (Number.isInteger(pid) && Number.isInteger(ppid)) {
      parentOf.set(pid, ppid)
    }
  }
  const own = new Set<number>([process.pid])
  for (const pid of parentOf.keys()) {
    let cur: number | undefined = pid
    let guard = 64
    while (cur !== undefined && guard-- > 0) {
      if (cur === process.pid) {
        own.add(pid)
        break
      }
      cur = parentOf.get(cur)
    }
  }
  return own
}

/**
 * Probe one candidate: GET / on loopback. Any HTTP response — including 4xx —
 * proves it speaks HTTP. Returns the page <title> when one is present in the
 * first bytes, '' when the server speaks HTTP without a title, and null when
 * the port doesn't answer HTTP at all.
 */
async function probeHttp(port: number): Promise<string | null> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/`, {
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
      redirect: 'manual'
    })
    let text = ''
    if (res.body) {
      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      while (text.length < TITLE_BYTES) {
        const { value, done } = await reader.read()
        if (done) {
          break
        }
        text += decoder.decode(value, { stream: true })
        if (/<\/title>/i.test(text)) {
          break
        }
      }
      await reader.cancel().catch(() => {})
    }
    const match = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(text)
    return match?.[1]?.trim().slice(0, 80) ?? ''
  } catch {
    return null
  }
}

let cache: { at: number; servers: LocalServer[] } | undefined

/**
 * List local dev servers: listeners owned by the current user that answer a
 * loopback HTTP GET. Results are cached for a few seconds so reopening the
 * new-tab page doesn't re-probe everything.
 */
export async function listLocalServers(excludePorts: number[] = []): Promise<LocalServer[]> {
  if (process.platform === 'win32') {
    return []
  }
  if (cache && Date.now() - cache.at < CACHE_MS) {
    return cache.servers
  }
  const uid = userInfo().uid
  const lsofOut = await execFileText(
    'lsof',
    ['-nP', '-iTCP', '-sTCP:LISTEN', '-a', '-u', String(uid)],
    LSOF_TIMEOUT_MS
  )
  if (!lsofOut) {
    return []
  }
  const candidates = parseLsofListeners(lsofOut, {
    ports: new Set(excludePorts),
    pids: await ownTreePids()
  }).slice(0, MAX_PROBES)
  const probed = await Promise.all(
    candidates.map(async (server): Promise<LocalServer | null> => {
      const title = await probeHttp(server.port)
      return title === null ? null : { ...server, title: title || undefined }
    })
  )
  const servers: LocalServer[] = []
  for (const server of probed) {
    if (server !== null && servers.length < MAX_SERVERS) {
      servers.push(server)
    }
  }
  cache = { at: Date.now(), servers }
  return servers
}
