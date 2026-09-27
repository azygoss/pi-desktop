import { execFile } from 'node:child_process'
import { userInfo } from 'node:os'

/** A listening TCP port that looks like a local dev server. */
export interface LocalServer {
  port: number
  /** Process name as reported by lsof (e.g. 'node', 'ruby'). */
  command: string
}

const MAX_SERVERS = 8
const LSOF_TIMEOUT_MS = 2000

/** Process names (lsof truncates to ~9 chars) that are never dev servers. */
const EXCLUDED_COMMANDS = new Set(['electron', 'pi deskto', 'pi desktop'])

/**
 * Parse `lsof -nP -iTCP -sTCP:LISTEN` output into unique servers.
 * Lines look like:
 *   node  1234 user  23u  IPv4 0x…  0t0  TCP 127.0.0.1:5173 (LISTEN)
 * `command` may contain spaces when truncated ("Pi Deskt"), so the port is
 * matched from the end of the line and the command taken before the pid.
 */
export function parseLsofListeners(
  output: string,
  excludePorts: ReadonlySet<number> = new Set()
): LocalServer[] {
  const seen = new Set<number>()
  const servers: LocalServer[] = []
  for (const line of output.split('\n')) {
    const portMatch = /:(\d+)\s+\(LISTEN\)\s*$/.exec(line)
    if (!portMatch) {
      continue
    }
    const port = Number(portMatch[1])
    if (!Number.isInteger(port) || port < 1024 || port > 65535) {
      continue
    }
    if (seen.has(port) || excludePorts.has(port)) {
      continue
    }
    const command = line.trim().split(/\s+/)[0]?.toLowerCase() ?? ''
    if (EXCLUDED_COMMANDS.has(command)) {
      continue
    }
    seen.add(port)
    servers.push({ port, command: line.trim().split(/\s+/)[0] ?? 'process' })
  }
  // Highest ports first: freshly started dev servers usually land on
  // ephemeral ports, which keeps them in the list on busy machines where
  // lsof reports dozens of long-lived listeners.
  servers.sort((a, b) => b.port - a.port)
  return servers.slice(0, MAX_SERVERS)
}

/**
 * List TCP listeners owned by the current user — candidate dev servers for
 * the new-tab page. Returns [] on platforms/timeouts where lsof is absent.
 */
export function listLocalServers(excludePorts: number[] = []): Promise<LocalServer[]> {
  if (process.platform === 'win32') {
    return Promise.resolve([])
  }
  const uid = userInfo().uid
  return new Promise((resolvePromise) => {
    execFile(
      'lsof',
      ['-nP', '-iTCP', '-sTCP:LISTEN', '-a', '-u', String(uid)],
      { timeout: LSOF_TIMEOUT_MS },
      (error, stdout) => {
        if (error) {
          resolvePromise([])
          return
        }
        resolvePromise(parseLsofListeners(stdout, new Set(excludePorts)))
      }
    )
  })
}
