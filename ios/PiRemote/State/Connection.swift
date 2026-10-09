import Foundation
import Observation
import PiRemoteKit
import UIKit

enum ConnectionPhase: Equatable {
    case loading, unpaired, connecting, online, offline
}

/**
 * The link to the computer in use: pairing, dialing with backoff, switching
 * between paired computers and fanning the desktop's broadcasts out to the
 * stores (mobile/src/state/connection.ts).
 */
@MainActor
@Observable
final class Connection {
    static let shared = Connection()

    private(set) var phase: ConnectionPhase = .loading
    /// The computer in use.
    private(set) var pairing: StoredPairing?
    /// Every paired computer, the one in use included.
    private(set) var computers: [StoredPairing] = []
    private(set) var server: RemoteServerInfo?
    /// Why the last attempt failed, in words for the user.
    var error: String?

    @ObservationIgnored private var identity: RemoteCrypto.KeyPair?
    @ObservationIgnored private var client: RemoteClient?
    @ObservationIgnored private var attempt = 0
    @ObservationIgnored private var retryTask: Task<Void, Never>?
    @ObservationIgnored private var connecting = false
    @ObservationIgnored private var inflight: Task<Void, Error>?
    @ObservationIgnored private var subscribedChats: [String] = []
    @ObservationIgnored private var listeners: [String: [UUID: (JSONValue) -> Void]] = [:]
    @ObservationIgnored private var onlineListeners: [UUID: () -> Void] = [:]
    @ObservationIgnored private var unpairListeners: [UUID: () -> Void] = [:]
    @ObservationIgnored private var removedListeners: [UUID: (String) -> Void] = [:]
    @ObservationIgnored private(set) var appActive = true
    /// The link is kept up with the app in the background (a background task runs).
    @ObservationIgnored var backgroundLink = false

    private static let backoff: [Double] = [0.5, 1, 2, 4, 8]

    private init() {}

    var isOnline: Bool { phase == .online }

    // MARK: Listeners

    /// Listen to one of the desktop's broadcasts; survives reconnects.
    @discardableResult
    func on(_ channel: String, _ listener: @escaping (JSONValue) -> Void) -> Subscription {
        let id = UUID()
        listeners[channel, default: [:]][id] = listener
        return Subscription { [weak self] in self?.listeners[channel]?[id] = nil }
    }

    /// Runs every time the link comes (back) up: the moment to resync.
    @discardableResult
    func onOnline(_ listener: @escaping () -> Void) -> Subscription {
        let id = UUID()
        onlineListeners[id] = listener
        return Subscription { [weak self] in self?.onlineListeners[id] = nil }
    }

    /// Runs when the computer in use changes or its pairing ends.
    @discardableResult
    func onUnpair(_ listener: @escaping () -> Void) -> Subscription {
        let id = UUID()
        unpairListeners[id] = listener
        return Subscription { [weak self] in self?.unpairListeners[id] = nil }
    }

    /// Runs when a computer is forgotten: what was kept on disk for it can go.
    @discardableResult
    func onComputerRemoved(_ listener: @escaping (String) -> Void) -> Subscription {
        let id = UUID()
        removedListeners[id] = listener
        return Subscription { [weak self] in self?.removedListeners[id] = nil }
    }

    private func forget() {
        subscribedChats = []
        for listener in unpairListeners.values { listener() }
    }

    private func removed(_ key: String) {
        for listener in removedListeners.values { listener(key) }
    }

    // MARK: Requests

    /// Run one of the desktop's IPC handlers. Fails at once while offline.
    func request(_ channel: String, _ arg: JSONValue? = nil, timeout: Double = defaultRequestTimeout) async throws -> JSONValue {
        guard let client, client.connected else { throw RemoteDisconnectedError() }
        return try await client.request(channel, arg, timeout: timeout)
    }

    /// Chats whose token stream this phone wants; remembered across reconnects.
    func subscribeChats(_ chatIds: [String]) {
        subscribedChats = chatIds
        client?.subscribe(chatIds)
    }

    // MARK: Dialing

    private var mayDial: Bool { appActive || backgroundLink }

    private func deviceInfo() -> (name: String, platform: String) {
        (String(UIDevice.current.name.prefix(64)), "ios")
    }

    private func storeComputers(_ list: [StoredPairing], active: StoredPairing?) {
        computers = list
        PairingStorage.saveComputers(StoredComputers(list: list, active: active?.key))
    }

    private func detach() async {
        clearRetry()
        let current = client
        client = nil
        current?.close()
        forget()
        _ = await inflight?.result
    }

    private func clearRetry() {
        retryTask?.cancel()
        retryTask = nil
    }

