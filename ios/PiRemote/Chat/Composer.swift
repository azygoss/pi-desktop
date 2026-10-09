import PhotosUI
import PiRemoteKit
import SwiftUI
import UniformTypeIdentifiers

private let maxImages = 6
private let maxSuggestions = 40

/// Drafts survive leaving the chat and restarting the app.
@MainActor
enum Drafts {
    private static var cache: [String: String] = [:]
    private static var timers: [String: Task<Void, Never>] = [:]
    private static func key(_ id: String) -> String { "pi-remote.draft.\(id)" }

    static func read(_ id: String) -> String {
        if let cached = cache[id] { return cached }
        let stored = UserDefaults.standard.string(forKey: key(id)) ?? ""
        cache[id] = stored
        return stored
    }

    static func save(_ id: String, _ text: String) {
        cache[id] = text
        timers[id]?.cancel()
        timers[id] = Task {
            try? await Task.sleep(nanoseconds: 600_000_000)
            guard !Task.isCancelled else { return }
            if text.isEmpty {
                UserDefaults.standard.removeObject(forKey: key(id))
            } else {
                UserDefaults.standard.set(text, forKey: key(id))
            }
        }
    }
}

/// Project file lists for @-mentions, fetched once per folder per app run.
@MainActor
enum ProjectFiles {
    private static var cache: [String: [String]] = [:]

    static func list(_ cwd: String) async -> [String] {
        if let cached = cache[cwd] { return cached }
        guard let files = try? await API.listFiles(cwd) else { return [] }
        cache[cwd] = files
        return files
    }
}

private struct PendingImage: Identifiable {
    let id = UUID()
    let content: ImageContent
    let preview: UIImage
}

/// Messages sent mid-run, waiting in pi's queue until it delivers them.
private struct QueueStrip: View {
    let chat: ChatModel
    @Environment(\.theme) private var theme

    var body: some View {
        if let queue = chat.view.queue, queue.count > 0 {
            VStack(alignment: .leading, spacing: Space.xs) {
                ForEach(Array((queue.steering.map { ("steer", $0) } + queue.followUp.map { ("next", $0) }).enumerated()), id: \.offset) { _, row in
                    HStack(spacing: Space.sm) {
                        Text(row.0).font(.mono(12)).foregroundStyle(theme.warning)
                        Text(row.1).font(.system(size: 14)).foregroundStyle(theme.text2).lineLimit(1)
                    }
                }
                Button("Take back to edit") { Task { await ChatStore.shared.clearQueue(chat.chatId) } }
                    .font(.system(size: 14))
                    .foregroundStyle(theme.accent)
                    .frame(minHeight: touchTarget)
            }
            .padding(.horizontal, Space.md)
            .padding(.vertical, Space.sm)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(RoundedRectangle(cornerRadius: Radius.md).fill(theme.surface))
            .padding(.bottom, Space.sm)
        }
    }
}

/**
 * The message box: text with `@` file mentions and `/` commands, photos,
 * `!command` shell runs, the model chip and the context readout. While pi
 * works, the send button stops it; text sent mid-run steers the run or
 * waits for it to end.
 */
struct Composer: View {
    let chat: ChatModel
    /// Run an app command (`/name foo`); false when it is not one.
    let onCommand: (String, String) -> Bool
    let onOpenModel: () -> Void
    let onOpenStats: () -> Void

    @Environment(\.theme) private var theme
    @State private var text = ""
    @State private var cursor = 0
    @State private var height: CGFloat = 44
    @State private var images: [PendingImage] = []
    @State private var attachOpen = false
    @State private var uploading: String?
    @State private var computerUse: Bool?
    @State private var queueMode: ChatSendMode = .steer
    @State private var files: [String] = []
    @State private var photosOpen = false
    @State private var photoItems: [PhotosPickerItem] = []
    @State private var cameraOpen = false
    @State private var fileImporterOpen = false
    @State private var draftId = ""
    @StateObject private var focus = TextFocus()

    private var streaming: Bool { chat.streaming }
    private var slash: String? { slashQuery(text) }
    private var mention: MentionTrigger? {
        slash == nil ? mentionTrigger(text, cursor: min(cursor, (text as NSString).length)) : nil
    }

