import Foundation
import XCTest

@testable import PiRemoteKit

private func bytes(_ hex: String) -> [UInt8] {
    var out: [UInt8] = []
    var index = hex.startIndex
    while index < hex.endIndex {
        let next = hex.index(index, offsetBy: 2)
        out.append(UInt8(hex[index..<next], radix: 16)!)
        index = next
    }
    return out
}

private func hex(_ bytes: [UInt8]) -> String { bytes.map { String(format: "%02x", $0) }.joined() }

private func seq(_ n: Int, _ step: Int) -> [UInt8] { (0..<n).map { UInt8(truncatingIfNeeded: $0 * step + 7) } }

final class CryptoTests: XCTestCase {
    private var vectors: JSONValue!

    override func setUpWithError() throws {
        vectors = try JSONValue.parse(referenceVectors)
    }

    func testSecretBoxMatchesTweetNaCl() throws {
        let key = bytes(vectors["key"]!.stringValue!)
        let nonce = bytes(vectors["nonce"]!.stringValue!)
        XCTAssertEqual(key, seq(32, 13))
        XCTAssertEqual(nonce, seq(24, 29))
        for item in vectors["boxes"]!.arrayValue! {
            let n = item["n"]!.intValue!
            let expected = item["box"]!.stringValue!
            let message = seq(n, 3)
            let sealed = SecretBox.seal(message, nonce: nonce, key: key)
            XCTAssertEqual(hex(sealed), expected, "seal of \(n) bytes")
            XCTAssertEqual(SecretBox.open(sealed, nonce: nonce, key: key), message, "open of \(n) bytes")
        }
    }

    func testSecretBoxRejectsTampering() {
        let key = seq(32, 13)
        let nonce = seq(24, 29)
        var sealed = SecretBox.seal(Array("hello".utf8), nonce: nonce, key: key)
        sealed[sealed.count - 1] ^= 1
        XCTAssertNil(SecretBox.open(sealed, nonce: nonce, key: key))
        XCTAssertNil(SecretBox.open([1, 2, 3], nonce: nonce, key: key))
    }

    func testKeyPairsAndSessionKeysMatchDesktop() throws {
        let clientStatic = try RemoteCrypto.keyPair(fromSecret: seq(32, 5))
        let clientEphemeral = try RemoteCrypto.keyPair(fromSecret: seq(32, 11))
        let serverStatic = try RemoteCrypto.keyPair(fromSecret: seq(32, 17))
        let serverEphemeral = try RemoteCrypto.keyPair(fromSecret: seq(32, 23))
        let pub = vectors["pub"]!
        XCTAssertEqual(hex(clientStatic.publicKey), pub["c"]!.stringValue!)
        XCTAssertEqual(hex(clientEphemeral.publicKey), pub["ce"]!.stringValue!)
        XCTAssertEqual(hex(serverStatic.publicKey), pub["s"]!.stringValue!)
        XCTAssertEqual(hex(serverEphemeral.publicKey), pub["se"]!.stringValue!)

        let client = try RemoteCrypto.clientSessionKeys(
            clientStatic: clientStatic,
            clientEphemeral: clientEphemeral,
            serverStaticPublic: serverStatic.publicKey,
            serverEphemeralPublic: serverEphemeral.publicKey
        )
        XCTAssertEqual(hex(client.clientToServer), vectors["c2s"]!.stringValue!)
        XCTAssertEqual(hex(client.serverToClient), vectors["s2c"]!.stringValue!)

        let server = try RemoteCrypto.serverSessionKeys(
            serverStatic: serverStatic,
            serverEphemeral: serverEphemeral,
            clientStaticPublic: clientStatic.publicKey,
            clientEphemeralPublic: clientEphemeral.publicKey
        )
        XCTAssertEqual(server.clientToServer, client.clientToServer)
        XCTAssertEqual(server.serverToClient, client.serverToClient)
    }

    func testLowOrderPointIsRefused() throws {
        let mine = RemoteCrypto.generateKeyPair()
        XCTAssertThrowsError(try RemoteCrypto.dh(mine.secretKey, [UInt8](repeating: 0, count: 32)))
    }

    func testSecureChannelCountersRejectReplayAndReorder() throws {
        let keys = RemoteCrypto.SessionKeys(clientToServer: seq(32, 1), serverToClient: seq(32, 2))
        let phone = SecureChannel.forClient(keys)
        let desktop = SecureChannel.forServer(keys)
        let first = phone.seal([1])
        let second = phone.seal([2])
        XCTAssertNil(desktop.open(second), "out of order")
        XCTAssertEqual(desktop.open(first), [1])
        XCTAssertNil(desktop.open(first), "replayed")
        XCTAssertEqual(desktop.open(second), [2])
        XCTAssertEqual(phone.open(desktop.seal([9, 9])), [9, 9])
    }

    func testNonceIsBigEndianCounterInLastEightBytes() {
        let nonce = SecureChannel.nonce(0x0102)
        XCTAssertEqual(nonce.count, 24)
        XCTAssertEqual(Array(nonce[22...]), [1, 2])
        XCTAssertEqual(Array(nonce[0..<22]), [UInt8](repeating: 0, count: 22))
    }

