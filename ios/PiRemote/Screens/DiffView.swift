import PiRemoteKit
import SwiftUI

/// Files with more diff lines than this start collapsed.
private let collapseLines = 400

private struct FileEntry: Identifiable {
    let file: DiffFile
    let added: Int
    let deleted: Int
    let lineCount: Int
    var id: String { file.path }
}

private struct LineTarget: Identifiable {
    let path: String
    let line: PatchLine
    var id: String { "\(path):\(line.oldNo ?? -1):\(line.newNo ?? -1)" }
    var number: Int? { line.newNo ?? line.oldNo }
}

private struct MenuTarget: Identifiable {
    let path: String
    var id: String { path }
}

/// Working-tree changes of a project: read, comment, review, commit, push.
struct DiffView: View {
    let cwd: String
    let chatId: String?

    @Environment(\.theme) private var theme
    @Environment(\.dismiss) private var dismiss
    @State private var result: RepoDiffResult?
    @State private var entries: [FileEntry] = []
    @State private var error: String?
    @State private var collapsed: Set<String> = []
    @State private var seen: Set<String> = []
    // The project's comments live on the computer, shared with its window
    // and other phones. A computer from before 0.13 cannot keep them: then
    // they stay on this screen.
    @State private var stored: [ReviewComment] = []
    @State private var shared = true
    @State private var menuTarget: MenuTarget?
    @State private var lineTarget: LineTarget?
    @State private var draft = ""
    @State private var message = ""
    @State private var busy: String?
    @State private var reviewing = false
    @State private var reviewMenu = false
    @State private var bag = SubscriptionBag()
    @State private var commentChanges = 0
    @State private var leaving = false

    private var chat: ChatModel? { chatId.flatMap { ChatStore.shared.chat($0) } }
    private var comments: [PlacedComment] { placeComments(entries.map(\.file), stored) }
    private var mine: [PlacedComment] { comments.filter { !$0.fromPi } }
    private var totals: (added: Int, deleted: Int) {
        entries.reduce((0, 0)) { ($0.0 + $1.added, $0.1 + $1.deleted) }
    }
    private var guardLeaving: Bool { !leaving && ((!shared && !mine.isEmpty) || !message.trimmed.isEmpty) }

    var body: some View {
        content
            .background(theme.bg.ignoresSafeArea())
            .navigationTitle("Changes")
            .navigationBarTitleDisplayMode(.inline)
            .navigationBarBackButtonHidden(guardLeaving)
            .toolbar {
                if guardLeaving {
                    ToolbarItem(placement: .topBarLeading) {
                        Button {
                            Task { await confirmLeave() }
                        } label: {
                            Label("Back", systemImage: "chevron.left")
                        }
                    }
                }
                ToolbarItem(placement: .principal) {
                    VStack(spacing: 0) {
                        Text("Changes").font(.system(size: 16, weight: .semibold)).foregroundStyle(theme.text)
                        if let branch = result?.branch { Text(branch).font(.mono(12)).foregroundStyle(theme.muted) }
                    }
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Button { Task { await load() } } label: { Image(systemName: "arrow.clockwise") }.accessibilityLabel("Refresh")
                }
            }
            .task { await load() }
            .task { await followComments() }
            .onDisappear { bag.cancelAll() }
            .sheet(item: $menuTarget) { target in fileMenu(target).sheetChrome([.medium]) }
            .sheet(item: $lineTarget) { target in commentSheet(target).sheetChrome([.medium, .large]) }
            .sheet(isPresented: $reviewMenu) {
                if let chat {
                    ReviewModelSheet(chat: chat) { model in Task { await review(model) } }.sheetChrome()
                }
            }
    }

