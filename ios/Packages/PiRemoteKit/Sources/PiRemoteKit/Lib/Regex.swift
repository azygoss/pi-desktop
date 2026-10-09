import Foundation

/// A compiled NSRegularExpression with the small surface the ports need.
public struct Pattern: @unchecked Sendable {
    let regex: NSRegularExpression

    public init(_ pattern: String, caseInsensitive: Bool = false) {
        // Patterns are literals in this module: a bad one is a programming error.
        regex = try! NSRegularExpression(pattern: pattern, options: caseInsensitive ? [.caseInsensitive] : [])
    }

    public func test(_ text: String) -> Bool {
        regex.firstMatch(in: text, range: NSRange(location: 0, length: (text as NSString).length)) != nil
    }

    /// Capture groups of the first match (index 0 is the whole match); nil groups are absent.
    public func exec(_ text: String) -> [String?]? {
        let ns = text as NSString
        guard let match = regex.firstMatch(in: text, range: NSRange(location: 0, length: ns.length)) else { return nil }
        return (0..<match.numberOfRanges).map { i in
            let range = match.range(at: i)
            return range.location == NSNotFound ? nil : ns.substring(with: range)
        }
    }

    /// Location (UTF-16) of the first match.
    public func firstRange(_ text: String) -> NSRange? {
        regex.firstMatch(in: text, range: NSRange(location: 0, length: (text as NSString).length))?.range
    }

    public func replace(_ text: String, with template: String) -> String {
        regex.stringByReplacingMatches(
            in: text,
            range: NSRange(location: 0, length: (text as NSString).length),
            withTemplate: template
        )
    }

    /// Every match with its groups and UTF-16 range.
    public func all(_ text: String) -> [(range: NSRange, groups: [String?])] {
        let ns = text as NSString
        return regex.matches(in: text, range: NSRange(location: 0, length: ns.length)).map { match in
            (
                match.range,
                (0..<match.numberOfRanges).map { i in
                    let range = match.range(at: i)
                    return range.location == NSNotFound ? nil : ns.substring(with: range)
                }
            )
        }
    }
}

public extension String {
    /// JS `trim()`.
    var trimmed: String { trimmingCharacters(in: .whitespacesAndNewlines) }
}

/// JS `text.replace(/\s+/g, ' ').trim()`.
public func collapseWhitespace(_ text: String) -> String {
    text.split(whereSeparator: { $0.isWhitespace || $0.isNewline }).joined(separator: " ")
}

/// `truncateText` from src/shared/text.ts.
public func truncateText(_ text: String, _ maxLength: Int) -> String {
    guard text.count > maxLength else { return text }
    let head = String(text.prefix(max(0, maxLength - 1)))
    return head.replacingOccurrences(of: "\\s+$", with: "", options: .regularExpression) + "…"
}