    private func scheduleRetry() {
        clearRetry()
        // No point dialing while the app sleeps in the background; resuming reconnects.
        guard mayDial else { return }
        let wait = Self.backoff[min(attempt, Self.backoff.count - 1)]
        attempt += 1
        retryTask = Task { [weak self] in
            try? await Task.sleep(nanoseconds: UInt64(wait * 1_000_000_000))
            guard !Task.isCancelled else { return }
            self?.dialSoon()
        }
    }

    private func dialSoon() {
        Task { try? await self.connect() }
    }

    /**
     * Dial the paired computer. With `candidate` (and its one-time `token`)
     * this is a pairing attempt: nothing is stored or shown as paired until
     * the computer accepts.
     */
    private func connect(token: String? = nil, candidate: StoredPairing? = nil) async throws {
        if connecting {
            if candidate != nil { throw RemoteMessageError("Already connecting. Try again in a moment.") }
            return
        }
        let task = Task { try await self.dial(token: token, candidate: candidate) }
        inflight = task
        defer {
            if inflight == task { inflight = nil }
        }
        try await task.value
    }

    private func dial(token: String?, candidate: StoredPairing?) async throws {
        guard let pairing = candidate ?? self.pairing, let identity, !connecting else {
            if candidate != nil { throw RemoteMessageError("Already connecting. Try again in a moment.") }
            return
        }
        connecting = true
        defer { connecting = false }
        clearRetry()
        client?.close()
        if candidate == nil && phase != .offline { phase = .connecting }
        let next = RemoteClient(identity: identity)
        client = next
        // The address that worked last goes first; the rest stay as fallbacks.
        var hosts = pairing.hosts
        if let last = pairing.lastHost { hosts = [last] + pairing.hosts.filter { $0 != last } }
        do {
            let result = try await next.connect(
                ConnectTarget(key: pairing.key, port: pairing.port, hosts: hosts, token: token, device: deviceInfo())
            )
            guard client === next else {
                next.close()
                return
            }
            attempt = 0
            next.onEvent = { [weak self] channel, payload in
                guard let self else { return }
                for listener in self.listeners[channel]?.values.map({ $0 }) ?? [] { listener(payload) }
            }
            next.onClose = { [weak self, weak next] in
                guard let self, let next, self.client === next else { return }
                self.client = nil
                // Usually the phone slept or changed network: redial at once
                // and only call it offline if that fails.
                self.phase = .connecting
                self.error = nil
                self.attempt = 0
                if self.mayDial { self.dialSoon() }
            }
            // The computer reports its addresses on every connection: keep them.
            var known: [String] = []
            for host in [result.host] + (result.server.hosts ?? []) + pairing.hosts where !known.contains(host) {
                known.append(host)
            }
            known = Array(known.prefix(16))
            var updated = pairing
            updated.hosts = known
            updated.name = result.server.name
            updated.lastHost = result.host
            updated.kind = result.server.kind ?? "desktop"
            if candidate == nil && updated != pairing {
                storeComputers(computers.map { $0.key == updated.key ? updated : $0 }, active: updated)
            }
            phase = .online
            server = result.server
            self.pairing = updated
            error = nil
            if !subscribedChats.isEmpty { next.subscribe(subscribedChats) }
            for listener in onlineListeners.values.map({ $0 }) { listener() }
        } catch {
            let superseded = client !== next
            if !superseded { client = nil }
            next.close()
            let unreachable =
                "Cannot reach the computer. Check that Pi Desktop is open with remote control on (or pi-remote is running on the server), and that this phone can reach it."
            if candidate != nil {
                let message = error is RemoteDeniedError
                    ? "That code no longer works. Show a new one on the computer and scan again."
                    : unreachable
                self.error = message
                throw RemoteMessageError(message)
            }
            if superseded { return }
            if error is RemoteDeniedError {
                // Removed on the computer: that pairing is over. Another
                // paired computer, if there is one, takes over.
                let rest = computers.filter { $0.key != pairing.key }
                let fallback = rest.first
                forget()
                removed(pairing.key)
                storeComputers(rest, active: fallback)
                phase = fallback != nil ? .connecting : .unpaired
                self.pairing = fallback
                server = nil
                self.error = "\(pairing.name) removed this phone. Pair it again to use it."
                if fallback != nil {
                    attempt = 0
                    dialSoon()
                }
                throw error
            }
            phase = .offline
            self.error = unreachable
            scheduleRetry()
        }
    }

    // MARK: Public actions

    /// Load the stored pairings and connect. Once, at launch.
    func start() {
        guard phase == .loading else { return }
        identity = PairingStorage.loadIdentity()
        let stored = PairingStorage.loadComputers()
        computers = stored.list
        guard let active = stored.list.first(where: { $0.key == stored.active }) else {
            phase = .unpaired
            return
        }
        pairing = active
        phase = .connecting
        dialSoon()
    }

