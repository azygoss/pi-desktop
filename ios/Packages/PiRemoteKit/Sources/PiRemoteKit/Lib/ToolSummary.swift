import Foundation

// One-line summaries of tool calls (src/renderer/src/lib/tool-summary.ts)
// and pi's shell status line (trace.ts).

public enum ToolCategory: String, Sendable {
    case read, edit, create, run, search, browser, computer, image, other
}

private let runName = Pattern("^(bash|sh|shell|exec|execute|run|terminal)($|[_\\W])")
private let editName = Pattern("^(edit|patch|str_replace|insert|apply)")
private let createName = Pattern("^(write|create)")
private let searchName = Pattern("^(grep|find|ls|list|glob|search)")
private let readName = Pattern("^(read|view|cat)")

public func toolCategory(_ name: String) -> ToolCategory {
    let n = name.lowercased()
    if n.hasPrefix("browser_") { return .browser }
    if n.hasPrefix("computer_") { return .computer }
    if n == "show_image" { return .image }
    if runName.test(n) { return .run }
    if editName.test(n) { return .edit }
    if createName.test(n) { return .create }
    if searchName.test(n) { return .search }
    if readName.test(n) { return .read }
    return .other
}

public struct EditEntry: Sendable {
    public var oldText: String?
    public var newText: String?
}

private func splitEditLines(_ value: String?) -> [String] {
    guard let text = value, !text.isEmpty else { return [] }
    let trimmed = text.hasSuffix("\n") ? String(text.dropLast()) : text
    return trimmed.components(separatedBy: "\n")
}

/// The lines an edit actually changes: shared context at either end is dropped.
public func changedLines(_ oldText: String?, _ newText: String?) -> (removed: [String], added: [String]) {
    var removed = splitEditLines(oldText)
    var added = splitEditLines(newText)
    var lead = 0
    while lead < removed.count && lead < added.count && removed[lead] == added[lead] { lead += 1 }
    removed = Array(removed[lead...])
    added = Array(added[lead...])
    var trail = 0
    while trail < removed.count && trail < added.count && removed[removed.count - 1 - trail] == added[added.count - 1 - trail] {
        trail += 1
    }
    return (Array(removed[0..<(removed.count - trail)]), Array(added[0..<(added.count - trail)]))
}

public func editEntries(_ args: [String: JSONValue]) -> [EditEntry] {
    if let edits = args["edits"]?.arrayValue {
        return edits.map { EditEntry(oldText: $0["oldText"]?.stringValue, newText: $0["newText"]?.stringValue) }
    }
    if args["oldText"]?.stringValue != nil || args["newText"]?.stringValue != nil {
        return [EditEntry(oldText: args["oldText"]?.stringValue, newText: args["newText"]?.stringValue)]
    }
    return []
}

public struct GroupSummary: Sendable {
    /// "Edited 2 files, ran 3 commands"
    public var text: String
    public var diff: (added: Int, removed: Int)?
    public var failed: Int
    public var running: Int
}

public struct ToolRunInfo: Sendable {
    public var name: String
    public var args: [String: JSONValue]
    public var status: ToolRun.Status

    public init(name: String, args: [String: JSONValue], status: ToolRun.Status) {
        self.name = name
        self.args = args
        self.status = status
    }
}

/// "Edited 2 files, ran 3 commands, read 4 files"
public func summarizeToolRuns(_ runs: [ToolRunInfo]) -> GroupSummary {
    var counts: [ToolCategory: Int] = [:]
    var order: [ToolCategory] = []
    var added = 0
    var removed = 0
    var hasDiff = false
    var failed = 0
    var running = 0
    for run in runs {
        let cat = toolCategory(run.name)
        if counts[cat] == nil { order.append(cat) }
        counts[cat, default: 0] += 1
        if run.status == .error { failed += 1 }
        if run.status == .running { running += 1 }
        if cat == .edit {
            for entry in editEntries(run.args) {
                let lines = changedLines(entry.oldText, entry.newText)
                removed += lines.removed.count
                added += lines.added.count
                hasDiff = true
            }
        } else if cat == .create {
            if let content = run.args["content"]?.stringValue { added += content.components(separatedBy: "\n").count }
            hasDiff = true
        }
    }
    func phrase(_ cat: ToolCategory, _ n: Int) -> String {
        switch cat {
        case .read: return "read \(n == 1 ? "a file" : "\(n) files")"
        case .edit: return "edited \(n == 1 ? "a file" : "\(n) files")"
        case .create: return "created \(n == 1 ? "a file" : "\(n) files")"
        case .run: return "ran \(n == 1 ? "a command" : "\(n) commands")"
        case .search: return n == 1 ? "searched" : "searched \(n) times"
        case .browser: return "used the browser\(n > 1 ? " (\(n) actions)" : "")"
        case .computer: return "used the computer\(n > 1 ? " (\(n) actions)" : "")"
        case .image: return "showed \(n == 1 ? "an image" : "\(n) images")"
        case .other: return "used \(n) other \(n == 1 ? "tool" : "tools")"
        }
    }
    let text = order.map { phrase($0, counts[$0] ?? 0) }.joined(separator: ", ")
    return GroupSummary(
        text: text.prefix(1).uppercased() + text.dropFirst(),
        diff: hasDiff ? (added, removed) : nil,
        failed: failed,
        running: running
    )
}

