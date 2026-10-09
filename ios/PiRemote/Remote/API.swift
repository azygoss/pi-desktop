import Foundation
import PiRemoteKit

/// A cold pi start (extensions, MCP servers) can take a while.
private let openTimeout: Double = 120
private let longTimeout: Double = 10 * 60

/// Catalog results without the message list (the phone pages transcripts).
private let lite: [String: JSONValue] = ["lite": true]

@MainActor
private func call(_ channel: String, _ arg: JSONValue? = nil, timeout: Double = defaultRequestTimeout) async throws -> JSONValue {
    try await Connection.shared.request(channel, arg, timeout: timeout)
}

@MainActor
private func decode<T: Decodable>(_ channel: String, _ arg: JSONValue? = nil, timeout: Double = defaultRequestTimeout) async throws -> T {
    let value = try await call(channel, arg, timeout: timeout)
    do {
        return try value.decode(T.self)
    } catch {
        throw RemoteMessageError("The computer sent an answer this app cannot read")
    }
}

private func merged(_ base: [String: JSONValue], _ extra: [String: JSONValue]) -> JSONValue {
    .object(base.merging(extra) { $1 })
}

/// The desktop's IPC surface as the phone uses it (mobile/src/remote/api.ts).
/// Channel names are the desktop's own; only allowlisted ones answer remotely.
@MainActor
enum API {
    // MARK: App

    static func appInfo() async throws -> AppInfo { try await decode("pi-desktop:app:info") }
    static func userFirstName() async throws -> String { try await call("pi-desktop:app:user-first-name").stringValue ?? "" }
    static func runtime() async throws -> PiRuntimeInfo { try await decode("pi-desktop:runtime:info") }
    static func catalog() async throws -> CatalogSnapshot { CatalogSnapshot(json: try await call("pi-desktop:catalog:get")) }

    static func listDirs(_ path: String?) async throws -> RemoteDirListing {
        try await decode("pi-desktop:remote:list-dirs", .compact(["path": path.map(JSONValue.string)]))
    }

    static func computerUseEnabled() async throws -> Bool {
        try await call("pi-desktop:app-settings:get")["computerUse"]?["enabled"]?.isTrue ?? false
    }

    // MARK: Sessions

    static func sessions() async throws -> [SessionSummary] {
        try await decode(LenientArray<SessionSummary>.self, "pi-desktop:sessions:list").items
    }

    static func search(_ query: String) async throws -> [SessionSearchHit] {
        try await decode(LenientArray<SessionSearchHit>.self, "pi-desktop:sessions:search", ["query": .string(query)]).items
    }

    static func usage() async throws -> UsageReport {
        UsageReport(json: try await call("pi-desktop:sessions:usage", nil, timeout: 60))
    }

    static func rename(sessionPath: String, name: String) async throws {
        _ = try await call("pi-desktop:sessions:rename", ["sessionPath": .string(sessionPath), "name": .string(name)], timeout: openTimeout)
    }

    static func deleteSession(_ sessionPath: String) async throws {
        _ = try await call("pi-desktop:sessions:delete", ["sessionPath": .string(sessionPath)])
    }

    static func meta() async throws -> SessionMetaMap { try await decode("pi-desktop:session-meta:get") }

    static func setMeta(_ sessionPath: String, pinned: Bool? = nil, archived: Bool? = nil) async throws -> SessionMetaMap {
        let patch = JSONValue.compact(["pinned": pinned.map(JSONValue.bool), "archived": archived.map(JSONValue.bool)])
        return try await decode("pi-desktop:session-meta:set", ["sessionPath": .string(sessionPath), "patch": patch])
    }

    // MARK: Projects and git

    static func projects() async throws -> [ProjectSummary] {
        try await decode(LenientArray<ProjectSummary>.self, "pi-desktop:projects:list").items
    }

    static func addProject(_ cwd: String) async throws {
        _ = try await call("pi-desktop:projects:add", ["cwd": .string(cwd)])
    }

    static func createWorktree(_ cwd: String, source: WorktreeSource? = nil) async throws -> WorktreeInfo {
        try await decode("pi-desktop:projects:create-worktree", .compact(["cwd": .string(cwd), "source": source?.json]), timeout: 60)
    }

    static func removeWorktree(_ cwd: String, force: Bool, deleteBranch: Bool) async throws -> GitActionResult {
        try await decode(
            "pi-desktop:projects:remove-worktree",
            ["cwd": .string(cwd), "force": .bool(force), "deleteBranch": .bool(deleteBranch)]
        )
    }

    static func branches(_ cwd: String, query: String?) async throws -> RepoBranches {
        let arg = JSONValue.compact(["cwd": .string(cwd), "query": query.flatMap { $0.isEmpty ? nil : .string($0) }])
        return RepoBranches(json: try await call("pi-desktop:git:branches", arg, timeout: 60))
    }

