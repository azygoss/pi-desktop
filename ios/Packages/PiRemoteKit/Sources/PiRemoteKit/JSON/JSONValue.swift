import Foundation

/**
 * A JSON value as the desktop sends it. The wire protocol is the desktop's
 * own IPC vocabulary, typed `unknown` in many places (tool arguments, tool
 * details, extension dialogs), so payloads are read into this tree first and
 * then into typed models.
 */
public enum JSONValue: Hashable, Sendable {
    case null
    case bool(Bool)
    case number(Double)
    case string(String)
    case array([JSONValue])
    case object([String: JSONValue])

    // MARK: Accessors

    public subscript(key: String) -> JSONValue? {
        if case .object(let fields) = self { return fields[key] }
        return nil
    }

    public subscript(index: Int) -> JSONValue? {
        if case .array(let items) = self, items.indices.contains(index) { return items[index] }
        return nil
    }

    public var stringValue: String? {
        if case .string(let text) = self { return text }
        return nil
    }

    public var doubleValue: Double? {
        if case .number(let value) = self { return value }
        return nil
    }

    /// Whole numbers only (JSON has no integer type).
    public var intValue: Int? {
        if case .number(let value) = self, value.rounded() == value, abs(value) < 9.0e15 { return Int(value) }
        return nil
    }

    public var boolValue: Bool? {
        if case .bool(let flag) = self { return flag }
        return nil
    }

    public var arrayValue: [JSONValue]? {
        if case .array(let items) = self { return items }
        return nil
    }

    public var objectValue: [String: JSONValue]? {
        if case .object(let fields) = self { return fields }
        return nil
    }

    public var isNull: Bool {
        if case .null = self { return true }
        return false
    }

    /// True for `true` only (JS truthiness is not borrowed).
    public var isTrue: Bool { boolValue == true }

    // MARK: Serialization

    /// Parse JSON text (fragments allowed).
    public static func parse(_ data: Data) throws -> JSONValue {
        let object = try JSONSerialization.jsonObject(with: data, options: [.fragmentsAllowed])
        return JSONValue(any: object)
    }

    public static func parse(_ text: String) throws -> JSONValue {
        try parse(Data(text.utf8))
    }

    /// Compact JSON text.
    public func serialized() throws -> Data {
        try JSONSerialization.data(withJSONObject: anyValue, options: [.fragmentsAllowed, .withoutEscapingSlashes])
    }

    public func serializedString() -> String {
        guard let data = try? serialized() else { return "null" }
        return String(decoding: data, as: UTF8.self)
    }

    /// Indented text (tool arguments shown in a step).
    public func prettyString() -> String {
        guard let data = try? JSONSerialization.data(
            withJSONObject: anyValue,
            options: [.fragmentsAllowed, .prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
        ) else { return "null" }
        return String(decoding: data, as: UTF8.self)
    }

    init(any: Any) {
        switch any {
        case let number as NSNumber:
            if CFGetTypeID(number) == CFBooleanGetTypeID() {
                self = .bool(number.boolValue)
            } else {
                self = .number(number.doubleValue)
            }
        case let text as String:
            self = .string(text)
        case let items as [Any]:
            self = .array(items.map(JSONValue.init(any:)))
        case let fields as [String: Any]:
            var out: [String: JSONValue] = [:]
            out.reserveCapacity(fields.count)
            for (key, value) in fields { out[key] = JSONValue(any: value) }
            self = .object(out)
        default:
            self = .null
        }
    }

    var anyValue: Any {
        switch self {
        case .null: return NSNull()
        case .bool(let flag): return flag
        case .number(let value):
            if value.rounded() == value, abs(value) < 9.0e15 { return Int64(value) }
            return value
        case .string(let text): return text
        case .array(let items): return items.map(\.anyValue)
        case .object(let fields): return fields.mapValues(\.anyValue)
        }
    }

    // MARK: Typed decoding

    /// Decode a `Decodable` model from this value.
    public func decode<T: Decodable>(_ type: T.Type = T.self) throws -> T {
        try T(from: JSONValueDecoder(value: self, codingPath: []))
    }
}

// MARK: - Literals

extension JSONValue: ExpressibleByNilLiteral, ExpressibleByBooleanLiteral, ExpressibleByIntegerLiteral,
    ExpressibleByFloatLiteral, ExpressibleByStringLiteral, ExpressibleByArrayLiteral, ExpressibleByDictionaryLiteral
{
    public init(nilLiteral: ()) { self = .null }
    public init(booleanLiteral value: Bool) { self = .bool(value) }
    public init(integerLiteral value: Int) { self = .number(Double(value)) }
    public init(floatLiteral value: Double) { self = .number(value) }
    public init(stringLiteral value: String) { self = .string(value) }
    public init(arrayLiteral elements: JSONValue...) { self = .array(elements) }
    public init(dictionaryLiteral elements: (String, JSONValue)...) {
        var fields: [String: JSONValue] = [:]
        for (key, value) in elements { fields[key] = value }
        self = .object(fields)
    }
}

public extension JSONValue {
    static func int(_ value: Int) -> JSONValue { .number(Double(value)) }
    /// `.string`, or `.null` for nil.
    static func optional(_ value: String?) -> JSONValue { value.map(JSONValue.string) ?? .null }