    private var slashItems: [SlashCommandItem] {
        guard let slash else { return [] }
        return Array(filterSlashCommands(chat.commands, query: slash, inChat: !chat.view.messages.isEmpty, streaming: streaming).prefix(maxSuggestions))
    }

    private var mentionItems: [String] {
        guard let mention else { return [] }
        return Array(fuzzyFilter(mention.query, files) { $0 }.prefix(maxSuggestions))
    }

    private var canSend: Bool { !text.trimmed.isEmpty || !images.isEmpty }
    private var showStop: Bool { (streaming || chat.bashRunning) && !canSend }

    var body: some View {
        VStack(spacing: 0) {
            QueueStrip(chat: chat)
            if let uploading {
                HStack(spacing: Space.sm) {
                    Text("↑").font(.mono(12)).foregroundStyle(theme.accent)
                    Text("Sending \(uploading) to the computer…").font(.mono(12)).foregroundStyle(theme.muted).lineLimit(1)
                    Spacer()
                }
                .padding(.horizontal, Space.lg)
                .padding(.vertical, Space.xs)
            }
            suggestions
            box
        }
        .padding(.horizontal, Space.sm)
        .padding(.top, Space.sm)
        .overlay(alignment: .top) { Rectangle().fill(theme.border).frame(height: 0.5) }
        .background(theme.bg)
        .onAppear(perform: restoreDraft)
        .onChange(of: chat.sessionPath) { _, _ in moveDraft() }
        .onChange(of: chat.composerSeed) { _, seed in takeSeed(seed) }
        .onChange(of: text) { _, value in Drafts.save(draftId, value) }
        .task(id: mention != nil && !chat.cwd.isEmpty ? chat.cwd : "") {
            guard mention != nil, !chat.cwd.isEmpty else { return }
            files = await ProjectFiles.list(chat.cwd)
        }
        .sheet(isPresented: $attachOpen) { attachSheet.sheetChrome([.medium, .large]) }
        .photosPicker(isPresented: $photosOpen, selection: $photoItems, maxSelectionCount: maxImages, matching: .images)
        .onChange(of: photoItems) { _, items in
            guard !items.isEmpty else { return }
            photoItems = []
            Task { await addPhotos(items) }
        }
        .fullScreenCover(isPresented: $cameraOpen) {
            CameraPicker { image in addImage(image) }.ignoresSafeArea()
        }
        .fileImporter(isPresented: $fileImporterOpen, allowedContentTypes: [.item]) { result in
            if case .success(let url) = result { Task { await sendFile(url) } }
        }
    }

    // MARK: Pieces

