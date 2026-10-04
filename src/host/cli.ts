import { chmod, mkdir, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import QRCode from 'qrcode'

import type { RemoteStatus } from '../main/remote/remote-server'
import { callControl, controlSocketPath, serveControl } from './control'

declare const __HOST_VERSION__: string

/**
 * `pi-remote`: Pi Desktop's remote-control host without the desktop app, for
 * a server (a VPS, a home box, a Linux machine). Pair Pi Remote on the phone
 * with the QR code it prints, then drive pi there exactly as with the app.
 */

const VERSION = typeof __HOST_VERSION__ === 'string' ? __HOST_VERSION__ : '0.0.0-dev'
const DEFAULT_PORT = 47821

const HELP = `pi-remote ${VERSION} — remote control for pi, without the desktop app

Usage:
  pi-remote start [options]    Run the host in the foreground (also under systemd)
  pi-remote pair               Show a pairing QR code for the running host
  pi-remote status             Show the running host and its paired phones
  pi-remote revoke <phone>     Remove a paired phone (its name or id)
  pi-remote service [install]  Print (or install) a systemd user service

Options for start and service:
  --host <address>   Address the phone connects to: a public IP, a domain or a
                     Tailscale name. Repeat for several. Default: this machine's
                     own addresses.
  --port <n>         Port to listen on (default ${DEFAULT_PORT}; with --host, only
                     this port is used, so it matches your firewall rule)
  --bind <address>   Interface to listen on (default 0.0.0.0)
  --name <name>      Name the phone shows for this machine (default: hostname)
  --pi <path>        pi executable to use (default: pi on PATH, else the bundled one)
  --pair             Show a pairing code at start even when phones are paired

Global options:
  --data-dir <dir>   Host key and paired phones (default ~/.config/pi-remote)
  -h, --help         Show this help
  -v, --version      Show the version

Everything between the phone and this host is end-to-end encrypted; only a
phone that scanned this host's code can connect.`

interface Args {
  command: string
  positional: string[]
  hosts: string[]
  port?: number
  bind?: string
  name?: string
  pi?: string
  pair: boolean
  dataDir: string
}

class UsageError extends Error {}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    command: '',
    positional: [],
    hosts: [],
    pair: false,
    dataDir: process.env['PI_REMOTE_DATA_DIR'] || join(homedir(), '.config', 'pi-remote')
  }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!
    const [flag, inline] = arg.startsWith('--') && arg.includes('=') ? arg.split(/=(.*)/s) : [arg]
    const value = (): string => {
      const next = inline ?? argv[++i]
      if (next === undefined || (inline === undefined && next.startsWith('--'))) {
        throw new UsageError(`${flag} needs a value`)
      }
      return next
    }
    switch (flag) {
      case '-h':
      case '--help':
        args.command = 'help'
        break
      case '-v':
      case '--version':
        args.command = 'version'
        break
      case '--host':
        args.hosts.push(
          ...value()
            .split(',')
            .map((h) => h.trim())
            .filter(Boolean)
        )
        break
      case '--port': {
        const port = Number(value())
        if (!Number.isInteger(port) || port < 1 || port > 65535) {
          throw new UsageError('--port must be a number from 1 to 65535')
        }
        args.port = port
        break
      }
      case '--bind':
        args.bind = value()
        break
      case '--name':
        args.name = value().slice(0, 64)
        break
      case '--pi':
        args.pi = resolve(value())
        break
      case '--pair':
        args.pair = true
        break
      case '--data-dir':
        args.dataDir = resolve(value())
        break
      default:
        if (flag!.startsWith('-')) {
          throw new UsageError(`Unknown option ${flag}`)
        }
        if (!args.command) {
          args.command = flag!
        } else {
          args.positional.push(flag!)
        }
    }
  }
  for (const host of args.hosts) {
    if (!/^[A-Za-z0-9.\-:[\]]{1,255}$/.test(host)) {
      throw new UsageError(`--host ${host} is not an address or a domain name`)
    }
  }
  return args
}

const socketPath = (args: Args): Promise<string> => controlSocketPath(args.dataDir)

function log(line: string): void {
  process.stdout.write(`${line}\n`)
}

async function printPairing(payload: string, expiresAt: number): Promise<void> {
  const qr = await QRCode.toString(payload, {
    type: 'terminal',
    small: true,
    errorCorrectionLevel: 'M'
  })
  const minutes = Math.max(1, Math.round((expiresAt - Date.now()) / 60_000))
  log('')
  log('Scan this with Pi Remote on your phone (Pair a computer → Scan):')
  log('')
  process.stdout.write(qr)
  log('')
  log('No camera? Send this link to the phone and paste it in Pi Remote:')
  log(payload)
  log('')
  log(`The code works once, for ${minutes} minutes.`)
}

