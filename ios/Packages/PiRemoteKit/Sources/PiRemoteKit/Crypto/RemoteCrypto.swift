import CryptoKit
import Foundation
import Security

/**
 * End-to-end encryption of the remote-control link, the Swift twin of
 * src/shared/remote/crypto.ts (see docs/remote.md):
 *
 *   phone   → { c: static public, e: ephemeral public }
 *   desktop → { e: ephemeral public }
 *
 * Session keys are SHA-512 over a context string, all four public keys and
 * three X25519 results (ephemeral/ephemeral, phone-ephemeral/desktop-static,
 * phone-static/desktop-ephemeral). Frames are XSalsa20-Poly1305 boxes whose
 * nonce is an implicit per-direction counter.
 */
public enum RemoteCrypto {
    public static let keyBytes = 32
    static let context = "pi-desktop-remote-v1"

    public struct KeyPair: Sendable {
        public let publicKey: [UInt8]
        public let secretKey: [UInt8]
    }

    public struct SessionKeys: Sendable {
        /// Key for frames the phone sends.
        public let clientToServer: [UInt8]
        /// Key for frames the desktop sends.
        public let serverToClient: [UInt8]
    }

    public enum CryptoError: Error {
        case invalidKey
    }

    public static func randomBytes(_ count: Int) -> [UInt8] {
        var bytes = [UInt8](repeating: 0, count: count)
        let status = SecRandomCopyBytes(kSecRandomDefault, count, &bytes)
        precondition(status == errSecSuccess, "No secure random source")
        return bytes
    }

    public static func generateKeyPair() -> KeyPair {
        let key = Curve25519.KeyAgreement.PrivateKey()
        return KeyPair(publicKey: Array(key.publicKey.rawRepresentation), secretKey: Array(key.rawRepresentation))
    }

    public static func keyPair(fromSecret secret: [UInt8]) throws -> KeyPair {
        guard secret.count == keyBytes else { throw CryptoError.invalidKey }
        let key = try Curve25519.KeyAgreement.PrivateKey(rawRepresentation: secret)
        return KeyPair(publicKey: Array(key.publicKey.rawRepresentation), secretKey: secret)
    }

    /// X25519, refusing a low-order point (the peer contributed nothing).
    static func dh(_ secret: [UInt8], _ publicKey: [UInt8]) throws -> [UInt8] {
        guard publicKey.count == keyBytes, secret.count == keyBytes else { throw CryptoError.invalidKey }
        let mine = try Curve25519.KeyAgreement.PrivateKey(rawRepresentation: secret)
        let theirs = try Curve25519.KeyAgreement.PublicKey(rawRepresentation: publicKey)
        let shared: [UInt8]
        do {
            shared = try mine.sharedSecretFromKeyAgreement(with: theirs).withUnsafeBytes { Array($0) }
        } catch {
            throw CryptoError.invalidKey
        }
        guard shared.contains(where: { $0 != 0 }) else { throw CryptoError.invalidKey }
        return shared
    }

    static func derive(
        serverStatic: [UInt8],
        clientStatic: [UInt8],
        clientEphemeral: [UInt8],
        serverEphemeral: [UInt8],
        shared: [[UInt8]]
    ) -> SessionKeys {
        var hasher = SHA512()
        hasher.update(data: Data(context.utf8))
        for part in [serverStatic, clientStatic, clientEphemeral, serverEphemeral] + shared {
            hasher.update(data: part)
        }
        let digest = Array(hasher.finalize())
        return SessionKeys(
            clientToServer: Array(digest[0..<keyBytes]),
            serverToClient: Array(digest[keyBytes..<keyBytes * 2])
        )
    }

    /// Phone side of the handshake.
    public static func clientSessionKeys(
        clientStatic: KeyPair,
        clientEphemeral: KeyPair,
        serverStaticPublic: [UInt8],
        serverEphemeralPublic: [UInt8]
    ) throws -> SessionKeys {
        derive(
            serverStatic: serverStaticPublic,
            clientStatic: clientStatic.publicKey,
            clientEphemeral: clientEphemeral.publicKey,
            serverEphemeral: serverEphemeralPublic,
            shared: [
                try dh(clientEphemeral.secretKey, serverEphemeralPublic),
                try dh(clientEphemeral.secretKey, serverStaticPublic),
                try dh(clientStatic.secretKey, serverEphemeralPublic)
            ]
        )
    }

    /// Desktop side (used by the tests to check both ends agree).
    public static func serverSessionKeys(
        serverStatic: KeyPair,
        serverEphemeral: KeyPair,
        clientStaticPublic: [UInt8],
        clientEphemeralPublic: [UInt8]
    ) throws -> SessionKeys {
        derive(
            serverStatic: serverStatic.publicKey,
            clientStatic: clientStaticPublic,
            clientEphemeral: clientEphemeralPublic,
            serverEphemeral: serverEphemeral.publicKey,
            shared: [
                try dh(serverEphemeral.secretKey, clientEphemeralPublic),
                try dh(serverStatic.secretKey, clientEphemeralPublic),
                try dh(serverEphemeral.secretKey, clientStaticPublic)
            ]
        )
    }
}

/**
 * One established session. The n-th frame sent is sealed with nonce n and
 * the receiver only accepts the n-th frame it reads: a mismatch means the
 * stream was tampered with and the connection must be dropped.
 */
public final class SecureChannel: @unchecked Sendable {
    private let sendKey: [UInt8]
    private let receiveKey: [UInt8]
    private var sendCounter: UInt64 = 0
    private var receiveCounter: UInt64 = 0
    private let lock = NSLock()

    public init(sendKey: [UInt8], receiveKey: [UInt8]) {
        self.sendKey = sendKey
        self.receiveKey = receiveKey
    }

    public static func forClient(_ keys: RemoteCrypto.SessionKeys) -> SecureChannel {
        SecureChannel(sendKey: keys.clientToServer, receiveKey: keys.serverToClient)
    }

    public static func forServer(_ keys: RemoteCrypto.SessionKeys) -> SecureChannel {
        SecureChannel(sendKey: keys.serverToClient, receiveKey: keys.clientToServer)
    }

    /// Big-endian counter in the last 8 bytes of a 24-byte nonce.
    static func nonce(_ counter: UInt64) -> [UInt8] {
        var nonce = [UInt8](repeating: 0, count: SecretBox.nonceLength)
        var value = counter
        for i in stride(from: nonce.count - 1, through: nonce.count - 8, by: -1) {
            nonce[i] = UInt8(truncatingIfNeeded: value)
            value >>= 8
        }
        return nonce
    }

    public func seal(_ plain: [UInt8]) -> [UInt8] {
        lock.lock()
        let counter = sendCounter
        sendCounter += 1
        lock.unlock()
        return SecretBox.seal(plain, nonce: Self.nonce(counter), key: sendKey)
    }

    /// Nil when the frame is forged, replayed or out of order.
    public func open(_ box: [UInt8]) -> [UInt8]? {
        lock.lock()
        defer { lock.unlock() }
        guard let plain = SecretBox.open(box, nonce: Self.nonce(receiveCounter), key: receiveKey) else { return nil }
        receiveCounter += 1
        return plain
    }
}
