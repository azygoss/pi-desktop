import Foundation

// Types of the `pi --mode rpc` protocol and pi session files, as the desktop
// forwards them (src/shared/pi-types.ts). Messages and events are read by
// hand from JSON: they are open unions, and a field of an unexpected shape
// must not drop a whole message.

public enum ThinkingLevel: String, Codable, CaseIterable, Sendable {
    case off, minimal, low, medium, high, xhigh, max

    public var label: String {
        switch self {
        case .off: return "Off"
        case .minimal: return "Min"
        case .low: return "Low"
        case .medium: return "Med"
        case .high: return "High"
        case .xhigh: return "XHigh"
        case .max: return "Max"
        }
    }

    static func list(_ value: JSONValue?) -> [ThinkingLevel] {
        (value?.arrayValue ?? []).compactMap { $0.stringValue.flatMap(ThinkingLevel.init(rawValue:)) }
    }
}

public enum StopReason: String, Sendable {
    case stop, length, toolUse, error, aborted, pending
}

// MARK: - Content

public struct ImageContent: Hashable, Sendable {
    /// base64-encoded image data
    public var data: String
    public var mimeType: String

    public init(data: String, mimeType: String) {
        self.data = data
        self.mimeType = mimeType
    }

    public var json: JSONValue { ["type": "image", "data": .string(data), "mimeType": .string(mimeType)] }
}

public struct ToolCallContent: Hashable, Sendable {
    public var id: String
    public var name: String
    public var arguments: [String: JSONValue]

    public init(id: String, name: String, arguments: [String: JSONValue]) {
        self.id = id
        self.name = name
        self.arguments = arguments
    }

    init?(json: JSONValue) {
        guard let id = json["id"]?.stringValue else { return nil }
        self.id = id
        name = json["name"]?.stringValue ?? ""
        arguments = json["arguments"]?.objectValue ?? [:]
    }
}

public enum ContentBlock: Hashable, Sendable {
    case text(String)
    case thinking(String)
    case toolCall(ToolCallContent)
    case image(ImageContent)
    case other(String)

    init(json: JSONValue) {
        switch json["type"]?.stringValue {
        case "text": self = .text(json["text"]?.stringValue ?? "")
        case "thinking": self = .thinking(json["thinking"]?.stringValue ?? "")
        case "toolCall":
            if let call = ToolCallContent(json: json) {
                self = .toolCall(call)
            } else {
                self = .other("toolCall")
            }
        case "image":
            self = .image(ImageContent(data: json["data"]?.stringValue ?? "", mimeType: json["mimeType"]?.stringValue ?? "image/png"))
        case let type:
            self = .other(type ?? "")
        }
    }

    static func list(_ value: JSONValue?) -> [ContentBlock] {
        if let text = value?.stringValue { return [.text(text)] }
        return (value?.arrayValue ?? []).map(ContentBlock.init(json:))
    }

    public var typeName: String {
        switch self {
        case .text: return "text"
        case .thinking: return "thinking"
        case .toolCall: return "toolCall"
        case .image: return "image"
        case .other(let type): return type
        }
    }
}

// MARK: - Messages

public struct Usage: Hashable, Sendable {
    public var input: Double
    public var output: Double
    public var cacheRead: Double
    public var cacheWrite: Double
    public var costTotal: Double

    init?(json: JSONValue?) {
        guard let json, json.objectValue != nil else { return nil }
        input = json["input"]?.doubleValue ?? 0
        output = json["output"]?.doubleValue ?? 0
        cacheRead = json["cacheRead"]?.doubleValue ?? 0
        cacheWrite = json["cacheWrite"]?.doubleValue ?? 0
        costTotal = json["cost"]?["total"]?.doubleValue ?? 0
    }
}

public struct AssistantMessage: Hashable, Sendable {
    public var content: [ContentBlock]
    public var provider: String
    public var model: String
    public var usage: Usage?
    public var stopReason: StopReason?
    public var errorMessage: String?
    public var timestamp: Double?
}

public struct ToolResultMessage: Hashable, Sendable {
    public var toolCallId: String
    public var toolName: String
    public var content: [ContentBlock]
    public var details: JSONValue?
    public var isError: Bool
    public var timestamp: Double?
}

