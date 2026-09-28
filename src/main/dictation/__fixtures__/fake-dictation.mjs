#!/usr/bin/env node
// Synthetic pi-desktop-dictation stand-in for tests and e2e. Speaks the same
// JSONL protocol as the Swift helper without touching the microphone:
//   {"id":N,"cmd":"permissions|locales"}        -> {"id":N,"ok":true,"result":{...}}
//   {"id":N,"cmd":"start"}                     -> {"id":N,"ok":true} then events
//   {"id":N,"cmd":"stop"}                      -> final + stopped events
//   {"id":N,"cmd":"cancel"}                    -> cancelled event
// Env PI_FAKE_DICTATION_CRASH=1 makes the helper exit on `start`.
import { StringDecoder } from 'node:string_decoder'

let buffer = ''
const decoder = new StringDecoder('utf8')

function writeLine(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n')
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let partials = []
let stopped = false

async function runScript() {
  stopped = false
  partials = ['hello ', 'hello pi', 'hello pi desktop']
  for (const text of partials) {
    if (stopped) return
    await sleep(30)
    writeLine({ event: 'level', rms: 0.6 })
    writeLine({ event: 'partial', text })
  }
}

process.stdin.on('data', (chunk) => {
  buffer += decoder.write(chunk)
  for (;;) {
    const idx = buffer.indexOf('\n')
    if (idx === -1) break
    const line = buffer.slice(0, idx)
    buffer = buffer.slice(idx + 1)
    if (!line) continue
    let cmd
    try {
      cmd = JSON.parse(line)
    } catch {
      continue
    }
    const id = cmd.id
    switch (cmd.cmd) {
      case 'permissions':
        writeLine({
          id,
          ok: true,
          result: { microphone: 'authorized', speech: 'authorized' }
        })
        break
      case 'locales':
        writeLine({ id, ok: true, result: { locales: ['en-US', 'tr-TR', 'de-DE'] } })
        break
      case 'start':
        if (process.env['PI_FAKE_DICTATION_CRASH'] === '1') {
          process.exit(1)
        }
        writeLine({ id, ok: true, result: {} })
        void runScript()
        break
      case 'stop':
        stopped = true
        writeLine({ id, ok: true, result: {} })
        writeLine({ event: 'final', text: partials[partials.length - 1] ?? 'hello' })
        writeLine({ event: 'stopped' })
        break
      case 'cancel':
        stopped = true
        writeLine({ id, ok: true, result: {} })
        writeLine({ event: 'cancelled' })
        break
      default:
        writeLine({ id, ok: false, error: `unknown command ${cmd.cmd}` })
    }
  }
})