function describeStatus(status: RemoteStatus): string {
  const lines = [
    `Listening on port ${status.port ?? '—'}`,
    `Phones connect to: ${status.addresses.join(', ') || '—'}`
  ]
  if (status.devices.length === 0) {
    lines.push('No paired phones yet — run `pi-remote pair`.')
  } else {
    lines.push('Paired phones:')
    for (const device of status.devices) {
      const seen = device.connected
        ? 'connected'
        : device.lastSeenAt
          ? `last seen ${new Date(device.lastSeenAt).toLocaleString()}`
          : 'never connected'
      lines.push(`  ${device.name}  (${seen})  id ${device.id}`)
    }
  }
  return lines.join('\n')
}

/** Show a code and wait until a new phone pairs, the code expires or Ctrl+C. */
async function pairAndWait(
  begin: () => Promise<{ payload: string; expiresAt: number }>,
  status: () => Promise<RemoteStatus>,
  cancel: () => Promise<void>
): Promise<boolean> {
  const before = new Set((await status()).devices.map((d) => d.id))
  const code = await begin()
  await printPairing(code.payload, code.expiresAt)
  log('Waiting for the phone… (Ctrl+C to cancel)')
  return new Promise((resolvePromise) => {
    let done = false
    const finish = (paired: boolean) => {
      if (done) {
        return
      }
      done = true
      clearInterval(timer)
      process.off('SIGINT', onInterrupt)
      resolvePromise(paired)
    }
    const onInterrupt = () => {
      void cancel().finally(() => {
        log('Pairing cancelled.')
        finish(false)
      })
    }
    process.on('SIGINT', onInterrupt)
    const timer = setInterval(() => {
      void status()
        .then((current) => {
          const added = current.devices.find((d) => !before.has(d.id))
          if (added) {
            log(`Paired with ${added.name}.`)
            finish(true)
          } else if (current.pairingExpiresAt === null || Date.now() > code.expiresAt) {
            log('The code expired. Run `pi-remote pair` for a new one.')
            finish(false)
          }
        })
        .catch(() => finish(false))
    }, 1000)
  })
}

async function commandStart(args: Args): Promise<void> {
  const [major] = process.versions.node.split('.').map(Number)
  if ((major ?? 0) < 20) {
    throw new Error(`pi-remote needs Node.js 20 or newer (this is ${process.versions.node})`)
  }
  await mkdir(args.dataDir, { recursive: true, mode: 0o700 })
  await chmod(args.dataDir, 0o700)
  // Read by the shared main-process modules (settings, workspace, store).
  process.env['PI_DESKTOP_USER_DATA_DIR'] = args.dataDir
  process.env['PI_REMOTE_HOST_VERSION'] = VERSION
  if (args.pi) {
    process.env['PI_DESKTOP_PI_COMMAND'] = args.pi
  }
  // Electron's main process only warns about a rejected promise nobody
  // handled; plain Node would exit. The shared services were written for
  // Electron, so the host keeps its behavior instead of dropping every phone.
  process.on('unhandledRejection', (reason) => {
    log(`Unhandled rejection: ${reason instanceof Error ? reason.message : String(reason)}`)
  })
  const { startHost } = await import('./host')
  const host = await startHost({
    version: VERSION,
    ...(args.port ? { port: args.port } : {}),
    // A firewall rule is per port: with explicit addresses, never wander.
    strictPort: args.hosts.length > 0 || args.port !== undefined,
    ...(args.bind ? { bind: args.bind } : {}),
    ...(args.hosts.length > 0 ? { publicHosts: args.hosts } : {}),
    ...(args.name ? { name: args.name } : {}),
    log
  })
  let stopControl: (() => Promise<void>) | null = null
  const shutdown = async (signal: string) => {
    log(`Stopping (${signal})…`)
    await stopControl?.().catch(() => {})
    await host.stop()
    process.exit(0)
  }
  try {
    stopControl = await serveControl(await socketPath(args), async (request) => {
      switch (request.cmd) {
        case 'status':
          return host.status()
        case 'pair':
          return host.beginPairing()
        case 'cancel-pair':
          host.cancelPairing()
          return null
        case 'revoke':
          await host.revoke(request.deviceId)
          return null
      }
    })
  } catch (error) {
    await host.stop()
    throw error
  }

  try {
    const runtime = await host.runtime()
    log(`pi ${runtime.version ?? '(unknown version)'} (${runtime.kind}: ${runtime.command})`)
  } catch (error) {
    log(
      `Warning: pi could not be started (${error instanceof Error ? error.message : String(error)}). ` +
        'Install it with `npm install -g @earendil-works/pi-coding-agent` or pass --pi.'
    )
  }
  log(`pi-remote ${VERSION}`)
  log(describeStatus(host.status()))

  const interactive = process.stdout.isTTY === true
  if (args.pair || (interactive && host.status().devices.length === 0)) {
    await pairAndWait(
      async () => host.beginPairing(),
      async () => host.status(),
      async () => host.cancelPairing()
    )
  } else if (!interactive && host.status().devices.length === 0) {
    log('Run `pi-remote pair` in a terminal on this machine to pair a phone.')
  }
  process.on('SIGINT', () => void shutdown('SIGINT'))
  process.on('SIGTERM', () => void shutdown('SIGTERM'))
  log('Ready.')
}

