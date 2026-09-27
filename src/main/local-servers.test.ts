import { describe, expect, it } from 'vitest'

import { parseLsofListeners } from './local-servers'

const LSOF_OUT = `COMMAND     PID     USER   FD   TYPE             DEVICE SIZE/OFF NODE NAME
node      1001     alex   23u  IPv4 0xabc              0t0  TCP 127.0.0.1:5173 (LISTEN)
node      1001     alex   24u  IPv6 0xdef              0t0  TCP *:5173 (LISTEN)
Python    1002     alex    5u  IPv4 0x123              0t0  TCP *:8000 (LISTEN)
rapportd  1003     alex    3u  IPv4 0x456              0t0  TCP *:80 (LISTEN)
Electron  1004     alex   10u  IPv4 0x789              0t0  TCP 127.0.0.1:9229 (LISTEN)
mystery   1005     alex    9u  IPv4 0xaaa              0t0  TCP 127.0.0.1:4040->10.0.0.1:22 (ESTABLISHED)
`

describe('parseLsofListeners', () => {
  it('keeps user-space listeners and dedupes by port', () => {
    const servers = parseLsofListeners(LSOF_OUT)
    // Sorted by port descending (newest ephemeral ports first).
    expect(servers).toEqual([
      { port: 8000, command: 'Python' },
      { port: 5173, command: 'node' }
    ])
  })

  it('drops privileged ports, the app itself and non-listen rows', () => {
    const servers = parseLsofListeners(LSOF_OUT)
    expect(servers.map((s) => s.port)).not.toContain(80)
    expect(servers.map((s) => s.port)).not.toContain(9229)
    expect(servers.map((s) => s.port)).not.toContain(4040)
  })

  it('drops the ephemeral port range', () => {
    const out = [
      'node  1001  alex  3u  IPv4 0x1  0t0  TCP *:3000 (LISTEN)',
      'node  1002  alex  3u  IPv4 0x1  0t0  TCP *:49151 (LISTEN)',
      'node  1003  alex  3u  IPv4 0x1  0t0  TCP *:49152 (LISTEN)',
      'node  1004  alex  3u  IPv4 0x1  0t0  TCP *:65373 (LISTEN)'
    ].join('\n')
    const servers = parseLsofListeners(out)
    // 49151 is the last non-ephemeral port: kept. 49152+ are dropped.
    expect(servers.map((s) => s.port)).toEqual([49151, 3000])
  })

  it('drops pids owned by this app and its children', () => {
    const out = [
      'node      1001  alex  3u  IPv4 0x1  0t0  TCP *:3000 (LISTEN)',
      'pi        2002  alex  3u  IPv4 0x1  0t0  TCP *:4567 (LISTEN)',
      'Electron  3003  alex  3u  IPv4 0x1  0t0  TCP *:8222 (LISTEN)'
    ].join('\n')
    const servers = parseLsofListeners(out, { pids: new Set([2002]) })
    // pid 2002 is excluded directly; Electron 3003 by command name.
    expect(servers.map((s) => s.port)).toEqual([3000])
  })

  it('drops macOS Control Center (AirPlay) listeners', () => {
    const out = [
      'node      1001  alex  3u  IPv4 0x1  0t0  TCP *:3000 (LISTEN)',
      'ControlCe 1002  alex  3u  IPv4 0x2  0t0  TCP *:5000 (LISTEN)',
      'ControlCe 1002  alex  4u  IPv4 0x3  0t0  TCP *:7000 (LISTEN)'
    ].join('\n')
    expect(parseLsofListeners(out).map((s) => s.port)).toEqual([3000])
  })

  it('honors excluded ports', () => {
    const out = [
      'node  1001  alex  3u  IPv4 0x1  0t0  TCP *:3000 (LISTEN)',
      'node  1002  alex  3u  IPv4 0x1  0t0  TCP *:3001 (LISTEN)'
    ].join('\n')
    const servers = parseLsofListeners(out, { ports: new Set([3000]) })
    expect(servers.map((s) => s.port)).toEqual([3001])
  })

  it('tolerates empty and malformed output', () => {
    expect(parseLsofListeners('')).toEqual([])
    expect(parseLsofListeners('COMMAND PID\n???')).toEqual([])
  })
})