/// One of pi's agent messages (session entries and stream events).
public enum AgentMessage: Hashable, Sendable {
    case user(content: [ContentBlock], timestamp: Double?)
    case assistant(AssistantMessage)
    case toolResult(ToolResultMessage)
    case bashExecution(command: String, output: String, exitCode: Int?, cancelled: Bool, timestamp: Double?)
    case custom(content: [ContentBlock], display: Bool, timestamp: Double?)
    case branchSummary(summary: String)
    case compactionSummary(summary: String, tokensBefore: Double?)
    case unknown(role: String)

    public init(json: JSONValue) {
        let timestamp = json["timestamp"]?.doubleValue
        switch json["role"]?.stringValue {
        case "user":
            self = .user(content: ContentBlock.list(json["content"]), timestamp: timestamp)
        case "assistant":
            self = .assistant(
                AssistantMessage(
                    content: (json["content"]?.arrayValue ?? []).map(ContentBlock.init(json:)),
                    provider: json["provider"]?.stringValue ?? "",
                    model: json["model"]?.stringValue ?? "",
                    usage: Usage(json: json["usage"]),
                    stopReason: json["stopReason"]?.stringValue.flatMap(StopReason.init(rawValue:)),
                    errorMessage: json["errorMessage"]?.stringValue,
                    timestamp: timestamp
                )
            )
        case "toolResult":
            self = .toolResult(
                ToolResultMessage(
                    toolCallId: json["toolCallId"]?.stringValue ?? "",
                    toolName: json["toolName"]?.stringValue ?? "",
                    content: ContentBlock.list(json["content"]),
                    details: json["details"],
                    isError: json["isError"]?.isTrue ?? false,
                    timestamp: timestamp
                )
            )
        case "bashExecution":
            self = .bashExecution(
                command: json["command"]?.stringValue ?? "",
                output: json["output"]?.stringValue ?? "",
                exitCode: json["exitCode"]?.intValue,
                cancelled: json["cancelled"]?.isTrue ?? false,
                timestamp: timestamp
            )
        case "custom":
            self = .custom(
                content: ContentBlock.list(json["content"]),
                display: json["display"]?.isTrue ?? false,
                timestamp: timestamp
            )
        case "branchSummary":
            self = .branchSummary(summary: json["summary"]?.stringValue ?? "")
        case "compactionSummary":
            self = .compactionSummary(summary: json["summary"]?.stringValue ?? "", tokensBefore: json["tokensBefore"]?.doubleValue)
        case let role:
            self = .unknown(role: role ?? "")
        }
    }

    static func list(_ value: JSONValue?) -> [AgentMessage] {
        (value?.arrayValue ?? []).map(AgentMessage.init(json:))
    }

    public var role: String {
        switch self {
        case .user: return "user"
        case .assistant: return "assistant"
        case .toolResult: return "toolResult"
        case .bashExecution: return "bashExecution"
        case .custom: return "custom"
        case .branchSummary: return "branchSummary"
        case .compactionSummary: return "compactionSummary"
        case .unknown(let role): return role
        }
    }

    /// The message's content blocks, for messages that have them.
    public var contentBlocks: [ContentBlock]? {
        switch self {
        case .user(let content, _), .custom(let content, _, _): return content
        case .assistant(let message): return message.content
        case .toolResult(let message): return message.content
        default: return nil
        }
    }
}

// MARK: - Model and session state

public struct ModelCost: Hashable, Sendable {
    public var input: Double
    public var output: Double
}

public struct Model: Hashable, Sendable, Identifiable {
    public var id: String
    public var name: String
    public var provider: String
    public var reasoning: Bool
    /// pi's thinking level → provider value; `nil` marks a level as unsupported.
    public var thinkingLevelMap: [String: String?]?
    public var contextWindow: Double
    public var maxTokens: Double

    public var key: String { "\(provider)/\(id)" }

    public init(id: String, name: String, provider: String, reasoning: Bool = false, contextWindow: Double = 0) {
        self.id = id
        self.name = name
        self.provider = provider
        self.reasoning = reasoning
        self.thinkingLevelMap = nil
        self.contextWindow = contextWindow
        self.maxTokens = 0
    }