    @ViewBuilder
    private var suggestions: some View {
        let slashList = slashItems
        let mentionList = mentionItems
        if slash != nil && !slashList.isEmpty || mention != nil && !mentionList.isEmpty {
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 0) {
                    if slash != nil {
                        ForEach(slashList) { item in
                            suggestionRow(title: "/\(item.name)", detail: item.description) { pickSlash(item) }
                        }
                    } else {
                        ForEach(mentionList, id: \.self) { path in
                            suggestionRow(title: path, detail: nil) { pickMention(path) }
                        }
                    }
                }
            }
            .frame(maxHeight: 232)
            .background(RoundedRectangle(cornerRadius: Radius.md).fill(theme.raised))
            .overlay(RoundedRectangle(cornerRadius: Radius.md).strokeBorder(theme.borderStrong, lineWidth: 0.5))
            .padding(.bottom, Space.sm)
        }
    }

    private func suggestionRow(title: String, detail: String?, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            VStack(alignment: .leading, spacing: 1) {
                Text(title).font(.mono(14)).foregroundStyle(theme.text).lineLimit(1)
                if let detail { Text(detail).font(.system(size: 13)).foregroundStyle(theme.muted).lineLimit(1) }
            }
            .padding(.horizontal, Space.md)
            .padding(.vertical, Space.sm)
            .frame(maxWidth: .infinity, minHeight: touchTarget, alignment: .leading)
        }
        .buttonStyle(RowButtonStyle())
    }

    private var box: some View {
        VStack(alignment: .leading, spacing: 0) {
            if !images.isEmpty {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: Space.sm) {
                        ForEach(Array(images.enumerated()), id: \.element.id) { index, image in
                            Image(uiImage: image.preview)
                                .resizable()
                                .scaledToFill()
                                .frame(width: 56, height: 56)
                                .clipShape(RoundedRectangle(cornerRadius: Radius.sm))
                                .overlay(alignment: .topTrailing) {
                                    Button {
                                        images.removeAll { $0.id == image.id }
                                    } label: {
                                        Image(systemName: "xmark")
                                            .font(.system(size: 10, weight: .bold))
                                            .foregroundStyle(theme.text)
                                            .frame(width: 22, height: 22)
                                            .background(Circle().fill(theme.active))
                                    }
                                    .offset(x: 6, y: -6)
                                    .accessibilityLabel("Remove image \(index + 1)")
                                }
                                .accessibilityLabel("Attached image \(index + 1)")
                        }
                    }
                    .padding(Space.sm)
                    .padding(.top, Space.xs)
                }
            }
            GrowingTextView(
                text: $text,
                cursor: $cursor,
                placeholder: streaming ? "Steer pi, or queue what comes next" : "Ask pi…   / commands   @ files   ! shell",
                minHeight: 44,
                maxHeight: 148,
                textColor: UIColor(theme.text),
                placeholderColor: UIColor(theme.muted),
                tintColor: UIColor(theme.accent),
                focus: focus,
                height: $height
            )
            .frame(height: height)
            .accessibilityIdentifier("composer-input")
            if streaming && canSend {
                HStack(spacing: Space.sm) {
                    ForEach([ChatSendMode.steer, .followUp], id: \.self) { mode in
                        Button {
                            queueMode = mode
                        } label: {
                            Text(mode == .steer ? "steer · after this step" : "next · when the run ends")
                                .font(.mono(12))
                                .foregroundStyle(queueMode == mode ? theme.text : theme.muted)
                                .padding(.horizontal, Space.md)
                                .frame(minHeight: 36)
                                .background(RoundedRectangle(cornerRadius: Radius.sm).fill(queueMode == mode ? theme.active : Color.clear))
                        }
                        .accessibilityAddTraits(queueMode == mode ? .isSelected : [])
                    }
                }
                .padding(.horizontal, Space.sm)
                .padding(.bottom, Space.xs)
            }
            HStack(spacing: 0) {
                Button {
                    attachOpen = true
                } label: {
                    Image(systemName: "plus").font(.system(size: 18)).foregroundStyle(theme.text2)
                        .frame(width: touchTarget, height: touchTarget)
                }
                .accessibilityLabel("Attach or insert")
                Button(action: onOpenModel) {
                    Text((chat.model.map { $0.name.isEmpty ? $0.id : $0.name } ?? "model")
                        + (chat.thinkingLevel.map { $0 != .off ? " · \($0.label.lowercased())" : "" } ?? ""))
                        .font(.mono(12))
                        .foregroundStyle(theme.text2)
                        .lineLimit(1)
                        .padding(.horizontal, Space.sm)
                        .frame(minHeight: touchTarget)
                }
                .accessibilityLabel("Model: \(chat.model?.name ?? "none"). Change model")
                Spacer(minLength: 0)
                if let percent = chat.stats?.contextPercent, percent >= 1 {
                    Button(action: onOpenStats) {
                        Text("\(Int(percent.rounded()))%")
                            .font(.mono(12))
                            .foregroundStyle(percent >= 85 ? theme.warning : theme.muted)
                            .padding(.horizontal, Space.sm)
                            .frame(minHeight: touchTarget)
                    }
                    .accessibilityLabel("Context \(Int(percent.rounded())) percent used. Session details")
                }
                Button(action: showStop ? stop : submit) {
                    Group {
                        if showStop {
                            Image(systemName: "stop.fill").font(.system(size: 14)).foregroundStyle(theme.danger)
                        } else {
                            Image(systemName: "arrow.up").font(.system(size: 17, weight: .bold)).foregroundStyle(canSend ? theme.onAccent : theme.muted)
                        }
                    }
                    .frame(width: 44, height: 44)
                    .background(RoundedRectangle(cornerRadius: Radius.md).fill(showStop ? theme.dangerSoft : canSend ? theme.accent : theme.active))
                }
                .disabled(!showStop && !canSend)
                .accessibilityLabel(showStop ? "Stop pi" : "Send")
                .accessibilityIdentifier("composer-send")
            }
            .padding(.leading, 2)
            .padding(.trailing, Space.xs)
            .padding(.bottom, Space.xs)
        }
        .background(RoundedRectangle(cornerRadius: Radius.lg).fill(theme.surface))
        .overlay(RoundedRectangle(cornerRadius: Radius.lg).strokeBorder(theme.borderStrong, lineWidth: 0.5))
    }

    private var attachSheet: some View {
        ActionSheetView(title: "Add to the message") {
            SheetAction(icon: "photo.on.rectangle", title: "Photo library") {
                attachOpen = false
                photosOpen = true
            }
            if UIImagePickerController.isSourceTypeAvailable(.camera) {
                SheetAction(icon: "camera", title: "Take a photo") {
                    attachOpen = false
                    cameraOpen = true
                }
            }
            if UIPasteboard.general.hasImages {
                SheetAction(icon: "doc.on.clipboard", title: "Paste image", detail: "The image on the clipboard") {
                    attachOpen = false
                    if let image = UIPasteboard.general.image { addImage(image) } else { toast("There is no image on the clipboard") }
                }
            }
            SheetAction(icon: "doc.badge.arrow.up", title: "Send a file", detail: "Any file up to 20 MB: stored on the computer, pi reads it") {
                attachOpen = false
                fileImporterOpen = true
            }
            SheetAction(icon: "at", title: "Mention a file", detail: "Search the project's files") { insert("@") }
            SheetAction(icon: "slash.circle", title: "Command", detail: "pi's skills, prompts and app commands") { insert("/") }
            SheetAction(icon: "terminal", title: "Run a shell command", detail: "Runs on the computer; its output joins the next prompt") { insert("!") }
            if let computerUse {
                SheetAction(
                    icon: "cursorarrow.click",
                    title: computerUse ? "Turn computer use off" : "Turn computer use on",
                    detail: "Lets pi operate the Mac's apps; new and restarted chats pick it up",
                    selected: computerUse
                ) { toggleComputerUse(computerUse) }
            }
        }
        .task {
            // What the sheet offers depends on the computer: looked up when it opens.
            guard let permissions = try? await API.cuaPermissions(), permissions.available else {
                computerUse = nil
                return
            }
            computerUse = try? await API.computerUseEnabled()
        }
    }

    // MARK: Drafts and seeds

    private func restoreDraft() {
        // A chat gets a new id on every app run; its session file is what lasts.
        draftId = chat.sessionPath ?? chat.chatId
        if text.isEmpty { text = Drafts.read(draftId) }
    }

    private func moveDraft() {
        let next = chat.sessionPath ?? chat.chatId
        guard next != draftId else { return }
        Drafts.save(draftId, "")
        draftId = next
        if !text.isEmpty { Drafts.save(draftId, text) }
    }

    /// Text handed over by the app: a fork's prompt, review comments, a queue taken back.
    private func takeSeed(_ seed: ComposerSeed?) {
        guard let seed else { return }
        let current = text.trimmed
        if !seed.text.isEmpty && !current.isEmpty && current != seed.text.trimmed {
            var head = text
            while head.last?.isWhitespace == true { head.removeLast() }
            text = "\(head)\n\n\(seed.text)"
        } else {
            text = seed.text
        }
        if !seed.text.isEmpty { focus.focus() }
    }

    // MARK: Picking

    private func pickSlash(_ item: SlashCommandItem) {
        if item.takesArgs || item.source != .app {
            text = "/\(item.name) "
            focus.focus()
            return
        }
        text = ""
        if !onCommand(item.name, "") { text = "/\(item.name) " }
    }

    private func pickMention(_ path: String) {
        guard let mention else { return }
        let ns = text as NSString
        text = ns.substring(to: mention.start) + formatMention(path) + " " + ns.substring(from: mention.end)
        cursor = mention.start + (formatMention(path) as NSString).length + 1
        focus.focus()
    }

    private func insert(_ prefix: String) {
        attachOpen = false
        if prefix == "@" {
            text = text.isEmpty || text.hasSuffix(" ") ? text + "@" : text + " @"
        } else {
            text = prefix + text
        }
        cursor = (text as NSString).length
        Task {
            try? await Task.sleep(nanoseconds: 350_000_000)
            focus.focus()
        }
    }

    private func addImage(_ image: UIImage) {
        guard let prepared = ImagePrep.attachment(from: image) else {
            toast("Could not add the image")
            return
        }
        images = Array((images + [PendingImage(content: prepared.content, preview: prepared.preview)]).prefix(maxImages))
    }

    private func addPhotos(_ items: [PhotosPickerItem]) async {
        for item in items.prefix(maxImages) {
            do {
                if let data = try await item.loadTransferable(type: Data.self), let image = UIImage(data: data) {
                    addImage(image)
                }
            } catch {
                toast("Could not add the image: \(errorText(error))")
            }
        }
    }

    /// Any file from the phone: stored on the computer, mentioned by path.
    private func sendFile(_ url: URL) async {
        let scoped = url.startAccessingSecurityScopedResource()
        defer { if scoped { url.stopAccessingSecurityScopedResource() } }
        do {
            let size = (try? url.resourceValues(forKeys: [.fileSizeKey]).fileSize) ?? 0
            guard size <= RemoteProtocol.maxUploadBytes else {
                toast("Files up to 20 MB can be sent")
                return
            }
            let data = try Data(contentsOf: url)
            guard data.count <= RemoteProtocol.maxUploadBytes else {
                toast("Files up to 20 MB can be sent")
                return
            }
            uploading = url.lastPathComponent
            defer { uploading = nil }
            let path = try await API.upload(name: url.lastPathComponent, base64: data.base64EncodedString())
            text = text + (text.isEmpty || text.hasSuffix(" ") ? "" : " ") + formatMention(path) + " "
            Haptic.success.play()
            focus.focus()
        } catch {
            toast("Could not send the file: \(errorText(error))")
        }
    }

    private func toggleComputerUse(_ current: Bool) {
        attachOpen = false
        let next = !current
        Task {
            do {
                try await API.setComputerUse(next)
                toast(next ? "Computer use is on. pi can use it from its next start in a chat." : "Computer use is off.")
            } catch {
                toast(errorText(error))
            }
        }
    }

    // MARK: Sending

    private func submit() {
        let message = text.trimmed
        guard !message.isEmpty || !images.isEmpty else { return }
        if let uploading {
            toast("Sending \(uploading) first…")
            return
        }
        guard Connection.shared.isOnline else {
            // Keep what was typed: it can be sent once the computer is back.
            Haptic.warning.play()
            toast("Not connected to the computer. Your message is kept.")
            return
        }
        let store = ChatStore.shared
        if message.hasPrefix("!") && message.count > 1 && images.isEmpty {
            if chat.bashRunning {
                toast("A command is still running. Stop it or wait for it to finish.")
                return
            }
            Haptic.tap.play()
            text = ""
            let command = String(message.dropFirst()).trimmed
            Task { await store.runBash(chat.chatId, command: command) }
            return
        }
        if images.isEmpty, let parsed = parseSlashSend(message), onCommand(parsed.command, parsed.args) {
            text = ""
            return
        }
        Haptic.tap.play()
        let sentImages = images
        let payload = images.isEmpty ? nil : images.map(\.content)
        let sentText = message.isEmpty ? "See the attached image." : message
        text = ""
        images = []
        let mode: ChatSendMode = streaming ? queueMode : .prompt
        let chatId = chat.chatId
        Task {
            do {
                try await store.send(chatId, message: sentText, images: payload, mode: mode)
            } catch {
                // The store hands the text back; the photos come back with it.
                images = sentImages
                toast("Could not send: \(errorText(error))")
            }
        }
    }

    private func stop() {
        Haptic.warning.play()
        let store = ChatStore.shared
        let chatId = chat.chatId
        Task {
            if chat.bashRunning {
                await store.abortBash(chatId)
            } else {
                do {
                    try await store.abort(chatId)
                } catch {
                    toast(errorText(error))
                }
            }
        }
    }
}
