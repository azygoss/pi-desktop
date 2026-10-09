import BackgroundTasks
import Foundation
import PiRemoteKit
import UIKit
import UserNotifications

/**
 * "When pi finishes or needs you" on iOS. There is no push server, so:
 *
 * - While pi works and the app goes to the background, a background task
 *   keeps the link open for the time iOS grants (about half a minute) and
 *   the app posts the notification itself when a chat settles or asks.
 * - A background app refresh, when iOS schedules one, reconnects briefly,
 *   compares the computer's live chats with what was running and announces
 *   the ones that finished or wait on the user.
 *
 * The mobile/ (Android) twin is src/lib/background.ts.
 */
@MainActor
final class Background: NSObject {
    static let shared = Background()
    nonisolated static let refreshTaskId = "io.github.azygoss.piremote.refresh"

    private static let workingKey = "pi-remote.background.working"
    private static let offlineLimit: Double = 3 * 60

    private var backgroundTask: UIBackgroundTaskIdentifier = .invalid
    private var wired = false

    var supported: Bool { true }

    private var enabled: Bool {
        Prefs.shared.notifications == true && Connection.shared.pairing != nil
    }

    // MARK: Permission

    /// Ask iOS for permission and turn notifications on if it is given.
    @discardableResult
    func enable() async -> Bool {
        let center = UNUserNotificationCenter.current()
        let granted = (try? await center.requestAuthorization(options: [.alert, .sound, .badge])) ?? false
        Prefs.shared.notifications = granted
        return granted
    }

    func disable() {
        Prefs.shared.notifications = false
        endBackgroundTask()
        BGTaskScheduler.shared.cancel(taskRequestWithIdentifier: Self.refreshTaskId)
    }

    // MARK: Notifications

    private func titleFor(_ chatId: String) -> String {
        if let chat = ChatStore.shared.chat(chatId), !chat.title.isEmpty, chat.title != "New chat" { return chat.title }
        let data = DataStore.shared
        let path = ChatStore.shared.chat(chatId)?.sessionPath ?? data.live[chatId]?.sessionPath
        if let title = data.session(path)?.title, !title.isEmpty { return title }
        let cwd = ChatStore.shared.chat(chatId)?.cwd ?? data.live[chatId]?.cwd
        return cwd.map { baseName($0) } ?? "Chat"
    }

    private func post(chatId: String, title: String, body: String, sessionPath: String?) {
        let content = UNMutableNotificationContent()
        content.title = title
        content.body = body
        content.sound = .default
        content.threadIdentifier = chatId
        var info: [String: String] = ["chatId": chatId]
        if let sessionPath { info["session"] = sessionPath }
        content.userInfo = info
        let request = UNNotificationRequest(identifier: "chat-\(chatId)", content: content, trigger: nil)
        UNUserNotificationCenter.current().add(request)
    }

    private func alert(_ chatId: String, _ body: String) {
        guard enabled, UIApplication.shared.applicationState != .active else { return }
        let path = ChatStore.shared.chat(chatId)?.sessionPath ?? DataStore.shared.live[chatId]?.sessionPath
        post(chatId: chatId, title: titleFor(chatId), body: body, sessionPath: path)
    }

    /// Markdown flattened to one short line for a notification body.
    private func plainText(_ markdown: String) -> String {
        var text = markdown.replacingOccurrences(of: "```[\\s\\S]*?```", with: " ", options: .regularExpression)
        text = text.replacingOccurrences(of: "[#>*_`~]", with: "", options: .regularExpression)
        return String(collapseWhitespace(text).prefix(180))
    }

    private func lastReply(_ chatId: String) -> String {
        for message in (ChatStore.shared.chat(chatId)?.view.messages ?? []).reversed() {
            guard case .assistant(let assistant) = message else { continue }
            let text = plainText(assistant.blocks.compactMap { if case .text(let t) = $0 { return t } else { return nil } }.joined(separator: " "))
            if !text.isEmpty { return text }
        }
        return ""
    }

    /// Say that a chat finished; for chats this phone does not follow, ask for the reply.
    private func announceFinished(_ chatId: String) async {
        guard enabled, UIApplication.shared.applicationState != .active else { return }
        var body = ""
        if let chat = ChatStore.shared.chat(chatId), !chat.stale { body = lastReply(chatId) }
        if body.isEmpty { body = plainText((try? await API.lastAssistantText(chatId)) ?? "") }
        alert(chatId, body.isEmpty ? "pi finished" : body)
    }

    func cancelAlerts() {
        UNUserNotificationCenter.current().removeAllDeliveredNotifications()
        UNUserNotificationCenter.current().setBadgeCount(0)
    }

    // MARK: Background time

    private var workingChats: [RemoteLiveChat] {
        DataStore.shared.live.values.filter(\.streaming)
    }

    private func beginBackgroundTask() {
        guard backgroundTask == .invalid else { return }
        backgroundTask = UIApplication.shared.beginBackgroundTask(withName: "pi is working") { [weak self] in
            Task { @MainActor in self?.endBackgroundTask() }
        }
        Connection.shared.backgroundLink = backgroundTask != .invalid
    }

    private func endBackgroundTask() {
        Connection.shared.backgroundLink = false
        guard backgroundTask != .invalid else { return }
        UIApplication.shared.endBackgroundTask(backgroundTask)
        backgroundTask = .invalid
    }

