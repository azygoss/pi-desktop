import Compression
import Foundation

/**
 * Wire protocol of the remote-control link (src/shared/remote/protocol.ts):
 * a request names one of the desktop's IPC channels and carries its input;
 * events are the desktop's broadcasts under their channel names.
 */
public enum RemoteProtocol {
    public static let version = 1
    public static let pairingScheme = "pidesktop"
    public static let pairingTTL: TimeInterval = 5 * 60
    public static let defaultPort = 47821

    /// First plaintext byte of every sealed frame.
    public static let frameJSON: UInt8 = 0
    public static let frameDeflate: UInt8 = 1

    /// Largest file a phone may upload.
    public static let maxUploadBytes = 20 * 1024 * 1024
}

/// What the pairing QR code carries.
public struct PairingPayload: Equatable, Sendable {
    /// Desktop's static public key (base64url).
    public var key: String
    /// One-time pairing token (base64url).
    public var token: String
    public var port: Int
    /// Addresses to try, most likely first.
    public var hosts: [String]
    public var name: String

    public init(key: String, token: String, port: Int, hosts: [String], name: String) {
        self.key = key
        self.token = token
        self.port = port
        self.hosts = hosts
        self.name = name
    }

    private static let hostPattern = try! NSRegularExpression(pattern: "^[A-Za-z0-9.\\-:\\[\\]]{1,255}$")

    static func isHost(_ text: String) -> Bool {
        hostPattern.firstMatch(in: text, range: NSRange(text.startIndex..., in: text)) != nil
    }

    /// Nil when the text is not a pairing link this version understands.
    public static func parse(_ text: String) -> PairingPayload? {
        let prefix = "\(RemoteProtocol.pairingScheme)://pair?"
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard trimmed.hasPrefix(prefix), trimmed.count <= 2048 else { return nil }
        var fields: [String: String] = [:]
        for pair in trimmed.dropFirst(prefix.count).split(separator: "&", omittingEmptySubsequences: false) {
            guard let at = pair.firstIndex(of: "="), at != pair.startIndex else { continue }
            fields[String(pair[..<at])] = String(pair[pair.index(after: at)...])
        }
        guard Int(fields["v"] ?? "") == RemoteProtocol.version else { return nil }
        let key = fields["k"] ?? ""
        let token = fields["t"] ?? ""
        guard let port = Int(fields["p"] ?? ""), (1...65535).contains(port) else { return nil }
        guard Base64URL.decode(key)?.count == 32, let tokenBytes = Base64URL.decode(token), tokenBytes.count >= 16
        else { return nil }
        var hosts: [String] = []
        for raw in (fields["h"] ?? "").split(separator: ",", omittingEmptySubsequences: false) {
            guard let host = String(raw).removingPercentEncoding else { return nil }
            if isHost(host) { hosts.append(host) }
            if hosts.count == 12 { break }
        }
        guard !hosts.isEmpty else { return nil }
        guard let decodedName = (fields["n"] ?? "").removingPercentEncoding else { return nil }
        let name = String(decodedName.prefix(80))
        return PairingPayload(key: key, token: token, port: port, hosts: hosts, name: name.isEmpty ? "Computer" : name)
    }

    public func encoded() -> String {
        let allowed = CharacterSet.alphanumerics.union(CharacterSet(charactersIn: "-._~"))
        let encode: (String) -> String = { $0.addingPercentEncoding(withAllowedCharacters: allowed) ?? $0 }
        let params = [
            "v=\(RemoteProtocol.version)",
            "k=\(key)",
            "t=\(token)",
            "p=\(port)",
            "h=\(hosts.map(encode).joined(separator: ","))",
            "n=\(encode(name))"
        ]
        return "\(RemoteProtocol.pairingScheme)://pair?\(params.joined(separator: "&"))"
    }
}