    @ViewBuilder
    private var content: some View {
        if result == nil, let error {
            EmptyState(icon: "arrow.triangle.branch", title: "Could not load the changes", detail: error, actionTitle: "Retry") { Task { await load() } }
        } else if result == nil {
            LoadingLine(text: "Loading…").frame(maxWidth: .infinity, maxHeight: .infinity)
        } else if result?.isRepo != true {
            EmptyState(icon: "arrow.triangle.branch", title: "Not a git repository", detail: "This folder has no repository, so there are no changes to show.")
        } else {
            VStack(spacing: 0) {
                if !entries.isEmpty { summaryBar }
                if let error {
                    Text(error).font(.system(size: 14)).foregroundStyle(theme.danger).padding(.horizontal, Space.lg).padding(.top, Space.sm)
                }
                if entries.isEmpty {
                    EmptyState(title: "No changes", detail: "The working tree matches the last commit.")
                } else {
                    diffList
                }
                actionBar
            }
        }
    }

    private var summaryBar: some View {
        HStack(spacing: Space.md) {
            (Text("\(entries.count) \(entries.count == 1 ? "file" : "files")  ").foregroundColor(theme.text2)
                + Text("+\(totals.added)").foregroundColor(theme.success) + Text(" ") + Text("−\(totals.deleted)").foregroundColor(theme.danger))
                .font(.mono(13))
                .frame(maxWidth: .infinity, alignment: .leading)
            if chatId != nil {
                if reviewing {
                    HStack(spacing: Space.sm) {
                        Pixel(tone: .working)
                        Text("pi is reviewing…").font(.system(size: 14)).foregroundStyle(theme.accent)
                    }
                } else {
                    Button {
                        startReview()
                    } label: {
                        Label("Review", systemImage: "text.magnifyingglass").font(.system(size: 15, weight: .semibold))
                    }
                    .frame(minHeight: touchTarget)
                }
            }
        }
        .padding(.leading, Space.lg)
        .padding(.trailing, Space.md)
        .frame(minHeight: touchTarget)
        .overlay(alignment: .bottom) { Rectangle().fill(theme.border).frame(height: 1) }
    }

    private var diffList: some View {
        let notes = Dictionary(grouping: comments) { "\($0.path)\n\($0.key)" }
        return ScrollView {
            LazyVStack(alignment: .leading, spacing: 0) {
                ForEach(entries) { entry in
                    fileHeader(entry)
                    if !collapsed.contains(entry.file.path) {
                        if entry.file.isBinary {
                            Text("Binary file").font(.system(size: 14)).foregroundStyle(theme.muted).padding(.horizontal, Space.lg).padding(.vertical, Space.md)
                        } else {
                            ForEach(Array(entry.file.hunks.enumerated()), id: \.offset) { hunkIndex, hunk in
                                Text(hunk.header)
                                    .font(.mono(12))
                                    .foregroundStyle(theme.muted)
                                    .lineLimit(1)
                                    .padding(.horizontal, Space.md)
                                    .padding(.vertical, Space.xs)
                                    .frame(maxWidth: .infinity, alignment: .leading)
                                    .background(theme.codeBg)
                                ForEach(Array(hunk.lines.enumerated()), id: \.offset) { lineIndex, line in
                                    lineRow(path: entry.file.path, line: line)
                                    ForEach(notes["\(entry.file.path)\n\(hunkIndex):\(lineIndex)"] ?? []) { comment in
                                        noteRow(comment)
                                    }
                                }
                            }
                        }
                    }
                }
            }
            .padding(.bottom, Space.lg)
        }
        .refreshable { await load() }
        .scrollDismissesKeyboard(.interactively)
    }

