import Foundation
import Observation
import PiRemoteKit
import UIKit

/// Text the composer takes over (the nonce bumps each time).
struct ComposerSeed: Equatable {
    var text: String
    var nonce: Int
}

struct CuaActivityState: Equatable {
    var app: String?
    var summary: String
    var phase: String
}

/// One chat as the phone knows it. Observed per chat, so a streaming chat
/// only re-renders its own screen.
@MainActor
@Observable
final class ChatModel: Identifiable {
    nonisolated let chatId: String
    nonisolated var id: String { chatId }

    var view = ChatViewState()
    var sessionPath: String?
    var cwd: String
    var title: String
    var model: Model?
    var thinkingLevel: ThinkingLevel?
    var availableThinkingLevels: [ThinkingLevel] = []
    var models: [Model] = []
    var commands: [PiCommandInfo] = []
    var stats: ChatSessionStats?
    var error: String?
    var stderrTail: [String]?
    var uiRequest: ExtensionUiRequest?
    var composerSeed: ComposerSeed?
    /// pi answered its first requests; false while the process is starting.
    var piReady = false
    var startedAt: Double?
    var startupHint: String?
    /// The session file has more messages than are loaded.
    var hasEarlier = false
    var transcriptLimit: Int?
    /// Branch index of the oldest loaded message: where "load earlier" continues.
    var transcriptStart: Int?
    var transcriptError: String?
    var transcriptApplied = false
    /// A run finished while this chat was not on screen.
    var unread = false
    var cuaActivity: CuaActivityState?
    var cuaActive = false
    var cuaPaused = false
    var bashRunning = false
    /// Events may have been missed: re-read before it is shown again.
    @ObservationIgnored var stale = false

    init(chatId: String, cwd: String, sessionPath: String?, title: String) {
        self.chatId = chatId
        self.cwd = cwd
        self.sessionPath = sessionPath
        self.title = title
    }

    var status: ChatStatus {
        get { view.status }
        set { view.status = newValue }
    }

    var streaming: Bool { view.status == .streaming }
}

/**
 * Open chats: bringing one up (transcript from the session file first, then
 * pi's state), streaming events into it, sending, and catching up after a
 * dropped link without waking a sleeping pi (mobile/src/state/chats.ts).
 */
@MainActor
@Observable
final class ChatStore {
    static let shared = ChatStore()

    private(set) var chats: [String: ChatModel] = [:]

    /// Messages read from the session file when a chat opens / per "Load earlier".
    private static let transcriptPage = 80
    /// Chats whose token stream stays subscribed (most recently opened first).
    private static let maxSubscribed = 12
    /// Chats kept in memory; older idle ones are dropped and reopen from the list.
    private static let maxOpen = 16
    private static let checkpointTimeout: Double = 4
    private static let flushInterval: Double = 0.05
    private static let backgroundFlushInterval: Double = 0.25
    private static let cuaTail: Double = 4

    @ObservationIgnored private var pendingEvents: [String: [PiEvent]] = [:]
    @ObservationIgnored private var openOrder: [String] = []
    @ObservationIgnored private var cuaTails: [String: Task<Void, Never>] = [:]
    @ObservationIgnored private var opening: [String: Task<String, Error>] = [:]
    @ObservationIgnored private var flushTask: Task<Void, Never>?
    @ObservationIgnored private var lastFlushAt = Date.distantPast
    @ObservationIgnored private var statsTask: Task<Void, Never>?
    @ObservationIgnored private var statsDirty = Set<String>()
    @ObservationIgnored private(set) var visibleChatId: String?
    @ObservationIgnored private var optimisticCounter = 0
    @ObservationIgnored private var seedCounter = 0
    @ObservationIgnored private var wired = false
    /// Offers to open a chat that finished off screen.
    @ObservationIgnored var openChatHandler: ((String) -> Void)?

    private init() {}

    func chat(_ chatId: String) -> ChatModel? { chats[chatId] }

    private func nextSeed(_ text: String) -> ComposerSeed {
        seedCounter += 1
        return ComposerSeed(text: text, nonce: seedCounter)
    }

    // MARK: Subscriptions and memory

