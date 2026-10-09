import PiRemoteKit
import SwiftUI

/// Where links in replies go: project files open in the viewer, `localhost`
/// is the computer (set by the chat on screen).
struct LinkContext {
    var openFile: ((String) -> Void)?
    var computerHost: String?
}

private struct LinkContextKey: EnvironmentKey {
    static let defaultValue = LinkContext()
}

extension EnvironmentValues {
    var linkContext: LinkContext {
        get { self[LinkContextKey.self] }
        set { self[LinkContextKey.self] = newValue }
    }
}

/// Links to files are carried in a private scheme until tapped.
private let fileScheme = "pi-file"

private func linkURL(_ href: String) -> URL? {
    let target = href.trimmingCharacters(in: .whitespaces)
    if target.range(of: "^(https?|mailto|tel):", options: [.regularExpression, .caseInsensitive]) != nil {
        return URL(string: target) ?? URL(string: target.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? "")
    }
    var path = target.replacingOccurrences(of: "^file://", with: "", options: [.regularExpression, .caseInsensitive])
    path = path.replacingOccurrences(of: "#.*$", with: "", options: .regularExpression)
    guard !path.isEmpty, path.range(of: "^[a-z][a-z0-9+.-]*:", options: [.regularExpression, .caseInsensitive]) == nil else { return nil }
    var components = URLComponents()
    components.scheme = fileScheme
    components.host = "open"
    components.queryItems = [URLQueryItem(name: "path", value: path.removingPercentEncoding ?? path)]
    return components.url
}

private let localHost = try! NSRegularExpression(pattern: "^(https?://)(localhost|127\\.0\\.0\\.1|0\\.0\\.0\\.0|\\[::1\\])(?=[:/]|$)", options: .caseInsensitive)

/// Route a tapped link: project files to the viewer, localhost to the computer.
@MainActor
func handleLink(_ url: URL, context: LinkContext) -> OpenURLAction.Result {
    if url.scheme == fileScheme {
        guard let path = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems?.first(where: { $0.name == "path" })?.value,
            let open = context.openFile
        else {
            toast("This link cannot be opened on the phone")
            return .handled
        }
        open(path)
        return .handled
    }
    let text = url.absoluteString
    let range = NSRange(location: 0, length: (text as NSString).length)
    if localHost.firstMatch(in: text, range: range) != nil {
        // "localhost" is the computer, not this phone.
        guard let host = context.computerHost else {
            toast("That link points at the computer itself")
            return .handled
        }
        let bare = host.trimmingCharacters(in: CharacterSet(charactersIn: "[]"))
        let rewritten = localHost.stringByReplacingMatches(
            in: text,
            range: range,
            withTemplate: "$1\(bare.contains(":") ? "[\(bare)]" : bare)"
        )
        toast("Opening on \(host). The server must listen on the network, not only on localhost.")
        if let target = URL(string: rewritten) { return .systemAction(target) }
        return .handled
    }
    return .systemAction
}

// MARK: - Inline

private struct InlineStyle {
    var bold = false
    var italic = false
    var strike = false
}

@MainActor
func attributedInline(_ nodes: [MarkdownInline], theme: Theme, size: CGFloat = 16, weight: Font.Weight = .regular) -> AttributedString {
    var out = AttributedString()
    func append(_ nodes: [MarkdownInline], _ style: InlineStyle, link: URL?) {
        for node in nodes {
            switch node {
            case .text(let text):
                var piece = AttributedString(text)
                var font = Font.system(size: size, weight: style.bold ? .semibold : weight)
                if style.italic { font = font.italic() }
                piece.font = font
                if style.strike {
                    piece.strikethroughStyle = .single
                    piece.foregroundColor = theme.muted
                }
                if let link {
                    piece.link = link
                    piece.foregroundColor = theme.accent
                    piece.underlineStyle = .single
                }
                out += piece
            case .lineBreak:
                out += AttributedString("\n")
            case .code(let text):
                var piece = AttributedString(text)
                piece.font = .mono(size - 2)
                piece.backgroundColor = theme.codeBg
                piece.foregroundColor = link == nil ? theme.text : theme.accent
                if let link { piece.link = link }
                out += piece
            case .strong(let children):
                var next = style
                next.bold = true
                append(children, next, link: link)
            case .em(let children):
                var next = style
                next.italic = true
                append(children, next, link: link)
            case .del(let children):
                var next = style
                next.strike = true
                append(children, next, link: link)
            case .link(let href, let children):
                append(children, style, link: linkURL(href) ?? link)
            }
        }
    }
    append(nodes, InlineStyle(), link: nil)
    return out
}

