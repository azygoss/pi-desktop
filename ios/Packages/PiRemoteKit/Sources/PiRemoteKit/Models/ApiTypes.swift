import Foundation

// Results of the desktop's IPC handlers as a paired phone receives them
// (src/shared/api.ts, session-types.ts and friends).

public struct SessionSummary: Codable, Hashable, Sendable, Identifiable {
    public var id: String
    public var path: String
    public var cwd: String
    public var name: String?
    public var title: String
    /// ISO timestamp from the session header.
    public var created: String
    /// File mtime as ISO timestamp.
    public var modified: String
    public var messageCount: Int
    public var parentSessionPath: String?

    public init(id: String, path: String, cwd: String, title: String, created: String, modified: String, messageCount: Int) {
        self.id = id
        self.path = path
        self.cwd = cwd
        self.title = title
        self.created = created
        self.modified = modified
        self.messageCount = messageCount
    }
}

public struct ProjectSummary: Codable, Hashable, Sendable, Identifiable {
    public var cwd: String
    public var name: String
    public var sessionCount: Int
    public var lastModified: String
    /// A git worktree the app created.
    public var worktree: Bool?

    public var id: String { cwd }
}

public struct PiRuntimeInfo: Decodable, Sendable {
    public var kind: String
    public var version: String?
    public var command: String
}

public struct AppInfo: Codable, Equatable, Sendable {
    public var version: String
    public var platform: String
    public var agentDir: String?
    public var agentDirDisplay: String?
    public var homeDir: String
    /// Scratch dir for project-less chats.
    public var workspaceDir: String
}

public struct SessionMetaEntry: Codable, Hashable, Sendable {
    /// pinnedAt epoch ms.
    public var pinned: Double?
    /// archivedAt epoch ms.
    public var archived: Double?

    public init(pinned: Double? = nil, archived: Double? = nil) {
        self.pinned = pinned
        self.archived = archived
    }
}

public typealias SessionMetaMap = [String: SessionMetaEntry]

public struct SessionSearchHit: Decodable, Hashable, Sendable {
    public var sessionPath: String
    public var role: String
    public var snippet: String
    public var matches: Int
}

public struct CatalogSnapshot: Sendable {
    public var models: [Model]
    public var commands: [PiCommandInfo]
    public var thinkingLevels: [ThinkingLevel]
    public var model: Model?
    public var thinkingLevel: ThinkingLevel?

    public init(json: JSONValue) {
        models = Model.list(json["models"])
        commands = PiCommandInfo.list(json["commands"])
        thinkingLevels = ThinkingLevel.list(json["thinkingLevels"])
        model = Model(json: json["model"])
        thinkingLevel = json["thinkingLevel"]?.stringValue.flatMap(ThinkingLevel.init(rawValue:))
    }
}

public struct ChatOpenResult: Sendable {
    public var chatId: String
    public var cwd: String
    public var state: PiSessionState
    public var messages: [AgentMessage]
    public var models: [Model]
    public var thinkingLevels: [ThinkingLevel]
    public var commands: [PiCommandInfo]
    public var sessionPath: String?

    public init(json: JSONValue) {
        chatId = json["chatId"]?.stringValue ?? ""
        cwd = json["cwd"]?.stringValue ?? ""
        state = PiSessionState(json: json["state"])
        messages = AgentMessage.list(json["messages"])
        models = Model.list(json["models"])
        thinkingLevels = ThinkingLevel.list(json["thinkingLevels"])
        commands = PiCommandInfo.list(json["commands"])
        sessionPath = json["sessionPath"]?.stringValue
    }
}

public struct ChatTranscriptResult: Sendable {
    public var messages: [AgentMessage]
    public var hasEarlier: Bool
    public var totalMessages: Int
    /// Index of the first returned message on the branch.
    public var startIndex: Int?

    public init(json: JSONValue) {
        messages = AgentMessage.list(json["messages"])
        hasEarlier = json["hasEarlier"]?.isTrue ?? false
        totalMessages = json["totalMessages"]?.intValue ?? messages.count
        startIndex = json["startIndex"]?.intValue
    }
}

public struct ChatReadyPayload: Sendable {
    public var chatId: String
    public var state: PiSessionState
    public var models: [Model]
    public var thinkingLevels: [ThinkingLevel]
    public var commands: [PiCommandInfo]
    public var sessionPath: String?

    public init(json: JSONValue) {
        chatId = json["chatId"]?.stringValue ?? ""
        state = PiSessionState(json: json["state"])
        models = Model.list(json["models"])
        thinkingLevels = ThinkingLevel.list(json["thinkingLevels"])
        commands = PiCommandInfo.list(json["commands"])
        sessionPath = json["sessionPath"]?.stringValue
    }
}

public struct ChatExitPayload: Sendable {
    public var chatId: String
    public var code: Int?
    public var stderrTail: [String]

    public init(json: JSONValue) {
        chatId = json["chatId"]?.stringValue ?? ""
        code = json["code"]?.intValue
        stderrTail = (json["stderrTail"]?.arrayValue ?? []).compactMap(\.stringValue)
    }
}

public struct ChatSessionStats: Sendable, Equatable {
    public struct Tokens: Sendable, Equatable {
        public var input: Double
        public var output: Double
        public var cacheRead: Double
        public var cacheWrite: Double
    }

    public var sessionFile: String?
    public var userMessages: Int?
    public var assistantMessages: Int?
    public var toolCalls: Int?
    public var tokens: Tokens?
    public var cost: Double?
    public var contextTokens: Double?
    public var contextWindow: Double?
    public var contextPercent: Double?

