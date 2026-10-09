import Foundation

/**
 * A small syntax highlighter for code in replies and the file viewer
 * (mobile/src/lib/highlight.ts): comments, strings, numbers and keywords for
 * the languages models write most. One linear pass; unknown stays plain.
 */
public enum TokenKind: Sendable {
    case plain, comment, string, keyword, number, added, removed
}

public struct CodeToken: Hashable, Sendable {
    public var text: String
    public var kind: TokenKind
}

private struct Family {
    var line: [String] = []
    var block: (String, String)?
    var quotes: Set<Character>
    var keywords: Set<String>
}

private func words(_ list: String) -> Set<String> { Set(list.split(separator: " ").map(String.init)) }

private let cLike = words(
    "abstract as async await break case catch class const continue debugger default delete do else enum export extends false final finally fn for from func function go if impl implements import in instanceof interface let match mod mut namespace new nil null of override package private protected pub public readonly return self static struct super switch this throw throws true try type typeof undefined use var void while yield int long float double bool boolean char string String"
)
private let python = words(
    "and as assert async await break class continue def del elif else except False finally for from global if import in is lambda None nonlocal not or pass raise return True try while with yield self"
)
private let shell = words("if then else elif fi for in do done while until case esac function return export local echo cd exit set unset source alias sudo")
private let sql = words(
    "select from where and or not insert into values update set delete create table drop alter index join left right inner outer on group by order having limit as distinct null is in like union all primary key foreign references default"
)
private let config = words("true false null yes no on off")

private let slash = Family(line: ["//"], block: ("/*", "*/"), quotes: ["\"", "'", "`"], keywords: cLike)
private let hash = Family(line: ["#"], quotes: ["\"", "'"], keywords: python)
private let shellFamily = Family(line: ["#"], quotes: ["\"", "'"], keywords: shell)

private let families: [String: Family] = {
    var map: [String: Family] = [:]
    for name in ["js", "jsx", "ts", "tsx", "javascript", "typescript", "mjs", "java", "kotlin", "kt", "swift", "go", "rust", "rs",
                 "c", "cpp", "c++", "h", "cs", "csharp", "php", "dart", "scala"] {
        map[name] = slash
    }
    map["json"] = Family(quotes: ["\""], keywords: config)
    map["jsonc"] = Family(line: ["//"], block: ("/*", "*/"), quotes: ["\""], keywords: config)
    map["css"] = Family(block: ("/*", "*/"), quotes: ["\"", "'"], keywords: [])
    map["scss"] = Family(line: ["//"], block: ("/*", "*/"), quotes: ["\"", "'"], keywords: [])
    for name in ["py", "python", "rb", "ruby"] { map[name] = hash }
    for name in ["sh", "bash", "zsh", "shell"] { map[name] = shellFamily }
    for name in ["yaml", "yml", "toml"] { map[name] = Family(line: ["#"], quotes: ["\"", "'"], keywords: config) }
    map["dockerfile"] = Family(line: ["#"], quotes: ["\"", "'"], keywords: [])
    map["sql"] = Family(line: ["--"], block: ("/*", "*/"), quotes: ["'", "\""], keywords: sql)
    return map
}()

/// Longer blocks stay plain: highlighting must never slow a stream down.
public let maxHighlightChars = 24_000

private func diffTokens(_ code: String) -> [CodeToken] {
    let lines = code.components(separatedBy: "\n")
    return lines.enumerated().map { index, line in
        let kind: TokenKind
        if line.hasPrefix("+") && !line.hasPrefix("+++") {
            kind = .added
        } else if line.hasPrefix("-") && !line.hasPrefix("---") {
            kind = .removed
        } else if line.hasPrefix("@@") {
            kind = .comment
        } else {
            kind = .plain
        }
        return CodeToken(text: index < lines.count - 1 ? line + "\n" : line, kind: kind)
    }
}

