import PiRemoteKit
import SwiftUI

private struct UserMenuTarget: Identifiable {
    let message: UserDisplay
    let userIndex: Int
    var id: String { message.key }
}

private enum ChatSheet: String, Identifiable {
    case model, stats, fork, tree, compact, branches
    var id: String { rawValue }
}

/// What pi is doing in a Mac app, with pause and stop.
private struct CuaStrip: View {
    let chat: ChatModel
    @Environment(\.theme) private var theme

    var body: some View {
        if chat.cuaActive, let activity = chat.cuaActivity {
            HStack(spacing: Space.sm) {
                Pixel(tone: chat.cuaPaused ? .attention : .working)
                Text(chat.cuaPaused ? "Paused" : activity.app.map { "Using \($0) · \(activity.summary)" } ?? activity.summary)
                    .font(.mono(12))
                    .foregroundStyle(theme.text)
                    .lineLimit(1)
                    .frame(maxWidth: .infinity, alignment: .leading)
                Button {
                    Task {
                        do {
                            if chat.cuaPaused { try await API.cuaResume() } else { try await API.cuaPause() }
                        } catch {
                            toast(errorText(error))
                        }
                    }
                } label: {
                    Image(systemName: chat.cuaPaused ? "play.fill" : "pause.fill").frame(width: touchTarget, height: touchTarget)
                }
                .accessibilityLabel(chat.cuaPaused ? "Resume computer use" : "Pause computer use")
                Button {
                    Task {
                        do { try await API.cuaStop() } catch { toast(errorText(error)) }
                    }
                } label: {
                    Image(systemName: "stop.fill").foregroundStyle(theme.danger).frame(width: touchTarget, height: touchTarget)
                }
                .accessibilityLabel("Stop computer use")
            }
            .font(.system(size: 14))
            .foregroundStyle(theme.text2)
            .padding(.leading, Space.md)
            .background(RoundedRectangle(cornerRadius: Radius.md).fill(theme.accentSoft))
            .padding(.horizontal, Space.md)
            .padding(.bottom, Space.sm)
        }
    }
}

struct ChatView: View {
    let chatId: String

    @State private var store = ChatStore.shared
    @State private var connection = Connection.shared
    @State private var data = DataStore.shared
    @State private var router = Router.shared
    @Environment(\.theme) private var theme

    var body: some View {
        if let chat = store.chat(chatId) {
            ChatScreen(chat: chat)
        } else {
            // A chat can disappear while its screen is up (another computer came into use).
            EmptyState(title: "This chat is no longer open", actionTitle: "Back to chats") { router.popToRoot() }
                .background(theme.bg.ignoresSafeArea())
                .navigationTitle("Chat")
        }
    }
}

private struct ChatScreen: View {
    let chat: ChatModel

    @State private var store = ChatStore.shared
    @State private var connection = Connection.shared
    @State private var data = DataStore.shared
    @State private var router = Router.shared
    @Environment(\.theme) private var theme

    @State private var repo: RepoSummary?
    @State private var pr: PullRequest?
    @State private var prSeen: (sha: String, pending: Bool)?
    @State private var gitTick = 0
    @State private var sheet: ChatSheet?
    @State private var userMenu: UserMenuTarget?
    @State private var lightbox: LightboxItem?
    @State private var loadingEarlier = false
    @State private var atBottom = true
    @State private var showStderr = false
    @State private var bag = SubscriptionBag()

    private var cwd: String { chat.cwd }
    private var projectless: Bool { !cwd.isEmpty && cwd == data.appInfo?.workspaceDir }
    private var computerHost: String? { connection.pairing?.lastHost ?? connection.pairing?.hosts.first }
    private var meta: SessionMetaEntry? { chat.sessionPath.flatMap { data.meta[$0] } }
    private var prSummary: PrSummary { pr.map { summarizeChecks($0.checks) } ?? .none }

    private var actions: RowActions {
        RowActions(
            onUserMenu: { message, index in userMenu = UserMenuTarget(message: message, userIndex: index) },
            onCopy: { copyToClipboard($0, "Reply copied") },
            onImage: { lightbox = LightboxItem(image: $0) },
            onOpenFile: { path in if !cwd.isEmpty { router.push(.file(cwd: cwd, path: path)) } }
        )
    }

