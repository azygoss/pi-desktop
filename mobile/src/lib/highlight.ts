/**
 * A small syntax highlighter for code blocks in replies: comments, strings,
 * numbers and keywords for the languages models write most. One linear pass,
 * no dependencies; anything it does not know stays plain.
 */

export type TokenKind = 'plain' | 'comment' | 'string' | 'keyword' | 'number' | 'added' | 'removed'

export interface Token {
  text: string
  kind: TokenKind
}

interface Family {
  line?: string[]
  block?: [string, string]
  quotes: string
  keywords: Set<string>
}

const words = (list: string): Set<string> => new Set(list.split(' '))

const C_LIKE = words(
  'abstract as async await break case catch class const continue debugger default delete do else enum export extends false final finally fn for from func function go if impl implements import in instanceof interface let match mod mut namespace new nil null of override package private protected pub public readonly return self static struct super switch this throw throws true try type typeof undefined use var void while yield int long float double bool boolean char string String'
)
const PYTHON = words(
  'and as assert async await break class continue def del elif else except False finally for from global if import in is lambda None nonlocal not or pass raise return True try while with yield self'
)
const SHELL = words(
  'if then else elif fi for in do done while until case esac function return export local echo cd exit set unset source alias sudo'
)
const SQL = words(
  'select from where and or not insert into values update set delete create table drop alter index join left right inner outer on group by order having limit as distinct null is in like union all primary key foreign references default'
)
const CONFIG = words('true false null yes no on off')

const SLASH: Family = { line: ['//'], block: ['/*', '*/'], quotes: '"\'`', keywords: C_LIKE }
const HASH: Family = { line: ['#'], quotes: '"\'', keywords: PYTHON }

const FAMILIES: Record<string, Family> = {
  js: SLASH, jsx: SLASH, ts: SLASH, tsx: SLASH, javascript: SLASH, typescript: SLASH, mjs: SLASH,
  java: SLASH, kotlin: SLASH, kt: SLASH, swift: SLASH, go: SLASH, rust: SLASH, rs: SLASH, c: SLASH,
  cpp: SLASH, 'c++': SLASH, h: SLASH, cs: SLASH, csharp: SLASH, php: SLASH, dart: SLASH, scala: SLASH,
  json: { quotes: '"', keywords: CONFIG },
  jsonc: { line: ['//'], block: ['/*', '*/'], quotes: '"', keywords: CONFIG },
  css: { block: ['/*', '*/'], quotes: '"\'', keywords: new Set() },
  scss: { line: ['//'], block: ['/*', '*/'], quotes: '"\'', keywords: new Set() },
  py: HASH, python: HASH, rb: HASH, ruby: HASH,
  sh: { line: ['#'], quotes: '"\'', keywords: SHELL },
  bash: { line: ['#'], quotes: '"\'', keywords: SHELL },
  zsh: { line: ['#'], quotes: '"\'', keywords: SHELL },
  shell: { line: ['#'], quotes: '"\'', keywords: SHELL },
  yaml: { line: ['#'], quotes: '"\'', keywords: CONFIG },
  yml: { line: ['#'], quotes: '"\'', keywords: CONFIG },
  toml: { line: ['#'], quotes: '"\'', keywords: CONFIG },
  dockerfile: { line: ['#'], quotes: '"\'', keywords: new Set() },
  sql: { line: ['--'], block: ['/*', '*/'], quotes: "'\"", keywords: SQL }
}

/** Longer blocks stay plain: highlighting must never slow a stream down. */
const MAX_CHARS = 24_000

const IDENT_START = /[A-Za-z_$]/
const IDENT = /[A-Za-z0-9_$]/
const DIGIT = /[0-9]/
const NUMBER = /[0-9A-Fa-fxX._]/

function diffTokens(code: string): Token[] {
  return code.split('\n').map((line, index, all) => ({
    text: index < all.length - 1 ? `${line}\n` : line,
    kind:
      line.startsWith('+') && !line.startsWith('+++')
        ? 'added'
        : line.startsWith('-') && !line.startsWith('---')
          ? 'removed'
          : line.startsWith('@@')
            ? 'comment'
            : 'plain'
  }))
}

export function highlight(code: string, lang: string | undefined): Token[] {
  const name = (lang ?? '').toLowerCase()
  if (name === 'diff' || name === 'patch') {
    return diffTokens(code)
  }
  const family = FAMILIES[name]
  if (!family || code.length > MAX_CHARS) {
    return [{ text: code, kind: 'plain' }]
  }
  const insensitive = name === 'sql'
  const tokens: Token[] = []
  let plain = ''
  const push = (text: string, kind: TokenKind): void => {
    if (plain) {
      tokens.push({ text: plain, kind: 'plain' })
      plain = ''
    }
    tokens.push({ text, kind })
  }
  let i = 0
  while (i < code.length) {
    const ch = code[i]!

    const lineComment = family.line?.find((mark) => code.startsWith(mark, i))
    if (lineComment) {
      let end = code.indexOf('\n', i)
      end = end === -1 ? code.length : end
      push(code.slice(i, end), 'comment')
      i = end
      continue
    }
    if (family.block && code.startsWith(family.block[0], i)) {
      let end = code.indexOf(family.block[1], i + family.block[0].length)
      end = end === -1 ? code.length : end + family.block[1].length
      push(code.slice(i, end), 'comment')
      i = end
      continue
    }
    if (family.quotes.includes(ch)) {
      let end = i + 1
      while (end < code.length && code[end] !== ch) {
        // A plain quote does not run past its line; a template literal may.
        if (code[end] === '\n' && ch !== '`') {
          break
        }
        end += code[end] === '\\' ? 2 : 1
      }
      end = Math.min(end + 1, code.length)
      push(code.slice(i, end), 'string')
      i = end
      continue
    }
    if (IDENT_START.test(ch)) {
      let end = i + 1
      while (end < code.length && IDENT.test(code[end]!)) {
        end++
      }
      const word = code.slice(i, end)
      if (family.keywords.has(insensitive ? word.toLowerCase() : word)) {
        push(word, 'keyword')
      } else {
        plain += word
      }
      i = end
      continue
    }
    if (DIGIT.test(ch)) {
      let end = i + 1
      while (end < code.length && NUMBER.test(code[end]!)) {
        end++
      }
      push(code.slice(i, end), 'number')
      i = end
      continue
    }
    plain += ch
    i++
  }
  if (plain) {
    tokens.push({ text: plain, kind: 'plain' })
  }
  return tokens
}