    public init?(json: JSONValue?) {
        guard let json, json.objectValue != nil else { return nil }
        sessionFile = json["sessionFile"]?.stringValue
        userMessages = json["userMessages"]?.intValue
        assistantMessages = json["assistantMessages"]?.intValue
        toolCalls = json["toolCalls"]?.intValue
        if let tokens = json["tokens"], tokens.objectValue != nil {
            self.tokens = Tokens(
                input: tokens["input"]?.doubleValue ?? 0,
                output: tokens["output"]?.doubleValue ?? 0,
                cacheRead: tokens["cacheRead"]?.doubleValue ?? 0,
                cacheWrite: tokens["cacheWrite"]?.doubleValue ?? 0
            )
        }
        cost = json["cost"]?.doubleValue
        contextTokens = json["contextUsage"]?["tokens"]?.doubleValue
        contextWindow = json["contextUsage"]?["contextWindow"]?.doubleValue
        contextPercent = json["contextUsage"]?["percent"]?.doubleValue
    }
}

public struct SetModelResult: Sendable {
    public var model: Model?
    public var thinkingLevel: ThinkingLevel?
    public var thinkingLevels: [ThinkingLevel]

    public init(json: JSONValue) {
        model = Model(json: json["model"])
        thinkingLevel = json["thinkingLevel"]?.stringValue.flatMap(ThinkingLevel.init(rawValue:))
        thinkingLevels = ThinkingLevel.list(json["thinkingLevels"])
    }
}

public struct ChatBashResult: Decodable, Sendable {
    public var output: String
    public var exitCode: Int?
    public var cancelled: Bool
    public var truncated: Bool?
}

public struct ForkMessage: Decodable, Hashable, Sendable, Identifiable {
    public var entryId: String
    public var text: String
    public var id: String { entryId }
}

public struct RepoDiffResult: Sendable {
    public struct Untracked: Sendable {
        public var path: String
        public var content: String
    }

    public var isRepo: Bool
    public var branch: String?
    public var root: String?
    public var diffText: String
    public var untracked: [Untracked]

    public init(json: JSONValue) {
        isRepo = json["isRepo"]?.isTrue ?? false
        branch = json["branch"]?.stringValue
        root = json["root"]?.stringValue
        diffText = json["diffText"]?.stringValue ?? ""
        untracked = (json["untracked"]?.arrayValue ?? []).compactMap { item in
            guard let path = item["path"]?.stringValue else { return nil }
            return Untracked(path: path, content: item["content"]?.stringValue ?? "")
        }
    }
}

public struct RepoSummary: Decodable, Equatable, Sendable {
    public var isRepo: Bool
    public var branch: String?
    public var files: Int
    public var added: Int
    public var removed: Int
}

public struct GitActionResult: Decodable, Sendable {
    public var ok: Bool
    public var message: String
}

public struct CheckpointRestoreResult: Decodable, Sendable {
    public var restored: Int
    public var trashed: Int
    public var undo: String
}

public struct WorktreeInfo: Decodable, Sendable {
    public var cwd: String
    public var branch: String
    public var repo: String
}

public struct FileReadResult: Decodable, Sendable {
    public var path: String
    public var relativePath: String
    public var size: Int
    public var binary: Bool
    public var truncated: Bool
    public var content: String
}

public struct RemoteImage: Decodable, Sendable {
    public var mimeType: String
    public var data: String
    public var size: Int?
}

public struct UsageTotals: Decodable, Hashable, Sendable {
    public var cost: Double
    public var input: Double
    public var output: Double
    public var requests: Int
}

public struct UsageReport: Sendable {
    public struct Day: Sendable, Hashable {
        public var day: String
        public var totals: UsageTotals
    }

    public struct Named: Sendable, Hashable {
        public var name: String
        public var totals: UsageTotals
    }

    public var days: [Day]
    public var models: [Named]
    public var projects: [Named]
    public var total: UsageTotals

    public init(json: JSONValue) {
        func totals(_ value: JSONValue) -> UsageTotals {
            (try? value.decode(UsageTotals.self)) ?? UsageTotals(cost: 0, input: 0, output: 0, requests: 0)
        }
        days = (json["days"]?.arrayValue ?? []).map { Day(day: $0["day"]?.stringValue ?? "", totals: totals($0)) }
        models = (json["models"]?.arrayValue ?? []).map { Named(name: $0["model"]?.stringValue ?? "", totals: totals($0)) }
        projects = (json["projects"]?.arrayValue ?? []).map { Named(name: $0["cwd"]?.stringValue ?? "", totals: totals($0)) }
        total = totals(json["total"] ?? .null)
    }
}

public struct CuaPermissions: Decodable, Sendable {
    public var available: Bool
    public var accessibility: Bool
    public var screenRecording: Bool
}

public struct CuaActivity: Sendable {
    public var chatId: String?
    /// start, end, paused, resumed
    public var phase: String
    public var app: String?
    public var summary: String

    public init(json: JSONValue) {
        chatId = json["chatId"]?.stringValue
        phase = json["phase"]?.stringValue ?? ""
        app = json["app"]?.stringValue
        summary = json["summary"]?.stringValue ?? ""
    }
}

public struct PrReviewPosted: Decodable, Sendable {
    public var url: String
    public var inline: Int
    public var listed: Int
    public var account: String
}

/// Which model a side chat or review pass uses.
public struct SideModelInput: Sendable {
    public var provider: String
    public var modelId: String

    public init(provider: String, modelId: String) {
        self.provider = provider
        self.modelId = modelId
    }

    public var json: JSONValue { ["provider": .string(provider), "modelId": .string(modelId)] }
}

public enum ChatSendMode: String, Sendable {
    case prompt, steer, followUp
}