    private func touchSubscription(_ chatId: String) {
        openOrder.removeAll { $0 == chatId }
        openOrder.insert(chatId, at: 0)
        // A long day opens many chats: let go of the oldest that are at rest.
        var index = openOrder.count - 1
        while index >= Self.maxOpen {
            let id = openOrder[index]
            if let old = chats[id], old.streaming || old.unread || old.bashRunning || old.chatId == visibleChatId {
                index -= 1
                continue
            }
            openOrder.remove(at: index)
            chats[id] = nil
            pendingEvents[id] = nil
            index -= 1
        }
        // Past the window a chat only hears that runs start and settle.
        for id in openOrder.dropFirst(Self.maxSubscribed) { chats[id]?.stale = true }
        Connection.shared.subscribeChats(Array(openOrder.prefix(Self.maxSubscribed)))
        if chats[chatId]?.stale == true {
            Task { await resync(chatId) }
        }
    }

    private func titleOf(_ messages: [DisplayMessage]) -> String? {
        guard let first = messages.lazy.compactMap(\.user).first, !first.text.trimmed.isEmpty else { return nil }
        return titleFromUserText(first.text).map { String(collapseWhitespace($0).prefix(80)) }
    }

    private func sessionTitle(_ sessionPath: String?) -> String? {
        DataStore.shared.session(sessionPath)?.title
    }

    private func clearQueuedFlags(_ chat: ChatModel) {
        for index in chat.view.messages.indices {
            if case .user(var user) = chat.view.messages[index], user.queued {
                user.queued = false
                chat.view.messages[index] = .user(user)
            }
        }
    }

    private func clearCua(_ chat: ChatModel) {
        cuaTails[chat.chatId]?.cancel()
        cuaTails[chat.chatId] = nil
        chat.cuaActive = false
    }

    // MARK: Event flushing

    private func flushPending() {
        flushTask = nil
        lastFlushAt = Date()
        let batches = pendingEvents
        pendingEvents.removeAll()
        for (chatId, events) in batches {
            guard let chat = chats[chatId] else { continue }
            var view = chat.view
            for event in events where view.reduce(event) {
                statsDirty.insert(chatId)
            }
            chat.view = view
            let settled = events.contains { $0.isAgentSettled }
            if settled || events.contains(where: { $0.isAgentEnd }) { clearCua(chat) }
            if settled && chat.status == .idle {
                if visibleChatId == chatId {
                    Haptic.success.play()
                } else {
                    chat.unread = true
                    let id = chatId
                    toast("\(chat.title.isEmpty ? "Chat" : chat.title) finished", action: ToastAction(label: "Open") { [weak self] in
                        self?.openChatHandler?(id)
                    })
                }
            }
        }
        if !statsDirty.isEmpty { scheduleStats() }
    }

    private func scheduleFlush() {
        guard flushTask == nil else { return }
        let interval = UIApplication.shared.applicationState == .active ? Self.flushInterval : Self.backgroundFlushInterval
        let wait = max(0, interval - Date().timeIntervalSince(lastFlushAt))
        flushTask = Task { [weak self] in
            if wait > 0 { try? await Task.sleep(nanoseconds: UInt64(wait * 1_000_000_000)) }
            self?.flushPending()
        }
    }

    private func scheduleStats() {
        statsTask?.cancel()
        statsTask = Task { [weak self] in
            try? await Task.sleep(nanoseconds: 200_000_000)
            guard let self, !Task.isCancelled else { return }
            // Only the chats that just ran: asking an idle chat for stats
            // would wake a pi process the computer had put to sleep.
            let dirty = self.statsDirty
            self.statsDirty.removeAll()
            for chatId in dirty {
                if let chat = self.chats[chatId], chat.piReady, chat.status == .idle || chat.status == .streaming {
                    await self.refreshStats(chatId)
                }
            }
        }
    }

    private func refreshStats(_ chatId: String) async {
        guard let stats = try? await API.stats(chatId), let chat = chats[chatId] else { return }
        chat.stats = stats
        if let file = stats.sessionFile, chat.sessionPath == nil { chat.sessionPath = file }
    }

    // MARK: Bringing chats up