    private func fileHeader(_ entry: FileEntry) -> some View {
        let isCollapsed = collapsed.contains(entry.file.path)
        return HStack(spacing: 0) {
            Button {
                if isCollapsed { collapsed.remove(entry.file.path) } else { collapsed.insert(entry.file.path) }
            } label: {
                HStack(spacing: Space.sm) {
                    Image(systemName: isCollapsed ? "chevron.right" : "chevron.down").font(.system(size: 13)).foregroundStyle(theme.muted)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(entry.file.path).font(.mono(13, .medium)).foregroundStyle(theme.text).lineLimit(2).truncationMode(.head)
                        HStack(spacing: Space.sm) {
                            Text(entry.file.status).font(.mono(12)).foregroundStyle(theme.muted)
                            DiffStatText(added: entry.added, removed: entry.deleted)
                        }
                    }
                    Spacer(minLength: 0)
                }
                .padding(.leading, Space.md)
                .padding(.vertical, Space.sm)
                .frame(minHeight: touchTarget)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("\(entry.file.path), \(entry.file.status). \(isCollapsed ? "Expand" : "Collapse")")
            Button {
                menuTarget = MenuTarget(path: entry.file.path)
            } label: {
                Image(systemName: "ellipsis").foregroundStyle(theme.text2).frame(width: touchTarget, height: touchTarget)
            }
            .accessibilityLabel("Actions for \(entry.file.path)")
        }
        .background(theme.surface)
        .overlay(alignment: .top) { Rectangle().fill(theme.border).frame(height: 1) }
        .overlay(alignment: .bottom) { Rectangle().fill(theme.border).frame(height: 1) }
        .padding(.top, Space.sm)
    }

    private func lineRow(path: String, line: PatchLine) -> some View {
        let add = line.type == .add
        let del = line.type == .del
        return HStack(alignment: .top, spacing: 0) {
            Text(line.oldNo.map(String.init) ?? "").font(.mono(12)).foregroundStyle(theme.muted).frame(width: 32, alignment: .trailing)
            Text(line.newNo.map(String.init) ?? "").font(.mono(12)).foregroundStyle(theme.muted).frame(width: 32, alignment: .trailing)
            Text(add ? "+" : del ? "−" : " ").font(.mono(12.5)).foregroundStyle(add ? theme.success : del ? theme.danger : theme.muted).frame(width: 18)
            Text(line.text.isEmpty ? " " : line.text).font(.mono(12.5)).foregroundStyle(theme.text).frame(maxWidth: .infinity, alignment: .leading)
        }
        .padding(.trailing, Space.sm)
        .background(add ? theme.successSoft : del ? theme.dangerSoft : Color.clear)
        .contentShape(Rectangle())
        // A long press, so scrolling a diff never opens the comment sheet.
        .onLongPressGesture(minimumDuration: 0.3) {
            Haptic.tap.play()
            draft = ""
            lineTarget = LineTarget(path: path, line: line)
        }
        .accessibilityAction(named: "Comment on this line") {
            draft = ""
            lineTarget = LineTarget(path: path, line: line)
        }
    }

    private func noteRow(_ comment: PlacedComment) -> some View {
        Button {
            Task { await removeComment(comment) }
        } label: {
            VStack(alignment: .leading, spacing: 2) {
                if comment.fromPi { Text("pi").font(.mono(12, .medium)).foregroundStyle(theme.accent) }
                Text(comment.text).font(.system(size: 14)).foregroundStyle(theme.text).frame(maxWidth: .infinity, alignment: .leading)
            }
            .padding(.horizontal, Space.md)
            .padding(.vertical, Space.sm)
            .frame(minHeight: touchTarget)
            .background(theme.surface)
            .overlay(alignment: .leading) { Rectangle().fill(comment.fromPi ? theme.accent : theme.warning).frame(width: 3) }
            .clipShape(RoundedRectangle(cornerRadius: Radius.sm))
        }
        .buttonStyle(.plain)
        .accessibilityHint("Delete this comment")
        .padding(.leading, Space.md)
        .padding(.trailing, Space.sm)
        .padding(.vertical, Space.xs)
    }