    static func switchBranch(_ cwd: String, _ branch: String) async throws -> GitActionResult {
        try await decode("pi-desktop:git:switch", ["cwd": .string(cwd), "branch": .string(branch)], timeout: 60)
    }

    static func createBranch(_ cwd: String, _ name: String) async throws -> GitActionResult {
        try await decode("pi-desktop:git:create-branch", ["cwd": .string(cwd), "name": .string(name)], timeout: 60)
    }

    // MARK: Files

    static func listFiles(_ cwd: String) async throws -> [String] {
        (try await call("pi-desktop:files:list", ["cwd": .string(cwd)])["files"]?.arrayValue ?? []).compactMap(\.stringValue)
    }

    static func readFile(_ cwd: String, _ path: String) async throws -> FileReadResult {
        try await decode("pi-desktop:files:read", ["cwd": .string(cwd), "path": .string(path)])
    }

    static func readImage(_ cwd: String, _ path: String) async throws -> RemoteImage {
        try await decode("pi-desktop:remote:read-image", ["cwd": .string(cwd), "path": .string(path)], timeout: 120)
    }

    /// Store a file from the phone on the computer; pi reads it by path.
    static func upload(name: String, base64: String) async throws -> String {
        let result = try await call("pi-desktop:remote:upload", ["name": .string(name), "data": .string(base64)], timeout: 5 * 60)
        guard let path = result["path"]?.stringValue else { throw RemoteMessageError("The computer did not keep the file") }
        return path
    }

    // MARK: Chats

    static func liveChats() async throws -> [RemoteLiveChat] {
        try await decode(LenientArray<RemoteLiveChat>.self, "pi-desktop:remote:live-chats").items
    }

    static func chatId(forSession sessionPath: String) async throws -> String? {
        try await call("pi-desktop:chat:id-for-session", ["sessionPath": .string(sessionPath)]).stringValue
    }

    static func openChat(chatId: String, cwd: String? = nil, sessionPath: String? = nil) async throws -> ChatOpenResult {
        var arg: [String: JSONValue] = ["chatId": .string(chatId)]
        if let cwd { arg["cwd"] = .string(cwd) }
        if let sessionPath { arg["sessionPath"] = .string(sessionPath) }
        return ChatOpenResult(json: try await call("pi-desktop:chat:open", merged(arg, lite), timeout: openTimeout))
    }

    /// State and catalog of a chat that is already open on the computer.
    static func refreshChat(_ chatId: String, withMessages: Bool = false) async throws -> ChatOpenResult {
        let arg: [String: JSONValue] = ["chatId": .string(chatId)]
        return ChatOpenResult(json: try await call("pi-desktop:chat:refresh", withMessages ? .object(arg) : merged(arg, lite), timeout: openTimeout))
    }

    static func reloadChat(_ chatId: String) async throws -> ChatOpenResult {
        ChatOpenResult(json: try await call("pi-desktop:chat:reload", merged(["chatId": .string(chatId)], lite), timeout: openTimeout))
    }

    static func setCwd(_ chatId: String, _ cwd: String) async throws -> ChatOpenResult {
        ChatOpenResult(json: try await call("pi-desktop:chat:set-cwd", merged(["chatId": .string(chatId), "cwd": .string(cwd)], lite), timeout: openTimeout))
    }

    /// The newest `limit` messages, or the `limit` before branch index `before`.
    static func transcript(_ sessionPath: String, limit: Int, before: Int? = nil) async throws -> ChatTranscriptResult {
        let arg = JSONValue.compact(["sessionPath": .string(sessionPath), "limit": .int(limit), "before": before.map(JSONValue.int)])
        return ChatTranscriptResult(json: try await call("pi-desktop:chat:transcript", arg, timeout: 60))
    }

    static func exportHtml(_ sessionPath: String) async throws -> String {
        try await call("pi-desktop:remote:export-html", ["sessionPath": .string(sessionPath)], timeout: openTimeout)["html"]?.stringValue ?? ""
    }

    static func send(chatId: String, message: String, images: [ImageContent]?, mode: ChatSendMode) async throws {
        let arg = JSONValue.compact([
            "chatId": .string(chatId),
            "message": .string(message),
            "images": images.map { .array($0.map(\.json)) },
            "mode": .string(mode.rawValue)
        ])
        _ = try await call("pi-desktop:chat:send", arg, timeout: openTimeout)
    }

    static func abort(_ chatId: String) async throws { _ = try await call("pi-desktop:chat:abort", ["chatId": .string(chatId)]) }

    static func bash(_ chatId: String, _ command: String) async throws -> ChatBashResult {
        try await decode("pi-desktop:chat:bash", ["chatId": .string(chatId), "command": .string(command)], timeout: 24 * 60 * 60)
    }

