import Foundation
import Observation
import PiRemoteKit
import SwiftUI

/// Every screen pushed over the home tabs, and what it is opened with.
enum Route: Hashable {
    case chat(String)
    /// Working-tree changes of a project: review, commit, push.
    case diff(cwd: String, chatId: String?)
    /// The pull request of the project's branch.
    case pr(cwd: String, chatId: String?)
    /// A text file inside a project folder (read-only).
    case file(cwd: String, path: String)
    /// A side chat: questions with the chat's context that leave nothing in it.
    case side(chatId: String, question: String?)
    case automationEdit(id: String?)
    case usage
    /// Browse folders on the computer; resolves through FolderPicker.
    case folderPicker(title: String)
}

enum HomeTab: Hashable {
    case chats, projects, automations, settings
}

/// Navigation state and incoming links (pairing links, notification taps).
@MainActor
@Observable
final class Router {
    static let shared = Router()

    var path: [Route] = []
    var tab: HomeTab = .chats
    /// "Pair another computer" (sheet over the app), with a link when one arrived.
    var addComputer: AddComputerRequest?

    struct AddComputerRequest: Identifiable {
        let id = UUID()
        var link: String?
    }

    /// A pairing link that arrived before anyone could take it (first pairing).
    var pendingPairLink: String?

    @ObservationIgnored private var folderResolver: ((String?) -> Void)?

    private init() {}

    func push(_ route: Route) {
        path.append(route)
    }

    func popToRoot() {
        path.removeAll()
    }

    func pop() {
        if !path.isEmpty { path.removeLast() }
    }

    func openChat(_ chatId: String) {
        if case .chat(let current)? = path.last, current == chatId { return }
        path.append(.chat(chatId))
    }

    /// Replace the chat on top (`/new`).
    func replaceTop(with route: Route) {
        if !path.isEmpty { path.removeLast() }
        path.append(route)
    }

    // MARK: Opening chats

    private var lastStart = Date.distantPast

    /// Start a draft chat in a folder on the computer and show it.
    func startChat(_ cwd: String) {
        // A double tap must not start two pi processes.
        guard Date().timeIntervalSince(lastStart) > 0.7 else { return }
        lastStart = Date()
        openChat(ChatStore.shared.newChat(cwd))
    }

    /// Open (or join) a session's chat and show it.
    func openSession(_ session: SessionSummary) {
        Task {
            do {
                openChat(try await ChatStore.shared.openSession(session.path))
            } catch {
                toast("Could not open the chat: \(errorText(error))")
            }
        }
    }

    func joinLive(_ chat: RemoteLiveChat) {
        openChat(ChatStore.shared.joinLive(chat.chatId, cwd: chat.cwd, sessionPath: chat.sessionPath))
    }

    // MARK: Folder picker

    /// Open the folder browser; resolves to the chosen absolute path (nil when left).
    func pickFolder(_ title: String) async -> String? {
        folderResolver?(nil)
        push(.folderPicker(title: title))
        return await withCheckedContinuation { continuation in
            folderResolver = { continuation.resume(returning: $0) }
        }
    }

    func resolveFolder(_ path: String?) {
        let resolve = folderResolver
        folderResolver = nil
        resolve?(path)
    }

    // MARK: Links

    /// `pidesktop://pair?…` or `pidesktop://chat?id=…&session=…`.
    func handle(url: URL) {
        let text = url.absoluteString
        if text.hasPrefix("pidesktop://pair") {
            if Connection.shared.pairing != nil {
                addComputer = AddComputerRequest(link: text)
            } else {
                pendingPairLink = text
            }
            return
        }
        if text.hasPrefix("pidesktop://chat?"), let components = URLComponents(string: text) {
            let items = components.queryItems ?? []
            guard let chatId = items.first(where: { $0.name == "id" })?.value,
                chatId.range(of: "^[A-Za-z0-9_-]{1,64}$", options: .regularExpression) != nil
            else { return }
            openChatLink(chatId: chatId, sessionPath: items.first { $0.name == "session" }?.value)
        }
    }

    /// Show the chat a notification was about, once the computer is reachable.
    func openChatLink(chatId: String, sessionPath: String?) {
        let open = { @MainActor [weak self] in
            guard let self else { return }
            let chats = ChatStore.shared
            if chats.chat(chatId) != nil {
                self.openChat(chatId)
                return
            }
            if let sessionPath {
                if let id = try? await chats.openSession(sessionPath) { self.openChat(id) }
                return
            }
            try? await DataStore.shared.refreshLive()
            if let live = DataStore.shared.live[chatId] { self.joinLive(live) }
        }
        if Connection.shared.isOnline {
            Task { await open() }
        } else {
            // Launched from the notification: the link is still coming up.
            var subscription: Subscription?
            subscription = Connection.shared.onOnline {
                subscription?.cancelNow()
                subscription = nil
                Task { await open() }
            }
        }
    }
}
