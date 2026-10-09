import Foundation
import Observation
import PiRemoteKit

enum LiveState {
    case working, attention
}

/**
 * The computer's lists — sessions, projects, pin/archive flags, live chats —
 * kept in step with its broadcasts (mobile/src/state/data.ts). A cache per
 * paired computer paints the chat list at once on a cold start.
 */
@MainActor
@Observable
final class DataStore {
    static let shared = DataStore()

    /// False until the first answer from the computer (or the cache).
    private(set) var loaded = false
    /// The lists could not be read (shown until the next successful refresh).
    private(set) var loadError: String?
    private(set) var sessions: [SessionSummary] = []
    private(set) var projects: [ProjectSummary] = []
    private(set) var meta: SessionMetaMap = [:]
    /// Chats with a live pi process on the computer, by chat id.
    private(set) var live: [String: RemoteLiveChat] = [:]
    private(set) var appInfo: AppInfo?
    private(set) var userName = ""

    @ObservationIgnored private var listsVisible = true
    @ObservationIgnored private var listsDirty = false
    @ObservationIgnored private var sessionsTimer: Task<Void, Never>?
    @ObservationIgnored private var liveTimer: Task<Void, Never>?
    @ObservationIgnored private var cacheTimer: Task<Void, Never>?
    @ObservationIgnored private var shownFor: String?
    @ObservationIgnored private var wired = false

    private static let sessionsRefreshDelay: UInt64 = 2_000_000_000
    private static let cacheSessions = 300
    private static let cacheWriteDelay: UInt64 = 20_000_000_000

    private init() {}

    func refresh() async throws {
        do {
            async let sessionList = API.sessions()
            async let projectList = API.projects()
            let (s, p) = try await (sessionList, projectList)
            sessions = s
            projects = p
            loaded = true
            loadError = nil
            scheduleCacheWrite()
        } catch {
            loadError = errorText(error)
            throw error
        }
    }

    func refreshLive() async throws {
        let list = try await API.liveChats()
        var next: [String: RemoteLiveChat] = [:]
        for chat in list { next[chat.chatId] = chat }
        live = next
    }

    func session(_ path: String?) -> SessionSummary? {
        guard let path else { return nil }
        return sessions.first { $0.path == path }
    }

    /// Whether pi is working in, or waiting on the user of, a session.
    func liveState(_ sessionPath: String) -> LiveState? {
        for chat in live.values where chat.sessionPath == sessionPath {
            return chat.uiRequest != nil ? .attention : chat.streaming ? .working : nil
        }
        return nil
    }

    func isPinned(_ path: String) -> Bool { meta[path]?.pinned != nil }
    func isArchived(_ path: String) -> Bool { meta[path]?.archived != nil }

    /// Optimistic, like the desktop: the broadcast brings the authoritative map.
    func setMeta(_ sessionPath: String, pinned: Bool? = nil, archived: Bool? = nil) async {
        let before = meta[sessionPath]
        var current = before ?? SessionMetaEntry()
        if let pinned { current.pinned = pinned ? nowMs() : nil }
        if let archived { current.archived = archived ? nowMs() : nil }
        meta[sessionPath] = current
        do {
            meta = try await API.setMeta(sessionPath, pinned: pinned, archived: archived)
            scheduleCacheWrite()
        } catch {
            meta[sessionPath] = before
            let verb = pinned.map { $0 ? "pin" : "unpin" } ?? (archived == true ? "archive" : "unarchive")
            toast("Could not \(verb): \(errorText(error))")
        }
    }

    /**
     * Whether a screen showing the lists is on top. While a chat covers them,
     * session changes only mark the lists stale; they are fetched when the
     * user comes back.
     */
    func setListsVisible(_ visible: Bool) {
        listsVisible = visible
        if visible && listsDirty && Connection.shared.isOnline { refreshLists() }
    }

    private func refreshLists() {
        listsDirty = false
        Task { try? await refresh() }
    }

    private func patchLive(_ chatId: String, _ patch: (inout RemoteLiveChat) -> Void) {
        guard var current = live[chatId] else {
            // A chat this phone has not heard of: ask the computer what runs.
            if liveTimer == nil {
                liveTimer = Task { [weak self] in
                    try? await Task.sleep(nanoseconds: 250_000_000)
                    self?.liveTimer = nil
                    try? await self?.refreshLive()
                }
            }
            return
        }
        patch(&current)
        live[chatId] = current
    }

    // MARK: Cache

    private struct Cache: Codable {
        var key: String
        var sessions: [SessionSummary]
        var projects: [ProjectSummary]
        var meta: SessionMetaMap
        var appInfo: AppInfo?
    }

