import { createHash } from 'node:crypto'
import { chmod, lstat, mkdir, unlink } from 'node:fs/promises'
import { createConnection, createServer, type Server } from 'node:net'
import { join } from 'node:path'

/**
 * Local control socket of a running host: `pi-remote pair`, `status` and
 * `revoke` talk to the service through it. It is a Unix socket inside the
 * host's data directory (mode 0700) and is itself mode 0600, so only the
 * user running the host can reach it. One JSON request line, one JSON reply.
 */

export type ControlRequest =
  { cmd: 'status' } | { cmd: 'pair' } | { cmd: 'cancel-pair' } | { cmd: 'revoke'; deviceId: string }

export type ControlReply = { ok: true; result: unknown } | { ok: false; error: string }

const MAX_LINE = 4096
/** Unix socket paths are limited to ~104 bytes (macOS) / 108 (Linux). */
const MAX_SOCKET_PATH = 100

/**
 * Where the control socket of the host using `dataDir` lives: inside the
 * data directory, or — when that path is too long for a socket — in a
 * private per-user directory under $XDG_RUNTIME_DIR or /tmp.
 */
export async function controlSocketPath(dataDir: string): Promise<string> {
  const inside = join(dataDir, 'host.sock')
  if (Buffer.byteLength(inside) <= MAX_SOCKET_PATH) {
    return inside
  }
  const uid = process.getuid?.() ?? 0
  const base = process.env['XDG_RUNTIME_DIR'] || join('/tmp', `pi-remote-${uid}`)
  await mkdir(base, { recursive: true, mode: 0o700 })
  const info = await lstat(base)
  if (!info.isDirectory() || info.uid !== uid || (info.mode & 0o077) !== 0) {
    throw new Error(`${base} must be a directory only you can access`)
  }
  const id = createHash('sha256').update(dataDir).digest('hex').slice(0, 12)
  return join(base, `pi-remote-${id}.sock`)
}

export async function serveControl(
  socketPath: string,
  handle: (request: ControlRequest) => Promise<unknown>
): Promise<() => Promise<void>> {
  // A socket file left by a host that did not shut down cleanly.
  if (await isAlive(socketPath)) {
    throw new Error('Another pi-remote host is already running with this data directory')
  }
  await unlink(socketPath).catch(() => {})
  const server: Server = createServer((socket) => {
    let buffer = ''
    socket.setEncoding('utf8')
    socket.on('error', () => {})
    socket.on('data', (chunk: string) => {
      buffer += chunk
      if (buffer.length > MAX_LINE) {
        socket.destroy()
        return
      }
      const end = buffer.indexOf('\n')
      if (end < 0) {
        return
      }
      const line = buffer.slice(0, end)
      buffer = ''
      void (async () => {
        let reply: ControlReply
        try {
          reply = { ok: true, result: await handle(parseRequest(line)) }
        } catch (error) {
          reply = { ok: false, error: error instanceof Error ? error.message : String(error) }
        }
        socket.end(JSON.stringify(reply) + '\n')
      })()
    })
  })
  await new Promise<void>((resolvePromise, reject) => {
    server.once('error', reject)
    server.listen(socketPath, () => {
      server.off('error', reject)
      resolvePromise()
    })
  })
  await chmod(socketPath, 0o600)
  return () =>
    new Promise<void>((resolvePromise) => {
      server.close(() => resolvePromise())
      void unlink(socketPath).catch(() => {})
    })
}

function parseRequest(line: string): ControlRequest {
  const value = JSON.parse(line) as { cmd?: unknown; deviceId?: unknown }
  switch (value.cmd) {
    case 'status':
    case 'pair':
    case 'cancel-pair':
      return { cmd: value.cmd }
    case 'revoke':
      if (typeof value.deviceId !== 'string' || value.deviceId.length > 64) {
        throw new Error('Invalid device')
      }
      return { cmd: 'revoke', deviceId: value.deviceId }
    default:
      throw new Error('Unknown command')
  }
}

/** Send one request to a running host. Rejects when none is running. */
export function callControl(
  socketPath: string,
  request: ControlRequest,
  timeoutMs = 10_000
): Promise<unknown> {
  return new Promise((resolvePromise, reject) => {
    const socket = createConnection(socketPath)
    let buffer = ''
    const timer = setTimeout(() => {
      socket.destroy()
      reject(new Error('The pi-remote host did not answer'))
    }, timeoutMs)
    socket.setEncoding('utf8')
    socket.on('connect', () => socket.write(JSON.stringify(request) + '\n'))
    socket.on('data', (chunk: string) => {
      buffer += chunk
    })
    socket.on('error', (error: NodeJS.ErrnoException) => {
      clearTimeout(timer)
      reject(
        error.code === 'ENOENT' || error.code === 'ECONNREFUSED'
          ? new Error('No pi-remote host is running (start one with `pi-remote start`)')
          : error
      )
    })
    socket.on('end', () => {
      clearTimeout(timer)
      try {
        const reply = JSON.parse(buffer.trim()) as ControlReply
        if (reply.ok) {
          resolvePromise(reply.result)
        } else {
          reject(new Error(reply.error))
        }
      } catch {
        reject(new Error('Unreadable reply from the pi-remote host'))
      }
    })
  })
}

function isAlive(socketPath: string): Promise<boolean> {
  return new Promise((resolvePromise) => {
    const socket = createConnection(socketPath)
    socket.once('connect', () => {
      socket.destroy()
      resolvePromise(true)
    })
    socket.once('error', () => resolvePromise(false))
  })
}