    private func applyCatalog(_ chat: ChatModel, _ result: ChatOpenResult) {
        chat.piReady = true
        chat.error = nil
        chat.stderrTail = nil
        chat.startupHint = nil
        chat.model = result.state.model
        chat.thinkingLevel = result.state.thinkingLevel
        chat.availableThinkingLevels = result.thinkingLevels
        chat.models = result.models
        chat.commands = result.commands
        if !result.cwd.isEmpty { chat.cwd = result.cwd }
        chat.sessionPath = result.sessionPath ?? chat.sessionPath
        if result.state.isStreaming {
            chat.status = .streaming
            if chat.view.runStartedAt == nil { chat.view.runStartedAt = nowMs() }
        } else if chat.status == .starting || chat.status == .error || chat.status == .exited {
            chat.status = .idle
        }
        clearQueuedFlags(chat)
    }

    /**
     * Render the tail of the session file: instant, and independent of pi.
     * `authoritative` is for catching up after missed events.
     */
    private func applyTranscript(_ chatId: String, _ sessionPath: String, limit: Int, authoritative: Bool = false) async throws {
        let transcript = try await API.transcript(sessionPath, limit: limit)
        guard let chat = chats[chatId] else { return }
        let built = ChatViewState.build(transcript.messages)
        if authoritative {
            pendingEvents[chatId] = nil
            chat.view.messages = built.messages
            chat.view.toolRuns = built.toolRuns
        } else {
            // A message pi is streaming right now is not in the file yet: keep it.
            if case .assistant(let last)? = chat.view.messages.last, last.streaming {
                chat.view.messages = built.messages + [.assistant(last)]
            } else {
                chat.view.messages = built.messages
            }
            chat.view.toolRuns = built.toolRuns.merging(chat.view.toolRuns) { $1 }
        }
        chat.hasEarlier = transcript.hasEarlier
        chat.transcriptLimit = max(limit, transcript.messages.count)
        chat.transcriptStart = transcript.startIndex
        chat.transcriptApplied = true
        chat.transcriptError = nil
        chat.title = sessionTitle(sessionPath) ?? titleOf(built.messages) ?? chat.title
    }

    /// Read the transcript; a failure is kept on the chat for a retry.
    private func loadTranscript(_ chatId: String, _ sessionPath: String, limit: Int) {
        Task {
            do {
                try await applyTranscript(chatId, sessionPath, limit: limit)
            } catch {
                if let chat = chats[chatId], !chat.transcriptApplied { chat.transcriptError = errorText(error) }
            }
        }
    }

    /// What the computer says about a chat right now.
    private func applyLive(_ chat: ChatModel, _ live: RemoteLiveChat?) {
        chat.uiRequest = live?.uiRequest
        if live?.streaming == true {
            chat.status = .streaming
            if chat.view.runStartedAt == nil { chat.view.runStartedAt = nowMs() }
        } else if chat.status == .streaming {
            chat.status = .idle
            chat.view.runStartedAt = nil
            chat.view.queue = nil
        }
        if let path = live?.sessionPath, chat.sessionPath == nil { chat.sessionPath = path }
    }

    private func liveChat(_ chatId: String) async throws -> RemoteLiveChat? {
        try await DataStore.shared.refreshLive()
        return DataStore.shared.live[chatId]
    }

    /// Catch a chat up after events were missed, without waking its pi.
    private func resync(_ chatId: String) async {
        guard let chat = chats[chatId] else { return }
        chat.stale = false
        do {
            let live = try await liveChat(chatId)
            guard let current = chats[chatId] else { return }
            applyLive(current, live)
            if live == nil { clearCua(current) }
            if let path = current.sessionPath {
                try await applyTranscript(chatId, path, limit: current.transcriptLimit ?? Self.transcriptPage, authoritative: true)
            }
        } catch {
            chats[chatId]?.stale = true // offline again: try when it is next shown
        }
    }

    @discardableResult
    private func createChat(_ chatId: String, cwd: String?, sessionPath: String?) -> ChatModel {
        let chat = ChatModel(chatId: chatId, cwd: cwd ?? "", sessionPath: sessionPath, title: sessionTitle(sessionPath) ?? "New chat")
        chat.status = .starting
        chat.startedAt = nowMs()
        chats[chatId] = chat
        touchSubscription(chatId)
        return chat
    }