    /// An object without its null fields (the TS side spreads optionals in).
    static func compact(_ fields: [String: JSONValue?]) -> JSONValue {
        var out: [String: JSONValue] = [:]
        for (key, value) in fields {
            if let value, !value.isNull { out[key] = value }
        }
        return .object(out)
    }
}

// MARK: - Codable (caching to disk)

extension JSONValue: Codable {
    public init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if container.decodeNil() {
            self = .null
        } else if let flag = try? container.decode(Bool.self) {
            self = .bool(flag)
        } else if let value = try? container.decode(Double.self) {
            self = .number(value)
        } else if let text = try? container.decode(String.self) {
            self = .string(text)
        } else if let items = try? container.decode([JSONValue].self) {
            self = .array(items)
        } else {
            self = .object(try container.decode([String: JSONValue].self))
        }
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        switch self {
        case .null: try container.encodeNil()
        case .bool(let flag): try container.encode(flag)
        case .number(let value): try container.encode(value)
        case .string(let text): try container.encode(text)
        case .array(let items): try container.encode(items)
        case .object(let fields): try container.encode(fields)
        }
    }
}

// MARK: - Decoder over a JSONValue tree

struct JSONValueDecoder: Decoder {
    let value: JSONValue
    let codingPath: [CodingKey]
    var userInfo: [CodingUserInfoKey: Any] { [:] }

    func container<Key: CodingKey>(keyedBy type: Key.Type) throws -> KeyedDecodingContainer<Key> {
        guard case .object(let fields) = value else {
            throw DecodingError.typeMismatch(
                [String: JSONValue].self,
                .init(codingPath: codingPath, debugDescription: "Expected an object")
            )
        }
        return KeyedDecodingContainer(KeyedContainer<Key>(fields: fields, codingPath: codingPath))
    }

    func unkeyedContainer() throws -> UnkeyedDecodingContainer {
        guard case .array(let items) = value else {
            throw DecodingError.typeMismatch(
                [JSONValue].self,
                .init(codingPath: codingPath, debugDescription: "Expected an array")
            )
        }
        return UnkeyedContainer(items: items, codingPath: codingPath)
    }

    func singleValueContainer() throws -> SingleValueDecodingContainer {
        SingleContainer(value: value, codingPath: codingPath)
    }
}

private struct IndexKey: CodingKey {
    var stringValue: String { "\(intValue ?? 0)" }
    var intValue: Int?
    init(_ index: Int) { intValue = index }
    init?(stringValue: String) { nil }
    init?(intValue: Int) { self.intValue = intValue }
}

private func mismatch<T>(_ type: T.Type, _ path: [CodingKey], _ value: JSONValue) -> DecodingError {
    .typeMismatch(type, .init(codingPath: path, debugDescription: "Unexpected \(value)"))
}

private func decodePrimitive<T: Decodable>(_ type: T.Type, _ value: JSONValue, _ path: [CodingKey]) throws -> T {
    switch type {
    case is JSONValue.Type:
        return value as! T
    case is String.Type:
        guard case .string(let text) = value else { throw mismatch(type, path, value) }
        return text as! T
    case is Bool.Type:
        guard case .bool(let flag) = value else { throw mismatch(type, path, value) }
        return flag as! T
    case is Double.Type:
        guard case .number(let number) = value else { throw mismatch(type, path, value) }
        return number as! T
    case is Float.Type:
        guard case .number(let number) = value else { throw mismatch(type, path, value) }
        return Float(number) as! T
    case is Int.Type:
        guard case .number(let number) = value, number.isFinite else { throw mismatch(type, path, value) }
        return Int(number.rounded(.towardZero)) as! T
    case is Int64.Type:
        guard case .number(let number) = value, number.isFinite else { throw mismatch(type, path, value) }
        return Int64(number.rounded(.towardZero)) as! T
    default:
        return try T(from: JSONValueDecoder(value: value, codingPath: path))
    }
}

private struct KeyedContainer<Key: CodingKey>: KeyedDecodingContainerProtocol {
    let fields: [String: JSONValue]
    let codingPath: [CodingKey]
    var allKeys: [Key] { fields.keys.compactMap(Key.init(stringValue:)) }

    func contains(_ key: Key) -> Bool { fields[key.stringValue] != nil }

    func decodeNil(forKey key: Key) throws -> Bool {
        fields[key.stringValue]?.isNull ?? true
    }

    func decode<T: Decodable>(_ type: T.Type, forKey key: Key) throws -> T {
        guard let value = fields[key.stringValue] else {
            throw DecodingError.keyNotFound(key, .init(codingPath: codingPath, debugDescription: "Missing \(key.stringValue)"))
        }
        return try decodePrimitive(type, value, codingPath + [key])
    }

