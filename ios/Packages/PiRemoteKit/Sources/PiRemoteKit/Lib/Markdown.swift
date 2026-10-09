import Foundation

// A small markdown parser for chat replies (mobile/src/lib/markdown.ts): the
// constructs models actually write, parsed into a tree the app renders with
// native text. Plus the desktop's block splitter (markdown-blocks.ts), so a
// streaming reply re-parses only its last, growing chunk.

public indirect enum MarkdownInline: Hashable, Sendable {
    case text(String)
    case code(String)
    case strong([MarkdownInline])
    case em([MarkdownInline])
    case del([MarkdownInline])
    case link(href: String, children: [MarkdownInline])
    case lineBreak
}

public struct MarkdownListItem: Hashable, Sendable {
    public var blocks: [MarkdownBlock]
    /// Task list state; nil for ordinary items.
    public var checked: Bool?
}

public indirect enum MarkdownBlock: Hashable, Sendable {
    case heading(level: Int, inline: [MarkdownInline])
    case paragraph([MarkdownInline])
    case code(lang: String, text: String)
    case quote([MarkdownBlock])
    case list(ordered: Bool, start: Int, items: [MarkdownListItem])
    case rule
    case table(header: [[MarkdownInline]], rows: [[[MarkdownInline]]])
}

private let fencePattern = Pattern("^ {0,3}(`{3,}|~{3,})\\s*([^\\s`]*)")
private let headingPattern = Pattern("^ {0,3}(#{1,6})\\s+(.*?)(?:\\s+#+)?\\s*$")
private let rulePattern = Pattern("^ {0,3}([-*_])(?:\\s*\\1){2,}\\s*$")
private let listItemPattern = Pattern("^(\\s*)([-*+]|\\d{1,9}[.)])(\\s+|$)(.*)$")
private let tableRulePattern = Pattern("^\\s*\\|?\\s*:?-{1,}:?\\s*(\\|\\s*:?-{1,}:?\\s*)*\\|?\\s*$")
private let quotePattern = Pattern("^ {0,3}>\\s?")
private let taskPattern = Pattern("^\\[([ xX])\\]\\s+")

private func isBlank(_ line: String) -> Bool { line.trimmed.isEmpty }

private func isTableStart(_ line: String, _ next: String?) -> Bool {
    guard let next else { return false }
    return line.contains("|") && tableRulePattern.test(next) && next.contains("-")
}

private func startsBlock(_ line: String, _ next: String?) -> Bool {
    fencePattern.test(line) || headingPattern.test(line) || rulePattern.test(line) || quotePattern.test(line)
        || isTableStart(line, next)
}

private func splitRow(_ line: String) -> [String] {
    var row = line.trimmed
    if row.hasPrefix("|") { row.removeFirst() }
    if row.hasSuffix("|") && !row.hasSuffix("\\|") { row.removeLast() }
    var cells: [String] = []
    var cell = ""
    var inCode = false
    let chars = Array(row)
    var i = 0
    while i < chars.count {
        let ch = chars[i]
        if ch == "\\" && i + 1 < chars.count && chars[i + 1] == "|" {
            cell.append("|")
            i += 1
        } else if ch == "`" {
            inCode.toggle()
            cell.append(ch)
        } else if ch == "|" && !inCode {
            cells.append(cell.trimmed)
            cell = ""
        } else {
            cell.append(ch)
        }
        i += 1
    }
    cells.append(cell.trimmed)
    return cells
}

public func parseMarkdown(_ text: String) -> [MarkdownBlock] {
    let normalized = text.replacingOccurrences(of: "\r\n", with: "\n").replacingOccurrences(of: "\r", with: "\n")
    return parseBlocks(normalized.components(separatedBy: "\n"))
}

private func indentOf(_ line: String) -> Int {
    var n = 0
    for ch in line {
        if ch == " " { n += 1 } else { break }
    }
    return n
}

private func dropChars(_ line: String, _ n: Int) -> String {
    String(line.dropFirst(min(n, line.count)))
}

