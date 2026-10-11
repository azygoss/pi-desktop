import XCTest

@testable import PiRemoteKit

// Input from the computer that once could drop the link or crash the app.
final class RobustnessTests: XCTestCase {
    func testLoneSurrogatesParseAsReplacementCharacters() throws {
        // What JSON.stringify writes for a string cut in the middle of an emoji.
        let high = try JSONValue.parse(#"{"t":"cut \ud83d"}"#)
        XCTAssertEqual(high["t"]?.stringValue, "cut \u{FFFD}")
        let low = try JSONValue.parse(#"["\ude00 end"]"#)
        XCTAssertEqual(low.arrayValue?.first?.stringValue, "\u{FFFD} end")
    }

    func testProperPairsAndOtherEscapesSurviveTheRepair() throws {
        let value = try JSONValue.parse(#"{"a":"\ud83d\ude00","b":"\\ud83d","c":"\ud83d","d":"\"\n\u0041"}"#)
        XCTAssertEqual(value["a"]?.stringValue, "😀")
        // An escaped backslash: the text \ud83d, not an escape.
        XCTAssertEqual(value["b"]?.stringValue, #"\ud83d"#)
        XCTAssertEqual(value["c"]?.stringValue, "\u{FFFD}")
        XCTAssertEqual(value["d"]?.stringValue, "\"\nA")
    }

    func testRepairLeavesValidJSONAlone() {
        XCTAssertNil(replacingLoneSurrogates(Data(#"{"a":"\ud83d\ude00"}"#.utf8)))
        XCTAssertThrowsError(try JSONValue.parse("{not json"))
    }

    func testFramesWithLoneSurrogatesDecode() throws {
        let json = Data(#"{"t":"ev","ch":"x","d":{"text":"tool output \ud83d"}}"#.utf8)
        let frame = FrameCodec.decodeServer([RemoteProtocol.frameJSON] + [UInt8](json))
        guard case .event(let channel, let payload)? = frame else { return XCTFail("not decoded") }
        XCTAssertEqual(channel, "x")
        XCTAssertEqual(payload["text"]?.stringValue, "tool output \u{FFFD}")
    }

    func testWholeNumberNeverTraps() {
        XCTAssertEqual(wholeNumber(42.9), 42)
        XCTAssertEqual(wholeNumber(-3.5), -3)
        XCTAssertEqual(wholeNumber(.nan), 0)
        XCTAssertEqual(wholeNumber(1e300), 9_000_000_000_000_000)
        XCTAssertEqual(wholeNumber(-.infinity), Int.min)
        XCTAssertEqual(compactNumber(-1e300), "-9000000000000000")
        XCTAssertEqual(formatElapsed(1e300), "2500000000000:00:00")
    }

    func testOutOfRangeIntegersFailToDecodeInsteadOfTrapping() {
        struct Box: Decodable { let n: Int }
        XCTAssertThrowsError(try JSONValue.object(["n": .number(1e300)]).decode(Box.self))
        XCTAssertEqual(try JSONValue.object(["n": .number(7.8)]).decode(Box.self).n, 7)
    }

    func testDeltaWithImpossibleContentIndexIsIgnored() {
        for index in [-1.0, 100_000] {
            let event = AssistantMessageEvent(json: ["type": "text_delta", "contentIndex": .number(index), "delta": "x"])
            guard case .unknown = event else { return XCTFail("index \(index) was accepted") }
        }
        guard case .textDelta(let index, _) = AssistantMessageEvent(json: ["type": "text_delta", "contentIndex": 2, "delta": "x"]) else {
            return XCTFail("a normal index was refused")
        }
        XCTAssertEqual(index, 2)
    }

    func testPairingHostsAcceptIPv6() {
        XCTAssertTrue(PairingPayload.isHost("fd7a:115c:a1e0::1"))
        XCTAssertTrue(PairingPayload.isHost("[fd7a:115c:a1e0::1]"))
        XCTAssertTrue(PairingPayload.isHost("mac.tail1234.ts.net"))
        XCTAssertFalse(PairingPayload.isHost("evil.com/path"))
        XCTAssertFalse(PairingPayload.isHost(""))
    }
}
