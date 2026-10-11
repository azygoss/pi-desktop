import Foundation
import PiRemoteKit
import Security

/// A computer this phone is paired with. Lives in the Keychain.
struct StoredPairing: Codable, Equatable, Identifiable {
    /// Desktop's static public key (base64url).
    var key: String
    var port: Int
    var hosts: [String]
    var name: String
    /// The address that worked last; tried first next time.
    var lastHost: String?
    /// "desktop" or "server" (pi-remote), learned on connecting.
    var kind: String?

    var id: String { key }
    var isServer: Bool { kind == "server" }
    var address: String { lastHost ?? hosts.first ?? "" }
}

/// Every computer this phone is paired with, and the one in use.
struct StoredComputers: Codable {
    var list: [StoredPairing]
    /// Key of the computer in use; nil when none is paired.
    var active: String?
}

/// Small Keychain wrapper. Items are readable after the first unlock so a
/// background refresh can reach the computer, and never leave this device.
enum Keychain {
    private static let service = "io.github.azygoss.piremote"

    enum Lookup {
        case found(Data)
        case missing
        /// The Keychain did not answer (locked before the first unlock, say):
        /// not the same as an item that is not there.
        case unavailable
    }

    static func lookup(_ account: String) -> Lookup {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne
        ]
        var result: AnyObject?
        switch SecItemCopyMatching(query as CFDictionary, &result) {
        case errSecSuccess: return (result as? Data).map(Lookup.found) ?? .missing
        case errSecItemNotFound: return .missing
        default: return .unavailable
        }
    }

    static func read(_ account: String) -> Data? {
        if case .found(let data) = lookup(account) { return data }
        return nil
    }

    @discardableResult
    static func write(_ account: String, _ data: Data) -> Bool {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account
        ]
        let attributes: [String: Any] = [
            kSecValueData as String: data,
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        ]
        if SecItemUpdate(query as CFDictionary, attributes as CFDictionary) == errSecSuccess { return true }
        var insert = query
        insert.merge(attributes) { $1 }
        return SecItemAdd(insert as CFDictionary, nil) == errSecSuccess
    }

    static func delete(_ account: String) {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account
        ]
        SecItemDelete(query as CFDictionary)
    }
}

enum PairingStorage {
    private static let identityKey = "pi-remote.identity"
    private static let computersKey = "pi-remote.computers"
    /// Enough for a desk, a laptop and a few servers.
    static let maxComputers = 8

    /// This phone's long-term key pair, created on first launch. Nil while the
    /// Keychain cannot be read: a new identity then would make every paired
    /// computer refuse this phone, and the pairings would be dropped.
    static func loadIdentity() -> RemoteCrypto.KeyPair? {
        switch Keychain.lookup(identityKey) {
        case .unavailable:
            return nil
        case .found(let data):
            if let text = String(data: data, encoding: .utf8),
                let secret = Base64URL.decode(text),
                let pair = try? RemoteCrypto.keyPair(fromSecret: secret)
            {
                return pair
            }
        case .missing:
            break
        }
        // Missing or damaged: a fresh identity (pairing is redone).
        let pair = RemoteCrypto.generateKeyPair()
        Keychain.write(identityKey, Data(Base64URL.encode(pair.secretKey).utf8))
        return pair
    }

    /// Nil while the Keychain cannot be read (see `loadIdentity`).
    static func loadComputers() -> StoredComputers? {
        let data: Data
        switch Keychain.lookup(computersKey) {
        case .unavailable: return nil
        case .missing: return StoredComputers(list: [], active: nil)
        case .found(let found): data = found
        }
        guard let stored = try? JSONDecoder().decode(StoredComputers.self, from: data)
        else { return StoredComputers(list: [], active: nil) }
        let list = Array(stored.list.filter { !$0.hosts.isEmpty }.prefix(maxComputers))
        let active = list.contains { $0.key == stored.active } ? stored.active : list.first?.key
        return StoredComputers(list: list, active: active)
    }

    static func saveComputers(_ computers: StoredComputers) {
        if computers.list.isEmpty {
            Keychain.delete(computersKey)
            return
        }
        if let data = try? JSONEncoder().encode(computers) { Keychain.write(computersKey, data) }
    }
}

/// Files the app keeps for itself (list caches), never anything secret.
enum AppFiles {
    static func cacheURL(_ name: String) -> URL {
        let base = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
        return base.appendingPathComponent(name)
    }

    static func temporaryURL(_ name: String) -> URL {
        FileManager.default.temporaryDirectory.appendingPathComponent(name)
    }
}