    static func abortBash(_ chatId: String) async throws { _ = try await call("pi-desktop:chat:abort-bash", ["chatId": .string(chatId)]) }

    static func clearQueue(_ chatId: String) async throws -> MessageQueue {
        let result = try await call("pi-desktop:chat:clear-queue", ["chatId": .string(chatId)])
        return MessageQueue(
            steering: (result["steering"]?.arrayValue ?? []).compactMap(\.stringValue),
            followUp: (result["followUp"]?.arrayValue ?? []).compactMap(\.stringValue)
        )
    }

    static func setModel(_ chatId: String, provider: String, modelId: String) async throws -> SetModelResult {
        SetModelResult(json: try await call("pi-desktop:chat:set-model", ["chatId": .string(chatId), "provider": .string(provider), "modelId": .string(modelId)]))
    }

    static func setThinkingLevel(_ chatId: String, _ level: ThinkingLevel) async throws {
        _ = try await call("pi-desktop:chat:set-thinking-level", ["chatId": .string(chatId), "level": .string(level.rawValue)])
    }

    static func stats(_ chatId: String) async throws -> ChatSessionStats? {
        ChatSessionStats(json: try await call("pi-desktop:chat:get-stats", ["chatId": .string(chatId)]))
    }

    static func compact(_ chatId: String, instructions: String?) async throws {
        let arg = JSONValue.compact(["chatId": .string(chatId), "customInstructions": instructions.map(JSONValue.string)])
        _ = try await call("pi-desktop:chat:compact", arg, timeout: longTimeout)
    }

    static func setSessionName(_ chatId: String, _ name: String) async throws {
        _ = try await call("pi-desktop:chat:set-session-name", ["chatId": .string(chatId), "name": .string(name)])
    }

    static func forkMessages(_ chatId: String) async throws -> [ForkMessage] {
        let value = try await call("pi-desktop:chat:get-fork-messages", ["chatId": .string(chatId)])
        return (try? (value["messages"] ?? .array([])).decode(LenientArray<ForkMessage>.self).items) ?? []
    }

    static func fork(_ chatId: String, entryId: String) async throws -> (text: String?, cancelled: Bool) {
        let result = try await call("pi-desktop:chat:fork", ["chatId": .string(chatId), "entryId": .string(entryId)])
        return (result["text"]?.stringValue, result["cancelled"]?.isTrue ?? false)
    }

    static func clone(_ chatId: String) async throws -> Bool {
        try await call("pi-desktop:chat:clone", ["chatId": .string(chatId)])["cancelled"]?.isTrue ?? false
    }

    static func tree(_ chatId: String) async throws -> PiTreeResult {
        PiTreeResult(json: try await call("pi-desktop:chat:get-tree", ["chatId": .string(chatId)]))
    }

    static func lastAssistantText(_ chatId: String) async throws -> String? {
        try await call("pi-desktop:chat:last-assistant-text", ["chatId": .string(chatId)])["text"]?.stringValue
    }

    static func respondUi(chatId: String, id: String, value: String? = nil, confirmed: Bool? = nil, cancelled: Bool? = nil) async throws {
        let arg = JSONValue.compact([
            "chatId": .string(chatId),
            "id": .string(id),
            "value": value.map(JSONValue.string),
            "confirmed": confirmed.map(JSONValue.bool),
            "cancelled": cancelled.map(JSONValue.bool)
        ])
        _ = try await call("pi-desktop:chat:respond-ui", arg)
    }

    // MARK: Checkpoints

    static func createCheckpoint(_ cwd: String) async throws -> String? {
        try await call("pi-desktop:checkpoints:create", ["cwd": .string(cwd)]).stringValue
    }

    static func restoreCheckpoint(_ cwd: String, _ checkpoint: String) async throws -> CheckpointRestoreResult {
        try await decode("pi-desktop:checkpoints:restore", ["cwd": .string(cwd), "checkpoint": .string(checkpoint)])
    }

    // MARK: Side chats

    static func openSide(sideId: String, cwd: String, sessionPath: String?, model: SideModelInput?) async throws {
        let arg = JSONValue.compact([
            "sideId": .string(sideId),
            "cwd": .string(cwd),
            "sessionPath": sessionPath.map(JSONValue.string),
            "model": model?.json
        ])
        _ = try await call("pi-desktop:side:open", arg, timeout: openTimeout)
    }

    static func sendSide(_ sideId: String, _ message: String) async throws {
        _ = try await call("pi-desktop:side:send", ["sideId": .string(sideId), "message": .string(message)], timeout: openTimeout)
    }

    static func abortSide(_ sideId: String) async throws { _ = try await call("pi-desktop:side:abort", ["sideId": .string(sideId)]) }
    static func closeSide(_ sideId: String) async throws { _ = try await call("pi-desktop:side:close", ["sideId": .string(sideId)]) }

