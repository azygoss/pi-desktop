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
private let diffGitPattern = try! NSRegularExpression(pattern: "^diff --git \"?a/(.+?)\"? \"?b/(.+?)\"?$")

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
    var headerPath = ""

    func flush() {
        if var current = file {
            let np = newPath.flatMap { $0 != "/dev/null" ? stripPrefix($0) : nil }
            let op = oldPath.flatMap { $0 != "/dev/null" ? stripPrefix($0) : nil }
            current.path = np ?? op ?? headerPath
            current.oldPath = (op != nil && op != current.path) ? op : nil
            if current.status == "modified" && current.oldPath != nil { current.status = "renamed" }
            files.append(current)
        }
        file = nil
        hunkIndex = nil
        oldPath = nil
        newPath = nil
        headerPath = ""
    }

    for line in text.components(separatedBy: "\n") {
        if line.hasPrefix("diff --git ") {
            flush()
            headerPath = capture(diffGitPattern, line, 2) ?? ""
            file = DiffFile(path: headerPath, oldPath: nil, status: "modified", hunks: [], isBinary: false)
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
        if line.hasPrefix("--- ") {
            oldPath = String(line.dropFirst(4)).trimmingCharacters(in: .whitespaces)
            if oldPath == "/dev/null" { file?.status = "added" }
            continue
        }
        if line.hasPrefix("+++ ") {
            newPath = String(line.dropFirst(4)).trimmingCharacters(in: .whitespaces)
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
public func diffFileForUntracked(path: String, content: String) -> DiffFile {
    var lines = content.components(separatedBy: "\n")
    if lines.last == "" { lines.removeLast() }
    return DiffFile(
        path: path,
        oldPath: nil,
        status: "added",
        hunks: [
            DiffHunk(
                header: "@@ -0,0 +1,\(lines.count) @@",
                lines: lines.enumerated().map { PatchLine(type: .add, text: $0.element, oldNo: nil, newNo: $0.offset + 1) }
            )
        ],
        isBinary: false
    )
}