private func isIdentStart(_ ch: Character) -> Bool { ch.isASCII && (ch.isLetter || ch == "_" || ch == "$") }
private func isIdent(_ ch: Character) -> Bool { ch.isASCII && (ch.isLetter || ch.isNumber || ch == "_" || ch == "$") }
private func isDigit(_ ch: Character) -> Bool { ch.isASCII && ch.isNumber }
private func isNumberPart(_ ch: Character) -> Bool { ch.isASCII && (ch.isHexDigit || ch == "x" || ch == "X" || ch == "." || ch == "_") }

public func highlight(_ code: String, lang: String?, maxChars: Int = maxHighlightChars) -> [CodeToken] {
    let name = (lang ?? "").lowercased()
    if name == "diff" || name == "patch" { return diffTokens(code) }
    guard let family = families[name], code.utf16.count <= maxChars else { return [CodeToken(text: code, kind: .plain)] }
    let insensitive = name == "sql"
    let chars = Array(code)
    let lineMarks = family.line.map(Array.init)
    let blockOpen = family.block.map { Array($0.0) }
    let blockClose = family.block.map { Array($0.1) }
    var tokens: [CodeToken] = []
    var plain = ""
    func push(_ text: String, _ kind: TokenKind) {
        if !plain.isEmpty {
            tokens.append(CodeToken(text: plain, kind: .plain))
            plain = ""
        }
        tokens.append(CodeToken(text: text, kind: kind))
    }
    func starts(_ mark: [Character], _ at: Int) -> Bool {
        guard at + mark.count <= chars.count else { return false }
        for k in 0..<mark.count where chars[at + k] != mark[k] { return false }
        return true
    }
    var i = 0
    while i < chars.count {
        let ch = chars[i]
        if lineMarks.contains(where: { starts($0, i) }) {
            var end = i
            while end < chars.count && !chars[end].isNewline { end += 1 }
            push(String(chars[i..<end]), .comment)
            i = end
            continue
        }
        if let open = blockOpen, let close = blockClose, starts(open, i) {
            var end = i + open.count
            while end < chars.count && !starts(close, end) { end += 1 }
            end = min(chars.count, end + (end < chars.count ? close.count : 0))
            push(String(chars[i..<end]), .comment)
            i = end
            continue
        }
        if family.quotes.contains(ch) {
            var end = i + 1
            while end < chars.count && chars[end] != ch {
                if chars[end].isNewline && ch != "`" { break }
                end += chars[end] == "\\" ? 2 : 1
            }
            end = min(end + 1, chars.count)
            push(String(chars[i..<end]), .string)
            i = end
            continue
        }
        if isIdentStart(ch) {
            var end = i + 1
            while end < chars.count && isIdent(chars[end]) { end += 1 }
            let word = String(chars[i..<end])
            if family.keywords.contains(insensitive ? word.lowercased() : word) {
                push(word, .keyword)
            } else {
                plain += word
            }
            i = end
            continue
        }
        if isDigit(ch) {
            var end = i + 1
            while end < chars.count && isNumberPart(chars[end]) { end += 1 }
            push(String(chars[i..<end]), .number)
            i = end
            continue
        }
        plain.append(ch)
        i += 1
    }
    if !plain.isEmpty { tokens.append(CodeToken(text: plain, kind: .plain)) }
    return tokens
}

/// The highlighter's language for a file name ("Dockerfile", "app.tsx").
public func languageOfPath(_ path: String) -> String? {
    let name = (path.split(separator: "/").last.map(String.init) ?? "").lowercased()
    if name == "dockerfile" { return "dockerfile" }
    guard name.contains("."), let ext = name.split(separator: ".").last.map(String.init) else { return nil }
    return families[ext] != nil || ext == "diff" || ext == "patch" ? ext : nil
}

/// A whole file highlighted at once, then cut into lines.
public func highlightLines(_ code: String, lang: String?) -> [[CodeToken]] {
    var lines: [[CodeToken]] = [[]]
    for token in highlight(code, lang: lang, maxChars: 400_000) {
        let parts = token.text.components(separatedBy: "\n")
        for (index, part) in parts.enumerated() {
            if index > 0 { lines.append([]) }
            if !part.isEmpty {
                let clean = part.hasSuffix("\r") ? String(part.dropLast()) : part
                lines[lines.count - 1].append(CodeToken(text: clean, kind: token.kind))
            }
        }
    }
    return lines
}
