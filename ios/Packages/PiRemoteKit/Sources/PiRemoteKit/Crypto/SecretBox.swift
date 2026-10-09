import Foundation

/**
 * NaCl's `crypto_secretbox` (XSalsa20-Poly1305), byte-compatible with
 * TweetNaCl's `nacl.secretbox`: the sealed box is the 16-byte Poly1305 tag
 * followed by the ciphertext. CryptoKit has no XSalsa20, so it lives here;
 * the tests check it against TweetNaCl's own output.
 */
public enum SecretBox {
    public static let keyLength = 32
    public static let nonceLength = 24
    public static let tagLength = 16

    public static func seal(_ message: [UInt8], nonce: [UInt8], key: [UInt8]) -> [UInt8] {
        precondition(key.count == keyLength && nonce.count == nonceLength)
        let subkey = Salsa20.hsalsa20(key: key, input: Array(nonce[0..<16]))
        var stream = Salsa20.Stream(key: subkey, nonce: Array(nonce[16..<24]))
        let polyKey = stream.next(32)
        var out = [UInt8](repeating: 0, count: tagLength + message.count)
        stream.xor(message, into: &out, at: tagLength)
        let tag = Poly1305.authenticate(out, from: tagLength, key: polyKey)
        out.replaceSubrange(0..<tagLength, with: tag)
        return out
    }

    /// Nil when the box does not authenticate.
    public static func open(_ box: [UInt8], nonce: [UInt8], key: [UInt8]) -> [UInt8]? {
        guard key.count == keyLength, nonce.count == nonceLength, box.count >= tagLength else { return nil }
        let subkey = Salsa20.hsalsa20(key: key, input: Array(nonce[0..<16]))
        var stream = Salsa20.Stream(key: subkey, nonce: Array(nonce[16..<24]))
        let polyKey = stream.next(32)
        let expected = Poly1305.authenticate(box, from: tagLength, key: polyKey)
        guard constantTimeEqual(expected, Array(box[0..<tagLength])) else { return nil }
        var plain = [UInt8](repeating: 0, count: box.count - tagLength)
        stream.xor(box, from: tagLength, into: &plain, at: 0)
        return plain
    }
}

/// Constant-time comparison of two byte strings.
public func constantTimeEqual(_ a: [UInt8], _ b: [UInt8]) -> Bool {
    guard a.count == b.count else { return false }
    var acc: UInt8 = 0
    for i in 0..<a.count { acc |= a[i] ^ b[i] }
    return acc == 0
}

@inline(__always) private func load32(_ bytes: [UInt8], _ offset: Int) -> UInt32 {
    UInt32(bytes[offset]) | UInt32(bytes[offset + 1]) << 8 | UInt32(bytes[offset + 2]) << 16
        | UInt32(bytes[offset + 3]) << 24
}

@inline(__always) private func store32(_ value: UInt32, _ bytes: inout [UInt8], _ offset: Int) {
    bytes[offset] = UInt8(truncatingIfNeeded: value)
    bytes[offset + 1] = UInt8(truncatingIfNeeded: value >> 8)
    bytes[offset + 2] = UInt8(truncatingIfNeeded: value >> 16)
    bytes[offset + 3] = UInt8(truncatingIfNeeded: value >> 24)
}

@inline(__always) private func rotl(_ x: UInt32, _ n: UInt32) -> UInt32 { (x << n) | (x >> (32 - n)) }

enum Salsa20 {
    /// "expand 32-byte k"
    static let sigma: [UInt32] = [0x6170_7865, 0x3320_646e, 0x7962_2d32, 0x6b20_6574]

