import Foundation

// Line diffs of edit steps (line-diff.ts), review comments on a working-tree
// diff (review-comments.ts) and the session tree (session-tree.ts).

public struct DiffLine: Hashable, Sendable {
    public enum Kind: Sendable { case context, removed, added }
    public var kind: Kind
    public var text: String

    public init(kind: Kind, text: String) {
        self.kind = kind
        self.text = text
    }
}

private let maxLCSCells = 400_000

private func splitDiffLines(_ text: String) -> [String] {
    guard !text.isEmpty else { return [] }
    return (text.hasSuffix("\n") ? String(text.dropLast()) : text).components(separatedBy: "\n")
}

private func diffMiddle(_ a: [String], _ b: [String]) -> [DiffLine] {
    if a.isEmpty || b.isEmpty || a.count * b.count > maxLCSCells {
        return a.map { DiffLine(kind: .removed, text: $0) } + b.map { DiffLine(kind: .added, text: $0) }
    }
    let width = b.count + 1
    var table = [UInt32](repeating: 0, count: (a.count + 1) * width)
    for i in stride(from: a.count - 1, through: 0, by: -1) {
        for j in stride(from: b.count - 1, through: 0, by: -1) {
            table[i * width + j] = a[i] == b[j]
                ? table[(i + 1) * width + j + 1] + 1
                : max(table[(i + 1) * width + j], table[i * width + j + 1])
        }
    }
    var out: [DiffLine] = []
    var i = 0
    var j = 0
    while i < a.count && j < b.count {
        if a[i] == b[j] {
            out.append(DiffLine(kind: .context, text: a[i]))
            i += 1
            j += 1
        } else if table[(i + 1) * width + j] >= table[i * width + j + 1] {
            out.append(DiffLine(kind: .removed, text: a[i]))
            i += 1
        } else {
            out.append(DiffLine(kind: .added, text: b[j]))
            j += 1
        }
    }
    while i < a.count {
        out.append(DiffLine(kind: .removed, text: a[i]))
        i += 1
    }
    while j < b.count {
        out.append(DiffLine(kind: .added, text: b[j]))
        j += 1
    }
    return out
}

/// Unified line diff of `oldText` → `newText`.
public func diffLines(_ oldText: String, _ newText: String) -> [DiffLine] {
    let a = splitDiffLines(oldText)
    let b = splitDiffLines(newText)
    var lead = 0
    while lead < a.count && lead < b.count && a[lead] == b[lead] { lead += 1 }
    var trail = 0
    while trail < a.count - lead && trail < b.count - lead && a[a.count - 1 - trail] == b[b.count - 1 - trail] {
        trail += 1
    }
    let context: ([String]) -> [DiffLine] = { $0.map { DiffLine(kind: .context, text: $0) } }
    return context(Array(a[0..<lead]))
        + diffMiddle(Array(a[lead..<(a.count - trail)]), Array(b[lead..<(b.count - trail)]))
        + context(Array(a[(a.count - trail)...]))
}

/// Keep `radius` context lines around each change; longer runs become nil gaps.
public func trimContext(_ lines: [DiffLine], radius: Int = 3) -> [DiffLine?] {
    var keep = [Bool](repeating: false, count: lines.count)
    for (index, line) in lines.enumerated() where line.kind != .context {
        for k in max(0, index - radius)...min(lines.count - 1, index + radius) { keep[k] = true }
    }
    var out: [DiffLine?] = []
    for (index, line) in lines.enumerated() {
        if keep[index] {
            out.append(line)
        } else if let last = out.last, last != nil {
            out.append(nil)
        }
    }
    while let last = out.last, last == nil { out.removeLast() }
    return out
}

// MARK: - Review comments

/// A comment placed on a line of the current diff.
public struct PlacedComment: Hashable, Sendable, Identifiable {
    public var comment: ReviewComment
    /// `hunk:line` of the diff line it sits under.
    public var key: String
    public var line: Int?
    public var lineText: String
    /// Text shown (prefixed with the line number when it fell back).
    public var text: String
    /// The line it was about is not in the diff: it sits on the file's first line.
    public var fallback: Bool
    /// It sits on a removed line (`line` is the old file's).
    public var removed: Bool

    public var id: String { comment.id }
    public var path: String { comment.path }
    public var fromPi: Bool { comment.fromPi }
}

/// Where a remark about `line` of the new file belongs in a parsed file.
public func anchorForLine(_ file: DiffFile, _ line: Int?) -> (key: String, line: Int?, lineText: String, exact: Bool)? {
    var first: (key: String, line: Int?, lineText: String, exact: Bool)?
    for (i, hunk) in file.hunks.enumerated() {
        for (j, diffLine) in hunk.lines.enumerated() {
            let here = (key: "\(i):\(j)", line: diffLine.newNo ?? diffLine.oldNo, lineText: diffLine.text)
            if let line, diffLine.newNo == line { return (here.key, here.line, here.lineText, true) }
            if first == nil { first = (here.key, here.line, here.lineText, false) }
        }
    }
    return first
}