private func relativePath(_ path: String, _ cwd: String) -> String {
    if !cwd.isEmpty, path.hasPrefix(cwd) {
        var rest = String(path.dropFirst(cwd.count))
        if rest.hasPrefix("/") || rest.hasPrefix("\\") { rest.removeFirst() }
        return rest.isEmpty ? path : rest
    }
    return path
}

private func argPath(_ args: [String: JSONValue]) -> String? {
    for key in ["path", "file", "filePath", "file_path"] {
        if let value = args[key] {
            return value.stringValue
        }
    }
    return nil
}

/// The one-line summary a tool step shows next to the tool name.
public func toolCallSummary(_ name: String, _ args: [String: JSONValue], cwd: String = "", details: JSONValue? = nil) -> String {
    if name.hasPrefix("computer_") { return computerToolSummary(name, args, details: details) }
    if toolCategory(name) == .run { return args["command"]?.stringValue ?? "" }
    if let path = argPath(args) { return relativePath(path, cwd) }
    // JS keeps insertion order; a dictionary does not, so prefer stable keys.
    for key in args.keys.sorted() {
        if let text = args[key]?.stringValue { return String(text.prefix(120)) }
    }
    return ""
}

private let chordModifiers: [String: String] = [
    "cmd": "⌘", "command": "⌘", "super": "⌘", "shift": "⇧", "alt": "⌥", "option": "⌥", "ctrl": "⌃", "control": "⌃"
]

private let chordKeys: [String: String] = [
    "return": "Return", "enter": "Return", "escape": "Escape", "esc": "Escape", "tab": "Tab", "space": "Space",
    "delete": "Delete", "backspace": "Delete", "forwarddelete": "Forward Delete", "up": "↑", "down": "↓",
    "left": "←", "right": "→", "home": "Home", "end": "End", "pageup": "Page Up", "pagedown": "Page Down"
]

/// "cmd+shift+s" → "⌘⇧S"
public func formatKeyChord(_ chord: String) -> String {
    var mods: [String] = []
    var key = ""
    for part in chord.split(separator: "+") {
        let piece = String(part).trimmed
        if piece.isEmpty { continue }
        if let mod = chordModifiers[piece.lowercased()] { mods.append(mod) } else { key = piece }
    }
    let rendered = chordKeys[key.lowercased()] ?? (key.count == 1 ? key.uppercased() : key)
    return mods.joined() + rendered
}

/// Per-call summary for computer_* tools: `Clicked "Save" in Finder`.
public func computerToolSummary(_ name: String, _ args: [String: JSONValue], details: JSONValue? = nil) -> String {
    func str(_ key: String) -> String? {
        guard let value = args[key]?.stringValue, !value.isEmpty else { return nil }
        return value
    }
    let app = str("app")
    let at = app.map { " in \($0)" } ?? ""
    switch name {
    case "computer_state":
        return "Read \(app ?? "app")\(args["screenshot"]?.isTrue == true ? " · screenshot" : "")"
    case "computer_click":
        let label = details?["element"]?["label"]?.stringValue.map { "\"\($0)\"" }
        let element: String
        if let label {
            element = label
        } else if let raw = args["element"], !raw.isNull {
            element = "element \(raw.stringValue ?? raw.intValue.map(String.init) ?? raw.serializedString())"
        } else {
            element = "element"
        }
        return "Clicked \(element)\(at)"
    case "computer_set_value": return "Set value\(at)"
    case "computer_type": return "Typed \(str("text")?.count ?? 0) characters\(at)"
    case "computer_key": return "Pressed \(formatKeyChord(str("key") ?? "?"))\(at)"
    case "computer_scroll": return "Scrolled \(str("direction") ?? "")\(at)".replacingOccurrences(of: "  ", with: " ")
    case "computer_drag": return "Dragged\(at)"
    case "computer_action": return "\(str("action") ?? "action")\(at)"
    case "computer_screenshot": return "Screenshot of \(app ?? "screen")"
    case "computer_apps": return "Listed apps"
    case "computer_confirm":
        switch details?["approved"]?.boolValue {
        case true?: return "Approved"
        case false?: return "Declined"
        default: return "Asked for approval"
        }
    default: return name
    }
}