    /// Bring a chat up: the session file's tail first, then pi's state.
    private func bringUp(_ chatId: String, cwd: String? = nil, sessionPath: String? = nil, live: Bool = false) async {
        guard let chat = chats[chatId] else { return }
        if !(chat.view.messages.count > 0 && chat.piReady) { chat.status = .starting }
        chat.error = nil
        chat.startedAt = nowMs()
        if let sessionPath { loadTranscript(chatId, sessionPath, limit: chat.transcriptLimit ?? Self.transcriptPage) }
        // Last-known models and commands, so the composer works while pi starts.
        Task {
            guard let catalog = try? await API.catalog(), let current = chats[chatId], !current.piReady else { return }
            current.models = catalog.models
            current.commands = catalog.commands
            current.availableThinkingLevels = catalog.thinkingLevels
            current.model = catalog.model ?? current.model
            current.thinkingLevel = catalog.thinkingLevel ?? current.thinkingLevel
        }
        let result: ChatOpenResult
        do {
            if live {
                do {
                    result = try await API.refreshChat(chatId)
                } catch {
                    // It stopped in the meantime: start it under the same id.
                    result = try await API.openChat(chatId: chatId, cwd: cwd, sessionPath: sessionPath)
                }
            } else {
                result = try await API.openChat(chatId: chatId, cwd: cwd, sessionPath: sessionPath)
            }
        } catch {
            if let current = chats[chatId] {
                current.status = .error
                current.error = errorText(error)
            }
            return
        }
        guard let current = chats[chatId] else { return }
        applyCatalog(current, result)
        // A chat joined by id alone learns its session file from pi.
        if !current.transcriptApplied, let path = current.sessionPath, live || sessionPath != nil {
            loadTranscript(chatId, path, limit: Self.transcriptPage)
        }
        // A live chat with no session file to read: take its messages from pi.
        if live && current.sessionPath == nil && current.view.messages.isEmpty {
            Task {
                guard let full = try? await API.refreshChat(chatId, withMessages: true), let joined = chats[chatId],
                    joined.view.messages.isEmpty, !full.messages.isEmpty
                else { return }
                let built = ChatViewState.build(full.messages)
                joined.view.messages = built.messages
                joined.view.toolRuns = built.toolRuns.merging(joined.view.toolRuns) { $1 }
                joined.title = titleOf(built.messages) ?? joined.title
            }
        }
        Task { await refreshStats(chatId) }
        // A question pi asked before this phone opened the chat.
        if live {
            Task {
                guard let liveChat = try? await liveChat(chatId), let joined = chats[chatId],
                    let request = liveChat.uiRequest, joined.uiRequest == nil
                else { return }
                joined.uiRequest = request
            }
        }
    }

    /// Run a chat request; if the computer no longer runs this chat, reopen it once.
    private func withRevive<T>(_ chatId: String, _ run: () async throws -> T) async throws -> T {
        do {
            return try await run()
        } catch {
            guard let chat = chats[chatId], errorText(error).contains("No running pi process") else { throw error }
            let result = try await API.openChat(
                chatId: chatId,
                cwd: chat.sessionPath == nil ? chat.cwd : nil,
                sessionPath: chat.sessionPath
            )
            applyCatalog(chat, result)
            return try await run()
        }
    }

    private func takeCheckpoint(_ cwd: String) async -> String? {
        guard !cwd.isEmpty else { return nil }
        return await withTaskGroup(of: String?.self) { group in
            group.addTask { @MainActor in try? await API.createCheckpoint(cwd) }
            group.addTask {
                try? await Task.sleep(nanoseconds: UInt64(Self.checkpointTimeout * 1_000_000_000))
                return nil
            }
            let first = await group.next() ?? nil
            group.cancelAll()
            return first
        }
    }

    // MARK: Opening