    public init?(json: JSONValue?) {
        guard let json, let id = json["id"]?.stringValue else { return nil }
        self.id = id
        name = json["name"]?.stringValue ?? id
        provider = json["provider"]?.stringValue ?? ""
        reasoning = json["reasoning"]?.isTrue ?? false
        if let map = json["thinkingLevelMap"]?.objectValue {
            var out: [String: String?] = [:]
            // updateValue keeps a null entry (unsupported) instead of removing the key.
            for (key, value) in map { out.updateValue(value.stringValue, forKey: key) }
            thinkingLevelMap = out
        } else {
            thinkingLevelMap = nil
        }
        contextWindow = json["contextWindow"]?.doubleValue ?? 0
        maxTokens = json["maxTokens"]?.doubleValue ?? 0
    }

    static func list(_ value: JSONValue?) -> [Model] {
        (value?.arrayValue ?? []).compactMap { Model(json: $0) }
    }

    public var json: JSONValue {
        ["id": .string(id), "name": .string(name), "provider": .string(provider), "reasoning": .bool(reasoning)]
    }

    /// Levels this model supports (docs: null = unsupported, missing = default).
    public var supportedThinkingLevels: [ThinkingLevel] {
        guard reasoning else { return [.off] }
        guard let map = thinkingLevelMap else { return ThinkingLevel.allCases }
        return ThinkingLevel.allCases.filter { level in
            if let entry = map[level.rawValue] { return entry != nil }
            return true
        }
    }

    public var hasThinking: Bool { reasoning && supportedThinkingLevels.contains { $0 != .off } }
}

public struct PiSessionState: Sendable {
    public var model: Model?
    public var thinkingLevel: ThinkingLevel?
    public var isStreaming: Bool
    public var sessionFile: String?
    public var sessionName: String?

    public init(json: JSONValue?) {
        model = Model(json: json?["model"])
        thinkingLevel = json?["thinkingLevel"]?.stringValue.flatMap(ThinkingLevel.init(rawValue:))
        isStreaming = json?["isStreaming"]?.isTrue ?? false
        sessionFile = json?["sessionFile"]?.stringValue
        sessionName = json?["sessionName"]?.stringValue
    }
}

public struct PiCommandInfo: Hashable, Sendable {
    public var name: String
    public var description: String?
    /// "extension", "prompt" or "skill".
    public var source: String

    public init(name: String, description: String?, source: String) {
        self.name = name
        self.description = description
        self.source = source
    }

    static func list(_ value: JSONValue?) -> [PiCommandInfo] {
        (value?.arrayValue ?? []).compactMap { item in
            guard let name = item["name"]?.stringValue else { return nil }
            return PiCommandInfo(name: name, description: item["description"]?.stringValue, source: item["source"]?.stringValue ?? "extension")
        }
    }
}

// MARK: - Events

public enum AssistantMessageEvent: Sendable {
    case textStart(index: Int)
    case textDelta(index: Int, delta: String)
    case textEnd(index: Int, content: String)
    case thinkingStart(index: Int)
    case thinkingDelta(index: Int, delta: String)
    case thinkingEnd(index: Int, content: String)
    case toolcallStart(index: Int, id: String, toolName: String)
    case toolcallDelta(index: Int, delta: String)
    case toolcallEnd(index: Int, call: ToolCallContent)
    case unknown

    init(json: JSONValue?) {
        guard let json else {
            self = .unknown
            return
        }
        let index = json["contentIndex"]?.intValue ?? 0
        let delta = json["delta"]?.stringValue ?? ""
        let content = json["content"]?.stringValue ?? ""
        switch json["type"]?.stringValue {
        case "text_start": self = .textStart(index: index)
        case "text_delta": self = .textDelta(index: index, delta: delta)
        case "text_end": self = .textEnd(index: index, content: content)
        case "thinking_start": self = .thinkingStart(index: index)
        case "thinking_delta": self = .thinkingDelta(index: index, delta: delta)
        case "thinking_end": self = .thinkingEnd(index: index, content: content)
        case "toolcall_start":
            self = .toolcallStart(index: index, id: json["id"]?.stringValue ?? "", toolName: json["toolName"]?.stringValue ?? "")
        case "toolcall_delta": self = .toolcallDelta(index: index, delta: delta)
        case "toolcall_end":
            if let call = json["toolCall"].flatMap(ToolCallContent.init(json:)) {
                self = .toolcallEnd(index: index, call: call)
            } else {
                self = .unknown
            }
        default: self = .unknown
        }
    }
}

