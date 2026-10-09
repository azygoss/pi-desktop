import Foundation

// Small text helpers ported from src/shared and src/renderer/src/lib:
// skill prefixes, @-mentions, fuzzy search, provider names, sigils, date
// groups, number formatting.

// MARK: - Skill prefix (skill-prefix.ts)

public struct SkillInvocation: Hashable, Sendable {
    public var name: String
    public var location: String
    public var body: String
}

private let skillOpen = Pattern("^\\s*<skill\\b([^>]*)>([\\s\\S]*?)</skill>", caseInsensitive: true)
private let skillAttr = Pattern("([\\w-]+)\\s*=\\s*\"([^\"]*)\"")

/// Strip leading `<skill …>…</skill>` blocks pi expands `/skill:name` into.
public func parseSkillPrefix(_ text: String) -> (skills: [SkillInvocation], rest: String) {
    var skills: [SkillInvocation] = []
    var rest = text
    while let range = skillOpen.firstRange(rest), let groups = skillOpen.exec(rest) {
        var attrs: [String: String] = [:]
        for match in skillAttr.all(groups[1] ?? "") {
            if let key = match.groups[1], let value = match.groups[2] { attrs[key] = value }
        }
        skills.append(SkillInvocation(name: attrs["name"] ?? "", location: attrs["location"] ?? "", body: (groups[2] ?? "").trimmed))
        rest = (rest as NSString).substring(from: range.location + range.length)
    }
    return (skills, rest.trimmed)
}

private let imagePathToken = Pattern(
    "^\\s*(?:file://\\S+|~?/\\S+|[A-Za-z]:\\\\\\S+)\\.(?:png|jpe?g|gif|webp|bmp|heic|heif|avif|tiff?|svg)(?=\\s|$)",
    caseInsensitive: true
)
private let mentionToken = Pattern("@\"([^\"\\n]+)\"|@([^\\s\"'@=]+)")
private let dottedExtension = Pattern("\\.[A-Za-z0-9]{1,10}$")

/// A chat's title from its first user message.
public func titleFromUserText(_ text: String?) -> String? {
    guard let text else { return nil }
    let (skills, afterSkills) = parseSkillPrefix(text)
    var rest = afterSkills
    var hadImage = false
    while let range = imagePathToken.firstRange(rest) {
        hadImage = true
        rest = (rest as NSString).substring(from: range.location + range.length)
    }
    rest = rest.trimmed
    if !rest.isEmpty {
        // @path tokens collapse to the basename; @username stays.
        let ns = rest as NSString
        var out = ""
        var last = 0
        for match in mentionToken.all(rest) {
            let at = match.range.location
            let prev = at > 0 ? ns.substring(with: NSRange(location: at - 1, length: 1)) : nil
            let path = match.groups[1] ?? match.groups[2] ?? ""
            if let prev, prev != " " && prev != "\t" && prev != "\n" { continue }
            if !path.contains("/") && !dottedExtension.test(path) { continue }
            out += ns.substring(with: NSRange(location: last, length: at - last))
            var clean = path
            while clean.hasSuffix("/") { clean.removeLast() }
            out += clean.split(separator: "/").last.map(String.init) ?? clean
            last = at + match.range.length
        }
        out += ns.substring(from: last)
        return out
    }
    if hadImage { return "Image" }
    if let first = skills.first(where: { !$0.name.isEmpty }) { return "/skill:\(first.name)" }
    return text
}

// MARK: - Mentions (mentions.ts), on UTF-16 offsets like the text view's selection

public struct MentionTrigger: Equatable, Sendable {
    /// UTF-16 offset of the '@'.
    public var start: Int
    /// UTF-16 offset just past the query (the cursor).
    public var end: Int
    public var query: String
}

private let mentionDelimiters: Set<UInt16> = [32, 9, 10, 34, 39, 61] // space tab \n " ' =

/// True when `pos` sits inside a code span or fenced code block.
public func insideCode(_ text: String, _ pos: Int) -> Bool {
    let ns = text as NSString
    var inFence = false
    var i = 0
    while i < pos {
        let lineEndRange = ns.range(of: "\n", options: [], range: NSRange(location: i, length: ns.length - i))
        let lineEnd = lineEndRange.location == NSNotFound ? -1 : lineEndRange.location
        let end = lineEnd == -1 ? pos : min(lineEnd, pos)
        let line = ns.substring(with: NSRange(location: i, length: end - i))
        if line.range(of: "^\\s*```", options: .regularExpression) != nil {
            if end == pos { return inFence }
            inFence.toggle()
        } else if end == pos {
            if inFence { return true }
            if line.filter({ $0 == "`" }).count % 2 == 1 { return true }
        }
        if lineEnd == -1 { break }
        i = lineEnd + 1
    }
    return inFence
}