    /// The 20-round core over a key and a 16-byte input. `h` selects HSalsa20.
    static func core(key: [UInt8], input: [UInt8], hsalsa: Bool) -> [UInt8] {
        var j = [UInt32](repeating: 0, count: 16)
        j[0] = sigma[0]
        j[1] = load32(key, 0)
        j[2] = load32(key, 4)
        j[3] = load32(key, 8)
        j[4] = load32(key, 12)
        j[5] = sigma[1]
        j[6] = load32(input, 0)
        j[7] = load32(input, 4)
        j[8] = load32(input, 8)
        j[9] = load32(input, 12)
        j[10] = sigma[2]
        j[11] = load32(key, 16)
        j[12] = load32(key, 20)
        j[13] = load32(key, 24)
        j[14] = load32(key, 28)
        j[15] = sigma[3]
        var x = j
        for _ in 0..<10 {
            x[4] ^= rotl(x[0] &+ x[12], 7)
            x[8] ^= rotl(x[4] &+ x[0], 9)
            x[12] ^= rotl(x[8] &+ x[4], 13)
            x[0] ^= rotl(x[12] &+ x[8], 18)
            x[9] ^= rotl(x[5] &+ x[1], 7)
            x[13] ^= rotl(x[9] &+ x[5], 9)
            x[1] ^= rotl(x[13] &+ x[9], 13)
            x[5] ^= rotl(x[1] &+ x[13], 18)
            x[14] ^= rotl(x[10] &+ x[6], 7)
            x[2] ^= rotl(x[14] &+ x[10], 9)
            x[6] ^= rotl(x[2] &+ x[14], 13)
            x[10] ^= rotl(x[6] &+ x[2], 18)
            x[3] ^= rotl(x[15] &+ x[11], 7)
            x[7] ^= rotl(x[3] &+ x[15], 9)
            x[11] ^= rotl(x[7] &+ x[3], 13)
            x[15] ^= rotl(x[11] &+ x[7], 18)

            x[1] ^= rotl(x[0] &+ x[3], 7)
            x[2] ^= rotl(x[1] &+ x[0], 9)
            x[3] ^= rotl(x[2] &+ x[1], 13)
            x[0] ^= rotl(x[3] &+ x[2], 18)
            x[6] ^= rotl(x[5] &+ x[4], 7)
            x[7] ^= rotl(x[6] &+ x[5], 9)
            x[4] ^= rotl(x[7] &+ x[6], 13)
            x[5] ^= rotl(x[4] &+ x[7], 18)
            x[11] ^= rotl(x[10] &+ x[9], 7)
            x[8] ^= rotl(x[11] &+ x[10], 9)
            x[9] ^= rotl(x[8] &+ x[11], 13)
            x[10] ^= rotl(x[9] &+ x[8], 18)
            x[12] ^= rotl(x[15] &+ x[14], 7)
            x[13] ^= rotl(x[12] &+ x[15], 9)
            x[14] ^= rotl(x[13] &+ x[12], 13)
            x[15] ^= rotl(x[14] &+ x[13], 18)
        }
        if hsalsa {
            var out = [UInt8](repeating: 0, count: 32)
            for (n, index) in [0, 5, 10, 15, 6, 7, 8, 9].enumerated() {
                store32(x[index], &out, n * 4)
            }
            return out
        }
        var out = [UInt8](repeating: 0, count: 64)
        for i in 0..<16 { store32(x[i] &+ j[i], &out, i * 4) }
        return out
    }

    static func hsalsa20(key: [UInt8], input: [UInt8]) -> [UInt8] {
        core(key: key, input: input, hsalsa: true)
    }

    /// The Salsa20 keystream for a key and an 8-byte nonce, block counter from 0.
    struct Stream {
        let key: [UInt8]
        var input: [UInt8]
        var block: [UInt8] = []
        var used = 64

        init(key: [UInt8], nonce: [UInt8]) {
            self.key = key
            input = nonce + [UInt8](repeating: 0, count: 8)
        }

        private mutating func refill() {
            block = Salsa20.core(key: key, input: input, hsalsa: false)
            used = 0
            // 64-bit little-endian block counter in bytes 8..<16.
            var carry: UInt16 = 1
            for i in 8..<16 {
                carry += UInt16(input[i])
                input[i] = UInt8(truncatingIfNeeded: carry)
                carry >>= 8
            }
        }

        mutating func nextByte() -> UInt8 {
            if used == 64 { refill() }
            defer { used += 1 }
            return block[used]
        }

        mutating func next(_ count: Int) -> [UInt8] {
            var out = [UInt8](repeating: 0, count: count)
            for i in 0..<count { out[i] = nextByte() }
            return out
        }

        mutating func xor(_ source: [UInt8], from start: Int = 0, into target: inout [UInt8], at offset: Int) {
            var i = start
            var o = offset
            while i < source.count {
                if used == 64 { refill() }
                let take = min(64 - used, source.count - i)
                for k in 0..<take { target[o + k] = source[i + k] ^ block[used + k] }
                used += take
                i += take
                o += take
            }
        }
    }
}