// MARK: - Code

private func tokenColor(_ kind: TokenKind, _ theme: Theme) -> Color? {
    switch kind {
    case .plain: return nil
    case .comment: return theme.muted
    case .string, .added: return theme.success
    case .keyword: return theme.accent
    case .number: return theme.warning
    case .removed: return theme.danger
    }
}

@MainActor
func highlighted(_ tokens: [CodeToken], theme: Theme, size: CGFloat) -> AttributedString {
    var out = AttributedString()
    for token in tokens {
        var piece = AttributedString(token.text)
        piece.foregroundColor = tokenColor(token.kind, theme) ?? theme.text
        out += piece
    }
    out.font = .mono(size)
    return out
}

/// A fenced code block: scrolls sideways instead of wrapping, with a copy button.
struct CodeBlockView: View, Equatable {
    let text: String
    let lang: String
    @Environment(\.theme) private var theme

    nonisolated static func == (lhs: CodeBlockView, rhs: CodeBlockView) -> Bool {
        lhs.text == rhs.text && lhs.lang == rhs.lang
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack {
                Text(lang.isEmpty ? "text" : lang).font(.mono(12)).foregroundStyle(theme.muted)
                Spacer()
                Button {
                    copyToClipboard(text)
                } label: {
                    Image(systemName: "doc.on.doc").font(.system(size: 13)).foregroundStyle(theme.muted)
                        .frame(width: 40, height: 36)
                }
                .accessibilityLabel("Copy code")
            }
            .padding(.leading, Space.md)
            .overlay(alignment: .bottom) { Rectangle().fill(theme.border).frame(height: 0.5) }
            ScrollView(.horizontal, showsIndicators: false) {
                Text(highlighted(highlight(text, lang: lang), theme: theme, size: 13))
                    .lineSpacing(3)
                    .textSelection(.enabled)
                    .padding(Space.md)
                    .fixedSize(horizontal: true, vertical: false)
            }
        }
        .background(RoundedRectangle(cornerRadius: Radius.md).fill(theme.codeBg))
        .overlay(RoundedRectangle(cornerRadius: Radius.md).strokeBorder(theme.border, lineWidth: 0.5))
        .clipShape(RoundedRectangle(cornerRadius: Radius.md))
    }
}

// MARK: - Blocks

private struct BlocksView: View {
    let blocks: [MarkdownBlock]
    let selectable: Bool
    @Environment(\.theme) private var theme

    var body: some View {
        VStack(alignment: .leading, spacing: Space.md) {
            ForEach(Array(blocks.enumerated()), id: \.offset) { _, block in
                BlockView(block: block, selectable: selectable)
            }
        }
    }
}

private struct SelectableText: View {
    let text: AttributedString
    let selectable: Bool

    var body: some View {
        if selectable {
            Text(text).textSelection(.enabled)
        } else {
            Text(text)
        }
    }
}

private struct BlockView: View {
    let block: MarkdownBlock
    let selectable: Bool
    @Environment(\.theme) private var theme

