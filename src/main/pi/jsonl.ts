import { StringDecoder } from 'node:string_decoder'

export interface JsonlReader {
  push(chunk: Buffer | string): void
  end(): void
}

/**
 * Strict JSONL framing for the pi RPC protocol: LF (`\n`) is the only record
 * delimiter, a trailing `\r` is stripped, and empty lines are skipped.
 *
 * Node's `readline` must not be used here: it also splits on U+2028/U+2029,
 * which are valid inside JSON strings. A `StringDecoder` keeps multi-byte
 * UTF-8 sequences intact across chunk boundaries.
 */
export function createJsonlReader(onLine: (line: string) => void): JsonlReader {
  const decoder = new StringDecoder('utf8')
  let buffer = ''
  let ended = false

  const drain = () => {
    for (;;) {
      const newlineIndex = buffer.indexOf('\n')
      if (newlineIndex === -1) {
        return
      }
      let line = buffer.slice(0, newlineIndex)
      buffer = buffer.slice(newlineIndex + 1)
      if (line.endsWith('\r')) {
        line = line.slice(0, -1)
      }
      if (line.length > 0) {
        onLine(line)
      }
    }
  }

  return {
    push(chunk) {
      if (ended) {
        return
      }
      buffer += typeof chunk === 'string' ? chunk : decoder.write(chunk)
      drain()
    },
    end() {
      if (ended) {
        return
      }
      ended = true
      buffer += decoder.end()
      drain()
      if (buffer.length > 0) {
        let line = buffer
        buffer = ''
        if (line.endsWith('\r')) {
          line = line.slice(0, -1)
        }
        if (line.length > 0) {
          onLine(line)
        }
      }
    }
  }
}