    /// Pair with the computer whose QR code (or pasted link) this is, and use it.
    func pair(_ text: String) async throws {
        guard let payload = PairingPayload.parse(text) else { throw RemoteMessageError("That is not a Pi Desktop pairing code") }
        if identity == nil { identity = PairingStorage.loadIdentity() }
        let known = computers.contains { $0.key == payload.key }
        if !known && computers.count >= PairingStorage.maxComputers {
            throw RemoteMessageError("Pi Remote keeps up to \(PairingStorage.maxComputers) computers. Remove one in Settings first.")
        }
        let candidate = StoredPairing(key: payload.key, port: payload.port, hosts: payload.hosts, name: payload.name)
        // The computer in use steps aside while the new one answers, and
        // comes back if it does not.
        let previous = pairing
        if previous != nil {
            await detach()
            phase = .connecting
            server = nil
        }
        error = nil
        do {
            try await connect(token: payload.token, candidate: candidate)
        } catch {
            if let previous {
                let message = self.error
                pairing = previous
                phase = .connecting
                self.error = nil
                attempt = 0
                Task {
                    try? await self.connect()
                    // The phone is back on the old computer; the failure is what to show.
                    if let message, self.phase == .online { self.error = message }
                }
            }
            throw error
        }
        guard let added = pairing else { return }
        storeComputers([added] + computers.filter { $0.key != added.key }, active: added)
    }

    /// Use another paired computer.
    func switchTo(_ key: String) async {
        guard let target = computers.first(where: { $0.key == key }), pairing?.key != key else { return }
        await detach()
        storeComputers(computers, active: target)
        pairing = target
        server = nil
        phase = .connecting
        error = nil
        attempt = 0
        dialSoon()
    }

    /// Forget a computer (default: the one in use).
    func unpair(_ key: String? = nil) async {
        guard let gone = key ?? pairing?.key else { return }
        let rest = computers.filter { $0.key != gone }
        removed(gone)
        if gone != pairing?.key {
            storeComputers(rest, active: pairing)
            return
        }
        await detach()
        let next = rest.first
        storeComputers(rest, active: next)
        phase = next != nil ? .connecting : .unpaired
        pairing = next
        server = nil
        error = nil
        if next != nil {
            attempt = 0
            dialSoon()
        }
    }

    /// Try again now instead of waiting for the next automatic attempt.
    func retry() {
        guard pairing != nil, phase != .online else { return }
        attempt = 0
        dialSoon()
    }

    /// Add an address to try (the computer moved to another network).
    func addHost(_ host: String) throws {
        var clean = host.trimmingCharacters(in: .whitespacesAndNewlines)
        clean = clean.replacingOccurrences(of: "^wss?://", with: "", options: .regularExpression)
        clean = clean.replacingOccurrences(of: "[:/].*$", with: "", options: .regularExpression)
        guard var updated = pairing, clean.range(of: "^[A-Za-z0-9.-]{1,255}$", options: .regularExpression) != nil else {
            throw RemoteMessageError("That is not an address")
        }
        updated.hosts = [clean] + updated.hosts.filter { $0 != clean }
        pairing = updated
        storeComputers(computers.map { $0.key == updated.key ? updated : $0 }, active: updated)
        if phase != .online {
            attempt = 0
            dialSoon()
        }
    }

    /// Wait (up to `timeout`) for the link to be up; for background refreshes.
    func waitUntilOnline(timeout: Double) async -> Bool {
        if phase == .online, client?.connected == true { return true }
        if pairing == nil { return false }
        if phase != .connecting || !connecting { dialSoon() }
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if phase == .online, client?.connected == true { return true }
            if phase == .unpaired { return false }
            try? await Task.sleep(nanoseconds: 250_000_000)
        }
        return phase == .online
    }

    // MARK: App lifecycle

    func appBecameActive() {
        appActive = true
        guard pairing != nil else { return }
        if phase == .online, let client, client.connected {
            // A dead socket can still look open; a request that times out closes it.
            Task {
                do {
                    _ = try await client.request("pi-desktop:app:info", nil, timeout: 4)
                } catch {
                    client.close()
                }
            }
            return
        }
        attempt = 0
        dialSoon()
    }

    func appWentToBackground() {
        appActive = false
        if !backgroundLink { clearRetry() }
    }
}

/// Cancels a listener registration (explicitly: app-lifetime listeners just drop it).
final class Subscription {
    private var cancel: (() -> Void)?

    init(_ cancel: @escaping () -> Void) {
        self.cancel = cancel
    }

    @MainActor
    func cancelNow() {
        cancel?()
        cancel = nil
    }
}

/// Listener registrations a view holds while it is on screen.
@MainActor
final class SubscriptionBag {
    private var items: [Subscription] = []

    func add(_ subscription: Subscription) { items.append(subscription) }

    func cancelAll() {
        for item in items { item.cancelNow() }
        items.removeAll()
    }
}
