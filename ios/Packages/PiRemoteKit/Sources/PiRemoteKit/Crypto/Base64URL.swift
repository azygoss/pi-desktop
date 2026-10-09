import Foundation

/// Unpadded base64url, as the pairing link and handshake carry keys.
public enum Base64URL {
    private static let alphabet = Array("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_".utf8)
    private static let lookup: [Int16] = {
        var table = [Int16](repeating: -1, count: 128)
        for (i, ch) in alphabet.enumerated() { table[Int(ch)] = Int16(i) }
        return table
    }()

    public static func encode(_ bytes: [UInt8]) -> String {
        var out = [UInt8]()
        out.reserveCapacity((bytes.count * 4 + 2) / 3)
        var i = 0
        while i + 2 < bytes.count {
            let n = UInt32(bytes[i]) << 16 | UInt32(bytes[i + 1]) << 8 | UInt32(bytes[i + 2])
            out.append(alphabet[Int((n >> 18) & 63)])
            out.append(alphabet[Int((n >> 12) & 63)])
            out.append(alphabet[Int((n >> 6) & 63)])
            out.append(alphabet[Int(n & 63)])
            i += 3
        }
        if i + 1 == bytes.count {
            let n = UInt32(bytes[i]) << 16
            out.append(alphabet[Int((n >> 18) & 63)])
            out.append(alphabet[Int((n >> 12) & 63)])
        } else if i + 2 == bytes.count {
            let n = UInt32(bytes[i]) << 16 | UInt32(bytes[i + 1]) << 8
            out.append(alphabet[Int((n >> 18) & 63)])
            out.append(alphabet[Int((n >> 12) & 63)])
            out.append(alphabet[Int((n >> 6) & 63)])
        }
        return String(decoding: out, as: UTF8.self)
    }

    /// Nil for anything that is not unpadded base64url.
    public static func decode(_ text: String) -> [UInt8]? {
        let chars = Array(text.utf8)
        if chars.count % 4 == 1 { return nil }
        var out = [UInt8]()
        out.reserveCapacity(chars.count * 3 / 4)
        var bits = 0
        var value: UInt32 = 0
        for ch in chars {
            guard ch < 128 else { return nil }
            let digit = lookup[Int(ch)]
            guard digit >= 0 else { return nil }
            value = (value << 6) | UInt32(digit)
            bits += 6
            if bits >= 8 {
                bits -= 8
                out.append(UInt8(truncatingIfNeeded: value >> UInt32(bits)))
            }
        }
        return out
    }
}
