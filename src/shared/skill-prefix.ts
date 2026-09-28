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

/**
 * A leading token that is an absolute path (or file:// URL) to an image
 * file — pi drops pasted screenshots into temp files and prefixes the
 * message with their paths. Never title a chat after one.
 */
const IMAGE_PATH_TOKEN =
  /^\s*(?:file:\/\/\S+|~?\/\S+|[A-Za-z]:\\\S+)\.(?:png|jpe?g|gif|webp|bmp|heic|heif|avif|tiff?|svg)(?=\s|$)/i

function stripLeadingImagePaths(text: string): { rest: string; hadImage: boolean } {
  let rest = text
  let hadImage = false
  for (;;) {
    const match = IMAGE_PATH_TOKEN.exec(rest)
    if (!match) {
      break
    }
    hadImage = true
    rest = rest.slice(match[0].length)
  }
  return { rest: rest.trim(), hadImage }
}

/** `@path` / `@"quoted path"` tokens collapse to the basename in derived
 *  titles — `@username` stays untouched. Mirrors the bubble chip rules. */
const MENTION_TOKEN_RE = /@"([^"\n]+)"|@([^\s"'@=]+)/g

function titleMentionsToBasenames(text: string): string {
  return text.replace(
    MENTION_TOKEN_RE,
    (raw, quoted: string | undefined, plain: string | undefined, offset: number, whole: string) => {
      const prev = whole[offset - 1]
      if (prev !== undefined && prev !== ' ' && prev !== '\t' && prev !== '\n') {
        return raw // mid-word, e.g. an email address
      }
      const path = quoted ?? plain!
      if (!path.includes('/') && !/\.[A-Za-z0-9]{1,10}$/.test(path)) {
        return raw
      }
      const clean = path.replace(/\/+$/, '')
      const slash = clean.lastIndexOf('/')
      return slash === -1 ? clean : clean.slice(slash + 1)
    }
  )
}

/** Title for a chat from its first user message: the typed text, or a
 *  `/skill:name` label when the message was only a skill invocation, or
 *  "Image" when it was only pasted images. */
export function titleFromUserText(text: string | undefined): string | undefined {
  if (text === undefined) {
    return undefined
  }
  const { skills, rest: afterSkills } = parseSkillPrefix(text)
  const { rest, hadImage } = stripLeadingImagePaths(afterSkills)
  if (rest) {
    return titleMentionsToBasenames(rest)
  }
  if (hadImage) {
    return 'Image'
  }
  const first = skills.find((s) => s.name)
  return first ? `/skill:${first.name}` : text
}