private func parseBlocks(_ lines: [String]) -> [MarkdownBlock] {
    var blocks: [MarkdownBlock] = []
    var i = 0
    while i < lines.count {
        let line = lines[i]
        if isBlank(line) {
            i += 1
            continue
        }

        if let fence = fencePattern.exec(line) {
            let marker = fence[1] ?? "```"
            let closing = String(repeating: String(marker.first ?? "`"), count: marker.count)
            var body: [String] = []
            i += 1
            while i < lines.count {
                let candidate = lines[i].trimmed
                if candidate.hasPrefix(closing) && candidate.allSatisfy({ $0 == "`" || $0 == "~" }) { break }
                body.append(lines[i])
                i += 1
            }
            i += 1
            blocks.append(.code(lang: fence[2] ?? "", text: body.joined(separator: "\n")))
            continue
        }

        if let heading = headingPattern.exec(line) {
            blocks.append(.heading(level: heading[1]?.count ?? 1, inline: parseInline(heading[2] ?? "")))
            i += 1
            continue
        }

        if rulePattern.test(line) {
            blocks.append(.rule)
            i += 1
            continue
        }

        if quotePattern.test(line) {
            var inner: [String] = []
            while i < lines.count && !isBlank(lines[i]) && (quotePattern.test(lines[i]) || !inner.isEmpty) {
                if !quotePattern.test(lines[i]) && startsBlock(lines[i], i + 1 < lines.count ? lines[i + 1] : nil) { break }
                inner.append(quotePattern.replace(lines[i], with: ""))
                i += 1
            }
            blocks.append(.quote(parseBlocks(inner)))
            continue
        }

        let next = i + 1 < lines.count ? lines[i + 1] : nil
        if isTableStart(line, next) {
            let header = splitRow(line).map(parseInline)
            var rows: [[[MarkdownInline]]] = []
            i += 2
            while i < lines.count && !isBlank(lines[i]) && lines[i].contains("|") {
                var cells = splitRow(lines[i]).map(parseInline)
                while cells.count < header.count { cells.append([]) }
                rows.append(Array(cells.prefix(header.count)))
                i += 1
            }
            blocks.append(.table(header: header, rows: rows))
            continue
        }

        if listItemPattern.test(line) {
            let (list, consumed) = parseList(lines, i)
            blocks.append(list)
            i = consumed
            continue
        }

        var paragraph: [String] = []
        while i < lines.count && !isBlank(lines[i]) {
            let following = i + 1 < lines.count ? lines[i + 1] : nil
            if !paragraph.isEmpty && (startsBlock(lines[i], following) || listItemPattern.test(lines[i])) { break }
            paragraph.append(lines[i])
            i += 1
        }
        blocks.append(.paragraph(parseInline(paragraph.joined(separator: "\n"))))
    }
    return blocks
}

private func isOrderedMarker(_ marker: String) -> Bool { marker.first?.isNumber ?? false }

private func parseList(_ lines: [String], _ start: Int) -> (MarkdownBlock, Int) {
    let first = listItemPattern.exec(lines[start]) ?? []
    let baseIndent = (first[safe: 1] ?? "")?.count ?? 0
    let firstMarker = (first[safe: 2] ?? "") ?? ""
    let ordered = isOrderedMarker(firstMarker)
    var items: [MarkdownListItem] = []
    var i = start
    while i < lines.count {
        guard let match = listItemPattern.exec(lines[i]),
            (match[1] ?? "").count == baseIndent,
            isOrderedMarker(match[2] ?? "") == ordered
        else { break }
        let marker = match[2] ?? ""
        let spacing = (match[3] ?? "").count
        let contentIndent = baseIndent + marker.count + min(max(spacing, 1), 4)
        var body: [String] = [match[4] ?? ""]
        i += 1
        while i < lines.count {
            let line = lines[i]
            if isBlank(line) {
                if i + 1 < lines.count, !isBlank(lines[i + 1]), indentOf(lines[i + 1]) >= contentIndent {
                    body.append("")
                    i += 1
                    continue
                }
                break
            }
            if indentOf(line) >= contentIndent {
                body.append(dropChars(line, contentIndent))
                i += 1
                continue
            }
            let sibling = listItemPattern.exec(line)
            if let sibling, (sibling[1] ?? "").count > baseIndent {
                body.append(dropChars(line, min(indentOf(line), contentIndent)))
                i += 1
                continue
            }
            if sibling != nil || startsBlock(line, i + 1 < lines.count ? lines[i + 1] : nil) { break }
            body.append(line.trimmed)
            i += 1
        }
        var checked: Bool?
        if let task = taskPattern.exec(body[0]) {
            checked = task[1] != " "
            body[0] = dropChars(body[0], (task[0] ?? "").count)
        }
        items.append(MarkdownListItem(blocks: parseBlocks(body), checked: checked))
        var peek = i
        while peek < lines.count && isBlank(lines[peek]) { peek += 1 }
        if peek > i, peek < lines.count, let nextItem = listItemPattern.exec(lines[peek]),
            (nextItem[1] ?? "").count == baseIndent, isOrderedMarker(nextItem[2] ?? "") == ordered
        {
            i = peek
        }
    }
    let startNumber = ordered ? (Int(firstMarker.filter(\.isNumber)) ?? 1) : 1
    return (.list(ordered: ordered, start: startNumber, items: items), i)
}

