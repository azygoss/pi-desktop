import Foundation

// A repository's branches and worktrees (src/shared/git-branches.ts) and the
// unified-diff parser the diff screen reads with (src/shared/diff-parse.ts).

public struct LocalBranch: Hashable, Sendable {
    public var name: String
    public var current: Bool
    public var upstream: String?
    public var ahead: Int?
    public var behind: Int?
    public var gone: Bool
    public var subject: String
    /// Checked out in another worktree at this path.
    public var worktree: String?
}

public struct RemoteBranch: Hashable, Sendable {
    /// e.g. "origin/feature-x"
    public var name: String
    public var remote: String
    /// The local branch a switch would create.
    public var branch: String
    public var subject: String
}

public struct WorktreeEntry: Hashable, Sendable {
    public var path: String
    public var branch: String?
    public var current: Bool
    public var main: Bool
    public var app: Bool
    public var prunable: Bool
}

public struct RepoBranches: Sendable {
    public var root: String
    public var current: String?
    public var changes: Int
    public var branches: [LocalBranch]
    public var remotes: [RemoteBranch]
    public var worktrees: [WorktreeEntry]
    public var truncated: Bool

    public init(json: JSONValue) {
        root = json["root"]?.stringValue ?? ""
        current = json["current"]?.stringValue
        changes = json["changes"]?.intValue ?? 0
        branches = (json["branches"]?.arrayValue ?? []).compactMap { item in
            guard let name = item["name"]?.stringValue else { return nil }
            return LocalBranch(
                name: name,
                current: item["current"]?.isTrue ?? false,
                upstream: item["upstream"]?.stringValue,
                ahead: item["ahead"]?.intValue,
                behind: item["behind"]?.intValue,
                gone: item["gone"]?.isTrue ?? false,
                subject: item["subject"]?.stringValue ?? "",
                worktree: item["worktree"]?.stringValue
            )
        }
        remotes = (json["remotes"]?.arrayValue ?? []).compactMap { item in
            guard let name = item["name"]?.stringValue else { return nil }
            return RemoteBranch(
                name: name,
                remote: item["remote"]?.stringValue ?? "",
                branch: item["branch"]?.stringValue ?? name,
                subject: item["subject"]?.stringValue ?? ""
            )
        }
        worktrees = (json["worktrees"]?.arrayValue ?? []).compactMap { item in
            guard let path = item["path"]?.stringValue else { return nil }
            return WorktreeEntry(
                path: path,
                branch: item["branch"]?.stringValue,
                current: item["current"]?.isTrue ?? false,
                main: item["main"]?.isTrue ?? false,
                app: item["app"]?.isTrue ?? false,
                prunable: item["prunable"]?.isTrue ?? false
            )
        }
        truncated = json["truncated"]?.isTrue ?? false
    }
}

/// What a new worktree checks out.
public enum WorktreeSource: Sendable {
    /// A new branch (named, or pi/<slug>) cut from HEAD.
    case new(branch: String?)
    /// An existing local or remote branch.
    case existing(branch: String)

    public var json: JSONValue {
        switch self {
        case .new(let branch):
            return .compact(["kind": "new", "branch": branch.map(JSONValue.string)])
        case .existing(let branch):
            return ["kind": "existing", "branch": .string(branch)]
        }
    }
}

// MARK: - Unified diff

public struct PatchLine: Hashable, Sendable {
    public enum Kind: String, Sendable { case add, del, ctx }
    public var type: Kind
    public var text: String
    public var oldNo: Int?
    public var newNo: Int?
}

public struct DiffHunk: Hashable, Sendable {
    public var header: String
    public var lines: [PatchLine]
}

public struct DiffFile: Hashable, Sendable {
    /// Display path (new path for renames).
    public var path: String
    public var oldPath: String?
    /// modified, added, deleted or renamed
    public var status: String
    public var hunks: [DiffHunk]
    public var isBinary: Bool
    /// Untracked file too large to inline; rendered with a label only.
    public var tooLarge: Bool

    public init(path: String, oldPath: String? = nil, status: String, hunks: [DiffHunk], isBinary: Bool = false, tooLarge: Bool = false) {
        self.path = path
        self.oldPath = oldPath
        self.status = status
        self.hunks = hunks
        self.isBinary = isBinary
        self.tooLarge = tooLarge
    }

    public var changes: (added: Int, deleted: Int) {
        var added = 0
        var deleted = 0
        for hunk in hunks {
            for line in hunk.lines {
                if line.type == .add { added += 1 } else if line.type == .del { deleted += 1 }
            }
        }
        return (added, deleted)
    }
}