    /// Lenient: a field of the wrong type reads as absent, as it would in the
    /// desktop's TypeScript (where optional fields are checked with typeof).
    func decodeIfPresent<T: Decodable>(_ type: T.Type, forKey key: Key) throws -> T? {
        guard let value = fields[key.stringValue], !value.isNull else { return nil }
        return try? decodePrimitive(type, value, codingPath + [key])
    }

    // The protocol's default primitive overloads would throw on a mismatch.
    func decodeIfPresent(_ type: String.Type, forKey key: Key) throws -> String? { try lenient(type, key) }
    func decodeIfPresent(_ type: Bool.Type, forKey key: Key) throws -> Bool? { try lenient(type, key) }
    func decodeIfPresent(_ type: Double.Type, forKey key: Key) throws -> Double? { try lenient(type, key) }
    func decodeIfPresent(_ type: Float.Type, forKey key: Key) throws -> Float? { try lenient(type, key) }
    func decodeIfPresent(_ type: Int.Type, forKey key: Key) throws -> Int? { try lenient(type, key) }
    func decodeIfPresent(_ type: Int64.Type, forKey key: Key) throws -> Int64? { try lenient(type, key) }

    private func lenient<T: Decodable>(_ type: T.Type, _ key: Key) throws -> T? {
        guard let value = fields[key.stringValue], !value.isNull else { return nil }
        return try? decodePrimitive(type, value, codingPath + [key])
    }

    func nestedContainer<NestedKey: CodingKey>(keyedBy type: NestedKey.Type, forKey key: Key) throws
        -> KeyedDecodingContainer<NestedKey>
    {
        try JSONValueDecoder(value: fields[key.stringValue] ?? .null, codingPath: codingPath + [key])
            .container(keyedBy: type)
    }

    func nestedUnkeyedContainer(forKey key: Key) throws -> UnkeyedDecodingContainer {
        try JSONValueDecoder(value: fields[key.stringValue] ?? .null, codingPath: codingPath + [key]).unkeyedContainer()
    }

    func superDecoder() throws -> Decoder { JSONValueDecoder(value: .object(fields), codingPath: codingPath) }

    func superDecoder(forKey key: Key) throws -> Decoder {
        JSONValueDecoder(value: fields[key.stringValue] ?? .null, codingPath: codingPath + [key])
    }
}

private struct UnkeyedContainer: UnkeyedDecodingContainer {
    let items: [JSONValue]
    let codingPath: [CodingKey]
    var currentIndex = 0
    var count: Int? { items.count }
    var isAtEnd: Bool { currentIndex >= items.count }

    init(items: [JSONValue], codingPath: [CodingKey]) {
        self.items = items
        self.codingPath = codingPath
    }

    private func current() throws -> JSONValue {
        guard !isAtEnd else {
            throw DecodingError.valueNotFound(JSONValue.self, .init(codingPath: codingPath, debugDescription: "End of array"))
        }
        return items[currentIndex]
    }

    mutating func decodeNil() throws -> Bool {
        if try current().isNull {
            currentIndex += 1
            return true
        }
        return false
    }

    mutating func decode<T: Decodable>(_ type: T.Type) throws -> T {
        let value = try current()
        let decoded = try decodePrimitive(type, value, codingPath + [IndexKey(currentIndex)])
        currentIndex += 1
        return decoded
    }

    mutating func nestedContainer<NestedKey: CodingKey>(keyedBy type: NestedKey.Type) throws
        -> KeyedDecodingContainer<NestedKey>
    {
        let value = try current()
        currentIndex += 1
        return try JSONValueDecoder(value: value, codingPath: codingPath).container(keyedBy: type)
    }

    mutating func nestedUnkeyedContainer() throws -> UnkeyedDecodingContainer {
        let value = try current()
        currentIndex += 1
        return try JSONValueDecoder(value: value, codingPath: codingPath).unkeyedContainer()
    }

    mutating func superDecoder() throws -> Decoder {
        let value = try current()
        currentIndex += 1
        return JSONValueDecoder(value: value, codingPath: codingPath)
    }
}

private struct SingleContainer: SingleValueDecodingContainer {
    let value: JSONValue
    let codingPath: [CodingKey]

    func decodeNil() -> Bool { value.isNull }

    func decode<T: Decodable>(_ type: T.Type) throws -> T {
        try decodePrimitive(type, value, codingPath)
    }
}

/// Decode a list leniently: elements that do not fit are skipped.
public struct LenientArray<Element: Decodable>: Decodable {
    public var items: [Element]

    public init(from decoder: Decoder) throws {
        var container = try decoder.unkeyedContainer()
        var out: [Element] = []
        while !container.isAtEnd {
            let value = try container.decode(JSONValue.self)
            if let item = try? value.decode(Element.self) { out.append(item) }
        }
        items = out
    }
}