/// The @-mention token ending at `cursor` (UTF-16), or nil.
public func mentionTrigger(_ text: String, cursor: Int) -> MentionTrigger? {
    let ns = text as NSString
    guard cursor >= 0, cursor <= ns.length else { return nil }
    let before = ns.substring(to: cursor) as NSString
    func isDelimiter(_ index: Int) -> Bool {
        index < 0 || mentionDelimiters.contains(before.character(at: index))
    }
    let quoteAt = before.range(of: "@\"", options: .backwards).location
    if quoteAt != NSNotFound, isDelimiter(quoteAt - 1) {
        let inner = before.substring(from: quoteAt + 2)
        if !inner.contains("\"") && !inner.contains("\n") && !insideCode(text, quoteAt) {
            return MentionTrigger(start: quoteAt, end: cursor, query: inner)
        }
    }
    var tokenStart = before.length
    while tokenStart > 0 && !mentionDelimiters.contains(before.character(at: tokenStart - 1)) { tokenStart -= 1 }
    let token = before.substring(from: tokenStart)
    guard token.hasPrefix("@"), !insideCode(text, tokenStart) else { return nil }
    return MentionTrigger(start: tokenStart, end: cursor, query: String(token.dropFirst()))
}

/// `@path`, or `@"a b/c"` when the path has spaces.
public func formatMention(_ path: String) -> String {
    path.contains(" ") ? "@\"\(path)\"" : "@\(path)"
}

public func looksLikePath(_ candidate: String) -> Bool {
    candidate.contains("/") || dottedExtension.test(candidate)
}

public enum MentionSegment: Hashable, Sendable {
    case text(String)
    case mention(text: String, path: String)
}

/// Split user text into plain runs and @path chips (emails and @names stay text).
public func splitMentions(_ text: String) -> [MentionSegment] {
    let ns = text as NSString
    var segments: [MentionSegment] = []
    var last = 0
    for match in mentionToken.all(text) {
        let at = match.range.location
        if at > 0 && !mentionDelimiters.contains(ns.character(at: at - 1)) { continue }
        let path = match.groups[1] ?? match.groups[2] ?? ""
        guard looksLikePath(path) else { continue }
        if at > last { segments.append(.text(ns.substring(with: NSRange(location: last, length: at - last)))) }
        segments.append(.mention(text: match.groups[0] ?? "", path: path))
        last = at + match.range.length
    }
    if last < ns.length { segments.append(.text(ns.substring(from: last))) }
    return segments
}

// MARK: - Fuzzy (fuzzy.ts)

/// Subsequence score; -1 when `query` is not a subsequence of `text`.
public func fuzzyScore(_ query: String, _ text: String) -> Double {
    let q = Array(query.trimmed.lowercased())
    let original = Array(text)
    let t = Array(text.lowercased())
    if q.isEmpty { return 0 }
    if t.isEmpty { return -1 }
    var score = 0.0
    var ti = 0
    var lastMatch = -1
    var run = 0
    for qc in q {
        guard ti <= t.count, let at = t[ti...].firstIndex(of: qc) else { return -1 }
        if at == lastMatch + 1 {
            run += 1
            score += 4 + Double(run) * 2
        } else {
            run = 0
            score += 1
        }
        if at == 0 {
            score += 10
        } else if " /_-:.·".contains(t[at - 1]) {
            score += 5
        } else if at < original.count, String(qc) != String(qc).lowercased(), original[at].isUppercase {
            score += 3
        }
        ti = at + 1
        lastMatch = at
    }
    score -= Double(t.count) * 0.05
    score -= Double(t.firstIndex(of: q[0]) ?? 0) * 0.1
    return score
}

/// Rank by fuzzy score; input order kept on ties.
public func fuzzyFilter<T>(_ query: String, _ items: [T], _ text: (T) -> String) -> [T] {
    let q = query.trimmed
    if q.isEmpty { return items }
    var scored: [(item: T, index: Int, score: Double)] = []
    for (index, item) in items.enumerated() {
        let score = fuzzyScore(q, text(item))
        if score >= 0 { scored.append((item, index, score)) }
    }
    scored.sort { lhs, rhs in
        if lhs.score != rhs.score { return lhs.score > rhs.score }
        return lhs.index < rhs.index
    }
    return scored.map(\.item)
}

// MARK: - Providers (providers.ts)

private let providerNames: [String: String] = [
    "anthropic": "Anthropic", "openai": "OpenAI", "openai-codex": "OpenAI Codex",
    "azure-openai-responses": "Azure OpenAI", "google": "Google", "google-gemini-cli": "Gemini CLI",
    "google-antigravity": "Antigravity", "google-vertex": "Vertex AI", "github-copilot": "GitHub Copilot",
    "amazon-bedrock": "Amazon Bedrock", "vercel-ai-gateway": "Vercel AI Gateway", "openrouter": "OpenRouter",
    "xai": "xAI", "zai": "Z.ai", "deepseek": "DeepSeek", "huggingface": "Hugging Face", "minimax": "MiniMax",
    "kimi-coding": "Kimi", "lmstudio": "LM Studio"
]

