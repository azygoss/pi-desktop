import Foundation

// Transcript rows (mobile/src/chat/transcript.ts), slash commands
// (slash-commands.ts) and the chat-as-Markdown export (chat-markdown.ts).

/// One row of the transcript list.
public enum TranscriptItem: Identifiable, Sendable {
    case user(UserDisplay, userIndex: Int)
    case assistant(AssistantDisplay, live: Bool)
    /// A stretch of thinking-and-tools-only messages, folded into one row.
    case work(key: String, messages: [AssistantDisplay], live: Bool, startedAt: Double?, endedAt: Double?)
    case bash(BashDisplay)
    case notice(NoticeDisplay)
    /// "model · 14:02 · 1.8k tokens out · $0.04" under a finished turn.
    case meta(key: String, text: String, reply: String)

    public var id: String {
        switch self {
        case .user(let m, _): return m.key
        case .assistant(let m, _): return m.key
        case .work(let key, _, _, _, _): return key
        case .bash(let m): return m.key
        case .notice(let m): return m.key
        case .meta(let key, _, _): return key
        }
    }
}

private let workGroupMin = 2

private func shortTokens(_ n: Double) -> String {
    if n < 1000 { return "\(Int(n))" }
    let k = n / 1000
    if k >= 100 { return "\(Int(k.rounded()))k" }
    var text = String(format: "%.1f", k)
    if text.hasSuffix(".0") { text.removeLast(2) }
    return "\(text)k"
}

private func clock(_ timestamp: Double) -> String {
    let date = Date(timeIntervalSince1970: timestamp / 1000)
    let parts = Calendar.current.dateComponents([.hour, .minute], from: date)
    return String(format: "%02d:%02d", parts.hour ?? 0, parts.minute ?? 0)
}

private func turnMeta(_ turn: [AssistantDisplay], _ models: [Model]) -> String {
    guard let last = turn.last else { return "" }
    var output = 0.0
    var cost = 0.0
    for message in turn {
        if let usage = message.usage {
            output += usage.output
            cost += usage.cost
        }
    }
    var parts: [String] = []
    if let model = last.model { parts.append(models.first { $0.id == model }?.name ?? model) }
    if let timestamp = last.timestamp { parts.append(clock(timestamp)) }
    if output > 0 { parts.append("\(shortTokens(output)) tokens out") }
    if cost > 0 { parts.append(String(format: cost < 0.1 ? "$%.3f" : "$%.2f", cost)) }
    return parts.joined(separator: " · ")
}

/// Flatten messages into rows, oldest first.
public func buildTranscript(_ messages: [DisplayMessage], streaming: Bool, models: [Model]) -> [TranscriptItem] {
    var items: [TranscriptItem] = []
    var turn: [AssistantDisplay] = []
    var userIndex = 0

    func flushTurn(_ live: Bool) {
        guard !turn.isEmpty else { return }
        var run: [AssistantDisplay] = []
        func flushRun(_ next: AssistantDisplay?) {
            if run.count >= workGroupMin {
                items.append(
                    .work(
                        key: "\(run[0].key):work",
                        messages: run,
                        live: live && next == nil,
                        startedAt: run[0].timestamp,
                        endedAt: next?.timestamp ?? run[run.count - 1].timestamp
                    )
                )
            } else {
                for message in run { items.append(.assistant(message, live: live)) }
            }
            run = []
        }
        for (index, message) in turn.enumerated() {
            // The turn's last message stays out of a group.
            if index < turn.count - 1 && message.isTraceOnly {
                run.append(message)
                continue
            }
            flushRun(message)
            items.append(.assistant(message, live: live))
        }
        flushRun(nil)
        if !live {
            let text = turnMeta(turn, models)
            let reply = turn.flatMap { message in
                message.blocks.compactMap { block -> String? in
                    if case .text(let t) = block, !t.trimmed.isEmpty { return t }
                    return nil
                }
            }.joined(separator: "\n\n")
            if !text.isEmpty || !reply.isEmpty {
                items.append(.meta(key: "\(turn[turn.count - 1].key):meta", text: text, reply: reply))
            }
        }
        turn = []
    }

    for message in messages {
        switch message {
        case .assistant(let assistant):
            turn.append(assistant)
        case .user(let user):
            flushTurn(false)
            items.append(.user(user, userIndex: userIndex))
            userIndex += 1
        case .bash(let bash):
            flushTurn(false)
            items.append(.bash(bash))
        case .notice(let notice):
            flushTurn(false)
            items.append(.notice(notice))
        }
    }
    flushTurn(streaming)
    return items
}

// MARK: - Slash commands

public struct SlashCommandItem: Hashable, Sendable, Identifiable {
    public enum Source: String, Sendable { case app, skill, prompt, `extension` }
    public var name: String
    public var description: String?
    public var source: Source
    public var takesArgs = false
    public var chatOnly = false
    public var idleOnly = false

    public var id: String { "\(source.rawValue):\(name)" }
}

