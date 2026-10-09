import Foundation
import PiRemoteKit

struct RemoteDeniedError: LocalizedError {
    let reason: String
    var errorDescription: String? { reason.isEmpty ? "The computer refused this phone" : reason }
}

struct RemoteDisconnectedError: LocalizedError {
    var errorDescription: String? { "Not connected to the computer" }
}

struct RemoteMessageError: LocalizedError {
    let message: String
    init(_ message: String) { self.message = message }
    var errorDescription: String? { message }
}

struct ConnectTarget {
    /// Desktop's static public key (base64url).
    var key: String
    var port: Int
    var hosts: [String]
    /// One-time pairing token, on the first connection only.
    var token: String?
    var device: (name: String, platform: String)
}

struct Connected {
    var host: String
    var deviceId: String
    var server: RemoteServerInfo
}

/// A socket that completed the handshake, not yet adopted.
private struct Handshake: @unchecked Sendable {
    let socket: URLSessionWebSocketTask
    let channel: SecureChannel
    let host: String
    let deviceId: String
    let server: RemoteServerInfo
}

private let openTimeout: Double = 3.5
private let handshakeTimeout: Double = 8
/// Delay before the next address is dialed alongside the previous one.
private let stagger: Double = 0.5
let defaultRequestTimeout: Double = 30
private let pingInterval: Double = 20
/// No frame for this long means the link is dead even if the socket says open.
private let silenceLimit: Double = 50
/// The desktop's own frame limit.
private let maxMessageBytes = 48 * 1024 * 1024

/// Run `operation`, failing with `message` after `seconds`.
private func withTimeout<T: Sendable>(
    _ seconds: Double,
    message: String,
    _ operation: @escaping @Sendable () async throws -> T
) async throws -> T {
    try await withThrowingTaskGroup(of: T.self) { group in
        group.addTask { try await operation() }
        group.addTask {
            try await Task.sleep(nanoseconds: UInt64(seconds * 1_000_000_000))
            throw RemoteMessageError(message)
        }
        defer { group.cancelAll() }
        guard let first = try await group.next() else { throw RemoteDisconnectedError() }
        return first
    }
}

/**
 * One encrypted connection to the paired computer: the handshake, request /
 * response correlation and event fan-out (mobile/src/remote/client.ts).
 * Reconnecting is the connection store's business; a client is used for one
 * socket.
 */
@MainActor
final class RemoteClient {
    private nonisolated static let session: URLSession = {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.waitsForConnectivity = false
        configuration.timeoutIntervalForRequest = 60 * 60 * 24
        return URLSession(configuration: configuration)
    }()

    private let identity: RemoteCrypto.KeyPair
    private var socket: URLSessionWebSocketTask?
    private var channel: SecureChannel?
    private var nextId = 1
    private var pending: [Int: (continuation: CheckedContinuation<JSONValue, Error>, timer: Task<Void, Never>)] = [:]
    private var receiveTask: Task<Void, Never>?
    private var pingTask: Task<Void, Never>?
    private var raceTask: Task<Handshake, Error>?
    private var lastFrameAt = Date()
    private(set) var closed = false

    var onClose: (() -> Void)?
    /// One of the desktop's broadcasts arrived.
    var onEvent: ((String, JSONValue) -> Void)?

    init(identity: RemoteCrypto.KeyPair) {
        self.identity = identity
    }

    var connected: Bool { channel != nil && !closed }

    /**
     * Reach the computer at one of its addresses. Pairing tries them in turn
     * (the one-time token must not be presented twice); a paired phone dials
     * them staggered and keeps the first that completes the handshake.
     */
    func connect(_ target: ConnectTarget) async throws -> Connected {
        let identity = identity
        let task = Task<Handshake, Error> {
            if target.token != nil || target.hosts.count <= 1 {
                var lastError: Error = RemoteDisconnectedError()
                for host in target.hosts {
                    try Task.checkCancellation()
                    do {
                        return try await Self.handshake(host: host, target: target, identity: identity)
                    } catch let denied as RemoteDeniedError {
                        throw denied // the computer answered and said no: other addresses will too
                    } catch {
                        lastError = error
                    }
                }
                throw lastError
            }
            return try await Self.race(target: target, identity: identity)
        }
        raceTask = task
        defer { raceTask = nil }
        let result: Handshake
        do {
            result = try await task.value
        } catch {
            if closed { throw RemoteDisconnectedError() }
            throw error
        }
        guard !closed else {
            result.socket.cancel(with: .goingAway, reason: nil)
            throw RemoteDisconnectedError()
        }
        adopt(result)
        return Connected(host: result.host, deviceId: result.deviceId, server: result.server)
    }