public struct ToolResultPayload: Hashable, Sendable {
    public var content: [ContentBlock]
    public var details: JSONValue?

    public init(content: [ContentBlock], details: JSONValue?) {
        self.content = content
        self.details = details
    }

    init(json: JSONValue?) {
        content = ContentBlock.list(json?["content"])
        details = json?["details"]
    }
}

public struct CompactionResult: Sendable {
    public var summary: String
    public var tokensBefore: Double?
    public var estimatedTokensAfter: Double?
}

/// A dialog an extension opened in pi (or a notice it posted).
public struct ExtensionUiRequest: Equatable, Sendable {
    public var id: String
    /// select, confirm, input, editor, notify, setStatus, setWidget, setTitle, set_editor_text
    public var method: String
    public var title: String?
    public var message: String?
    public var options: [String]
    public var placeholder: String?
    public var prefill: String?
    public var notifyType: String?

    public init?(json: JSONValue) {
        guard let id = json["id"]?.stringValue, let method = json["method"]?.stringValue else { return nil }
        self.id = id
        self.method = method
        title = json["title"]?.stringValue
        message = json["message"]?.stringValue
        options = (json["options"]?.arrayValue ?? []).compactMap(\.stringValue)
        placeholder = json["placeholder"]?.stringValue
        prefill = json["prefill"]?.stringValue
        notifyType = json["notifyType"]?.stringValue
    }

    /// pi waits on the user until someone answers.
    public var isInteractive: Bool {
        method == "select" || method == "confirm" || method == "input" || method == "editor"
    }
}

public enum PiEvent: Sendable {
    case agentStart
    case agentEnd(messages: [AgentMessage])
    case agentSettled
    case turnEnd
    case queueUpdate(steering: [String], followUp: [String])
    case messageStart(AgentMessage)
    case messageUpdate(AssistantMessageEvent)
    case messageEnd(AgentMessage)
    case toolExecutionStart(toolCallId: String, toolName: String, args: [String: JSONValue])
    case toolExecutionUpdate(toolCallId: String, toolName: String, args: [String: JSONValue], partialText: String?)
    case toolExecutionEnd(toolCallId: String, toolName: String, result: ToolResultPayload, isError: Bool)
    case bashExecutionUpdate(delta: String)
    case compactionStart
    case compactionEnd(result: CompactionResult?, aborted: Bool, errorMessage: String?)
    case autoRetryStart(attempt: Int, maxAttempts: Int)
    case autoRetryEnd(success: Bool, finalError: String?)
    case summarizationRetryScheduled(attempt: Int, maxAttempts: Int)
    case extensionError(error: String)
    case extensionUi(ExtensionUiRequest)
    case other(type: String)

