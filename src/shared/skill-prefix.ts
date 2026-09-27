/**
 * Pi expands `/skill:name` invocations into leading XML blocks on the user
 * message, e.g. `<skill name="x" location="/path">…instructions…</skill>`
 * followed by the text the user actually typed. Titles and message bubbles
 * should never show that raw markup.
 */

export interface SkillInvocation {
  name: string
  location: string
  /** The raw instructions inside the <skill> block (for expanders). */
  body: string
}

export interface SkillPrefix {
  skills: SkillInvocation[]
  /** What the user actually typed, after all leading skill blocks. */
  rest: string
}

const SKILL_OPEN = /^\s*<skill\b([^>]*)>([\s\S]*?)<\/skill>/i
const ATTR = /([\w-]+)\s*=\s*"([^"]*)"/g

function parseAttrs(raw: string): Record<string, string> {
  const attrs: Record<string, string> = {}
  for (const match of raw.matchAll(ATTR)) {
    attrs[match[1]!] = match[2]!
  }
  return attrs
}

/** Strip one or more leading <skill …>…</skill> blocks from a user message. */
export function parseSkillPrefix(text: string): SkillPrefix {
  const skills: SkillInvocation[] = []
  let rest = text
  for (;;) {
    const match = SKILL_OPEN.exec(rest)
    if (!match) {
      break
    }
    const attrs = parseAttrs(match[1]!)
    skills.push({
      name: attrs['name'] ?? '',
      location: attrs['location'] ?? '',
      body: (match[2] ?? '').trim()
    })
    rest = rest.slice(match[0].length)
  }
  return { skills, rest: rest.trim() }
}

/** Title for a chat from its first user message: the typed text, or a
 *  `/skill:name` label when the message was only a skill invocation. */
export function titleFromUserText(text: string | undefined): string | undefined {
  if (text === undefined) {
    return undefined
  }
  const { skills, rest } = parseSkillPrefix(text)
  if (rest) {
    return rest
  }
  const first = skills.find((s) => s.name)
  return first ? `/skill:${first.name}` : text
}