    private func cacheURL(_ key: String) -> URL {
        // The key is base64url: safe as a file name.
        AppFiles.cacheURL("lists-\(key).json")
    }

    private func scheduleCacheWrite() {
        guard cacheTimer == nil else { return }
        cacheTimer = Task { [weak self] in
            try? await Task.sleep(nanoseconds: Self.cacheWriteDelay)
            guard let self else { return }
            self.cacheTimer = nil
            self.writeCache()
        }
    }

    func writeCache() {
        guard let key = Connection.shared.pairing?.key, loaded else { return }
        let cache = Cache(key: key, sessions: Array(sessions.prefix(Self.cacheSessions)), projects: projects, meta: meta, appInfo: appInfo)
        if let data = try? JSONEncoder().encode(cache) {
            try? data.write(to: cacheURL(key), options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
        }
    }

    private func restoreCache(_ key: String) {
        guard !loaded,
            let data = try? Data(contentsOf: cacheURL(key)),
            let cache = try? JSONDecoder().decode(Cache.self, from: data),
            cache.key == key
        else { return }
        sessions = cache.sessions
        projects = cache.projects
        meta = cache.meta
        appInfo = cache.appInfo
        loaded = true
    }

    // MARK: Wiring

    /// Keep the lists in step with the computer. Once, at launch.
    func wire() {
        guard !wired else { return }
        wired = true
        let connection = Connection.shared

        connection.onOnline { [weak self] in
            guard let self else { return }
            self.refreshLists()
            Task { try? await self.refreshLive() }
            Task { if let meta = try? await API.meta() { self.meta = meta } }
            Task { if let info = try? await API.appInfo() { self.appInfo = info } }
            Task { if let name = try? await API.userFirstName() { self.userName = name } }
        }

        connection.on(RemoteEvent.sessionsChanged) { [weak self] _ in
            guard let self else { return }
            // pi appends to session files the whole time it works: at most
            // one refresh every couple of seconds, and none while hidden.
            guard self.listsVisible else {
                self.listsDirty = true
                return
            }
            guard self.sessionsTimer == nil else { return }
            self.sessionsTimer = Task { [weak self] in
                try? await Task.sleep(nanoseconds: Self.sessionsRefreshDelay)
                self?.sessionsTimer = nil
                self?.refreshLists()
            }
        }

        connection.on(RemoteEvent.sessionMetaChanged) { [weak self] payload in
            guard let self, let map = try? payload.decode(SessionMetaMap.self) else { return }
            self.meta = map
            self.scheduleCacheWrite()
        }

        connection.onUnpair { [weak self] in
            guard let self else { return }
            self.loaded = false
            self.sessions = []
            self.projects = []
            self.meta = [:]
            self.live = [:]
            self.appInfo = nil
            self.userName = ""
            self.shownFor = nil
        }

        connection.onComputerRemoved { [weak self] key in
            guard let self else { return }
            try? FileManager.default.removeItem(at: self.cacheURL(key))
        }

        connection.on(RemoteEvent.chatEvent) { [weak self] payload in
            guard let self, let chatId = payload["chatId"]?.stringValue else { return }
            for event in payload["events"]?.arrayValue ?? [] {
                switch event["type"]?.stringValue {
                case "agent_start": self.patchLive(chatId) { $0.streaming = true }
                case "agent_settled": self.patchLive(chatId) { $0.streaming = false }
                default: break
                }
            }
        }
        connection.on(RemoteEvent.chatUiRequest) { [weak self] payload in
            guard let self, let chatId = payload["chatId"]?.stringValue,
                let request = payload["request"].flatMap(ExtensionUiRequest.init(json:)), request.method != "notify"
            else { return }
            self.patchLive(chatId) { $0.uiRequest = request }
        }
        connection.on(RemoteEvent.chatUiResolved) { [weak self] payload in
            guard let self, let chatId = payload["chatId"]?.stringValue else { return }
            self.patchLive(chatId) { $0.uiRequest = nil }
        }
        connection.on(RemoteEvent.chatExit) { [weak self] payload in
            guard let self, let chatId = payload["chatId"]?.stringValue else { return }
            self.live[chatId] = nil
        }

        // Whenever another computer comes into use (and at launch): show its
        // cached lists until it answers.
        followPairing()
        pairingChanged()
    }

    private func followPairing() {
        withObservationTracking {
            _ = Connection.shared.pairing?.key
        } onChange: { [weak self] in
            Task { @MainActor in
                self?.pairingChanged()
                self?.followPairing()
            }
        }
    }

    private func pairingChanged() {
        let key = Connection.shared.pairing?.key
        guard key != shownFor else { return }
        shownFor = key
        if let key { restoreCache(key) }
    }
}