async function commandPair(args: Args): Promise<void> {
  const socket = await socketPath(args)
  const call = (cmd: 'status' | 'pair' | 'cancel-pair') => callControl(socket, { cmd })
  const paired = await pairAndWait(
    async () => (await call('pair')) as { payload: string; expiresAt: number },
    async () => (await call('status')) as RemoteStatus,
    async () => {
      await call('cancel-pair').catch(() => {})
    }
  )
  process.exit(paired ? 0 : 1)
}

async function commandStatus(args: Args): Promise<void> {
  const status = (await callControl(await socketPath(args), { cmd: 'status' })) as RemoteStatus
  log(describeStatus(status))
}

async function commandRevoke(args: Args): Promise<void> {
  const query = args.positional[0]
  if (!query) {
    throw new UsageError('Which phone? Give its name or id (see `pi-remote status`).')
  }
  const socket = await socketPath(args)
  const status = (await callControl(socket, { cmd: 'status' })) as RemoteStatus
  const matches = status.devices.filter(
    (d) => d.id === query || d.id.startsWith(query) || d.name.toLowerCase() === query.toLowerCase()
  )
  if (matches.length !== 1) {
    throw new Error(
      matches.length === 0
        ? `No paired phone matches "${query}"`
        : `"${query}" matches ${matches.length} phones; use the id`
    )
  }
  await callControl(socket, { cmd: 'revoke', deviceId: matches[0]!.id })
  log(`Removed ${matches[0]!.name}. It can no longer connect.`)
}

function serviceUnit(args: Args, argv: string[]): string {
  const script = fileURLToPath(import.meta.url)
  // The flags given to `service` become the service's flags (minus --pair).
  const passthrough = argv
    .slice(argv.indexOf('service') + 1)
    .filter((arg) => arg !== 'install' && arg !== '--pair')
  const quote = (value: string) =>
    /^[A-Za-z0-9_@%+=:,./-]+$/.test(value) ? value : JSON.stringify(value)
  const command = [process.execPath, script, 'start', ...passthrough]
  if (!passthrough.some((arg) => arg.startsWith('--data-dir'))) {
    command.push('--data-dir', args.dataDir)
  }
  return [
    '[Unit]',
    'Description=Pi Remote host (remote control for pi)',
    'After=network-online.target',
    'Wants=network-online.target',
    '',
    '[Service]',
    `ExecStart=${command.map(quote).join(' ')}`,
    // pi and the tools it runs (git, gh, node) come from this PATH.
    `Environment=PATH=${process.env['PATH'] ?? '/usr/local/bin:/usr/bin:/bin'}`,
    'Restart=on-failure',
    'RestartSec=5',
    '',
    '[Install]',
    'WantedBy=default.target',
    ''
  ].join('\n')
}

async function commandService(args: Args, argv: string[]): Promise<void> {
  const unit = serviceUnit(args, argv)
  if (args.positional[0] !== 'install') {
    process.stdout.write(unit)
    return
  }
  if (process.platform !== 'linux') {
    throw new Error('`service install` sets up a systemd user service (Linux only)')
  }
  const dir = join(process.env['XDG_CONFIG_HOME'] || join(homedir(), '.config'), 'systemd', 'user')
  const path = join(dir, 'pi-remote.service')
  await mkdir(dir, { recursive: true })
  await writeFile(path, unit)
  log(`Wrote ${path}`)
  log('')
  log('Start it now and at every boot:')
  log('  systemctl --user daemon-reload')
  log('  systemctl --user enable --now pi-remote')
  log('Keep it running after you log out:')
  log(`  sudo loginctl enable-linger ${process.env['USER'] ?? '$USER'}`)
  log('Then pair a phone:')
  log('  pi-remote pair')
  log('Logs: journalctl --user -u pi-remote -f')
}

export async function main(argv: string[]): Promise<void> {
  let args: Args
  try {
    args = parseArgs(argv)
  } catch (error) {
    process.stderr.write(`${(error as Error).message}\n\n${HELP}\n`)
    process.exit(2)
  }
  if (!isAbsolute(args.dataDir)) {
    args.dataDir = resolve(args.dataDir)
  }
  try {
    switch (args.command) {
      case '':
      case 'help':
        log(HELP)
        return
      case 'version':
        log(VERSION)
        return
      case 'start':
        await commandStart(args)
        return
      case 'pair':
        await commandPair(args)
        return
      case 'status':
        await commandStatus(args)
        return
      case 'revoke':
        await commandRevoke(args)
        return
      case 'service':
        await commandService(args, argv)
        return
      default:
        throw new UsageError(`Unknown command ${args.command}`)
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    process.stderr.write(
      error instanceof UsageError ? `${message}\n\n${HELP}\n` : `pi-remote: ${message}\n`
    )
    process.exit(error instanceof UsageError ? 2 : 1)
  }
}

void main(process.argv.slice(2))