/// The prompt that hands review comments to pi.
public func reviewPrompt(_ comments: [(path: String, line: Int?, lineText: String, text: String)]) -> String {
    guard !comments.isEmpty else { return "" }
    let items = comments.enumerated().map { index, comment -> String in
        let place = comment.line.map { "\(comment.path):\($0)" } ?? comment.path
        let quoted = String(comment.lineText.trimmed.prefix(120))
        let head = quoted.isEmpty ? "`\(place)`" : "`\(place)` — `\(quoted.replacingOccurrences(of: "`", with: "'"))`"
        let body = comment.text.trimmed.components(separatedBy: "\n").map { "   \($0)" }.joined(separator: "\n")
        return "\(index + 1). \(head)\n\(body)"
    }
    let intro = comments.count == 1
        ? "Please address this review comment on the current changes:"
        : "Please address these review comments on the current changes:"
    return "\(intro)\n\n\(items.joined(separator: "\n\n"))\n"
}

/// Place a project's comments on the diff. Yours follow their line by its
/// text, nearest to where it was; pi's go on the line they name.
public func placeComments(_ files: [DiffFile], _ comments: [ReviewComment]) -> [PlacedComment] {
    var placed: [PlacedComment] = []
    for comment in comments {
        guard let file = files.first(where: { $0.path == comment.path }) else { continue }
        var found: (key: String, line: Int?, lineText: String, removed: Bool)?
        if !comment.lineText.isEmpty {
            var best = Int.max
            for (i, hunk) in file.hunks.enumerated() {
                for (j, line) in hunk.lines.enumerated() where line.text == comment.lineText {
                    let no = line.newNo ?? line.oldNo
                    let distance = abs((no ?? 0) - (comment.line ?? 0))
                    if distance < best {
                        best = distance
                        found = ("\(i):\(j)", no, line.text, line.type == .del)
                    }
                }
            }
        } else if let anchor = anchorForLine(file, comment.line), anchor.exact {
            found = (anchor.key, anchor.line, anchor.lineText, false)
        }
        if let at = found {
            placed.append(
                PlacedComment(
                    comment: comment,
                    key: at.key,
                    line: at.line ?? comment.line,
                    lineText: at.lineText,
                    text: comment.text,
                    fallback: false,
                    removed: at.removed
                )
            )
            continue
        }
        if let first = anchorForLine(file, nil) {
            placed.append(
                PlacedComment(
                    comment: comment,
                    key: first.key,
                    line: comment.line,
                    lineText: comment.lineText,
                    text: comment.line.map { "Line \($0): \(comment.text)" } ?? comment.text,
                    fallback: true,
                    removed: false
                )
            )
        }
    }
    return placed
}

// MARK: - Session tree

public struct TreeRow: Hashable, Sendable, Identifiable {
    public var id: String
    /// Indent: grows only where the conversation branches.
    public var depth: Int
    public var role: String
    public var snippet: String
    /// On the branch pi is on now.
    public var active: Bool
    public var leaf: Bool
    public var branchStart: Bool
    public var forkable: Bool
}

public func messageSnippet(_ message: AgentMessage?, max: Int = 90) -> String {
    guard let message, let content = message.contentBlocks else { return "" }
    for block in content {
        if case .text(let text) = block { return String(collapseWhitespace(text).prefix(max)) }
    }
    for block in content {
        if case .toolCall(let call) = block { return "→ \(call.name)" }
    }
    for block in content {
        if case .thinking(let thinking) = block { return String(collapseWhitespace(thinking).prefix(max)) }
    }
    return "[\(content.map(\.typeName).joined(separator: ", "))]"
}

/// Flatten pi's session tree: a linear chat stays flat, branches indent.
public func flattenSessionTree(_ result: PiTreeResult) -> [TreeRow] {
    var parents: [String: String?] = [:]
    var pending: [(node: PiTreeNode, parent: String?)] = result.tree.map { ($0, nil) }
    while let (node, parent) = pending.popLast() {
        parents[node.id] = parent
        for child in node.children { pending.append((child, node.id)) }
    }
    var active = Set<String>()
    var cursor = result.leafId
    while let id = cursor {
        active.insert(id)
        cursor = parents[id] ?? nil
    }

    var rows: [TreeRow] = []
    var stack: [(node: PiTreeNode, depth: Int, branchStart: Bool)] = []
    func push(_ nodes: [PiTreeNode], _ depth: Int) {
        let branched = nodes.count > 1
        let ordered = nodes.enumerated().sorted { lhs, rhs in
            let a = active.contains(lhs.element.id) ? 1 : 0
            let b = active.contains(rhs.element.id) ? 1 : 0
            return a != b ? a > b : lhs.offset < rhs.offset
        }.map(\.element)
        for node in ordered.reversed() {
            stack.append((node, branched ? depth + 1 : depth, branched))
        }
    }
    push(result.tree, -1)
    while let (node, depth, branchStart) = stack.popLast() {
        let role = node.message?.role ?? node.type
        let snippet = collapseWhitespace(node.label ?? messageSnippet(node.message))
        rows.append(
            TreeRow(
                id: node.id,
                depth: Swift.max(depth, 0),
                role: role,
                snippet: snippet.isEmpty ? node.type : snippet,
                active: active.contains(node.id),
                leaf: node.id == result.leafId,
                branchStart: branchStart,
                forkable: role == "user"
            )
        )
        push(node.children, Swift.max(depth, 0))
    }
    return rows
}
