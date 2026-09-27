// Synthetic `pi --mode rpc` stand-in used by unit tests. Reads JSONL commands
// from stdin and writes canned JSONL responses/events to stdout.
import { StringDecoder } from 'node:string_decoder'

const decoder = new StringDecoder('utf8')
let buffer = ''

function writeLine(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n')
}

function handle(command) {
  const id = command.id
  switch (command.type) {
    case 'echo':
      writeLine({ id, type: 'response', command: 'echo', success: true, data: command.data })
      break
    case 'fail':
      writeLine({ id, type: 'response', command: 'fail', success: false, error: 'synthetic failure' })
      break
    case 'hang':
      // Never respond; used to exercise request timeouts.
      break
    case 'die':
      process.exit(1)
      break
    case 'emit':
      writeLine({ type: 'agent_start' })
      writeLine({
        type: 'message_update',
        assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'hi' }
      })
      writeLine({ id, type: 'response', command: 'emit', success: true })
      break
    case 'ui':
      writeLine({
        type: 'extension_ui_request',
        id: 'ui-1',
        method: 'confirm',
        title: 'Proceed?'
      })
      writeLine({ id, type: 'response', command: 'ui', success: true })
      break
    case 'malformed':
      process.stdout.write('this is not json {{{\n')
      writeLine({ id, type: 'response', command: 'malformed', success: true })
      break
    case 'extension_ui_response':
      writeLine({ type: 'ui_response_seen', response: command })
      break
    default:
      writeLine({ id, type: 'response', command: command.type, success: true, data: null })
  }
}

process.stdin.on('data', (chunk) => {
  buffer += decoder.write(chunk)
  for (;;) {
    const idx = buffer.indexOf('\n')
    if (idx === -1) break
    const line = buffer.slice(0, idx)
    buffer = buffer.slice(idx + 1)
    if (line.length === 0) continue
    handle(JSON.parse(line))
  }
})
