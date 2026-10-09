import Foundation

// The display model of a chat and the streaming reducer that builds it from
// pi's events: the Swift port of src/shared/chat-view.ts, so the phone shows
// a chat exactly as the desktop window does.

/// Wall-clock milliseconds since the epoch, like JS `Date.now()`.
public func nowMs() -> Double { (Date().timeIntervalSince1970 * 1000).rounded() }

private final class KeyCounter: @unchecked Sendable {
    private var value = 0
    private let lock = NSLock()
    func next(_ prefix: String) -> String {
        lock.lock()
        value += 1
        let n = value
        lock.unlock()
        return "\(prefix)-\(n)"
    }
}

private let keys = KeyCounter()

public func nextDisplayKey(_ prefix: String) -> String { keys.next(prefix) }

public struct ThinkingBlock: Hashable, Sendable {
    public var thinking: String
    /// Live streams: wall-clock when thinking_start arrived.
    public var startedAt: Double?
    /// thinking_end minus startedAt; persisted sessions leave it unset.
    public var durationMs: Double?
}

public struct ToolCallBlock: Hashable, Sendable {
    public var id: String
    public var name: String
    /// Raw accumulated argument JSON while streaming.
    public var argsText: String?
    public var arguments: [String: JSONValue]
}

public enum DisplayBlock: Hashable, Sendable {
    case text(String)
    case thinking(ThinkingBlock)
    case toolCall(ToolCallBlock)
    case image(ImageContent)

    public var isText: Bool {
        if case .text = self { return true }
        return false
    }
}

public struct UserDisplay: Hashable, Sendable {
    public var key: String
    public var text: String
    public var images: [ImageContent]
    /// Sent while pi was still starting; delivered once it is ready.
    public var queued: Bool = false
    /// Snapshot of the project's files taken just before this prompt.
    public var checkpoint: String?
    public var timestamp: Double?

    public init(key: String, text: String, images: [ImageContent], queued: Bool = false, checkpoint: String? = nil, timestamp: Double? = nil) {
        self.key = key
        self.text = text
        self.images = images
        self.queued = queued
        self.checkpoint = checkpoint
        self.timestamp = timestamp
    }
}

public struct TurnUsage: Hashable, Sendable {
    public var input: Double
    public var output: Double
    public var cost: Double
}

public struct AssistantDisplay: Hashable, Sendable {
    public var key: String
    public var blocks: [DisplayBlock]
    public var stopReason: StopReason?
    public var errorMessage: String?
    public var streaming: Bool = false
    public var timestamp: Double?
    /// pi's model id that produced this message.
    public var model: String?
    public var usage: TurnUsage?

    /// Only reasoning and tool calls, no prose.
    public var isTraceOnly: Bool {
        errorMessage == nil && !blocks.isEmpty && blocks.allSatisfy {
            switch $0 {
            case .thinking, .toolCall: return true
            default: return false
            }
        }
    }
}

public struct BashDisplay: Hashable, Sendable {
    public var key: String
    public var command: String
    public var output: String
    public var exitCode: Int?
    public var cancelled: Bool = false
    /// A `!command` still running; output grows with bash_execution_update.
    public var running: Bool = false
    public var timestamp: Double?

    public init(key: String, command: String, output: String, exitCode: Int? = nil, cancelled: Bool = false, running: Bool = false, timestamp: Double? = nil) {
        self.key = key
        self.command = command
        self.output = output
        self.exitCode = exitCode
        self.cancelled = cancelled
        self.running = running
        self.timestamp = timestamp
    }
}

public struct NoticeDisplay: Hashable, Sendable {
    public enum Tone: Sendable { case info, error }
    public var key: String
    public var text: String
    public var tone: Tone
    /// Longer text behind the notice (a compaction summary).
    public var detail: String?
}

public enum DisplayMessage: Hashable, Sendable, Identifiable {
    case user(UserDisplay)
    case assistant(AssistantDisplay)
    case bash(BashDisplay)
    case notice(NoticeDisplay)

    public var key: String {
        switch self {
        case .user(let m): return m.key
        case .assistant(let m): return m.key
        case .bash(let m): return m.key
        case .notice(let m): return m.key
        }
    }

    public var id: String { key }

    public var user: UserDisplay? {
        if case .user(let m) = self { return m }
        return nil
    }

    public var assistant: AssistantDisplay? {
        if case .assistant(let m) = self { return m }
        return nil
    }

    public var bash: BashDisplay? {
        if case .bash(let m) = self { return m }
        return nil
    }
}

public struct ToolRun: Hashable, Sendable {
    public enum Status: String, Sendable { case running, done, error }
    public var toolCallId: String
    public var name: String
    public var args: [String: JSONValue]
    public var status: Status
    /// Wall-clock at tool_execution_start (live runs only).
    public var startedAt: Double?
    public var durationMs: Double?
    public var partialText: String?
    public var result: ToolResultPayload?
}