    var body: some View {
        let items = buildTranscript(chat.view.messages, streaming: chat.streaming, models: chat.models)
        VStack(spacing: 0) {
            transcript(items)
            bottom
        }
        .background(theme.bg.ignoresSafeArea())
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .principal) { header }
            ToolbarItem(placement: .topBarTrailing) { menu }
        }
        .environment(\.linkContext, LinkContext(openFile: cwd.isEmpty ? nil : { path in router.push(.file(cwd: cwd, path: path)) }, computerHost: computerHost))
        .onAppear {
            store.setVisible(chat.chatId)
            if let request = chat.uiRequest, !request.isInteractive { store.respondUi(chat.chatId, id: request.id) }
        }
        .onDisappear { if store.visibleChatId == chat.chatId { store.setVisible(nil) } }
        .task { bag.add(connection.on(RemoteEvent.gitChanged) { _ in gitTick += 1 }) }
        .onDisappear { bag.cancelAll() }
        // Branch and change counts: on open, when a run settles, when a branch changes.
        .task(id: "\(cwd)|\(connection.isOnline)|\(chat.streaming)|\(gitTick)") { await loadRepo() }
        // The branch's pull request: number and checks in the header.
        .task(id: "\(cwd)|\(connection.isOnline)|\(repo?.branch ?? "")|\(chat.streaming)") { await followPr() }
        // Display-only extension requests are acknowledged at once.
        .onChange(of: chat.uiRequest?.id) { _, _ in
            if let request = chat.uiRequest, !request.isInteractive { store.respondUi(chat.chatId, id: request.id) }
        }
        .sheet(item: $sheet) { which in sheetView(which) }
        .confirmationDialog("Prompt", isPresented: Binding(get: { userMenu != nil }, set: { if !$0 { userMenu = nil } }), presenting: userMenu) { target in
            userMenuButtons(target)
        }
        .fullScreenCover(item: $lightbox) { item in LightboxView(item: item) }
    }

    // MARK: Header and menu

    private var header: some View {
        Button {
            if repo != nil { router.push(.diff(cwd: cwd, chatId: chat.chatId)) }
        } label: {
            VStack(spacing: 0) {
                Text(chat.title).font(.system(size: 16, weight: .semibold)).foregroundStyle(theme.text).lineLimit(1)
                if chat.streaming, let started = chat.view.runStartedAt {
                    LiveTick { _ in
                        Text("Working \(formatElapsed(nowMs() - started))").font(.mono(12)).foregroundStyle(theme.accent).lineLimit(1)
                    }
                } else {
                    subtitle.lineLimit(1)
                }
            }
            .frame(maxWidth: 260)
        }
        .buttonStyle(.plain)
        .accessibilityLabel(
            "\(chat.title).\(repo.map { " \($0.files) changed files. Open changes." } ?? "")\(pr.map { " Pull request \($0.number), checks \(prSummary.rawValue)." } ?? "")"
        )
    }

    private var subtitle: Text {
        var text = Text(projectless ? "no project" : (baseName(cwd).isEmpty ? "…" : baseName(cwd))).foregroundColor(theme.muted)
        if let branch = repo?.branch { text = text + Text(" · \(branch)").foregroundColor(theme.muted) }
        if let pr {
            let (mark, color): (String, Color) = {
                switch prSummary {
                case .failing: return ("✗", theme.danger)
                case .passing: return ("✓", theme.success)
                case .pending: return ("●", theme.accent)
                case .none: return ("", theme.muted)
                }
            }()
            text = text + Text(" · #\(pr.number) ").foregroundColor(theme.muted) + Text(mark).foregroundColor(color)
        }
        if let repo, repo.files > 0 {
            if repo.added + repo.removed > 0 {
                text = text + Text(" · ").foregroundColor(theme.muted) + Text("+\(repo.added)").foregroundColor(theme.success)
                    + Text(" ") + Text("−\(repo.removed)").foregroundColor(theme.danger)
            } else {
                text = text + Text(" · \(repo.files) \(repo.files == 1 ? "file" : "files")").foregroundColor(theme.muted)
            }
        }
        return text.font(.mono(12))
    }

    private var menu: some View {
        Menu {
            if let repo {
                Button { router.push(.diff(cwd: cwd, chatId: chat.chatId)) } label: {
                    Label(repo.files > 0 ? "Changes · \(repo.files) \(repo.files == 1 ? "file" : "files")" : "Changes", systemImage: "plusminus")
                }
                Button { sheet = .branches } label: { Label("Branches and worktrees", systemImage: "arrow.triangle.branch") }
                Button { router.push(.pr(cwd: cwd, chatId: chat.chatId)) } label: { Label("Pull request", systemImage: "arrow.triangle.pull") }
            }
            Button { router.push(.side(chatId: chat.chatId, question: nil)) } label: { Label("Side chat", systemImage: "questionmark.bubble") }
            Divider()
            Button { sheet = .stats } label: { Label("Session details", systemImage: "info.circle") }
            Button { Task { await rename() } } label: { Label("Rename", systemImage: "pencil") }
            Button { sheet = .compact } label: { Label("Compact context", systemImage: "arrow.down.right.and.arrow.up.left") }
            Button { sheet = .fork } label: { Label("Fork from a prompt", systemImage: "arrow.branch") }
            Button { sheet = .tree } label: { Label("Session tree", systemImage: "list.bullet.indent") }
            Button { _ = onCommand("clone", "") } label: { Label("Fork chat", systemImage: "plus.square.on.square") }
            Divider()
            Button {
                copyToClipboard(chatToMarkdown(title: chat.title, messages: chat.view.messages, toolRuns: chat.view.toolRuns, cwd: chat.cwd), "Chat copied as Markdown")
            } label: {
                Label("Copy as Markdown", systemImage: "doc.on.doc")
            }
            if let path = chat.sessionPath {
                Button { Task { await shareHtml(path) } } label: { Label("Share as a web page", systemImage: "square.and.arrow.up") }
            }
            Button { _ = onCommand("reload", "") } label: { Label("Restart pi", systemImage: "arrow.clockwise") }
            if let path = chat.sessionPath {
                Divider()
                Button { Task { await data.setMeta(path, pinned: meta?.pinned == nil) } } label: {
                    Label(meta?.pinned != nil ? "Unpin" : "Pin", systemImage: "pin")
                }
                Button { Task { await data.setMeta(path, archived: meta?.archived == nil) } } label: {
                    Label(meta?.archived != nil ? "Unarchive" : "Archive", systemImage: "archivebox")
                }
                Button(role: .destructive) { Task { await deleteChat(path) } } label: { Label("Move to Trash…", systemImage: "trash") }
            }
        } label: {
            Image(systemName: "ellipsis.circle")
        }
        .accessibilityLabel("Chat actions")
    }

    // MARK: Transcript

    @ViewBuilder
    private func transcript(_ items: [TranscriptItem]) -> some View {
        if items.isEmpty {
            Group {
                if let error = chat.transcriptError {
                    EmptyState(title: "Could not load this conversation", detail: error, actionTitle: "Try again") { store.retryTranscript(chat.chatId) }
                } else if chat.sessionPath != nil && !chat.transcriptApplied {
                    EmptyState(title: "Loading the conversation…", detail: connection.isOnline ? nil : "Waiting for the computer.")
                } else if chat.status == .starting {
                    Spacer()
                } else {
                    EmptyState(
                        title: "What should pi do?",
                        detail: projectless ? "This chat runs without a project." : "pi works in \(baseName(cwd)) on your computer."
                    )
                }
            }
            .frame(maxHeight: .infinity)
            .onTapGesture { UIApplication.shared.sendAction(#selector(UIResponder.resignFirstResponder), to: nil, from: nil, for: nil) }
        } else {
            let retry = retryTarget(items)
            let split = items.lastIndex { if case .user = $0 { return true } else { return false } } ?? 0
            let settled = items[..<split]
            let tail = items[split...]
            ScrollViewReader { proxy in
                ScrollView {
                    VStack(alignment: .leading, spacing: 0) {
                        LazyVStack(alignment: .leading, spacing: 0) {
                            if chat.hasEarlier {
                                Button(loadingEarlier ? "Loading earlier messages…" : "Load earlier messages") { loadEarlier() }
                                    .buttonStyle(SecondaryButtonStyle())
                                    .disabled(loadingEarlier)
                                    .frame(maxWidth: .infinity)
                                    .padding(Space.lg)
                                    // Scrolling up to it pages in older messages.
                                    .onAppear { if !loadingEarlier { loadEarlier() } }
                            }
                            ForEach(settled) { item in
                                row(item, retry: retry).id(item.id)
                            }
                        }
                        // The live turn stays out of the lazy stack: a streaming row that keeps
                        // resizing and re-keying at the end of a LazyVStack can lock the main
                        // thread in a layout loop.
                        VStack(alignment: .leading, spacing: 0) {
                            ForEach(tail) { item in
                                row(item, retry: retry).id(item.id)
                            }
                        }
                        // Lazy so onAppear/onDisappear track whether the end is on screen.
                        LazyVStack(spacing: 0) {
                            Color.clear.frame(height: 1).id("bottom")
                                .onAppear { atBottom = true }
                                .onDisappear { atBottom = false }
                        }
                    }
                    .padding(.vertical, Space.sm)
                }
                .defaultScrollAnchor(.bottom)
                .scrollDismissesKeyboard(.interactively)
                .overlay(alignment: .bottomTrailing) {
                    if !atBottom {
                        Button {
                            withAnimation(.easeOut(duration: 0.2)) { proxy.scrollTo("bottom", anchor: .bottom) }
                        } label: {
                            Image(systemName: "arrow.down")
                                .font(.system(size: 16, weight: .semibold))
                                .foregroundStyle(theme.text2)
                                .frame(width: touchTarget, height: touchTarget)
                                .background(Circle().fill(theme.raised))
                                .overlay(Circle().strokeBorder(theme.borderStrong, lineWidth: 1))
                        }
                        .padding(Space.lg)
                        .accessibilityLabel("Jump to the latest message")
                    }
                }
                .onChange(of: items.last?.id) { _, _ in
                    // New content while reading the end: follow it.
                    if atBottom { proxy.scrollTo("bottom", anchor: .bottom) }
                }
            }
        }
    }

    /// The last turn's meta line offers Retry when nothing follows it.
    private func retryTarget(_ items: [TranscriptItem]) -> (key: String, userIndex: Int)? {
        guard !chat.streaming else { return nil }
        guard let last = items.last(where: {
            switch $0 {
            case .meta, .user: return true
            default: return false
            }
        }), case .meta(let key, _, _) = last else { return nil }
        for item in items.reversed() {
            if case .user(_, let index) = item { return (key, index) }
        }
        return nil
    }

    @ViewBuilder
    private func row(_ item: TranscriptItem, retry: (key: String, userIndex: Int)?) -> some View {
        switch item {
        case .user(let message, let index):
            UserRow(message: message, userIndex: index, actions: actions).equatable()
        case .assistant(let message, let live):
            AssistantRow(message: message, toolRuns: chat.view.toolRuns, cwd: cwd, live: live, actions: actions).equatable()
        case .work(_, let messages, let live, let startedAt, let endedAt):
            WorkGroupRow(messages: messages, toolRuns: chat.view.toolRuns, cwd: cwd, live: live, startedAt: startedAt, endedAt: endedAt, actions: actions)
                .equatable()
        case .bash(let message):
            BashRow(message: message).equatable()
        case .notice(let message):
            NoticeRow(message: message).equatable()
        case .meta(let key, let text, let reply):
            MetaRow(
                text: text,
                reply: reply,
                onCopy: actions.onCopy,
                onRetry: retry?.key == key ? { retryLast(retry?.userIndex ?? 0) } : nil
            )
        }
    }

    // MARK: Bottom

    private var bottom: some View {
        VStack(spacing: 0) {
            if !connection.isOnline {
                HStack(spacing: Space.sm) {
                    Pixel(tone: connection.phase == .connecting ? .working : .error)
                    Text(connection.phase == .connecting ? "Reconnecting to the computer…" : "Not connected to the computer")
                        .font(.mono(12))
                        .foregroundStyle(theme.muted)
                        .frame(maxWidth: .infinity, alignment: .leading)
                    if connection.phase != .connecting {
                        Button("Retry") { connection.retry() }.font(.system(size: 14)).frame(minHeight: touchTarget)
                    }
                }
                .padding(.horizontal, Space.lg)
                .padding(.vertical, Space.xs)
            }
            if chat.status == .starting && connection.isOnline {
                LiveTick { _ in
                    let seconds = chat.startedAt.map { Int((nowMs() - $0) / 1000) } ?? 0
                    LoadingLine(text: "Starting pi\(seconds >= 2 ? " · \(seconds)s" : "")\(chat.startupHint.map { " · \($0)" } ?? "")")
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal, Space.lg)
                .padding(.vertical, Space.sm)
            }
            if let error = chat.error {
                VStack(alignment: .leading, spacing: Space.sm) {
                    Text(error).font(.system(size: 14)).foregroundStyle(theme.danger).textSelection(.enabled)
                    if showStderr, let tail = chat.stderrTail {
                        Text(tail.joined(separator: "\n")).font(.mono(12)).foregroundStyle(theme.text2).textSelection(.enabled)
                    }
                    HStack(spacing: Space.sm) {
                        if chat.status == .error || chat.status == .exited {
                            Button("Start pi again") { store.retryOpen(chat.chatId) }.buttonStyle(SecondaryButtonStyle())
                        }
                        if chat.stderrTail != nil && !showStderr {
                            Button("Show details") { showStderr = true }.foregroundStyle(theme.text2)
                        }
                    }
                }
                .padding(Space.md)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(RoundedRectangle(cornerRadius: Radius.md).fill(theme.dangerSoft))
                .padding(.horizontal, Space.md)
                .padding(.bottom, Space.sm)
            }
            CuaStrip(chat: chat)
            if let request = chat.uiRequest, request.isInteractive {
                UiRequestCard(chatId: chat.chatId, request: request).id(request.id)
            }
            Composer(chat: chat, onCommand: onCommand, onOpenModel: { sheet = .model }, onOpenStats: { sheet = .stats })
                .padding(.bottom, Space.sm)
        }
        .background(theme.bg)
    }

    // MARK: Sheets

    @ViewBuilder
    private func sheetView(_ which: ChatSheet) -> some View {
        switch which {
        case .model: ModelSheet(chat: chat).sheetChrome()
        case .stats: StatsSheet(chat: chat, onCompact: chat.streaming ? nil : { sheet = .compact }).sheetChrome()
        case .fork: ForkSheet(chatId: chat.chatId).sheetChrome()
        case .tree: TreeSheet(chatId: chat.chatId).sheetChrome([.large])
        case .branches: BranchSheet(cwd: cwd, busy: chat.streaming).sheetChrome([.large])
        case .compact:
            CompactSheet { instructions in
                guardRun("Could not compact") { try await store.compact(chat.chatId, instructions: instructions.isEmpty ? nil : instructions) }
            }
            .sheetChrome([.medium])
        }
    }

    @ViewBuilder
    private func userMenuButtons(_ target: UserMenuTarget) -> some View {
        Button("Copy") { copyToClipboard(parseSkillPrefix(target.message.text).rest, "Prompt copied") }
        Button("Edit and resend") {
            guardRun("Could not fork") { _ = try await store.forkFromUserMessage(chat.chatId, userIndex: target.userIndex) }
        }
        Button("Retry") {
            guardRun("Could not retry") { try await store.retryFromUserMessage(chat.chatId, userIndex: target.userIndex) }
        }
        if let checkpoint = target.message.checkpoint, !chat.streaming {
            Button("Restore files to before this prompt", role: .destructive) { Task { await restoreCheckpoint(checkpoint) } }
        }
        Button("Cancel", role: .cancel) {}
    }

    // MARK: Actions

    private func guardRun(_ failure: String, _ run: @escaping () async throws -> Void) {
        Task {
            do {
                try await run()
            } catch {
                toast("\(failure): \(errorText(error))")
            }
        }
    }

    private func loadRepo() async {
        guard !cwd.isEmpty, connection.isOnline, !chat.streaming else { return }
        if let summary = try? await API.diffSummary(cwd) { repo = summary.isRepo ? summary : nil }
    }

    /// While checks run (and this chat is on screen) they are looked at every
    /// minute; the moment they finish is announced.
    private func followPr() async {
        guard !cwd.isEmpty, connection.isOnline, repo?.branch != nil else { return }
        while !Task.isCancelled {
            var again = false
            do {
                let status = try await API.prStatus(cwd)
                let next = status.pr?.state == "OPEN" ? status.pr : nil
                pr = next
                let settled = !(next?.checks.contains { $0.state == .pending } ?? false)
                if let next, let previous = prSeen, previous.sha == next.headSha, previous.pending, settled {
                    let summary = summarizeChecks(next.checks)
                    (summary == .failing ? Haptic.warning : Haptic.success).play()
                    toast("Pull request #\(next.number): \(summary == .failing ? "checks failed" : "checks passed")")
                }
                prSeen = next.map { ($0.headSha, !settled) }
                again = !settled
            } catch {
                // A failed look (gh, the network) is tried again, not given up on.
                again = prSeen?.pending == true
            }
            guard again else { return }
            try? await Task.sleep(nanoseconds: 60_000_000_000)
        }
    }

    private func loadEarlier() {
        guard !loadingEarlier else { return }
        loadingEarlier = true
        Task {
            do {
                try await store.loadEarlier(chat.chatId)
            } catch {
                toast(errorText(error))
            }
            loadingEarlier = false
        }
    }

    private func retryLast(_ userIndex: Int) {
        Haptic.tap.play()
        guardRun("Could not retry") { try await store.retryFromUserMessage(chat.chatId, userIndex: userIndex) }
    }

    /// App commands typed as `/name args`; false hands the text to pi.
    private func onCommand(_ command: String, _ args: String) -> Bool {
        // pi's own commands (skills, prompts, extensions) are sent as prompts.
        if chat.commands.contains(where: { $0.name == command }) { return false }
        guard phoneCommandNames.contains(command) else { return false }
        let id = chat.chatId
        switch command {
        case "new":
            router.replaceTop(with: .chat(store.newChat(chat.cwd)))
        case "resume":
            router.popToRoot()
        case "name":
            if args.isEmpty {
                Task { await rename() }
            } else {
                guardRun("Could not rename") { try await store.rename(id, args) }
            }
        case "session":
            sheet = .stats
        case "tree":
            sheet = .tree
        case "fork":
            sheet = .fork
        case "clone":
            guardRun("Could not fork the chat") {
                try await store.cloneChat(id)
                toast("Continuing on a copy of the chat")
            }
        case "btw":
            router.push(.side(chatId: id, question: args.isEmpty ? nil : args))
        case "compact":
            guardRun("Could not compact") { try await store.compact(id, instructions: args.isEmpty ? nil : args) }
        case "copy":
            guardRun("Could not copy") {
                if let text = try await API.lastAssistantText(id), !text.isEmpty {
                    copyToClipboard(text, "Last reply copied")
                } else {
                    toast("Nothing to copy yet")
                }
            }
        case "reload":
            guardRun("Could not restart pi") {
                try await store.reloadChat(id)
                toast("pi restarted")
            }
        case "model":
            sheet = .model
        case "thinking":
            let wanted = args.lowercased()
            if let level = chat.availableThinkingLevels.first(where: { $0.rawValue == wanted || $0.label.lowercased() == wanted }) {
                guardRun("Could not set the level") { try await store.setThinkingLevel(id, level) }
            } else {
                sheet = .model
            }
        default:
            return false
        }
        return true
    }

    private func rename() async {
        guard let name = await Dialogs.prompt(title: "Rename chat", initial: chat.title, action: "Rename") else { return }
        do {
            try await store.rename(chat.chatId, name)
        } catch {
            toast("Could not rename: \(errorText(error))")
        }
    }

    private func shareHtml(_ path: String) async {
        do {
            let html = try await API.exportHtml(path)
            let stem = String(chat.title.replacingOccurrences(of: "[\\\\/:*?\"<>|]+", with: " ", options: .regularExpression).trimmed.prefix(60))
            let url = AppFiles.temporaryURL("\(stem.isEmpty ? "pi-chat" : stem).html")
            try html.write(to: url, atomically: true, encoding: .utf8)
            Dialogs.share([url])
        } catch {
            toast("Could not share: \(errorText(error))")
        }
    }

    private func restoreCheckpoint(_ checkpoint: String) async {
        let ok = await Dialogs.confirm(
            title: "Restore the files to before this prompt?",
            message: "Every change made to the project since then is undone, including your own edits. Files created since are moved to the Trash on the computer. The conversation stays as it is.",
            action: "Restore files",
            danger: true
        )
        guard ok else { return }
        await restore(checkpoint, undoable: true)
    }

    private func restore(_ target: String, undoable: Bool) async {
        do {
            let result = try await API.restoreCheckpoint(cwd, target)
            if result.restored == 0 && result.trashed == 0 {
                toast("The files already match that point")
                return
            }
            let parts = [
                result.restored > 0 ? "\(result.restored) \(result.restored == 1 ? "file" : "files") restored" : "",
                result.trashed > 0 ? "\(result.trashed) moved to Trash" : ""
            ].filter { !$0.isEmpty }
            toast(parts.joined(separator: ", "), action: undoable ? ToastAction(label: "Undo") { Task { await restore(result.undo, undoable: false) } } : nil)
        } catch {
            toast("Could not restore: \(errorText(error))")
        }
    }

    private func deleteChat(_ path: String) async {
        let ok = await Dialogs.confirm(
            title: "Move this chat to the Trash?",
            message: "The session file goes to the Trash on the computer.",
            action: "Move to Trash",
            danger: true
        )
        guard ok else { return }
        do {
            try await API.deleteSession(path)
            router.pop()
        } catch {
            toast("Could not delete: \(errorText(error))")
        }
    }
}