// MARK: - Shell status and durations (trace.ts)

public enum ShellStatus: Equatable, Sendable {
    case exit(Int)
    case timeout(Double)
    case aborted

    public var label: String {
        switch self {
        case .exit(let code): return "exit \(code)"
        case .timeout: return "timed out"
        case .aborted: return "aborted"
        }
    }
}

private let statusLine = Pattern(
    "(?:^|\\n\\n)(Command exited with code (-?\\d+)|Command timed out after (\\d+(?:\\.\\d+)?) seconds|Command aborted)\\s*$"
)

/// Split pi's trailing shell status line off a bash tool's output.
public func splitShellStatus(_ text: String) -> (output: String, status: ShellStatus?) {
    guard let range = statusLine.firstRange(text), let groups = statusLine.exec(text) else { return (text, nil) }
    let output = (text as NSString).substring(to: range.location)
    if let code = groups[2].flatMap({ Int($0) }) { return (output, .exit(code)) }
    if let seconds = groups[3].flatMap({ Double($0) }) { return (output, .timeout(seconds)) }
    return (output, .aborted)
}

/// Steps faster than this show no duration.
public let minShownDurationMs: Double = 100

/// "0.4s", "12s", "2m 05s"
public func formatDuration(_ ms: Double) -> String {
    if ms < 1000 { return String(format: "%.1fs", max(ms, 0) / 1000) }
    let total = Int((ms / 1000).rounded())
    if total < 60 { return "\(total)s" }
    return "\(total / 60)m \(String(format: "%02d", total % 60))s"
}

/// "0:42", "12:05", "1:02:03"
public func formatElapsed(_ ms: Double) -> String {
    let total = max(0, Int(ms / 1000))
    let h = total / 3600
    let m = (total % 3600) / 60
    let s = total % 60
    return h > 0 ? String(format: "%d:%02d:%02d", h, m, s) : String(format: "%d:%02d", m, s)
}

// MARK: - Tool images (tool-images.ts)

public let showImageTool = "show_image"

/// An image a tool produced: a screenshot, or one the agent chose to show.
public struct ToolShot: Hashable, Sendable, Identifiable {
    public var key: String
    public var mimeType: String
    public var data: String
    public var caption: String?
    /// show_image: part of the answer, shown large. Otherwise a thumbnail.
    public var shown: Bool
    public var id: String { key }
}

public func toolShots(_ run: ToolRun) -> [ToolShot] {
    let content = run.status == .done ? (run.result?.content ?? []) : []
    let shown = run.name == showImageTool
    let text = content.compactMap { block -> String? in
        if case .text(let t) = block { return t }
        return nil
    }.joined(separator: " ").trimmed
    let firstLine = String((text.components(separatedBy: "\n").first ?? "").prefix(120))
    let caption: String?
    if shown {
        let raw = run.args["caption"]?.stringValue?.trimmed ?? ""
        caption = raw.isEmpty ? nil : raw
    } else {
        caption = firstLine.isEmpty ? nil : firstLine
    }
    var shots: [ToolShot] = []
    for (index, block) in content.enumerated() {
        if case .image(let image) = block {
            shots.append(ToolShot(key: "\(run.toolCallId):\(index)", mimeType: image.mimeType, data: image.data, caption: caption, shown: shown))
        }
    }
    return shots
}

/// Every image the tool calls of these messages produced, in order.
public func collectToolShots(_ messages: [AssistantDisplay], _ toolRuns: [String: ToolRun]) -> [ToolShot] {
    var shots: [ToolShot] = []
    for message in messages {
        for block in message.blocks {
            if case .toolCall(let call) = block, let run = toolRuns[call.id] {
                shots.append(contentsOf: toolShots(run))
            }
        }
    }
    return shots
}