    private var actionBar: some View {
        VStack(spacing: Space.sm) {
            if (chatId != nil && !mine.isEmpty) || (shared && !comments.isEmpty) {
                HStack(spacing: Space.sm) {
                    if chatId != nil && !mine.isEmpty {
                        Button {
                            sendComments()
                        } label: {
                            Text("Send \(mine.count) \(mine.count == 1 ? "comment" : "comments") to pi")
                                .font(.system(size: 14, weight: .semibold))
                                .foregroundStyle(theme.text)
                                .padding(.horizontal, Space.md)
                                .frame(maxWidth: .infinity, minHeight: touchTarget, alignment: .leading)
                                .background(theme.warningSoft)
                                .overlay(alignment: .leading) { Rectangle().fill(theme.warning).frame(width: 3) }
                                .clipShape(RoundedRectangle(cornerRadius: Radius.md))
                        }
                    }
                    if shared && !comments.isEmpty {
                        Button {
                            Task { await postToPr() }
                        } label: {
                            Label(busy == "post" ? "Posting…" : "Post to PR", systemImage: "arrow.triangle.pull").font(.system(size: 14, weight: .semibold))
                        }
                        .disabled(busy != nil)
                        .frame(minHeight: touchTarget)
                    }
                }
            }
            HStack(alignment: .bottom, spacing: Space.sm) {
                TextField("Commit message", text: $message, axis: .vertical)
                    .lineLimit(1...4)
                    .fieldStyle()
                    .accessibilityLabel("Commit message")
                Button(busy == "commit" ? "Commit…" : "Commit") { Task { await commit() } }
                    .buttonStyle(PrimaryButtonStyle())
                    .disabled(busy != nil || entries.isEmpty || message.trimmed.isEmpty)
                Button(busy == "push" ? "Push…" : "Push") { Task { await gitAction("push") { try await API.push(cwd) } } }
                    .buttonStyle(SecondaryButtonStyle())
                    .disabled(busy != nil)
            }
        }
        .padding(.horizontal, Space.md)
        .padding(.top, Space.sm)
        .padding(.bottom, Space.sm)
        .background(theme.bg)
        .overlay(alignment: .top) { Rectangle().fill(theme.border).frame(height: 1) }
    }

    private func fileMenu(_ target: MenuTarget) -> some View {
        let entry = entries.first { $0.file.path == target.path }
        return ActionSheetView(title: target.path) {
            if entry?.file.status != "deleted" && entry?.file.isBinary != true {
                SheetAction(icon: "doc.text", title: "Open file") {
                    menuTarget = nil
                    Router.shared.push(.file(cwd: result?.root ?? cwd, path: target.path))
                }
            }
            SheetAction(icon: "arrow.uturn.backward", title: "Discard changes", danger: true) {
                menuTarget = nil
                Task { await discard(target.path) }
            }
        }
    }

    private func commentSheet(_ target: LineTarget) -> some View {
        VStack(alignment: .leading, spacing: Space.md) {
            Text("Comment on this line").font(.system(size: 17, weight: .semibold)).foregroundStyle(theme.text)
            Text(target.path + (target.number.map { ":\($0)" } ?? "")).font(.mono(12)).foregroundStyle(theme.muted).lineLimit(1).truncationMode(.head)
            if !target.line.text.trimmed.isEmpty {
                Text(target.line.text)
                    .font(.mono(12.5))
                    .foregroundStyle(theme.text2)
                    .lineLimit(3)
                    .padding(Space.sm)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(RoundedRectangle(cornerRadius: Radius.sm).fill(theme.codeBg))
            }
            TextField("What should change here?", text: $draft, axis: .vertical)
                .lineLimit(4...8)
                .fieldStyle()
                .accessibilityLabel("Comment")
            Button {
                addComment(target)
            } label: {
                Text("Add comment").frame(maxWidth: .infinity)
            }
            .buttonStyle(PrimaryButtonStyle())
            .disabled(draft.trimmed.isEmpty)
            Spacer()
        }
        .padding(Space.lg)
        .padding(.top, Space.md)
        .background(theme.raised)
    }

    // MARK: Loading

