import PiRemoteKit
import SwiftUI

private let imageExtensions: Set<String> = ["png", "jpg", "jpeg", "gif", "webp"]

private struct FileLine: Identifiable {
    let number: Int
    let text: AttributedString
    var id: Int { number }
}

/// A text file of the project, read-only, with line numbers.
struct FileView: View {
    let cwd: String
    let path: String

    @Environment(\.theme) private var theme
    @State private var file: FileReadResult?
    @State private var lines: [FileLine] = []
    /// Width of one digit of the line numbers, wider at larger text sizes.
    @ScaledMetric(relativeTo: .caption) private var digitWidth: CGFloat = 7.5
    /// The highlighted tokens, kept to recolor the lines when light and dark switch.
    @State private var tokens: [[CodeToken]] = []
    @Environment(\.colorScheme) private var colorScheme
    @State private var error: String?
    @State private var image: UIImage?
    @State private var imageError: String?
    @State private var lightbox: LightboxItem?

    private var isImage: Bool {
        guard let file else { return false }
        return file.binary && imageExtensions.contains((file.relativePath as NSString).pathExtension.lowercased())
    }

    var body: some View {
        content
            .background(theme.bg.ignoresSafeArea())
            .onChange(of: colorScheme) { _, _ in
                // The colors are baked into the text: bake them again for the new palette.
                DispatchQueue.main.async { colorLines() }
            }
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .principal) {
                    VStack(spacing: 0) {
                        Text(baseName(file?.relativePath ?? path)).uiFont(16, weight: .semibold).foregroundStyle(theme.text).lineLimit(1)
                        Text(file?.relativePath ?? path).font(.mono(12)).foregroundStyle(theme.muted).lineLimit(1).truncationMode(.head)
                    }
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Button {
                        if let file { copyToClipboard(file.content) }
                    } label: {
                        Image(systemName: "doc.on.doc")
                    }
                    .disabled(file == nil || file?.binary == true)
                    .accessibilityLabel("Copy file contents")
                }
            }
            .task { await load() }
            .fullScreenCover(item: $lightbox) { LightboxView(item: $0) }
    }

    @ViewBuilder
    private var content: some View {
        if let error {
            EmptyState(icon: "doc.questionmark", title: "Could not open the file", detail: error, actionTitle: "Retry") { Task { await load() } }
        } else if let file {
            if isImage {
                if let image {
                    Button {
                        lightbox = LightboxItem(image: image)
                    } label: {
                        Image(uiImage: image).resizable().scaledToFit().padding(Space.lg)
                    }
                    .accessibilityLabel("Open image full screen")
                } else if let imageError {
                    EmptyState(icon: "photo", title: "Could not show the image", detail: imageError)
                } else {
                    LoadingLine(text: "Loading…").frame(maxWidth: .infinity, maxHeight: .infinity)
                }
            } else if file.binary {
                EmptyState(icon: "doc", title: "Binary file", detail: "This file cannot be shown as text.")
            } else if lines.isEmpty {
                EmptyState(title: "Empty file")
            } else {
                VStack(spacing: 0) {
                    if file.truncated {
                        Text("The file is large; only its beginning is shown.")
                            .uiFont(13)
                            .foregroundStyle(theme.muted)
                            .padding(.horizontal, Space.lg)
                            .padding(.vertical, Space.sm)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .overlay(alignment: .bottom) { Rectangle().fill(theme.border).frame(height: 1) }
                    }
                    let gutter = CGFloat(max(3, String(lines.count).count)) * digitWidth + Space.md
                    ScrollView {
                        LazyVStack(alignment: .leading, spacing: 0) {
                            ForEach(lines) { line in
                                HStack(alignment: .top, spacing: Space.sm) {
                                    Text("\(line.number)").font(.mono(12)).foregroundStyle(theme.muted).frame(width: gutter, alignment: .trailing)
                                    Text(line.text).frame(maxWidth: .infinity, alignment: .leading)
                                }
                                .padding(.trailing, Space.md)
                            }
                        }
                        .textSelection(.enabled)
                        .padding(.vertical, Space.sm)
                    }
                }
            }
        } else {
            LoadingLine(text: "Loading…").frame(maxWidth: .infinity, maxHeight: .infinity)
        }
    }

    private func colorLines() {
        lines = tokens.enumerated().map { index, tokens in
            FileLine(number: index + 1, text: tokens.isEmpty ? AttributedString(" ") : highlighted(tokens, theme: theme, size: 12.5))
        }
    }

    private func load() async {
        error = nil
        do {
            let result = try await API.readFile(cwd, path)
            file = result
            if !result.binary {
                var rows = highlightLines(result.content, lang: languageOfPath(result.relativePath))
                if rows.count > 1, rows.last?.isEmpty == true, result.content.hasSuffix("\n") { rows.removeLast() }
                tokens = rows
                colorLines()
            } else if isImage {
                do {
                    let remote = try await API.readImage(cwd, path)
                    image = ImageCache.shared.image(key: "file:\(cwd):\(path):\(remote.data.count)", base64: remote.data)
                    if image == nil { imageError = "The image could not be decoded." }
                } catch {
                    imageError = errorText(error)
                }
            }
        } catch {
            self.error = errorText(error)
        }
    }
}