    var body: some View {
        switch block {
        case .paragraph(let inline):
            SelectableText(text: attributedInline(inline, theme: theme), selectable: selectable)
                .foregroundStyle(theme.text)
                .lineSpacing(4)
                .frame(maxWidth: .infinity, alignment: .leading)
        case .heading(let level, let inline):
            SelectableText(
                text: attributedInline(inline, theme: theme, size: level == 1 ? 21 : level == 2 ? 18 : 16, weight: .semibold),
                selectable: selectable
            )
            .foregroundStyle(theme.text)
            .accessibilityAddTraits(.isHeader)
            .frame(maxWidth: .infinity, alignment: .leading)
        case .code(let lang, let text):
            CodeBlockView(text: text, lang: lang).equatable()
        case .quote(let blocks):
            HStack(alignment: .top, spacing: Space.md) {
                Rectangle().fill(theme.borderStrong).frame(width: 2)
                BlocksView(blocks: blocks, selectable: selectable)
            }
            .fixedSize(horizontal: false, vertical: true)
        case .rule:
            Rectangle().fill(theme.borderStrong).frame(height: 0.5)
        case .list(let ordered, let start, let items):
            VStack(alignment: .leading, spacing: Space.xs) {
                ForEach(Array(items.enumerated()), id: \.offset) { index, item in
                    HStack(alignment: .firstTextBaseline, spacing: Space.sm) {
                        Text(item.checked.map { $0 ? "☑" : "☐" } ?? (ordered ? "\(start + index)." : "•"))
                            .font(.system(size: 16))
                            .foregroundStyle(theme.muted)
                            .frame(minWidth: 18, alignment: .trailing)
                        BlocksView(blocks: item.blocks, selectable: selectable)
                    }
                }
            }
        case .table(let header, let rows):
            TableBlock(header: header, rows: rows)
        }
    }
}

private struct TableBlock: View {
    let header: [[MarkdownInline]]
    let rows: [[[MarkdownInline]]]
    @Environment(\.theme) private var theme

    var body: some View {
        // One width per column, sized by its longest cell within limits.
        let widths: [CGFloat] = header.indices.map { column in
            var longest = inlineText(header[column]).count
            for row in rows where column < row.count { longest = max(longest, inlineText(row[column]).count) }
            return min(260, max(80, CGFloat(longest) * 8.5 + 28))
        }
        ScrollView(.horizontal, showsIndicators: false) {
            VStack(alignment: .leading, spacing: 0) {
                row(header, widths: widths, head: true)
                ForEach(Array(rows.enumerated()), id: \.offset) { _, cells in
                    Rectangle().fill(theme.border).frame(height: 0.5)
                    row(cells, widths: widths, head: false)
                }
            }
            .overlay(RoundedRectangle(cornerRadius: Radius.sm).strokeBorder(theme.borderStrong, lineWidth: 0.5))
        }
    }

    private func row(_ cells: [[MarkdownInline]], widths: [CGFloat], head: Bool) -> some View {
        HStack(alignment: .top, spacing: 0) {
            ForEach(Array(widths.enumerated()), id: \.offset) { column, width in
                Text(attributedInline(column < cells.count ? cells[column] : [], theme: theme, size: 14, weight: head ? .semibold : .regular))
                    .foregroundStyle(theme.text)
                    .padding(.horizontal, Space.md)
                    .padding(.vertical, Space.sm)
                    .frame(width: width, alignment: .leading)
                    .overlay(alignment: .trailing) { Rectangle().fill(theme.border).frame(width: 0.5) }
            }
        }
    }
}

/// One top-level chunk, parsed once per distinct string.
private struct MarkdownChunk: View, Equatable {
    let text: String
    let selectable: Bool

    nonisolated static func == (lhs: MarkdownChunk, rhs: MarkdownChunk) -> Bool {
        lhs.text == rhs.text && lhs.selectable == rhs.selectable
    }

    var body: some View {
        BlocksView(blocks: parseMarkdown(text), selectable: selectable)
    }
}

/**
 * Markdown as native text. The source is split into top-level chunks that
 * render the same on their own, so a streaming reply re-parses only its
 * last, growing chunk.
 */
struct MarkdownView: View {
    let text: String
    var selectable = true
    @Environment(\.linkContext) private var links

    var body: some View {
        let chunks = splitMarkdownBlocks(text)
        VStack(alignment: .leading, spacing: Space.md) {
            ForEach(Array(chunks.enumerated()), id: \.offset) { _, chunk in
                MarkdownChunk(text: chunk, selectable: selectable).equatable()
            }
        }
        .environment(\.openURL, OpenURLAction { url in handleLink(url, context: links) })
    }
}
