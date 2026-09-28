// Fake pi-desktop-cua helper for tests: JSONL over stdin/stdout.
// Commands:
//   ping {value}      -> result echoes value
//   hang              -> never responds (for timeouts)
//   crash             -> exits immediately (after ack'ing nothing)
//   permissions       -> fixed {accessibility:true, screenRecording:true}
//   app_state         -> fixed small tree
//   everything else   -> {ok:true}
import { createInterface } from 'node:readline'

const rl = createInterface({ input: process.stdin })
rl.on('line', (line) => {
  let req
  try {
    req = JSON.parse(line)
  } catch {
    return
  }
  const reply = (result, error) => {
    process.stdout.write(
      JSON.stringify({ id: req.id, ok: !error, result, error }) + '\n'
    )
  }
  switch (req.cmd) {
    case 'hang':
      return
    case 'crash':
      process.exit(2)
      return
    case 'permissions':
      return reply({ accessibility: true, screenRecording: true })
    case 'app_state':
      return reply({
        app: { name: 'Fake', bundleId: 'com.test.fake', pid: 123 },
        window: { title: 'Doc', x: 0, y: 0, width: 800, height: 600 },
        tree: '[1] button "Save" 10,10 80x24 {press}',
        diff: false
      })
    case 'ping':
      return reply({ value: req.args?.value })
    default:
      return reply({ ok: true })
  }
})