/// `ws://host:port` for a host from the pairing payload (IPv6 gets brackets).
public func remoteURL(host: String, port: Int) -> URL? {
    var bare = host
    if bare.hasPrefix("[") { bare.removeFirst() }
    if bare.hasSuffix("]") { bare.removeLast() }
    return URL(string: "ws://\(bare.contains(":") ? "[\(bare)]" : bare):\(port)")
}

/// The computer, as it introduces itself on every connection.
public struct RemoteServerInfo: Codable, Equatable, Sendable {
    public var name: String
    public var version: String
    public var platform: String
    public var homeDir: String
    public var workspaceDir: String
    public var hosts: [String]?
    /// The computer's `Date#getTimezoneOffset()` in minutes.
    public var tzOffset: Int?
    /// "desktop" or "server" (pi-remote).
    public var kind: String?
}

/// A chat with a live pi process on the computer.
public struct RemoteLiveChat: Decodable, Equatable, Sendable {
    public var chatId: String
    public var cwd: String
    public var sessionPath: String?
    public var streaming: Bool
    /// The extension dialog pi is waiting on.
    public var uiRequest: ExtensionUiRequest?

    public init(chatId: String, cwd: String, sessionPath: String?, streaming: Bool, uiRequest: ExtensionUiRequest?) {
        self.chatId = chatId
        self.cwd = cwd
        self.sessionPath = sessionPath
        self.streaming = streaming
        self.uiRequest = uiRequest
    }

    enum CodingKeys: String, CodingKey { case chatId, cwd, sessionPath, streaming, uiRequest }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        chatId = try c.decode(String.self, forKey: .chatId)
        cwd = try c.decodeIfPresent(String.self, forKey: .cwd) ?? ""
        sessionPath = try c.decodeIfPresent(String.self, forKey: .sessionPath)
        streaming = try c.decodeIfPresent(Bool.self, forKey: .streaming) ?? false
        uiRequest = (try c.decodeIfPresent(JSONValue.self, forKey: .uiRequest)).flatMap(ExtensionUiRequest.init(json:))
    }
}

public struct RemoteDirListing: Decodable, Sendable {
    public var path: String
    /// Nil at the filesystem root.
    public var parent: String?
    public var dirs: [String]
    public var repo: Bool
}

/// Remote-only channels; the rest are the desktop's IPC channel names.
public enum RemoteChannel {
    public static let liveChats = "pi-desktop:remote:live-chats"
    public static let listDirs = "pi-desktop:remote:list-dirs"
    public static let uiResolved = "pi-desktop:chat:ui-resolved"
    public static let setComputerUse = "pi-desktop:remote:set-computer-use"
    public static let exportHtml = "pi-desktop:remote:export-html"
    public static let upload = "pi-desktop:remote:upload"
    public static let readImage = "pi-desktop:remote:read-image"
}

/// Broadcast channels the phone listens to.
public enum RemoteEvent {
    public static let chatEvent = "pi-desktop:chat:event"
    public static let chatReady = "pi-desktop:chat:ready"
    public static let chatExit = "pi-desktop:chat:exit"
    public static let chatHint = "pi-desktop:chat:hint"
    public static let chatUiRequest = "pi-desktop:chat:ui-request"
    public static let chatUiResolved = "pi-desktop:chat:ui-resolved"
    public static let sideEvent = "pi-desktop:side:event"
    public static let sideExit = "pi-desktop:side:exit"
    public static let sessionsChanged = "pi-desktop:sessions:changed"
    public static let sessionMetaChanged = "pi-desktop:session-meta:changed"
    public static let automationsChanged = "pi-desktop:automations:changed"
    public static let reviewCommentsChanged = "pi-desktop:review-comments:changed"
    public static let gitChanged = "pi-desktop:git:changed"
    public static let cuaActivity = "pi-desktop:cua:activity"
}

// MARK: - Frames