extension Array {
    subscript(safe index: Int) -> Element? { indices.contains(index) ? self[index] : nil }
}

// MARK: - Inline

private func isWordChar(_ ch: Character?) -> Bool {
    guard let ch, ch.isASCII else { return false }
    return ch.isLetter || ch.isNumber
}

private func hasPrefix(_ chars: [Character], _ prefix: [Character], at index: Int) -> Bool {
    guard index >= 0, index + prefix.count <= chars.count else { return false }
    for k in 0..<prefix.count where chars[index + k] != prefix[k] { return false }
    return true
}

private func indexOf(_ chars: [Character], _ needle: [Character], from: Int) -> Int? {
    guard !needle.isEmpty else { return nil }
    var i = max(0, from)
    while i + needle.count <= chars.count {
        if hasPrefix(chars, needle, at: i) { return i }
        i += 1
    }
    return nil
}

/// Index of the delimiter that closes one opened before `from`.
private func findClose(_ chars: [Character], _ delimiter: [Character], from: Int) -> Int? {
    var i = from
    while i < chars.count {
        let ch = chars[i]
        if ch == "\\" {
            i += 2
            continue
        }
        if ch == "`" {
            if let end = indexOf(chars, ["`"], from: i + 1) { i = end + 1 } else { i += 1 }
            continue
        }
        if hasPrefix(chars, delimiter, at: i) {
            let before: Character? = i > 0 ? chars[i - 1] : nil
            let after: Character? = i + delimiter.count < chars.count ? chars[i + delimiter.count] : nil
            let single = delimiter.count == 1
            if let before, before != " ", before != "\n",
                !(single && (after == delimiter[0] || before == delimiter[0])),
                !(delimiter[0] == "_" && isWordChar(after))
            {
                return i
            }
        }
        i += 1
    }
    return nil
}

private func findBracket(_ chars: [Character], _ open: Int) -> Int? {
    var depth = 0
    var i = open
    while i < chars.count {
        let ch = chars[i]
        if ch == "\\" {
            i += 1
        } else if ch == "[" {
            depth += 1
        } else if ch == "]" {
            depth -= 1
            if depth == 0 { return i }
        } else if ch == "\n" && i + 1 < chars.count && chars[i + 1] == "\n" {
            return nil
        }
        i += 1
    }
    return nil
}

private let urlEnd: Set<Character> = [" ", "\t", "\n", "<", ">"]
private let urlTrailing: Set<Character> = [".", ",", ";", ":", "!", "?", ")", "]", "'", "\""]

public func parseInline(_ text: String) -> [MarkdownInline] {
    parseInline(Array(text))
}