    /// Open (or join) the chat for a session file; resolves to its chat id.
    func openSession(_ sessionPath: String) async throws -> String {
        if let chat = chats.values.first(where: { $0.sessionPath == sessionPath }) {
            touchSubscription(chat.chatId)
            if chat.status == .error || chat.status == .exited {
                Task { await bringUp(chat.chatId, sessionPath: sessionPath) }
            }
            return chat.chatId
        }
        // A second tap while the first is still asking the computer.
        if let pending = opening[sessionPath] { return try await pending.value }
        let task = Task<String, Error> {
            // The computer (or its window) may already run this session: join it.
            let liveId = try? await API.chatId(forSession: sessionPath)
            let chatId = liveId ?? UUID().uuidString.lowercased()
            if chats[chatId] == nil {
                createChat(chatId, cwd: nil, sessionPath: sessionPath)
                Task { await bringUp(chatId, sessionPath: sessionPath, live: liveId != nil) }
            }
            return chatId
        }
        opening[sessionPath] = task
        defer { opening[sessionPath] = nil }
        return try await task.value
    }

    /// Join a chat that is live on the computer (it may have no session file yet).
    func joinLive(_ chatId: String, cwd: String, sessionPath: String?) -> String {
        if chats[chatId] == nil {
            createChat(chatId, cwd: cwd, sessionPath: sessionPath)
            Task { await bringUp(chatId, cwd: cwd, sessionPath: sessionPath, live: true) }
        } else {
            touchSubscription(chatId)
        }
        return chatId
    }

    /// Start a draft chat in a project folder.
    func newChat(_ cwd: String) -> String {
        let chatId = UUID().uuidString.lowercased()
        createChat(chatId, cwd: cwd, sessionPath: nil)
        Task { await bringUp(chatId, cwd: cwd) }
        return chatId
    }

    func retryOpen(_ chatId: String) {
        guard let chat = chats[chatId] else { return }
        let path = chat.sessionPath
        let cwd = chat.cwd
        Task { await bringUp(chatId, cwd: path == nil ? cwd : nil, sessionPath: path) }
    }

    // MARK: Sending

    func send(_ chatId: String, message: String, images: [ImageContent]?, mode: ChatSendMode) async throws {
        guard let chat = chats[chatId] else { throw RemoteMessageError("Chat is not open") }
        // Sent mid-run: it waits in pi's queue (the strip above the composer).
        if chat.streaming && (mode == .steer || mode == .followUp) {
            var queue = chat.view.queue ?? MessageQueue()
            if mode == .steer { queue.steering.append(message) } else { queue.followUp.append(message) }
            chat.view.queue = queue
            do {
                try await API.send(chatId: chatId, message: message, images: images, mode: mode)
            } catch {
                // It never reached pi's queue: take it off the strip, give it back.
                if let current = chats[chatId], var queue = current.view.queue {
                    if let at = queue.steering.lastIndex(of: message) {
                        queue.steering.remove(at: at)
                    } else if let at = queue.followUp.lastIndex(of: message) {
                        queue.followUp.remove(at: at)
                    }
                    current.view.queue = queue.count == 0 ? nil : queue
                    current.composerSeed = nextSeed(message)
                }
                throw error
            }
            return
        }
        optimisticCounter += 1
        let key = "local-\(optimisticCounter)"
        chat.view.messages.append(
            .user(UserDisplay(key: key, text: message, images: images ?? [], queued: !chat.piReady, timestamp: nowMs()))
        )
        if chat.title == "New chat" && !message.trimmed.isEmpty {
            chat.title = titleFromUserText(message).map { String(collapseWhitespace($0).prefix(80)) } ?? chat.title
        }
        if !chat.streaming { chat.view.runStartedAt = nowMs() }
        chat.status = chat.piReady ? .streaming : .starting
        chat.error = nil
        // Snapshot the project before pi can touch it, so this prompt's
        // changes can be undone. Skipped while pi starts and outside git.
        if mode == .prompt && chat.piReady {
            if let checkpoint = await takeCheckpoint(chat.cwd), let current = chats[chatId],
                let index = current.view.messages.firstIndex(where: { $0.key == key }),
                case .user(var row) = current.view.messages[index]
            {
                row.checkpoint = checkpoint
                current.view.messages[index] = .user(row)
            }
        }
        do {
            try await withRevive(chatId) { try await API.send(chatId: chatId, message: message, images: images, mode: mode) }
        } catch {
            // Nothing reached pi: take the prompt back out and hand its text
            // back to the message box instead of losing it.
            if let current = chats[chatId] {
                current.view.messages.removeAll { $0.key == key }
                if current.streaming {
                    current.status = .idle
                    current.view.runStartedAt = nil
                }
                current.composerSeed = nextSeed(message)
            }
            throw error
        }
    }