/// The app commands that make sense on a phone (the rest need the computer).
public let phoneCommands: [SlashCommandItem] = [
    .init(name: "model", description: "Select a model", source: .app, takesArgs: true),
    .init(name: "thinking", description: "Set the thinking level", source: .app, takesArgs: true, chatOnly: true),
    .init(name: "new", description: "New chat", source: .app),
    .init(name: "resume", description: "Search chats", source: .app),
    .init(name: "name", description: "Set the chat name, or show it when omitted", source: .app, takesArgs: true, chatOnly: true),
    .init(name: "session", description: "Session info and stats", source: .app, chatOnly: true),
    .init(name: "tree", description: "Show the session tree", source: .app, chatOnly: true),
    .init(name: "fork", description: "Fork from an earlier message", source: .app, chatOnly: true, idleOnly: true),
    .init(name: "clone", description: "Duplicate the current chat", source: .app, chatOnly: true, idleOnly: true),
    .init(name: "btw", description: "Ask a side question that stays out of this chat", source: .app, takesArgs: true, chatOnly: true),
    .init(name: "compact", description: "Compact context (optional instructions)", source: .app, takesArgs: true, chatOnly: true),
    .init(name: "copy", description: "Copy the last reply", source: .app, chatOnly: true),
    .init(name: "reload", description: "Restart pi and reload resources", source: .app, chatOnly: true)
]

public let phoneCommandNames = Set(phoneCommands.map(\.name))

/// The `/token` being typed (no whitespace yet), without the slash.
public func slashQuery(_ text: String) -> String? {
    guard text.hasPrefix("/"), !text.contains(where: { $0.isWhitespace || $0.isNewline }) else { return nil }
    return String(text.dropFirst())
}

/// `/name foo bar` → ("name", "foo bar")
public func parseSlashSend(_ text: String) -> (command: String, args: String)? {
    let trimmed = text.trimmed
    guard trimmed.hasPrefix("/") else { return nil }
    let body = trimmed.dropFirst()
    guard let first = body.first, !first.isWhitespace else { return nil }
    if let space = body.firstIndex(where: { $0.isWhitespace || $0.isNewline }) {
        return (String(body[..<space]), String(body[space...]).trimmed)
    }
    return (String(body), "")
}

/// App commands and pi's catalog, filtered by name or description and grouped
/// App, Skills, Prompts, Extensions (each sorted by name), flattened.
public func filterSlashCommands(_ piCommands: [PiCommandInfo], query: String, inChat: Bool, streaming: Bool) -> [SlashCommandItem] {
    let needle = query.lowercased()
    func matches(_ item: SlashCommandItem) -> Bool {
        needle.isEmpty || item.name.lowercased().contains(needle) || (item.description?.lowercased().contains(needle) ?? false)
    }
    let catalog = piCommands.map { command in
        SlashCommandItem(
            name: command.name,
            description: command.description,
            source: command.source == "skill" ? .skill : command.source == "prompt" ? .prompt : .extension
        )
    }
    let items = phoneCommands.filter { (inChat || !$0.chatOnly) && (!streaming || !$0.idleOnly) && matches($0) }
        + catalog.filter(matches)
    return [SlashCommandItem.Source.app, .skill, .prompt, .extension].flatMap { source in
        items.filter { $0.source == source }.sorted { $0.name.localizedCompare($1.name) == .orderedAscending }
    }
}

// MARK: - Chat as Markdown

private func fence(for text: String) -> String {
    var longest = 0
    var run = 0
    for ch in text {
        if ch == "`" {
            run += 1
            longest = max(longest, run)
        } else {
            run = 0
        }
    }
    return String(repeating: "`", count: max(3, longest + 1))
}

/// Prompts as headed sections, replies as written, each tool call as one line.
public func chatToMarkdown(title: String, messages: [DisplayMessage], toolRuns: [String: ToolRun], cwd: String) -> String {
    var out = ["# \(title.trimmed.isEmpty ? "Chat" : title.trimmed)"]
    for message in messages {
        switch message {
        case .user(let user):
            let (skills, rest) = parseSkillPrefix(user.text)
            let text = (skills.map { "/skill:\($0.name)" } + [rest]).filter { !$0.isEmpty }.joined(separator: " ")
            out.append("## You\n\n\(text.trimmed)")
        case .assistant(let assistant):
            var parts: [String] = []
            for block in assistant.blocks {
                switch block {
                case .text(let text) where !text.trimmed.isEmpty:
                    parts.append(text.trimmed)
                case .toolCall(let call):
                    let run = toolRuns[call.id]
                    let args = (run?.args.isEmpty == false ? run?.args : nil) ?? call.arguments
                    let summary = toolCallSummary(call.name, args, cwd: cwd)
                    parts.append("- `\(call.name)`\(summary.isEmpty ? "" : " \(summary)")\(run?.status == .error ? " (failed)" : "")")
                default:
                    break
                }
            }
            if let error = assistant.errorMessage { parts.append("> \(error)") }
            if !parts.isEmpty {
                var body = ""
                for (i, part) in parts.enumerated() {
                    let joiner = i == 0 ? "" : (part.hasPrefix("- `") && parts[i - 1].hasPrefix("- `") ? "\n" : "\n\n")
                    body += joiner + part
                }
                out.append(body)
            }
        case .bash(let bash):
            let f = fence(for: bash.output)
            let output = bash.output.trimmed
            out.append("\(f)console\n$ \(bash.command)\(output.isEmpty ? "" : "\n\(output)")\n\(f)")
        case .notice:
            break
        }
    }
    return out.joined(separator: "\n\n") + "\n"
}