    // MARK: Diff

    static func diffStatus(_ cwd: String) async throws -> RepoDiffResult {
        RepoDiffResult(json: try await call("pi-desktop:diff:status", ["cwd": .string(cwd)], timeout: 60))
    }

    static func diffSummary(_ cwd: String) async throws -> RepoSummary {
        try await decode("pi-desktop:diff:summary", ["cwd": .string(cwd)])
    }

    static func discard(_ cwd: String, _ path: String) async throws -> GitActionResult {
        try await decode("pi-desktop:diff:discard", ["cwd": .string(cwd), "path": .string(path)])
    }

    static func commit(_ cwd: String, _ message: String) async throws -> GitActionResult {
        try await decode("pi-desktop:diff:commit", ["cwd": .string(cwd), "message": .string(message)], timeout: 60)
    }

    static func push(_ cwd: String) async throws -> GitActionResult {
        try await decode("pi-desktop:diff:push", ["cwd": .string(cwd)], timeout: 120)
    }

    /// nil when pi's reply was not a list of comments.
    static func review(_ cwd: String, model: SideModelInput?) async throws -> [PiReviewComment]? {
        let value = try await call("pi-desktop:diff:review", .compact(["cwd": .string(cwd), "model": model?.json]), timeout: longTimeout)
        guard let items = value.arrayValue else { return nil }
        return items.compactMap(PiReviewComment.init(json:))
    }

    static func postComments(_ cwd: String, _ comments: [PrCommentInput]) async throws -> PrReviewPosted {
        try await decode("pi-desktop:diff:post-comments", ["cwd": .string(cwd), "comments": .array(comments.map(\.json))], timeout: 120)
    }

    // MARK: Review comments (kept on the computer, shared by every screen)

    static func reviewComments(_ cwd: String) async throws -> [ReviewComment] {
        ReviewComment.list(try await call("pi-desktop:review-comments:list", ["cwd": .string(cwd)]))
    }

    static func addReviewComment(_ cwd: String, path: String, line: Int?, lineText: String, text: String) async throws -> ReviewComment? {
        let arg = JSONValue.compact([
            "cwd": .string(cwd),
            "path": .string(path),
            "line": line.map(JSONValue.int),
            "lineText": .string(lineText),
            "text": .string(text)
        ])
        return ReviewComment(json: try await call("pi-desktop:review-comments:add", arg))
    }

    static func removeReviewComments(_ cwd: String, ids: [String]) async throws -> [ReviewComment] {
        ReviewComment.list(try await call("pi-desktop:review-comments:remove", ["cwd": .string(cwd), "ids": .array(ids.map(JSONValue.string))]))
    }

    // MARK: Pull requests

    static func prStatus(_ cwd: String) async throws -> PrStatus {
        PrStatus(json: try await call("pi-desktop:pr:status", ["cwd": .string(cwd)], timeout: 60))
    }

    static func failedLog(_ cwd: String, runId: String) async throws -> String {
        try await call("pi-desktop:pr:failed-log", ["cwd": .string(cwd), "runId": .string(runId)], timeout: 60).stringValue ?? ""
    }

    // MARK: Automations

    static func automations() async throws -> [Automation] {
        (try await call("pi-desktop:automations:list").arrayValue ?? []).compactMap(Automation.init(json:))
    }

    static func saveAutomation(_ input: AutomationInput) async throws {
        _ = try await call("pi-desktop:automations:save", input.json)
    }

    static func deleteAutomation(_ id: String) async throws { _ = try await call("pi-desktop:automations:delete", ["id": .string(id)]) }
    static func runAutomation(_ id: String) async throws { _ = try await call("pi-desktop:automations:run-now", ["id": .string(id)]) }

    // MARK: Computer use

    static func cuaPermissions() async throws -> CuaPermissions { try await decode("pi-desktop:cua:permissions") }
    static func cuaPause() async throws { _ = try await call("pi-desktop:cua:pause") }
    static func cuaResume() async throws { _ = try await call("pi-desktop:cua:resume") }
    static func cuaStop() async throws { _ = try await call("pi-desktop:cua:stop") }

    static func setComputerUse(_ enabled: Bool) async throws {
        _ = try await call("pi-desktop:remote:set-computer-use", ["enabled": .bool(enabled)])
    }
}

@MainActor
private func decode<T: Decodable>(_ type: T.Type, _ channel: String, _ arg: JSONValue? = nil) async throws -> T {
    try await decode(channel, arg)
}

/// The error's text without Electron's IPC prefix.
func errorText(_ error: Error) -> String {
    let message = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
    return message.replacingOccurrences(
        of: "^Error invoking remote method [^:]+: (Error: )?",
        with: "",
        options: .regularExpression
    )
}