    /// Remember what runs, so a later refresh can tell what finished.
    private func rememberWorking() {
        let working = workingChats.map { ["chatId": $0.chatId, "session": $0.sessionPath ?? "", "title": titleFor($0.chatId)] }
        UserDefaults.standard.set(working, forKey: Self.workingKey)
    }

    func appWentToBackground() {
        guard enabled else { return }
        rememberWorking()
        if !workingChats.isEmpty {
            beginBackgroundTask()
            scheduleRefresh()
        }
    }

    func appBecameActive() {
        endBackgroundTask()
        cancelAlerts()
    }

    private func sync() {
        guard backgroundTask != .invalid else { return }
        rememberWorking()
        if workingChats.isEmpty || !enabled {
            // Give the last notification a moment to go out.
            Task {
                try? await Task.sleep(nanoseconds: 2_000_000_000)
                if self.workingChats.isEmpty { self.endBackgroundTask() }
            }
        }
    }

    func scheduleRefresh() {
        let request = BGAppRefreshTaskRequest(identifier: Self.refreshTaskId)
        request.earliestBeginDate = Date(timeIntervalSinceNow: 15 * 60)
        try? BGTaskScheduler.shared.submit(request)
    }

    /// Register the refresh task. Must run before the app finishes launching.
    nonisolated static func registerTasks() {
        BGTaskScheduler.shared.register(forTaskWithIdentifier: refreshTaskId, using: nil) { task in
            guard let refresh = task as? BGAppRefreshTask else {
                task.setTaskCompleted(success: false)
                return
            }
            Task { @MainActor in
                let work = Task { await Background.shared.runRefresh() }
                refresh.expirationHandler = { work.cancel() }
                let success = await work.value
                refresh.setTaskCompleted(success: success)
            }
        }
    }

    /// One background refresh: reconnect, compare, announce, reschedule.
    private func runRefresh() async -> Bool {
        guard enabled else { return true }
        Connection.shared.start()
        Connection.shared.backgroundLink = true
        defer { Connection.shared.backgroundLink = UIApplication.shared.applicationState == .active || backgroundTask != .invalid }
        guard await Connection.shared.waitUntilOnline(timeout: 20), !Task.isCancelled else { return false }
        guard (try? await DataStore.shared.refreshLive()) != nil else { return false }
        let before = (UserDefaults.standard.array(forKey: Self.workingKey) as? [[String: String]]) ?? []
        let live = DataStore.shared.live
        for entry in before {
            guard let chatId = entry["chatId"] else { continue }
            if live[chatId]?.streaming == true { continue }
            let body = plainText((try? await API.lastAssistantText(chatId)) ?? "")
            post(
                chatId: chatId,
                title: entry["title"].flatMap { $0.isEmpty ? nil : $0 } ?? "Chat",
                body: body.isEmpty ? "pi finished" : body,
                sessionPath: entry["session"].flatMap { $0.isEmpty ? nil : $0 }
            )
        }
        for chat in live.values {
            if let request = chat.uiRequest, request.isInteractive {
                post(chatId: chat.chatId, title: titleFor(chat.chatId), body: "pi needs you\(request.title.map { ": \($0)" } ?? "")", sessionPath: chat.sessionPath)
            }
        }
        rememberWorking()
        if !workingChats.isEmpty { scheduleRefresh() }
        return true
    }

    // MARK: Wiring

    /// Follow the computer's events. Once, at launch.
    func wire() {
        guard !wired else { return }
        wired = true
        UNUserNotificationCenter.current().delegate = self
        let connection = Connection.shared
        connection.on(RemoteEvent.chatEvent) { [weak self] payload in
            guard let self, let chatId = payload["chatId"]?.stringValue else { return }
            let events = payload["events"]?.arrayValue ?? []
            if events.contains(where: { $0["type"]?.stringValue == "agent_settled" }) {
                // A beat later, so the chat store has taken in the final message.
                Task {
                    try? await Task.sleep(nanoseconds: 600_000_000)
                    await self.announceFinished(chatId)
                    self.sync()
                }
            }
        }
        connection.on(RemoteEvent.chatUiRequest) { [weak self] payload in
            guard let self, let chatId = payload["chatId"]?.stringValue,
                let request = payload["request"].flatMap(ExtensionUiRequest.init(json:)), request.isInteractive
            else { return }
            self.alert(chatId, "pi needs you\(request.title.map { ": \($0)" } ?? "")")
        }
        connection.on(RemoteEvent.chatUiResolved) { payload in
            guard let chatId = payload["chatId"]?.stringValue else { return }
            UNUserNotificationCenter.current().removeDeliveredNotifications(withIdentifiers: ["chat-\(chatId)"])
        }
        connection.onUnpair { [weak self] in
            self?.endBackgroundTask()
            self?.cancelAlerts()
            UserDefaults.standard.removeObject(forKey: Self.workingKey)
        }
        connection.onOnline { [weak self] in
            self?.sync()
        }
    }
}

extension Background: UNUserNotificationCenterDelegate {
    /// On screen, the app says it itself.
    nonisolated func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification
    ) async -> UNNotificationPresentationOptions {
        []
    }

    /// A tapped notification opens its chat.
    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse) async {
        let info = response.notification.request.content.userInfo
        guard let chatId = info["chatId"] as? String else { return }
        let session = info["session"] as? String
        await MainActor.run {
            Router.shared.openChatLink(chatId: chatId, sessionPath: session)
        }
    }
}