    private func load() async {
        do {
            let next = try await API.diffStatus(cwd)
            let files = parseUnifiedDiff(next.diffText) + next.untracked.map { diffFileForUntracked(path: $0.path, content: $0.content) }
            let built = files.map { file -> FileEntry in
                let changes = file.changes
                return FileEntry(file: file, added: changes.added, deleted: changes.deleted, lineCount: file.hunks.reduce(0) { $0 + $1.lines.count })
            }
            // Only new large files are collapsed on a reload.
            for entry in built where !seen.contains(entry.file.path) && entry.lineCount > collapseLines {
                collapsed.insert(entry.file.path)
            }
            seen.formUnion(built.map(\.file.path))
            entries = built
            result = next
            error = nil
        } catch {
            self.error = errorText(error)
        }
    }

    /// Read on opening and after every reconnect; a broadcast during the read is newer.
    private func followComments() async {
        bag.add(Connection.shared.on(RemoteEvent.reviewCommentsChanged) { payload in
            guard payload["cwd"]?.stringValue == cwd else { return }
            commentChanges += 1
            stored = ReviewComment.list(payload["comments"])
        })
        bag.add(Connection.shared.onOnline { Task { await readComments() } })
        await readComments()
    }

    private func readComments() async {
        let before = commentChanges
        do {
            let list = try await API.reviewComments(cwd)
            if commentChanges == before {
                shared = true
                stored = list
            }
        } catch {
            // Only a computer without the store keeps them on this screen.
            if errorText(error).range(of: "not available from a paired device", options: .caseInsensitive) != nil { shared = false }
        }
    }

    // MARK: Comments

    private func addComment(_ target: LineTarget) {
        let text = draft.trimmed
        guard !text.isEmpty else { return }
        lineTarget = nil
        draft = ""
        Haptic.tap.play()
        if shared {
            Task {
                do {
                    if let added = try await API.addReviewComment(cwd, path: target.path, line: target.number, lineText: target.line.text, text: text),
                        !stored.contains(where: { $0.id == added.id })
                    {
                        stored.append(added)
                    }
                } catch {
                    toast("Could not add the comment: \(errorText(error))")
                }
            }
        } else {
            stored.append(ReviewComment(id: UUID().uuidString, path: target.path, line: target.number, lineText: target.line.text, text: text, author: nil, createdAt: nowMs()))
        }
    }

    private func removeComment(_ comment: PlacedComment) async {
        let yes = await Dialogs.confirm(
            title: comment.fromPi ? "Delete pi's remark?" : "Delete this comment?",
            message: String(comment.comment.text.prefix(200)),
            action: "Delete",
            danger: true
        )
        guard yes else { return }
        if shared {
            do {
                stored = try await API.removeReviewComments(cwd, ids: [comment.id])
            } catch {
                toast(errorText(error))
            }
        } else {
            stored.removeAll { $0.id == comment.id }
        }
    }

    private func sendComments() {
        guard let chatId, !mine.isEmpty else { return }
        ChatStore.shared.seedComposer(chatId, reviewPrompt(mine.map { (path: $0.path, line: $0.line, lineText: $0.lineText, text: $0.text) }))
        toast(mine.count == 1 ? "Comment added to the composer" : "Comments added to the composer")
        // They went to pi: done with, here and on every other screen.
        if shared {
            let ids = mine.map(\.id)
            Task { _ = try? await API.removeReviewComments(cwd, ids: ids) }
        }
        leaving = true
        dismiss()
    }

    /// Every comment (yours and pi's) to the branch's pull request as one
    /// review signed pi-bot. Public on GitHub, so ask first.
    private func postToPr() async {
        guard busy == nil, !comments.isEmpty else { return }
        let all = comments
        let yes = await Dialogs.confirm(
            title: "Post \(all.count) \(all.count == 1 ? "comment" : "comments") to the pull request?",
            message: "They are added to the PR on GitHub as one review signed pi-bot, visible to everyone who can see the repository, and leave this list.",
            action: "Post"
        )
        guard yes else { return }
        busy = "post"
        defer { busy = nil }
        do {
            let posted = try await API.postComments(cwd, all.map { comment in
                PrCommentInput(
                    path: comment.path,
                    line: comment.line,
                    // Unknown when it sits on a fallback line; "" is a real blank line.
                    lineText: comment.fallback ? nil : comment.lineText,
                    text: comment.comment.text,
                    author: comment.comment.author,
                    removed: comment.removed
                )
            })
            // They live on the PR now: posting again would only repeat them.
            _ = try? await API.removeReviewComments(cwd, ids: all.map(\.id))
            Haptic.success.play()
            let url = URL(string: posted.url)
            toast(
                "Posted to the PR\(posted.account.isEmpty ? "" : " as \(posted.account)")\(posted.listed > 0 ? " (\(posted.listed) in the summary)" : "")",
                action: url.map { target in ToastAction(label: "Open") { UIApplication.shared.open(target) } }
            )
        } catch {
            toast("Could not post: \(errorText(error))")
        }
    }