    func testRawInflateMatchesNodeDeflateRaw() throws {
        let deflated = Data(base64Encoded: vectors["deflated"]!.stringValue!)!
        let inflated = try XCTUnwrap(Inflate.raw(deflated))
        XCTAssertEqual(inflated.count, vectors["jsonLen"]!.intValue!)
        let frame = FrameCodec.decodeServer([RemoteProtocol.frameDeflate] + Array(deflated))
        guard case .event(let channel, let payload)? = frame else { return XCTFail("not an event frame") }
        XCTAssertEqual(channel, RemoteEvent.chatEvent)
        XCTAssertEqual(payload["events"]?.arrayValue?.count, 40)
        XCTAssertEqual(payload["events"]?[39]?["assistantMessageEvent"]?["delta"]?.stringValue, "hello wörld 39")
    }

    func testBase64URLRoundTripAndValidation() {
        for n in 0..<40 {
            let data = seq(n, 37)
            XCTAssertEqual(Base64URL.decode(Base64URL.encode(data)), data)
        }
        XCTAssertEqual(Base64URL.encode([0xfb, 0xff]), "-_8")
        XCTAssertNil(Base64URL.decode("abcde"))
        XCTAssertNil(Base64URL.decode("ab+/"))
        XCTAssertNil(Base64URL.decode("ab=="))
    }
}

final class ProtocolTests: XCTestCase {
    func testPairingPayloadRoundTrip() throws {
        let payload = PairingPayload(
            key: Base64URL.encode(seq(32, 3)),
            token: Base64URL.encode(seq(16, 5)),
            port: 47821,
            hosts: ["192.168.1.20", "fe80::1", "my-mac.local"],
            name: "Example Mac"
        )
        let link = payload.encoded()
        XCTAssertTrue(link.hasPrefix("pidesktop://pair?v=1&"))
        XCTAssertEqual(PairingPayload.parse(link), payload)
    }

    func testPairingPayloadRejectsBadLinks() {
        let key = Base64URL.encode(seq(32, 3))
        let token = Base64URL.encode(seq(16, 5))
        XCTAssertNil(PairingPayload.parse("https://example.com"))
        XCTAssertNil(PairingPayload.parse("pidesktop://pair?v=2&k=\(key)&t=\(token)&p=1&h=a&n=x"))
        XCTAssertNil(PairingPayload.parse("pidesktop://pair?v=1&k=\(key)&t=short&p=1&h=a&n=x"))
        XCTAssertNil(PairingPayload.parse("pidesktop://pair?v=1&k=\(key)&t=\(token)&p=70000&h=a&n=x"))
        XCTAssertNil(PairingPayload.parse("pidesktop://pair?v=1&k=\(key)&t=\(token)&p=1&h=&n=x"))
        XCTAssertEqual(PairingPayload.parse("pidesktop://pair?v=1&k=\(key)&t=\(token)&p=1&h=a")?.name, "Computer")
    }

    func testRemoteURLBracketsIPv6() {
        XCTAssertEqual(remoteURL(host: "10.0.0.2", port: 47821)?.absoluteString, "ws://10.0.0.2:47821")
        XCTAssertEqual(remoteURL(host: "fe80::1", port: 1)?.absoluteString, "ws://[fe80::1]:1")
        XCTAssertEqual(remoteURL(host: "[fe80::1]", port: 1)?.absoluteString, "ws://[fe80::1]:1")
    }

    func testServerFrames() throws {
        func frame(_ json: String) -> ServerFrame? {
            FrameCodec.decodeServer([RemoteProtocol.frameJSON] + Array(json.utf8))
        }
        guard case .response(let id, .success(let value))? = frame(#"{"t":"res","id":4,"ok":true,"d":[1,2]}"#) else {
            return XCTFail("response")
        }
        XCTAssertEqual(id, 4)
        XCTAssertEqual(value.arrayValue?.count, 2)
        guard case .response(_, .failure(let error))? = frame(#"{"t":"res","id":5,"ok":false,"e":"nope"}"#) else {
            return XCTFail("error response")
        }
        XCTAssertEqual(error.message, "nope")
        guard case .ready(let device, let server)? = frame(
            #"{"t":"ready","deviceId":"d1","server":{"name":"Mac","version":"0.14.0","platform":"darwin","homeDir":"/Users/example","workspaceDir":"/w","kind":"server"}}"#
        ) else {
            return XCTFail("ready")
        }
        XCTAssertEqual(device, "d1")
        XCTAssertEqual(server.kind, "server")
        XCTAssertNil(frame("not json"))
        XCTAssertNil(FrameCodec.decodeServer([7, 1, 2]))
    }

    func testClientFrameEncoding() throws {
        let plain = try FrameCodec.encodeClient(["t": "req", "id": 3, "ch": "pi-desktop:app:info"])
        XCTAssertEqual(plain.first, RemoteProtocol.frameJSON)
        let value = try JSONValue.parse(Data(plain.dropFirst()))
        XCTAssertEqual(value["id"]?.intValue, 3)
        XCTAssertEqual(String(decoding: plain.dropFirst(), as: UTF8.self).contains("\"id\":3"), true)
    }
}