private let hunkPattern = try! NSRegularExpression(pattern: "^@@ -(\\d+)(?:,\\d+)? \\+(\\d+)(?:,\\d+)? @@")
private let diffGitPattern = try! NSRegularExpression(pattern: "^a/(.+?) b/(.+?)$")

private let quotedEscapes: [Character: UInt8] = [
    "a": 0x07, "b": 0x08, "f": 0x0c, "n": 0x0a, "r": 0x0d,
    "t": 0x09, "v": 0x0b, "\"": 0x22, "\\": 0x5c
]

/// Undo git's C-style quoting of paths containing non-ASCII or unusual
/// bytes (`"a/yeni dosya \\360\\237\\232\\200.txt"` when core.quotepath is on,
/// `"a/q\\"ğ.txt"` when it is off): unescape the simple escapes and 3-digit
/// octal byte escapes, keep unescaped characters as raw UTF-8, then decode
/// the byte stream as UTF-8. Returns `s` unchanged when it is not quoted
/// or the result is not valid UTF-8.
public func unquoteGitPath(_ s: String) -> String {
    guard s.count >= 2, s.hasPrefix("\""), s.hasSuffix("\"") else { return s }
    let body = s.dropFirst().dropLast()
    var bytes: [UInt8] = []
    var i = body.startIndex
    while i < body.endIndex {
        let ch = body[i]
        if ch != "\\" {
            // A code point, raw UTF-8.
            bytes.append(contentsOf: ch.utf8)
            i = body.index(after: i)
            continue
        }
        let next = body.index(after: i)
        guard next < body.endIndex else { return s }
        let n = body[next]
        if n >= "0", n <= "7" {
            var octal = ""
            var j = next
            while j < body.endIndex, octal.count < 3, body[j] >= "0", body[j] <= "7" {
                octal.append(body[j])
                j = body.index(after: j)
            }
            guard let value = Int(octal, radix: 8), value <= 0xff else { return s }
            bytes.append(UInt8(value))
            i = j
            continue
        }
        if let simple = quotedEscapes[n] {
            bytes.append(simple)
        } else {
            // Unknown escape: treat the escaped char as its literal self.
            bytes.append(contentsOf: n.utf8)
        }
        i = body.index(after: next)
    }
    return String(bytes: bytes, encoding: .utf8) ?? s
}

/// One `diff --git` side token: C-quoted string or text up to a space.
private func readHeaderToken(_ text: Substring) -> (token: Substring, rest: Substring)? {
    if text.hasPrefix("\"") {
        var i = text.index(after: text.startIndex)
        while i < text.endIndex {
            if text[i] == "\\" {
                i = text.index(i, offsetBy: 2, limitedBy: text.endIndex) ?? text.endIndex
                continue
            }
            if text[i] == "\"" {
                return (text[...i], text[text.index(after: i)...])
            }
            i = text.index(after: i)
        }
        return nil
    }
    if let space = text.firstIndex(of: " ") {
        return (text[..<space], text[space...])
    }
    return (text, Substring())
}

/// The b/ path of a `diff --git` line; C-quoted sides are unquoted.
private func headerNewPath(_ line: String) -> String {
    let tail = line.dropFirst("diff --git ".count)
    if !tail.contains("\"") {
        // Unquoted header — tolerate spaces in the a/ side by letting the b/
        // side take the last " b/" boundary.
        return capture(diffGitPattern, String(tail), 2) ?? ""
    }
    guard let a = readHeaderToken(tail) else { return "" }
    guard let b = readHeaderToken(a.rest.drop(while: { $0 == " " })) else { return "" }
    return stripPrefix(unquoteGitPath(String(b.token)))
}

private func capture(_ regex: NSRegularExpression, _ text: String, _ group: Int) -> String? {
    let range = NSRange(text.startIndex..., in: text)
    guard let match = regex.firstMatch(in: text, range: range), let r = Range(match.range(at: group), in: text) else {
        return nil
    }
    return String(text[r])
}

private func stripPrefix(_ path: String) -> String {
    if path.hasPrefix("a/") || path.hasPrefix("b/") { return String(path.dropFirst(2)) }
    return path
}