/// A frame from the desktop, opened and decoded.
public enum ServerFrame: Sendable {
    case ready(deviceId: String, server: RemoteServerInfo)
    case denied(reason: String)
    case response(id: Int, result: Result<JSONValue, RemoteRequestError>)
    case event(channel: String, payload: JSONValue)
    case pong
}

public struct RemoteRequestError: Error, LocalizedError, Sendable {
    public let message: String
    public init(_ message: String) { self.message = message }
    public var errorDescription: String? { message }
}

public enum FrameCodec {
    /// Plain bytes of a client frame: a JSON marker and UTF-8 JSON.
    public static func encodeClient(_ frame: JSONValue) throws -> [UInt8] {
        [RemoteProtocol.frameJSON] + Array(try frame.serialized())
    }

    /// Decode an opened server frame; nil when it is not one.
    public static func decodeServer(_ plain: [UInt8]) -> ServerFrame? {
        guard let marker = plain.first else { return nil }
        let body = Data(plain.dropFirst())
        let json: Data
        switch marker {
        case RemoteProtocol.frameJSON:
            json = body
        case RemoteProtocol.frameDeflate:
            guard let inflated = Inflate.raw(body) else { return nil }
            json = inflated
        default:
            return nil
        }
        guard let value = try? JSONValue.parse(json), let type = value["t"]?.stringValue else { return nil }
        switch type {
        case "ready":
            guard let deviceId = value["deviceId"]?.stringValue,
                let server = try? (value["server"] ?? .null).decode(RemoteServerInfo.self)
            else { return nil }
            return .ready(deviceId: deviceId, server: server)
        case "denied":
            return .denied(reason: value["reason"]?.stringValue ?? "")
        case "res":
            guard let id = value["id"]?.intValue else { return nil }
            if value["ok"]?.isTrue == true {
                return .response(id: id, result: .success(value["d"] ?? .null))
            }
            return .response(id: id, result: .failure(RemoteRequestError(value["e"]?.stringValue ?? "Request failed")))
        case "ev":
            guard let channel = value["ch"]?.stringValue else { return nil }
            return .event(channel: channel, payload: value["d"] ?? .null)
        case "pong":
            return .pong
        default:
            return nil
        }
    }
}

/// Raw DEFLATE (RFC 1951) decompression: what the desktop's `deflateRawSync` writes.
public enum Inflate {
    public static func raw(_ data: Data) -> Data? {
        if data.isEmpty { return Data() }
        let bufferSize = 64 * 1024
        let destination = UnsafeMutablePointer<UInt8>.allocate(capacity: bufferSize)
        defer { destination.deallocate() }
        let streamPointer = UnsafeMutablePointer<compression_stream>.allocate(capacity: 1)
        defer { streamPointer.deallocate() }
        guard compression_stream_init(streamPointer, COMPRESSION_STREAM_DECODE, COMPRESSION_ZLIB) == COMPRESSION_STATUS_OK
        else { return nil }
        defer { compression_stream_destroy(streamPointer) }

        var output = Data()
        return data.withUnsafeBytes { (raw: UnsafeRawBufferPointer) -> Data? in
            guard let base = raw.bindMemory(to: UInt8.self).baseAddress else { return nil }
            streamPointer.pointee.src_ptr = base
            streamPointer.pointee.src_size = data.count
            while true {
                streamPointer.pointee.dst_ptr = destination
                streamPointer.pointee.dst_size = bufferSize
                let status = compression_stream_process(streamPointer, Int32(COMPRESSION_STREAM_FINALIZE.rawValue))
                let produced = bufferSize - streamPointer.pointee.dst_size
                if produced > 0 { output.append(destination, count: produced) }
                switch status {
                case COMPRESSION_STATUS_OK:
                    if produced == 0 && streamPointer.pointee.src_size == 0 { return output }
                    continue
                case COMPRESSION_STATUS_END:
                    return output
                default:
                    return nil
                }
            }
        }
    }
}