public enum ChatStatus: String, Sendable {
    case starting, idle, streaming, error, exited
}

public struct MessageQueue: Hashable, Sendable {
    public var steering: [String]
    public var followUp: [String]

    public init(steering: [String] = [], followUp: [String] = []) {
        self.steering = steering
        self.followUp = followUp
    }

    public var count: Int { steering.count + followUp.count }
}

public struct ChatViewState: Sendable {
    public var status: ChatStatus = .idle
    public var messages: [DisplayMessage] = []
    public var toolRuns: [String: ToolRun] = [:]
    /// Wall-clock at agent_start of the current run; cleared when it settles.
    public var runStartedAt: Double?
    /// Messages waiting in pi's steering / follow-up queues.
    public var queue: MessageQueue?

    public init() {}

    // MARK: AgentMessage → DisplayMessage

    static func userContent(_ content: [ContentBlock]) -> (text: String, images: [ImageContent]) {
        var text: [String] = []
        var images: [ImageContent] = []
        for block in content {
            switch block {
            case .text(let t): text.append(t)
            case .image(let image): images.append(image)
            default: break
            }
        }
        return (text.joined(separator: "\n"), images)
    }

    static func assistantBlocks(_ message: AssistantMessage) -> [DisplayBlock] {
        message.content.compactMap { block in
            switch block {
            case .text(let text): return .text(text)
            case .thinking(let thinking): return .thinking(ThinkingBlock(thinking: thinking))
            case .toolCall(let call): return .toolCall(ToolCallBlock(id: call.id, name: call.name, argsText: nil, arguments: call.arguments))
            default: return nil
            }
        }
    }

    static func compactTokens(_ n: Double) -> String {
        n < 1000 ? "\(Int(n))" : "\(Int((n / 1000).rounded()))k"
    }

    /// "Context compacted · 150k → 32k tokens"
    static func compactedLabel(_ before: Double?, _ after: Double? = nil) -> String {
        guard let before, before > 0 else { return "Context compacted" }
        if let after, after > 0 {
            return "Context compacted · \(compactTokens(before)) → \(compactTokens(after)) tokens"
        }
        return "Context compacted · was \(compactTokens(before)) tokens"
    }

    /// A display message for an agent message; nil for tool results (they
    /// update tool runs) and messages the transcript does not show.
    public static func mapAgentMessage(_ message: AgentMessage, key: String? = nil) -> DisplayMessage? {
        let k = key ?? nextDisplayKey("msg")
        switch message {
        case .user(let content, let timestamp):
            let (text, images) = userContent(content)
            return .user(UserDisplay(key: k, text: text, images: images, timestamp: timestamp))
        case .assistant(let message):
            var usage: TurnUsage?
            if let u = message.usage {
                usage = TurnUsage(input: u.input + u.cacheRead + u.cacheWrite, output: u.output, cost: u.costTotal)
            }
            return .assistant(
                AssistantDisplay(
                    key: k,
                    blocks: assistantBlocks(message),
                    stopReason: message.stopReason,
                    errorMessage: message.errorMessage,
                    timestamp: message.timestamp,
                    model: message.model.isEmpty ? nil : message.model,
                    usage: usage
                )
            )
        case .bashExecution(let command, let output, let exitCode, let cancelled, let timestamp):
            return .bash(BashDisplay(key: k, command: command, output: output, exitCode: exitCode, cancelled: cancelled, timestamp: timestamp))
        case .toolResult:
            return nil
        case .compactionSummary(let summary, let tokensBefore):
            return .notice(NoticeDisplay(key: k, text: compactedLabel(tokensBefore), tone: .info, detail: summary.isEmpty ? nil : summary))
        case .branchSummary:
            return .notice(NoticeDisplay(key: k, text: "Branched with summary", tone: .info))
        case .custom(let content, let display, _):
            guard display else { return nil }
            return .notice(NoticeDisplay(key: k, text: userContent(content).text, tone: .info))
        case .unknown:
            return nil
        }
    }

    func findCallArgs(_ id: String) -> [String: JSONValue]? {
        for message in messages.reversed() {
            guard case .assistant(let assistant) = message else { continue }
            for block in assistant.blocks {
                if case .toolCall(let call) = block, call.id == id { return call.arguments }
            }
        }
        return nil
    }

    mutating func applyToolResult(_ message: AgentMessage, args: [String: JSONValue]? = nil) {
        guard case .toolResult(let result) = message else { return }
        var run = toolRuns[result.toolCallId] ?? ToolRun(
            toolCallId: result.toolCallId,
            name: result.toolName,
            args: args ?? findCallArgs(result.toolCallId) ?? [:],
            status: .done
        )
        run.status = result.isError ? .error : .done
        run.result = ToolResultPayload(content: result.content, details: result.details)
        toolRuns[result.toolCallId] = run
    }