private func parseInline(_ chars: [Character]) -> [MarkdownInline] {
    var out: [MarkdownInline] = []
    var buffer = ""
    func flush() {
        if !buffer.isEmpty {
            out.append(.text(buffer))
            buffer = ""
        }
    }
    let http = Array("http://")
    let https = Array("https://")
    var i = 0
    while i < chars.count {
        let ch = chars[i]

        if ch == "\\" && i + 1 < chars.count {
            if chars[i + 1] == "\n" {
                flush()
                out.append(.lineBreak)
            } else {
                buffer.append(chars[i + 1])
            }
            i += 2
            continue
        }

        if ch == "`" {
            var run = 1
            while i + run < chars.count && chars[i + run] == "`" { run += 1 }
            let fence = [Character](repeating: "`", count: run)
            if let end = indexOf(chars, fence, from: i + run) {
                flush()
                out.append(.code(String(chars[(i + run)..<end]).replacingOccurrences(of: "\n", with: " ")))
                i = end + run
                continue
            }
            buffer += String(fence)
            i += run
            continue
        }

        if ch == "\n" {
            if buffer.hasSuffix("  ") {
                while buffer.hasSuffix(" ") { buffer.removeLast() }
                flush()
                out.append(.lineBreak)
            } else {
                buffer.append(" ")
            }
            i += 1
            continue
        }

        if ch == "!" && i + 1 < chars.count && chars[i + 1] == "[" {
            i += 1 // an image renders as its link
            continue
        }

        if ch == "[", let close = findBracket(chars, i), close + 1 < chars.count, chars[close + 1] == "(",
            let end = indexOf(chars, [")"], from: close + 2)
        {
            let href = String(chars[(close + 2)..<end]).trimmed.split(whereSeparator: { $0.isWhitespace }).first.map(String.init) ?? ""
            flush()
            out.append(.link(href: href, children: parseInline(Array(chars[(i + 1)..<close]))))
            i = end + 1
            continue
        }

        if ch == "<", let end = indexOf(chars, [">"], from: i + 1) {
            let inner = String(chars[(i + 1)..<end])
            if (inner.hasPrefix("http://") || inner.hasPrefix("https://")) && !inner.contains(where: { $0.isWhitespace }) {
                flush()
                out.append(.link(href: inner, children: [.text(inner)]))
                i = end + 1
                continue
            }
        }

        if (ch == "h" && hasPrefix(chars, http, at: i)) || hasPrefix(chars, https, at: i) {
            if !isWordChar(i > 0 ? chars[i - 1] : nil) {
                var end = i
                while end < chars.count && !urlEnd.contains(chars[end]) { end += 1 }
                while end > i && urlTrailing.contains(chars[end - 1]) { end -= 1 }
                let href = String(chars[i..<end])
                if href.count > 8 {
                    flush()
                    out.append(.link(href: href, children: [.text(href)]))
                    i = end
                    continue
                }
            }
        }

        if ch == "*" || ch == "_" || ch == "~" {
            let double = i + 1 < chars.count && chars[i + 1] == ch
            let delimiter: [Character] = double ? [ch, ch] : [ch]
            let after: Character? = i + delimiter.count < chars.count ? chars[i + delimiter.count] : nil
            let opens = after != nil && after != " " && after != "\n"
                && !(ch == "_" && isWordChar(i > 0 ? chars[i - 1] : nil))
                && !(ch == "~" && !double)
            if opens, let close = findClose(chars, delimiter, from: i + delimiter.count + 1) {
                let children = parseInline(Array(chars[(i + delimiter.count)..<close]))
                flush()
                out.append(ch == "~" ? .del(children) : double ? .strong(children) : .em(children))
                i = close + delimiter.count
                continue
            }
            buffer += String(delimiter)
            i += delimiter.count
            continue
        }

        buffer.append(ch)
        i += 1
    }
    flush()
    return out
}

/// The plain text of inline nodes.
public func inlineText(_ nodes: [MarkdownInline]) -> String {
    nodes.map { node -> String in
        switch node {
        case .text(let t), .code(let t): return t
        case .lineBreak: return "\n"
        case .strong(let c), .em(let c), .del(let c): return inlineText(c)
        case .link(_, let c): return inlineText(c)
        }
    }.joined()
}

// MARK: - Block splitting (markdown-blocks.ts)

private let unsplittable = Pattern("^ {0,3}\\[[^\\]]+\\]:|<(?:pre|script|style|textarea)\\b|<!--", caseInsensitive: true)
private let splitFenceOpen = Pattern("^ {0,3}(`{3,}|~{3,})")
private let splitFenceClose = Pattern("^ {0,3}(`{3,}|~{3,})\\s*$")
private let splitListItem = Pattern("^(?:[-*+]|\\d{1,9}[.)])(?:\\s|$)")

/// Split markdown into top-level chunks that render identically on their own.
public func splitMarkdownBlocks(_ text: String) -> [String] {
    // NSRegularExpression's ^ is start-of-input unless multiline: check lines.
    let lines = text.components(separatedBy: "\n")
    if lines.contains(where: { unsplittable.test($0) }) { return [text] }
    var chunks: [String] = []
    var start = 0
    var fence: (char: Character, length: Int)?
    var prevBlank = false
    for (i, line) in lines.enumerated() {
        if let open = fence {
            if let close = splitFenceClose.exec(line), let marker = close[1], marker.first == open.char, marker.count >= open.length {
                fence = nil
            }
            prevBlank = false
            continue
        }
        let blank = line.trimmed.isEmpty
        if !blank && prevBlank && i > start, let first = line.first, !first.isWhitespace, !splitListItem.test(line) {
            chunks.append(lines[start..<i].joined(separator: "\n"))
            start = i
        }
        if let open = splitFenceOpen.exec(line), let marker = open[1], let char = marker.first {
            fence = (char, marker.count)
        }
        prevBlank = blank
    }
    chunks.append(lines[start...].joined(separator: "\n"))
    return chunks
}