/// Parse unified `git diff` output into per-file hunks.
public func parseUnifiedDiff(_ text: String) -> [DiffFile] {
    var files: [DiffFile] = []
    var file: DiffFile?
    var hunkIndex: Int?
    var oldNo = 0
    var newNo = 0
    var oldPath: String?
    var newPath: String?
    /// ---/+++ paths carry a/ b/ prefixes; `rename from`/`to` do not.
    var oldPrefixed = false
    var newPrefixed = false
    /// Fallback display path parsed from the `diff --git` line itself.
    var headerPath = ""

    func flush() {
        if var current = file {
            let np = newPath.flatMap { $0 != "/dev/null" ? newPrefixed ? stripPrefix($0) : $0 : nil }
            let op = oldPath.flatMap { $0 != "/dev/null" ? oldPrefixed ? stripPrefix($0) : $0 : nil }
            current.path = np ?? op ?? headerPath
            current.oldPath = (op != nil && op != current.path) ? op : nil
            if current.status == "modified" && current.oldPath != nil { current.status = "renamed" }
            files.append(current)
        }
        file = nil
        hunkIndex = nil
        oldPath = nil
        newPath = nil
        oldPrefixed = false
        newPrefixed = false
        headerPath = ""
    }

    for line in text.components(separatedBy: "\n") {
        if line.hasPrefix("diff --git ") {
            flush()
            // `diff --git a/old b/new` — the b/ path is the display fallback
            // for files without ---/+++ lines (binary, pure renames).
            headerPath = headerNewPath(line)
            file = DiffFile(path: headerPath, status: "modified", hunks: [])
            continue
        }
        guard file != nil else { continue }
        if line.hasPrefix("new file mode") {
            file?.status = "added"
            continue
        }
        if line.hasPrefix("deleted file mode") {
            file?.status = "deleted"
            continue
        }
        if line.hasPrefix("Binary files") {
            file?.isBinary = true
            continue
        }
        // Pure renames (100% similarity) carry only rename from/to lines.
        if line.hasPrefix("rename from ") {
            oldPath = unquoteGitPath(String(line.dropFirst("rename from ".count)).trimmingCharacters(in: .whitespaces))
            oldPrefixed = false
            continue
        }
        if line.hasPrefix("rename to ") {
            newPath = unquoteGitPath(String(line.dropFirst("rename to ".count)).trimmingCharacters(in: .whitespaces))
            newPrefixed = false
            continue
        }
        if line.hasPrefix("--- ") {
            oldPath = unquoteGitPath(String(line.dropFirst(4)).trimmingCharacters(in: .whitespaces))
            oldPrefixed = true
            if oldPath == "/dev/null" { file?.status = "added" }
            continue
        }
        if line.hasPrefix("+++ ") {
            newPath = unquoteGitPath(String(line.dropFirst(4)).trimmingCharacters(in: .whitespaces))
            newPrefixed = true
            if newPath == "/dev/null" { file?.status = "deleted" }
            continue
        }
        if line.hasPrefix("@@"), let old = capture(hunkPattern, line, 1), let new = capture(hunkPattern, line, 2) {
            oldNo = Int(old) ?? 0
            newNo = Int(new) ?? 0
            file?.hunks.append(DiffHunk(header: line, lines: []))
            hunkIndex = (file?.hunks.count ?? 1) - 1
            continue
        }
        guard let h = hunkIndex, let first = line.first else { continue }
        let rest = String(line.dropFirst())
        switch first {
        case "+":
            file?.hunks[h].lines.append(PatchLine(type: .add, text: rest, oldNo: nil, newNo: newNo))
            newNo += 1
        case "-":
            file?.hunks[h].lines.append(PatchLine(type: .del, text: rest, oldNo: oldNo, newNo: nil))
            oldNo += 1
        case " ":
            file?.hunks[h].lines.append(PatchLine(type: .ctx, text: rest, oldNo: oldNo, newNo: newNo))
            oldNo += 1
            newNo += 1
        default:
            break
        }
    }
    flush()
    return files
}

/// A synthetic all-added file for an untracked file's contents.
/// Binary and oversized files have no content to show — the flags mark
/// them so the screen can say so instead of rendering an empty diff.
public func diffFileForUntracked(path: String, content: String, binary: Bool = false, tooLarge: Bool = false) -> DiffFile {
    if binary {
        return DiffFile(path: path, status: "added", hunks: [], isBinary: true)
    }
    if tooLarge {
        return DiffFile(path: path, status: "added", hunks: [], tooLarge: true)
    }
    var lines = content.components(separatedBy: "\n")
    if lines.last == "" { lines.removeLast() }
    return DiffFile(
        path: path,
        status: "added",
        hunks: [
            DiffHunk(
                header: "@@ -0,0 +1,\(lines.count) @@",
                lines: lines.enumerated().map { PatchLine(type: .add, text: $0.element, oldNo: nil, newNo: $0.offset + 1) }
            )
        ]
    )
}
