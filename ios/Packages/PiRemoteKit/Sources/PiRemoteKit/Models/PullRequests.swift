import Foundation

// Pull-request status as the desktop reports it through the GitHub CLI
// (src/shared/pr-status.ts), and the review-comment types (review.ts,
// pr-review.ts).

public enum CheckState: String, Sendable {
    case pass, fail, pending, skipped
}

public struct PrCheck: Hashable, Sendable {
    public var name: String
    public var state: CheckState
    public var url: String?
    public var runId: String?
}

public struct PullRequest: Hashable, Sendable {
    public var number: Int
    public var title: String
    public var url: String
    /// OPEN, CLOSED or MERGED
    public var state: String
    public var draft: Bool
    public var headSha: String
    public var reviewDecision: String?
    public var checks: [PrCheck]

    init?(json: JSONValue?) {
        guard let json, let number = json["number"]?.intValue else { return nil }
        self.number = number
        title = json["title"]?.stringValue ?? ""
        url = json["url"]?.stringValue ?? ""
        state = json["state"]?.stringValue ?? "OPEN"
        draft = json["draft"]?.isTrue ?? false
        headSha = json["headSha"]?.stringValue ?? ""
        reviewDecision = json["reviewDecision"]?.stringValue
        checks = (json["checks"]?.arrayValue ?? []).compactMap { item in
            guard let name = item["name"]?.stringValue else { return nil }
            return PrCheck(
                name: name,
                state: item["state"]?.stringValue.flatMap(CheckState.init(rawValue:)) ?? .pending,
                url: item["url"]?.stringValue,
                runId: item["runId"]?.stringValue
            )
        }
    }
}

public struct PrStatus: Sendable {
    /// False when the GitHub CLI is missing or not signed in.
    public var available: Bool
    public var pr: PullRequest?

    public init(json: JSONValue) {
        available = json["available"]?.isTrue ?? false
        pr = PullRequest(json: json["pr"])
    }
}

public enum PrSummary: String, Sendable {
    case none, pending, failing, passing
}

/// One word for the whole set of checks.
public func summarizeChecks(_ checks: [PrCheck]) -> PrSummary {
    if checks.contains(where: { $0.state == .fail }) { return .failing }
    if checks.contains(where: { $0.state == .pending }) { return .pending }
    return checks.contains(where: { $0.state == .pass }) ? .passing : .none
}

private func fenceFor(_ text: String) -> String {
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

/// The prompt that asks pi to fix failing checks, with the log tail if any.
public func fixChecksPrompt(_ pr: PullRequest, log: String) -> String {
    let failing = pr.checks.filter { $0.state == .fail }.map(\.name)
    let head = "CI is failing on pull request #\(pr.number) (\(pr.title)). Failing \(failing.count == 1 ? "check" : "checks"): \(failing.joined(separator: ", "))."
    let ask = "Find the cause, fix it, and tell me what you changed. Do not push."
    let trimmed = log.trimmingCharacters(in: .whitespacesAndNewlines)
    if trimmed.isEmpty { return "\(head)\n\n\(ask)" }
    let fence = fenceFor(trimmed)
    return "\(head)\n\nEnd of the failed job's log:\n\n\(fence)\n\(trimmed)\n\(fence)\n\n\(ask)"
}

/// A note on one line of a project's working-tree diff, kept by the computer.
public struct ReviewComment: Hashable, Sendable, Identifiable {
    public var id: String
    public var path: String
    /// Line in the new file (old file for removed lines).
    public var line: Int?
    /// The line's text as the diff showed it ("" when unknown).
    public var lineText: String
    public var text: String
    /// "pi" on remarks from a review pass.
    public var author: String?
    public var createdAt: Double

    public init(id: String, path: String, line: Int?, lineText: String, text: String, author: String?, createdAt: Double) {
        self.id = id
        self.path = path
        self.line = line
        self.lineText = lineText
        self.text = text
        self.author = author
        self.createdAt = createdAt
    }

    public init?(json: JSONValue) {
        guard let id = json["id"]?.stringValue, let path = json["path"]?.stringValue else { return nil }
        self.id = id
        self.path = path
        line = json["line"]?.intValue
        lineText = json["lineText"]?.stringValue ?? ""
        text = json["text"]?.stringValue ?? ""
        author = json["author"]?.stringValue
        createdAt = json["createdAt"]?.doubleValue ?? 0
    }

    public static func list(_ value: JSONValue?) -> [ReviewComment] {
        (value?.arrayValue ?? []).compactMap(ReviewComment.init(json:))
    }

    public var fromPi: Bool { author == "pi" }
}

/// A remark pi made in a review pass.
public struct PiReviewComment: Sendable {
    public var path: String
    public var line: Int?
    public var comment: String

    public init?(json: JSONValue) {
        guard let path = json["path"]?.stringValue, let comment = json["comment"]?.stringValue else { return nil }
        self.path = path
        line = json["line"]?.intValue
        self.comment = comment
    }
}

/// A comment as the PR-posting handler takes it.
public struct PrCommentInput: Sendable {
    public var path: String
    public var line: Int?
    public var lineText: String?
    public var text: String
    public var author: String?
    public var removed: Bool

    public init(path: String, line: Int?, lineText: String?, text: String, author: String?, removed: Bool) {
        self.path = path
        self.line = line
        self.lineText = lineText
        self.text = text
        self.author = author
        self.removed = removed
    }

    public var json: JSONValue {
        .compact([
            "path": .string(path),
            "line": line.map(JSONValue.int),
            "lineText": lineText.map(JSONValue.string),
            "text": .string(text),
            "author": author.map(JSONValue.string),
            "removed": removed ? .bool(true) : nil
        ])
    }
}