    // MARK: Git

    private func discard(_ path: String) async {
        let untracked = entries.first { $0.file.path == path }?.file.status == "added"
        let yes = await Dialogs.confirm(
            title: "Discard changes?",
            message: untracked ? "\(path) is moved to the Trash on the computer." : "\(path) is restored to the last commit. This cannot be undone.",
            action: "Discard",
            danger: true
        )
        guard yes else { return }
        do {
            let outcome = try await API.discard(cwd, path)
            toast(outcome.ok ? outcome.message : "Discard failed: \(outcome.message)")
            if outcome.ok && !shared { stored.removeAll { $0.path == path } }
        } catch {
            toast(errorText(error))
        }
        await load()
    }

    @discardableResult
    private func gitAction(_ kind: String, _ run: () async throws -> GitActionResult) async -> Bool {
        guard busy == nil else { return false }
        busy = kind
        defer { busy = nil }
        do {
            let outcome = try await run()
            toast(outcome.ok ? outcome.message : "\(kind == "commit" ? "Commit" : "Push") failed: \(outcome.message)")
            if outcome.ok { Haptic.success.play() }
            return outcome.ok
        } catch {
            toast(errorText(error))
            return false
        }
    }

    private func commit() async {
        let text = message.trimmed
        guard !text.isEmpty else { return }
        UIApplication.shared.sendAction(#selector(UIResponder.resignFirstResponder), to: nil, from: nil, for: nil)
        if await gitAction("commit", { try await API.commit(cwd, text) }) {
            message = ""
            if !shared { stored = [] }
            await load()
        }
    }

    // MARK: Review

    /// Choose the model first when the chat has others to offer.
    private func startReview() {
        let current = chat?.model
        let others = (chat?.models ?? []).filter { !(current != nil && $0.provider == current?.provider && $0.id == current?.id) }
        if !others.isEmpty {
            reviewMenu = true
        } else {
            Task { await review(current) }
        }
    }

    private func review(_ picked: Model?) async {
        guard !reviewing else { return }
        reviewing = true
        defer { reviewing = false }
        do {
            guard let remarks = try await API.review(cwd, model: picked.map { SideModelInput(provider: $0.provider, modelId: $0.id) }) else {
                toast("pi's reply was not a list of comments")
                return
            }
            // The computer keeps the remarks; an older one does not.
            if !shared {
                stored = stored.filter { !$0.fromPi } + remarks.map {
                    ReviewComment(id: UUID().uuidString, path: $0.path, line: $0.line, lineText: "", text: $0.comment, author: "pi", createdAt: nowMs())
                }
            }
            let placed = remarks.filter { remark in entries.contains { $0.file.path == remark.path } }
            for remark in placed { collapsed.remove(remark.path) }
            toast(placed.isEmpty ? "pi found nothing to flag" : "\(placed.count) \(placed.count == 1 ? "remark" : "remarks") from pi")
        } catch {
            toast(errorText(error))
        }
    }

    private func confirmLeave() async {
        let ok = await Dialogs.confirm(
            title: shared ? "Discard the commit message?" : "Discard your comments?",
            message: shared ? "The commit message has not been used." : "Your line comments and the commit message have not been sent.",
            action: "Discard",
            danger: true
        )
        if ok {
            leaving = true
            dismiss()
        }
    }
}