enum Poly1305 {
    /// The 16-byte tag of `message[from...]` under a one-time 32-byte key.
    static func authenticate(_ message: [UInt8], from start: Int, key: [UInt8]) -> [UInt8] {
        let mask: UInt32 = 0x3ff_ffff
        let r0 = load32(key, 0) & 0x3ff_ffff
        let r1 = (load32(key, 3) >> 2) & 0x3ff_ff03
        let r2 = (load32(key, 6) >> 4) & 0x3ff_c0ff
        let r3 = (load32(key, 9) >> 6) & 0x3f0_3fff
        let r4 = (load32(key, 12) >> 8) & 0x00f_ffff
        let s1 = UInt64(r1 * 5), s2 = UInt64(r2 * 5), s3 = UInt64(r3 * 5), s4 = UInt64(r4 * 5)
        let r0w = UInt64(r0), r1w = UInt64(r1), r2w = UInt64(r2), r3w = UInt64(r3), r4w = UInt64(r4)

        var h0: UInt32 = 0, h1: UInt32 = 0, h2: UInt32 = 0, h3: UInt32 = 0, h4: UInt32 = 0
        var offset = start
        var block = [UInt8](repeating: 0, count: 16)
        while offset < message.count {
            let remaining = message.count - offset
            var hibit: UInt32 = 1 << 24
            if remaining >= 16 {
                for k in 0..<16 { block[k] = message[offset + k] }
            } else {
                for k in 0..<16 { block[k] = k < remaining ? message[offset + k] : (k == remaining ? 1 : 0) }
                hibit = 0
            }
            offset += 16

            h0 &+= load32(block, 0) & mask
            h1 &+= (load32(block, 3) >> 2) & mask
            h2 &+= (load32(block, 6) >> 4) & mask
            h3 &+= (load32(block, 9) >> 6) & mask
            h4 &+= (load32(block, 12) >> 8) | hibit

            let a0 = UInt64(h0), a1 = UInt64(h1), a2 = UInt64(h2), a3 = UInt64(h3), a4 = UInt64(h4)
            let d0 = a0 * r0w + a1 * s4 + a2 * s3 + a3 * s2 + a4 * s1
            var d1 = a0 * r1w + a1 * r0w + a2 * s4 + a3 * s3 + a4 * s2
            var d2 = a0 * r2w + a1 * r1w + a2 * r0w + a3 * s4 + a4 * s3
            var d3 = a0 * r3w + a1 * r2w + a2 * r1w + a3 * r0w + a4 * s4
            var d4 = a0 * r4w + a1 * r3w + a2 * r2w + a3 * r1w + a4 * r0w

            var c = d0 >> 26
            h0 = UInt32(truncatingIfNeeded: d0) & mask
            d1 += c
            c = d1 >> 26
            h1 = UInt32(truncatingIfNeeded: d1) & mask
            d2 += c
            c = d2 >> 26
            h2 = UInt32(truncatingIfNeeded: d2) & mask
            d3 += c
            c = d3 >> 26
            h3 = UInt32(truncatingIfNeeded: d3) & mask
            d4 += c
            c = d4 >> 26
            h4 = UInt32(truncatingIfNeeded: d4) & mask
            h0 &+= UInt32(truncatingIfNeeded: c) &* 5
            let carry = h0 >> 26
            h0 &= mask
            h1 &+= carry
        }

        // Fully carry h.
        var c = h1 >> 26
        h1 &= mask
        h2 &+= c
        c = h2 >> 26
        h2 &= mask
        h3 &+= c
        c = h3 >> 26
        h3 &= mask
        h4 &+= c
        c = h4 >> 26
        h4 &= mask
        h0 &+= c &* 5
        c = h0 >> 26
        h0 &= mask
        h1 &+= c

        // g = h + -p
        var g0 = h0 &+ 5
        c = g0 >> 26
        g0 &= mask
        var g1 = h1 &+ c
        c = g1 >> 26
        g1 &= mask
        var g2 = h2 &+ c
        c = g2 >> 26
        g2 &= mask
        var g3 = h3 &+ c
        c = g3 >> 26
        g3 &= mask
        var g4 = h4 &+ c &- (1 << 26)

        // Select h if h < p, else g.
        var select = (g4 >> 31) &- 1
        g0 &= select
        g1 &= select
        g2 &= select
        g3 &= select
        g4 &= select
        select = ~select
        h0 = (h0 & select) | g0
        h1 = (h1 & select) | g1
        h2 = (h2 & select) | g2
        h3 = (h3 & select) | g3
        h4 = (h4 & select) | g4

        // h %= 2^128
        h0 = h0 | (h1 << 26)
        h1 = (h1 >> 6) | (h2 << 20)
        h2 = (h2 >> 12) | (h3 << 14)
        h3 = (h3 >> 18) | (h4 << 8)

        // tag = (h + pad) % 2^128
        var f = UInt64(h0) + UInt64(load32(key, 16))
        h0 = UInt32(truncatingIfNeeded: f)
        f = UInt64(h1) + UInt64(load32(key, 20)) + (f >> 32)
        h1 = UInt32(truncatingIfNeeded: f)
        f = UInt64(h2) + UInt64(load32(key, 24)) + (f >> 32)
        h2 = UInt32(truncatingIfNeeded: f)
        f = UInt64(h3) + UInt64(load32(key, 28)) + (f >> 32)
        h3 = UInt32(truncatingIfNeeded: f)

        var tag = [UInt8](repeating: 0, count: 16)
        store32(h0, &tag, 0)
        store32(h1, &tag, 4)
        store32(h2, &tag, 8)
        store32(h3, &tag, 12)
        return tag
    }
}