    /// Rebuild view state from a persisted message list.
    public static func build(_ messages: [AgentMessage]) -> ChatViewState {
        var state = ChatViewState()
        var callArgs: [String: [String: JSONValue]] = [:]
        for message in messages {
            if case .toolResult(let result) = message {
                state.applyToolResult(message, args: callArgs[result.toolCallId])
                continue
            }
            if case .assistant(let assistant) = message {
                for block in assistant.content {
                    if case .toolCall(let call) = block { callArgs[call.id] = call.arguments }
                }
            }
            if let display = mapAgentMessage(message) { state.messages.append(display) }
        }
        return state
    }

    // MARK: Streaming reducer

    private mutating func streamingAssistantIndex() -> Int {
        if let last = messages.last, case .assistant(let assistant) = last, assistant.streaming {
            return messages.count - 1
        }
        messages.append(.assistant(AssistantDisplay(key: nextDisplayKey("stream"), blocks: [], streaming: true)))
        return messages.count - 1
    }

    private mutating func applyAssistantDelta(_ event: AssistantMessageEvent) {
        let index = streamingAssistantIndex()
        guard case .assistant(var message) = messages[index] else { return }
        func block(_ i: Int) -> DisplayBlock? { i < message.blocks.count ? message.blocks[i] : nil }
        func set(_ i: Int, _ newBlock: DisplayBlock) {
            while message.blocks.count <= i { message.blocks.append(.text("")) }
            message.blocks[i] = newBlock
        }
        switch event {
        case .textStart(let i):
            if block(i) == nil { set(i, .text("")) }
        case .textDelta(let i, let delta):
            if case .text(let existing) = block(i) { set(i, .text(existing + delta)) } else { set(i, .text(delta)) }
        case .textEnd(let i, let content):
            set(i, .text(content))
        case .thinkingStart(let i):
            if block(i) == nil { set(i, .thinking(ThinkingBlock(thinking: "", startedAt: nowMs()))) }
        case .thinkingDelta(let i, let delta):
            if case .thinking(let existing) = block(i) {
                set(i, .thinking(ThinkingBlock(thinking: existing.thinking + delta, startedAt: existing.startedAt)))
            } else {
                set(i, .thinking(ThinkingBlock(thinking: delta)))
            }
        case .thinkingEnd(let i, let content):
            var duration: Double?
            if case .thinking(let existing) = block(i), let started = existing.startedAt { duration = nowMs() - started }
            set(i, .thinking(ThinkingBlock(thinking: content, durationMs: duration)))
        case .toolcallStart(let i, let id, let toolName):
            set(i, .toolCall(ToolCallBlock(id: id, name: toolName, argsText: "", arguments: [:])))
        case .toolcallDelta(let i, let delta):
            if case .toolCall(let existing) = block(i) {
                set(i, .toolCall(ToolCallBlock(id: existing.id, name: existing.name, argsText: (existing.argsText ?? "") + delta, arguments: existing.arguments)))
            } else {
                set(i, .toolCall(ToolCallBlock(id: "call_\(i)", name: "", argsText: delta, arguments: [:])))
            }
        case .toolcallEnd(let i, let call):
            set(i, .toolCall(ToolCallBlock(id: call.id, name: call.name, argsText: nil, arguments: call.arguments)))
        case .unknown:
            return
        }
        messages[index] = .assistant(message)
    }

    /// pi's echo of a prompt the app already shows: keep our key and checkpoint.
    static func keepLocal(_ echo: UserDisplay, _ local: UserDisplay) -> DisplayMessage {
        var merged = echo
        merged.key = local.key
        if local.checkpoint != nil { merged.checkpoint = local.checkpoint }
        return .user(merged)
    }

    private mutating func pushDeduped(_ display: DisplayMessage) {
        if case .user(let user) = display, case .user(let last)? = messages.last, last.text == user.text {
            messages[messages.count - 1] = Self.keepLocal(user, last)
            return
        }
        if case .bash(let bash) = display, case .bash(let last)? = messages.last, last.command == bash.command {
            return
        }
        messages.append(display)
    }

    private mutating func dequeue(_ text: String) {
        guard let current = queue else { return }
        let steerAt = current.steering.firstIndex(of: text)
        let followAt = steerAt == nil ? current.followUp.firstIndex(of: text) : nil
        guard steerAt != nil || followAt != nil else { return }
        var next = current
        if let steerAt { next.steering.remove(at: steerAt) }
        if let followAt { next.followUp.remove(at: followAt) }
        queue = next.count == 0 ? nil : next
    }

