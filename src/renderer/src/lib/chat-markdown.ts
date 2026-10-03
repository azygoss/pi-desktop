import type { DisplayMessage, ToolRun } from '../../../shared/chat-view'
import { parseSkillPrefix } from '../../../shared/skill-prefix'
import { toolCallSummary } from './tool-summary'

/** A fence longer than any backtick run inside `text`. */
function fenceFor(text: string): string {
  const longest = (text.match(/`+/g) ?? []).reduce((max, run) => Math.max(max, run.length), 0)
  return '`'.repeat(Math.max(3, longest + 1))
}

/**
 * A chat as Markdown: prompts as headed sections, replies as written, and
 * each tool call as one line (the trace, not its output). Thinking is left
 * out — it is the model's scratch work, not the conversation.
 */
export function chatToMarkdown(
  title: string,
  messages: DisplayMessage[],
  toolRuns: Record<string, ToolRun>,
  cwd: string
): string {
  const out: string[] = [`# ${title.trim() || 'Chat'}`]
  for (const message of messages) {
    if (message.kind === 'user') {
      const { skills, rest } = parseSkillPrefix(message.text)
      const text = [...skills.map((s) => `/skill:${s.name}`), rest].filter(Boolean).join(' ')
      out.push(`## You\n\n${text.trim()}`)
    } else if (message.kind === 'assistant') {
      const parts: string[] = []
      for (const block of message.blocks) {
        if (block.type === 'text' && block.text.trim()) {
          parts.push(block.text.trim())
        } else if (block.type === 'toolCall') {
          const run = toolRuns[block.id]
          const args = run && Object.keys(run.args).length > 0 ? run.args : block.arguments
          const summary = toolCallSummary(block.name, args, cwd)
          const failed = run?.status === 'error' ? ' (failed)' : ''
          parts.push(`- \`${block.name}\`${summary ? ` ${summary}` : ''}${failed}`)
        }
      }
      if (message.errorMessage) {
        parts.push(`> ${message.errorMessage}`)
      }
      if (parts.length > 0) {
        // Consecutive tool lines form one list; prose gets its own paragraph.
        let body = ''
        parts.forEach((part, i) => {
          const prev = parts[i - 1]
          const joiner =
            i === 0 ? '' : part.startsWith('- `') && prev?.startsWith('- `') ? '\n' : '\n\n'
          body += joiner + part
        })
        out.push(body)
      }
    } else if (message.kind === 'bash') {
      const fence = fenceFor(message.output)
      const output = message.output.trim()
      out.push(
        `${fence}console\n$ ${message.command}${output ? `\n${output}` : ''}\n${fence}`
      )
    }
  }
  return out.join('\n\n') + '\n'
}
