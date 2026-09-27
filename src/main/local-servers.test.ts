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

  it('honors excluded ports and caps the list', () => {
    const many = Array.from(
      { length: 12 },
      (_, i) => `node  ${2000 + i}  alex  3u  IPv4 0x1  0t0  TCP *:${3000 + i} (LISTEN)`
    ).join('\n')
    const servers = parseLsofListeners(many, new Set([3000, 3001]))
    expect(servers).toHaveLength(8)
    // Highest (most recently allocated) ports first, so the cap drops the
    // oldest listeners, not a server the user just started.
    expect(servers[0]!.port).toBe(3011)
  })

  it('tolerates empty and malformed output', () => {
    expect(parseLsofListeners('')).toEqual([])
    expect(parseLsofListeners('COMMAND PID\n???')).toEqual([])
  })
})