    private nonisolated static func race(target: ConnectTarget, identity: RemoteCrypto.KeyPair) async throws -> Handshake {
        try await withThrowingTaskGroup(of: Handshake?.self) { group in
            for (index, host) in target.hosts.enumerated() {
                group.addTask {
                    if index > 0 { try await Task.sleep(nanoseconds: UInt64(Double(index) * stagger * 1_000_000_000)) }
                    return try await handshake(host: host, target: target, identity: identity)
                }
            }
            var denied: Error?
            var lastError: Error = RemoteDisconnectedError()
            var winner: Handshake?
            while let next = await group.nextResult() {
                switch next {
                case .success(let handshake?):
                    if winner == nil {
                        winner = handshake
                        group.cancelAll()
                    } else {
                        handshake.socket.cancel(with: .goingAway, reason: nil) // another address won the race
                    }
                case .success(nil):
                    break
                case .failure(let error):
                    if error is RemoteDeniedError { denied = error }
                    if !(error is CancellationError) { lastError = error }
                }
            }
            if let winner { return winner }
            try Task.checkCancellation()
            throw denied ?? lastError
        }
    }

    private nonisolated static func handshake(
        host: String,
        target: ConnectTarget,
        identity: RemoteCrypto.KeyPair
    ) async throws -> Handshake {
        guard let url = remoteURL(host: host, port: target.port) else { throw RemoteMessageError("Not a valid address: \(host)") }
        guard let serverKey = Base64URL.decode(target.key), serverKey.count == RemoteCrypto.keyBytes else {
            throw RemoteMessageError("The pairing key is damaged")
        }
        let socket = session.webSocketTask(with: url)
        socket.maximumMessageSize = maxMessageBytes
        socket.resume()
        let ephemeral = RemoteCrypto.generateKeyPair()
        do {
            return try await withTaskCancellationHandler {
                try await withTimeout(openTimeout + handshakeTimeout, message: "The computer did not answer") {
                    let hello: JSONValue = [
                        "v": .int(RemoteProtocol.version),
                        "c": .string(Base64URL.encode(identity.publicKey)),
                        "e": .string(Base64URL.encode(ephemeral.publicKey))
                    ]
                    do {
                        try await socket.send(.string(hello.serializedString()))
                    } catch {
                        throw RemoteMessageError("Could not reach the computer")
                    }
                    let reply: URLSessionWebSocketTask.Message
                    do {
                        reply = try await socket.receive()
                    } catch {
                        throw RemoteMessageError("Could not reach the computer")
                    }
                    guard case .string(let text) = reply, let serverHello = try? JSONValue.parse(text) else {
                        throw RemoteMessageError("Unexpected reply")
                    }
                    guard serverHello["v"]?.intValue == RemoteProtocol.version,
                        let ephemeralText = serverHello["e"]?.stringValue,
                        let serverEphemeral = Base64URL.decode(ephemeralText)
                    else {
                        throw RemoteMessageError("Pi Desktop and this app are different versions")
                    }
                    let keys = try RemoteCrypto.clientSessionKeys(
                        clientStatic: identity,
                        clientEphemeral: ephemeral,
                        serverStaticPublic: serverKey,
                        serverEphemeralPublic: serverEphemeral
                    )
                    let channel = SecureChannel.forClient(keys)
                    let auth = JSONValue.compact([
                        "t": "auth",
                        "device": ["name": .string(target.device.name), "platform": .string(target.device.platform)],
                        "pair": target.token.map(JSONValue.string)
                    ])
                    try await socket.send(.data(Data(channel.seal(try FrameCodec.encodeClient(auth)))))
                    while true {
                        let message: URLSessionWebSocketTask.Message
                        do {
                            message = try await socket.receive()
                        } catch {
                            throw RemoteMessageError("Could not reach the computer")
                        }
                        guard case .data(let data) = message,
                            let plain = channel.open([UInt8](data)),
                            let frame = FrameCodec.decodeServer(plain)
                        else {
                            throw RemoteMessageError("The computer sent something this app cannot read")
                        }
                        switch frame {
                        case .denied(let reason):
                            throw RemoteDeniedError(reason: reason)
                        case .ready(let deviceId, let server):
                            return Handshake(socket: socket, channel: channel, host: host, deviceId: deviceId, server: server)
                        default:
                            continue
                        }
                    }
                }
            } onCancel: {
                socket.cancel(with: .goingAway, reason: nil)
            }
        } catch {
            socket.cancel(with: .goingAway, reason: nil)
            throw error
        }
    }