    private mutating func pushNotice(_ text: String, _ tone: NoticeDisplay.Tone = .info) {
        messages.append(.notice(NoticeDisplay(key: nextDisplayKey("notice"), text: text, tone: tone)))
    }

    /// Apply one pi event. Returns true when session stats should be re-read.
    @discardableResult
    public mutating func reduce(_ event: PiEvent) -> Bool {
        switch event {
        case .agentStart:
            // A retry continues the same run; anything else starts the clock.
            if status != .streaming || runStartedAt == nil { runStartedAt = nowMs() }
            status = .streaming
            return false

        case .agentEnd(let ended):
            for message in ended {
                if case .toolResult = message { applyToolResult(message) }
            }
            return true

        case .agentSettled:
            status = .idle
            runStartedAt = nil
            queue = nil
            return false

        case .queueUpdate(let steering, let followUp):
            queue = steering.isEmpty && followUp.isEmpty ? nil : MessageQueue(steering: steering, followUp: followUp)
            return false

        case .messageStart(let message):
            guard var display = Self.mapAgentMessage(message) else { return false }
            if case .assistant(var assistant) = display {
                assistant.streaming = true
                display = .assistant(assistant)
            }
            if case .user(let user) = display { dequeue(user.text) }
            pushDeduped(display)
            return false

        case .messageUpdate(let delta):
            applyAssistantDelta(delta)
            return false

        case .messageEnd(let message):
            guard let display = Self.mapAgentMessage(message) else {
                applyToolResult(message)
                return false
            }
            switch (display, messages.last) {
            case (.assistant(var final), .assistant(let last)?) where last.streaming:
                final.key = last.key
                messages[messages.count - 1] = .assistant(final)
            case (.user(let user), .user(let last)?) where last.text == user.text:
                messages[messages.count - 1] = Self.keepLocal(user, last)
            case (.bash(var bash), .bash(let last)?) where last.command == bash.command:
                bash.key = last.key
                messages[messages.count - 1] = .bash(bash)
            default:
                messages.append(display)
            }
            return false

        case .toolExecutionStart(let id, let name, let args):
            toolRuns[id] = ToolRun(toolCallId: id, name: name, args: args, status: .running, startedAt: nowMs())
            return false

        case .toolExecutionUpdate(let id, let name, let args, let partialText):
            if var run = toolRuns[id] {
                if let partialText {
                    run.partialText = partialText
                    toolRuns[id] = run
                }
            } else {
                toolRuns[id] = ToolRun(toolCallId: id, name: name, args: args, status: .running, partialText: partialText)
            }
            return false

        case .toolExecutionEnd(let id, let name, let result, let isError):
            var run = toolRuns[id] ?? ToolRun(toolCallId: id, name: name, args: [:], status: .done)
            run.status = isError ? .error : .done
            run.result = result
            if let started = run.startedAt { run.durationMs = nowMs() - started }
            run.partialText = nil
            toolRuns[id] = run
            return false

        case .bashExecutionUpdate(let delta):
            for i in messages.indices.reversed() {
                if case .bash(var bash) = messages[i], bash.running {
                    bash.output += delta
                    messages[i] = .bash(bash)
                    break
                }
            }
            return false

        case .compactionStart:
            pushNotice("Compacting context…")
            return false

        case .compactionEnd(let result, let aborted, let errorMessage):
            if !aborted, let result {
                messages.append(
                    .notice(
                        NoticeDisplay(
                            key: nextDisplayKey("notice"),
                            text: Self.compactedLabel(result.tokensBefore, result.estimatedTokensAfter),
                            tone: .info,
                            detail: result.summary.isEmpty ? nil : result.summary
                        )
                    )
                )
                return true
            }
            if aborted {
                pushNotice("Compaction aborted")
            } else {
                pushNotice("Compaction failed\(errorMessage.map { ": \($0)" } ?? "")", .error)
            }
            return false

        case .autoRetryStart(let attempt, let maxAttempts):
            pushNotice("Retrying (\(attempt)/\(maxAttempts))…")
            return false

        case .autoRetryEnd(let success, let finalError):
            if !success { pushNotice("Retry failed: \(finalError ?? "unknown error")", .error) }
            return false

        case .summarizationRetryScheduled(let attempt, let maxAttempts):
            pushNotice("Summarization retry scheduled (\(attempt)/\(maxAttempts))")
            return false

        case .extensionError(let error):
            pushNotice("Extension error: \(error)", .error)
            return false

        case .extensionUi(let request):
            if request.method == "notify" {
                pushNotice(request.message ?? "", request.notifyType == "error" ? .error : .info)
            }
            return false

        case .other:
            return false
        }
    }
}