/// "openai-codex" → "OpenAI Codex"; unknown ids are title-cased.
public func providerLabel(_ id: String) -> String {
    if let known = providerNames[id] { return known }
    return id.split(whereSeparator: { $0 == "-" || $0 == "_" || $0 == " " })
        .map { $0.prefix(1).uppercased() + $0.dropFirst() }
        .joined(separator: " ")
}

// MARK: - Sigil (sigil.ts)

/// A project's 3×3 pixel pattern (mirrored) and hue index, from its path.
public func sigilPattern(_ seed: String) -> (cells: [Bool], hue: Int) {
    // FNV-1a over UTF-16 code units, like the desktop's charCodeAt loop.
    var h: UInt32 = 0x811c_9dc5
    for unit in seed.utf16 {
        h ^= UInt32(unit)
        h = h &* 0x0100_0193
    }
    var bits = h & 0b111111
    let filled = (0..<6).filter { bits & (1 << $0) != 0 }.count
    if filled < 3 {
        bits |= 0b101010
    } else if bits == 0b111111 {
        bits = 0b101111
    }
    var cells: [Bool] = []
    for row in 0..<3 {
        let left = (bits >> UInt32(row)) & 1 == 1
        let mid = (bits >> UInt32(row + 3)) & 1 == 1
        cells.append(contentsOf: [left, mid, left])
    }
    return (cells, Int((h >> 8) % 6))
}

// MARK: - Date groups (date-groups.ts)

public enum DateGroup: String, CaseIterable, Sendable {
    case today = "Today"
    case yesterday = "Yesterday"
    case week = "Previous 7 days"
    case month = "Previous 30 days"
    case older = "Older"
}

private let isoFractional: ISO8601DateFormatter = {
    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    return formatter
}()

private let isoPlain: ISO8601DateFormatter = {
    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [.withInternetDateTime]
    return formatter
}()

/// Parse an ISO timestamp as JS `new Date(iso)` does for the desktop's values.
public func parseISODate(_ text: String) -> Date? {
    isoFractional.date(from: text) ?? isoPlain.date(from: text)
}

public func dateGroup(for iso: String, now: Date = Date(), calendar: Calendar = .current) -> DateGroup {
    guard let then = parseISODate(iso) else { return .older }
    let days = calendar.dateComponents([.day], from: calendar.startOfDay(for: then), to: calendar.startOfDay(for: now)).day ?? 0
    if days <= 0 { return .today }
    if days == 1 { return .yesterday }
    if days <= 7 { return .week }
    if days <= 30 { return .month }
    return .older
}

/// Group sessions by `modified` into recency buckets, in display order.
public func groupByDate(_ sessions: [SessionSummary], now: Date = Date()) -> [(group: DateGroup, items: [SessionSummary])] {
    var buckets: [DateGroup: [SessionSummary]] = [:]
    for session in sessions { buckets[dateGroup(for: session.modified, now: now), default: []].append(session) }
    return DateGroup.allCases.compactMap { group in buckets[group].map { (group, $0) } }
}

// MARK: - Formatting (mobile lib/format.ts)

/// "now", "5m", "3h", "2d", "4mo"
public func relativeTime(_ ms: Double, now: Double = nowMs()) -> String {
    let minutes = Int(floor((now - ms) / 60000))
    if minutes < 1 { return "now" }
    if minutes < 60 { return "\(minutes)m" }
    let hours = minutes / 60
    if hours < 24 { return "\(hours)h" }
    let days = hours / 24
    if days < 30 { return "\(days)d" }
    return "\(days / 30)mo"
}

public func relativeTime(iso: String) -> String {
    guard let date = parseISODate(iso) else { return "" }
    return relativeTime(date.timeIntervalSince1970 * 1000)
}

/// 1234 → "1.2k", 1_250_000 → "1.3M"
public func compactNumber(_ n: Double) -> String {
    if n < 1000 { return "\(Int(n.rounded()))" }
    if n < 1_000_000 { return String(format: n < 10_000 ? "%.1fk" : "%.0fk", n / 1000) }
    return String(format: "%.1fM", n / 1_000_000)
}

public func formatCost(_ cost: Double) -> String {
    if cost <= 0 { return "$0" }
    return cost < 0.01 ? "<$0.01" : String(format: "$%.2f", cost)
}

/// Last path segment; "~" for the home directory itself.
public func baseName(_ path: String, homeDir: String? = nil) -> String {
    if let homeDir, path == homeDir { return "~" }
    return path.split(whereSeparator: { $0 == "/" || $0 == "\\" }).last.map(String.init) ?? path
}

/// A path with the home directory collapsed to "~".
public func tildePath(_ path: String, homeDir: String?) -> String {
    guard let homeDir, homeDir != "/", path.hasPrefix(homeDir) else { return path }
    return "~" + path.dropFirst(homeDir.count)
}