    private func adopt(_ handshake: Handshake) {
        socket = handshake.socket
        channel = handshake.channel
        lastFrameAt = Date()
        let socket = handshake.socket
        let channel = handshake.channel
        // Frames are opened, inflated and parsed off the main thread, in order.
        receiveTask = Task.detached(priority: .userInitiated) { [weak self] in
            while !Task.isCancelled {
                let message: URLSessionWebSocketTask.Message
                do {
                    message = try await socket.receive()
                } catch {
                    break
                }
                guard case .data(let data) = message,
                    let plain = channel.open([UInt8](data)),
                    let frame = FrameCodec.decodeServer(plain)
                else {
                    break // a frame that does not open: the stream cannot be trusted
                }
                await self?.receive(frame)
            }
            await self?.close()
        }
        pingTask = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: UInt64(pingInterval * 1_000_000_000))
                guard let self, !Task.isCancelled, !self.closed else { return }
                if Date().timeIntervalSince(self.lastFrameAt) > silenceLimit {
                    self.close()
                    return
                }
                _ = self.send(["t": "ping"])
            }
        }
    }

    private func receive(_ frame: ServerFrame) {
        guard !closed else { return }
        lastFrameAt = Date()
        switch frame {
        case .response(let id, let result):
            guard let entry = pending.removeValue(forKey: id) else { return }
            entry.timer.cancel()
            switch result {
            case .success(let value): entry.continuation.resume(returning: value)
            case .failure(let error): entry.continuation.resume(throwing: RemoteMessageError(error.message))
            }
        case .event(let channel, let payload):
            onEvent?(channel, payload)
        default:
            break
        }
    }

    /// Seal and queue a frame. Called on the main actor in order, so the
    /// implicit nonce counters match the order frames go out.
    private func send(_ frame: JSONValue) -> Bool {
        guard let socket, let channel, !closed, let plain = try? FrameCodec.encodeClient(frame) else { return false }
        socket.send(.data(Data(channel.seal(plain)))) { [weak self] error in
            if error != nil {
                Task { @MainActor in self?.close() }
            }
        }
        return true
    }

    /// Run one of the desktop's IPC handlers.
    func request(_ channelName: String, _ arg: JSONValue? = nil, timeout: Double = defaultRequestTimeout) async throws -> JSONValue {
        guard connected else { throw RemoteDisconnectedError() }
        let id = nextId
        nextId += 1
        return try await withCheckedThrowingContinuation { continuation in
            let timer = Task { [weak self] in
                try? await Task.sleep(nanoseconds: UInt64(timeout * 1_000_000_000))
                guard !Task.isCancelled, let self, let entry = self.pending.removeValue(forKey: id) else { return }
                entry.continuation.resume(throwing: RemoteMessageError("The computer took too long to answer"))
            }
            pending[id] = (continuation, timer)
            var frame: [String: JSONValue] = ["t": "req", "id": .int(id), "ch": .string(channelName)]
            if let arg { frame["a"] = arg }
            if !send(.object(frame)), let entry = pending.removeValue(forKey: id) {
                entry.timer.cancel()
                entry.continuation.resume(throwing: RemoteDisconnectedError())
            }
        }
    }

    /// Ask for the full event stream of these chats (replaces the last set).
    func subscribe(_ chatIds: [String]) {
        _ = send(["t": "sub", "chats": .array(chatIds.map(JSONValue.string))])
    }

    func close() {
        guard !closed else { return }
        closed = true
        raceTask?.cancel()
        receiveTask?.cancel()
        pingTask?.cancel()
        socket?.cancel(with: .goingAway, reason: nil)
        socket = nil
        channel = nil
        let waiting = pending
        pending.removeAll()
        for entry in waiting.values {
            entry.timer.cancel()
            entry.continuation.resume(throwing: RemoteDisconnectedError())
        }
        onClose?()
    }
}