    func abort(_ chatId: String) async throws {
        if let chat = chats[chatId] { clearCua(chat) }
        try await API.abort(chatId)
    }

    func runBash(_ chatId: String, command: String) async {
        guard let chat = chats[chatId], !chat.bashRunning else { return }
        optimisticCounter += 1
        let key = "local-bash-\(optimisticCounter)"
        chat.view.messages.append(.bash(BashDisplay(key: key, command: command, output: "", running: true, timestamp: nowMs())))
        chat.bashRunning = true
        func settle(output: String, exitCode: Int?, cancelled: Bool) {
            guard let current = chats[chatId] else { return }
            current.bashRunning = false
            if let index = current.view.messages.firstIndex(where: { $0.key == key }), case .bash(var row) = current.view.messages[index] {
                row.output = output
                row.exitCode = exitCode
                row.cancelled = cancelled
                row.running = false
                current.view.messages[index] = .bash(row)
            }
        }
        do {
            let result = try await withRevive(chatId) { try await API.bash(chatId, command) }
            settle(output: result.output, exitCode: result.exitCode, cancelled: result.cancelled)
        } catch {
            settle(output: errorText(error), exitCode: 1, cancelled: false)
        }
    }

    func abortBash(_ chatId: String) async {
        try? await API.abortBash(chatId)
    }

    func clearQueue(_ chatId: String) async {
        guard let chat = chats[chatId] else { return }
        let local = chat.view.queue
        let result = try? await API.clearQueue(chatId)
        guard let current = chats[chatId] else { return }
        current.view.queue = nil
        let texts = result.map { $0.steering + $0.followUp } ?? ((local?.steering ?? []) + (local?.followUp ?? []))
        if !texts.isEmpty { current.composerSeed = nextSeed(texts.joined(separator: "\n\n")) }
    }

    // MARK: Chat actions

    func setModel(_ chatId: String, provider: String, modelId: String) async throws {
        let result = try await withRevive(chatId) { try await API.setModel(chatId, provider: provider, modelId: modelId) }
        guard let chat = chats[chatId] else { return }
        chat.model = result.model ?? chat.models.first { $0.provider == provider && $0.id == modelId } ?? chat.model
        chat.thinkingLevel = result.thinkingLevel ?? chat.thinkingLevel
        chat.availableThinkingLevels = result.thinkingLevels
    }

    func setThinkingLevel(_ chatId: String, _ level: ThinkingLevel) async throws {
        try await withRevive(chatId) { try await API.setThinkingLevel(chatId, level) }
        chats[chatId]?.thinkingLevel = level
    }

    /// Re-read state and messages from pi (after fork / clone / compact).
    func refresh(_ chatId: String) async throws {
        guard chats[chatId] != nil else { return }
        let result = try await withRevive(chatId) { try await API.refreshChat(chatId, withMessages: true) }
        guard let chat = chats[chatId] else { return }
        let built = ChatViewState.build(result.messages)
        chat.view = built
        chat.stats = nil
        chat.uiRequest = nil
        applyCatalog(chat, result)
        chat.status = result.state.isStreaming ? .streaming : .idle
        chat.hasEarlier = false
        chat.transcriptLimit = nil
        chat.transcriptStart = nil
        chat.title = titleOf(built.messages) ?? chat.title
        Task { await refreshStats(chatId) }
    }

    func retryTranscript(_ chatId: String) {
        guard let chat = chats[chatId], let path = chat.sessionPath else { return }
        chat.transcriptError = nil
        loadTranscript(chatId, path, limit: chat.transcriptLimit ?? Self.transcriptPage)
    }

    func loadEarlier(_ chatId: String) async throws {
        guard let chat = chats[chatId], let sessionPath = chat.sessionPath else { return }
        if let start = chat.transcriptStart, start > 0 {
            // Only the page before what is loaded travels.
            let page = try await API.transcript(sessionPath, limit: Self.transcriptPage * 2, before: start)
            guard let current = chats[chatId], current.sessionPath == sessionPath, current.transcriptStart == start else { return }
            let built = ChatViewState.build(page.messages)
            current.view.messages = built.messages + current.view.messages
            current.view.toolRuns = built.toolRuns.merging(current.view.toolRuns) { $1 }
            current.hasEarlier = page.hasEarlier
            current.transcriptStart = page.startIndex ?? 0
            current.transcriptLimit = (current.transcriptLimit ?? 0) + page.messages.count
            return
        }
        // A computer that cannot page: a bigger window from the end.
        try await applyTranscript(chatId, sessionPath, limit: (chat.transcriptLimit ?? Self.transcriptPage) + Self.transcriptPage * 2)
    }