    public init(json: JSONValue) {
        let type = json["type"]?.stringValue ?? ""
        switch type {
        case "agent_start": self = .agentStart
        case "agent_end": self = .agentEnd(messages: AgentMessage.list(json["messages"]))
        case "agent_settled": self = .agentSettled
        case "turn_end": self = .turnEnd
        case "queue_update":
            self = .queueUpdate(
                steering: (json["steering"]?.arrayValue ?? []).compactMap(\.stringValue),
                followUp: (json["followUp"]?.arrayValue ?? []).compactMap(\.stringValue)
            )
        case "message_start": self = .messageStart(AgentMessage(json: json["message"] ?? .null))
        case "message_update": self = .messageUpdate(AssistantMessageEvent(json: json["assistantMessageEvent"]))
        case "message_end": self = .messageEnd(AgentMessage(json: json["message"] ?? .null))
        case "tool_execution_start":
            self = .toolExecutionStart(
                toolCallId: json["toolCallId"]?.stringValue ?? "",
                toolName: json["toolName"]?.stringValue ?? "",
                args: json["args"]?.objectValue ?? [:]
            )
        case "tool_execution_update":
            let partial = json["partialResult"]?["content"]?.arrayValue.map { blocks in
                blocks.compactMap { $0["type"]?.stringValue == "text" ? $0["text"]?.stringValue : nil }.joined()
            }
            self = .toolExecutionUpdate(
                toolCallId: json["toolCallId"]?.stringValue ?? "",
                toolName: json["toolName"]?.stringValue ?? "",
                args: json["args"]?.objectValue ?? [:],
                partialText: partial
            )
        case "tool_execution_end":
            self = .toolExecutionEnd(
                toolCallId: json["toolCallId"]?.stringValue ?? "",
                toolName: json["toolName"]?.stringValue ?? "",
                result: ToolResultPayload(json: json["result"]),
                isError: json["isError"]?.isTrue ?? false
            )
        case "bash_execution_update": self = .bashExecutionUpdate(delta: json["delta"]?.stringValue ?? "")
        case "compaction_start": self = .compactionStart
        case "compaction_end":
            let result = json["result"].flatMap { value -> CompactionResult? in
                guard value.objectValue != nil else { return nil }
                return CompactionResult(
                    summary: value["summary"]?.stringValue ?? "",
                    tokensBefore: value["tokensBefore"]?.doubleValue,
                    estimatedTokensAfter: value["estimatedTokensAfter"]?.doubleValue
                )
            }
            self = .compactionEnd(result: result, aborted: json["aborted"]?.isTrue ?? false, errorMessage: json["errorMessage"]?.stringValue)
        case "auto_retry_start":
            self = .autoRetryStart(attempt: json["attempt"]?.intValue ?? 0, maxAttempts: json["maxAttempts"]?.intValue ?? 0)
        case "auto_retry_end":
            self = .autoRetryEnd(success: json["success"]?.isTrue ?? false, finalError: json["finalError"]?.stringValue)
        case "summarization_retry_scheduled":
            self = .summarizationRetryScheduled(attempt: json["attempt"]?.intValue ?? 0, maxAttempts: json["maxAttempts"]?.intValue ?? 0)
        case "extension_error": self = .extensionError(error: json["error"]?.stringValue ?? "")
        case "extension_ui_request":
            if let request = ExtensionUiRequest(json: json) {
                self = .extensionUi(request)
            } else {
                self = .other(type: type)
            }
        default: self = .other(type: type)
        }
    }

    public var isAgentEnd: Bool {
        if case .agentEnd = self { return true }
        return false
    }

    public var isAgentSettled: Bool {
        if case .agentSettled = self { return true }
        return false
    }

    public var isAgentStart: Bool {
        if case .agentStart = self { return true }
        return false
    }
}

// MARK: - Session tree

public struct PiTreeNode: Sendable {
    public var id: String
    public var type: String
    public var label: String?
    public var message: AgentMessage?
    public var children: [PiTreeNode]

    init(json: JSONValue) {
        let entry = json["entry"] ?? .null
        id = entry["id"]?.stringValue ?? ""
        type = entry["type"]?.stringValue ?? ""
        label = json["label"]?.stringValue ?? entry["label"]?.stringValue
        message = entry["message"].flatMap { $0.objectValue != nil ? AgentMessage(json: $0) : nil }
        children = (json["children"]?.arrayValue ?? []).map(PiTreeNode.init(json:))
    }

    public init(id: String, type: String, label: String? = nil, message: AgentMessage? = nil, children: [PiTreeNode] = []) {
        self.id = id
        self.type = type
        self.label = label
        self.message = message
        self.children = children
    }
}

public struct PiTreeResult: Sendable {
    public var tree: [PiTreeNode]
    public var leafId: String?

    public init(json: JSONValue) {
        tree = (json["tree"]?.arrayValue ?? []).map(PiTreeNode.init(json:))
        leafId = json["leafId"]?.stringValue
    }

    public init(tree: [PiTreeNode], leafId: String?) {
        self.tree = tree
        self.leafId = leafId
    }
}