    @discardableResult
    func forkAtEntry(_ chatId: String, entryId: String) async throws -> String? {
        let result = try await withRevive(chatId) { try await API.fork(chatId, entryId: entryId) }
        if result.cancelled { return nil }
        try await refresh(chatId)
        if let text = result.text, let chat = chats[chatId] { chat.composerSeed = nextSeed(text) }
        return result.text
    }

    @discardableResult
    func forkFromUserMessage(_ chatId: String, userIndex: Int) async throws -> String? {
        let messages = try await withRevive(chatId) { try await API.forkMessages(chatId) }
        // The loaded window may start mid-session: count user messages from the end.
        let loaded = chats[chatId]?.view.messages.filter { $0.user != nil }.count ?? 0
        let index = messages.count - (loaded - userIndex)
        guard messages.indices.contains(index) else { return nil }
        return try await forkAtEntry(chatId, entryId: messages[index].entryId)
    }

    func retryFromUserMessage(_ chatId: String, userIndex: Int) async throws {
        let users = chats[chatId]?.view.messages.compactMap(\.user) ?? []
        guard users.indices.contains(userIndex) else { return }
        let user = users[userIndex]
        guard try await forkFromUserMessage(chatId, userIndex: userIndex) != nil else { return }
        if let chat = chats[chatId], chat.composerSeed != nil { chat.composerSeed = nextSeed("") }
        try await send(chatId, message: user.text, images: user.images.isEmpty ? nil : user.images, mode: .prompt)
    }

    func reloadChat(_ chatId: String) async throws {
        let result = try await API.reloadChat(chatId)
        guard let chat = chats[chatId] else { return }
        applyCatalog(chat, result)
        chat.status = result.state.isStreaming ? .streaming : .idle
    }

    func cloneChat(_ chatId: String) async throws {
        let cancelled = try await withRevive(chatId) { try await API.clone(chatId) }
        if !cancelled { try await refresh(chatId) }
    }

    func compact(_ chatId: String, instructions: String?) async throws {
        try await withRevive(chatId) { try await API.compact(chatId, instructions: instructions) }
    }

    func rename(_ chatId: String, _ name: String) async throws {
        try await withRevive(chatId) { try await API.setSessionName(chatId, name) }
        chats[chatId]?.title = name
    }

    func seedComposer(_ chatId: String, _ text: String) {
        chats[chatId]?.composerSeed = nextSeed(text)
    }

    /// The chat on screen (nil when none): drives unread marks.
    func setVisible(_ chatId: String?) {
        visibleChatId = chatId
        guard let chatId, let chat = chats[chatId] else { return }
        touchSubscription(chatId)
        chat.unread = false
    }

    func respondUi(_ chatId: String, id: String, value: String? = nil, confirmed: Bool? = nil, cancelled: Bool? = nil) {
        chats[chatId]?.uiRequest = nil
        Task {
            do {
                try await API.respondUi(chatId: chatId, id: id, value: value, confirmed: confirmed, cancelled: cancelled)
            } catch {
                toast(errorText(error))
            }
        }
    }

    // MARK: Wiring

    /// Route the computer's chat broadcasts into the chats. Once, at launch.
    func wire() {
        guard !wired else { return }
        wired = true
        let connection = Connection.shared

        connection.on(RemoteEvent.chatEvent) { [weak self] payload in
            guard let self, let chatId = payload["chatId"]?.stringValue, self.chats[chatId] != nil else { return }
            let events = (payload["events"]?.arrayValue ?? []).map(PiEvent.init(json:))
            self.pendingEvents[chatId, default: []].append(contentsOf: events)
            self.scheduleFlush()
        }

        connection.on(RemoteEvent.chatReady) { [weak self] payload in
            let ready = ChatReadyPayload(json: payload)
            guard let self, let chat = self.chats[ready.chatId] else { return }
            chat.piReady = true
            chat.models = ready.models
            chat.commands = ready.commands
            chat.model = ready.state.model ?? chat.model
            chat.thinkingLevel = ready.state.thinkingLevel ?? chat.thinkingLevel
            chat.availableThinkingLevels = ready.thinkingLevels
            if let path = ready.sessionPath, chat.sessionPath == nil { chat.sessionPath = path }
            chat.startupHint = nil
            if chat.status == .starting { chat.status = ready.state.isStreaming ? .streaming : .idle }
            self.clearQueuedFlags(chat)
        }

        connection.on(RemoteEvent.chatHint) { [weak self] payload in
            guard let self, let chatId = payload["chatId"]?.stringValue, let chat = self.chats[chatId], !chat.piReady else { return }
            chat.startupHint = payload["hint"]?.stringValue
        }

        connection.on(RemoteEvent.chatUiRequest) { [weak self] payload in
            guard let self, let chatId = payload["chatId"]?.stringValue, let chat = self.chats[chatId],
                let request = payload["request"].flatMap(ExtensionUiRequest.init(json:))
            else { return }
            chat.uiRequest = request
            // pi is blocked until someone answers: say so wherever the user is.
            if request.isInteractive {
                Haptic.warning.play()
                if self.visibleChatId != chatId {
                    toast("pi needs you: \(request.title ?? chat.title)", action: ToastAction(label: "Open") { [weak self] in
                        self?.openChatHandler?(chatId)
                    })
                }
            }
        }

        connection.onUnpair { [weak self] in
            guard let self else { return }
            self.chats.removeAll()
            self.pendingEvents.removeAll()
            self.openOrder.removeAll()
            self.visibleChatId = nil
        }

        connection.on(RemoteEvent.chatUiResolved) { [weak self] payload in
            guard let self, let chatId = payload["chatId"]?.stringValue, let chat = self.chats[chatId],
                chat.uiRequest?.id == payload["id"]?.stringValue
            else { return }
            chat.uiRequest = nil
        }

        connection.on(RemoteEvent.chatExit) { [weak self] payload in
            let exit = ChatExitPayload(json: payload)
            guard let self, let chat = self.chats[exit.chatId] else { return }
            chat.status = .exited
            chat.piReady = false
            chat.error = exit.code == 0 ? "The pi process exited." : "The pi process exited with code \(exit.code.map(String.init) ?? "?")."
            chat.stderrTail = exit.stderrTail.isEmpty ? nil : exit.stderrTail
        }

        connection.on(RemoteEvent.cuaActivity) { [weak self] payload in
            guard let self else { return }
            let activity = CuaActivity(json: payload)
            if activity.phase == "paused" || activity.phase == "resumed" {
                for chat in self.chats.values { chat.cuaPaused = activity.phase == "paused" }
                return
            }
            guard let chatId = activity.chatId, let chat = self.chats[chatId] else { return }
            chat.cuaActivity = CuaActivityState(app: activity.app, summary: activity.summary, phase: activity.phase)
            self.cuaTails[chatId]?.cancel()
            self.cuaTails[chatId] = nil
            if activity.phase == "start" {
                chat.cuaActive = true
            } else {
                self.cuaTails[chatId] = Task { [weak self] in
                    try? await Task.sleep(nanoseconds: UInt64(Self.cuaTail * 1_000_000_000))
                    guard !Task.isCancelled, let self else { return }
                    self.cuaTails[chatId] = nil
                    self.chats[chatId]?.cuaActive = false
                }
            }
        }

        // Back online: events were missed. The chat on screen and the ones
        // that were running catch up now; the rest when they are shown.
        var first = true
        connection.onOnline { [weak self] in
            guard let self else { return }
            if first {
                first = false
                return
            }
            connection.subscribeChats(Array(self.openOrder.prefix(Self.maxSubscribed)))
            for chat in self.chats.values {
                if chat.chatId == self.visibleChatId || chat.streaming || chat.uiRequest != nil {
                    Task { await self.resync(chat.chatId) }
                } else {
                    chat.stale = true
                }
            }
        }
    }
}
