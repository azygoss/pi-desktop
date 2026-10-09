import PiRemoteKit
import SwiftUI

/// Sessions listed before "Show older chats" is tapped.
private let initialLimit = 120

private enum ChatEntry: Identifiable {
    case session(SessionSummary, status: PixelTone?, pinned: Bool)
    /// A chat running on the computer that has no session file yet.
    case live(RemoteLiveChat)
    case hit(SessionSummary, SessionSearchHit)

    var id: String {
        switch self {
        case .session(let session, _, _): return session.path
        case .live(let chat): return "live:\(chat.chatId)"
        case .hit(let session, _): return "hit:\(session.path)"
        }
    }
}

private struct ChatSection: Identifiable {
    let title: String
    let entries: [ChatEntry]
    var id: String { title }
}

/// The chat list: what is active, what is pinned, then everything by date.
struct ChatsTab: View {
    @Environment(\.theme) private var theme
    @State private var data = DataStore.shared
    @State private var chats = ChatStore.shared
    @State private var connection = Connection.shared
    @State private var prefs = Prefs.shared
    @State private var router = Router.shared
    @State private var query = ""
    @State private var hits: [SessionSearchHit] = []
    @State private var showAll = false
    @State private var showArchived = false
    @State private var newChatOpen = false

    private var workspaceDir: String? { data.appInfo?.workspaceDir }

    /// Sessions with a reply that arrived while their chat was off screen.
    private var unread: Set<String> {
        Set(chats.chats.values.compactMap { $0.unread ? $0.sessionPath : nil })
    }

    private var needle: String { query.trimmingCharacters(in: .whitespacesAndNewlines) }

    private func statusOf(_ session: SessionSummary, _ unread: Set<String>) -> PixelTone? {
        switch data.liveState(session.path) {
        case .working?: return .working
        case .attention?: return .attention
        case nil: return unread.contains(session.path) ? .unread : nil
        }
    }

    private var sections: [ChatSection] {
        let unread = unread
        func entry(_ session: SessionSummary) -> ChatEntry {
            .session(session, status: statusOf(session, unread), pinned: data.isPinned(session.path))
        }
        if !needle.isEmpty {
            var out: [ChatSection] = []
            let titled = Array(fuzzyFilter(needle, data.sessions) { $0.title }.prefix(40))
            if !titled.isEmpty { out.append(ChatSection(title: "Chats", entries: titled.map(entry))) }
            let byPath = Dictionary(data.sessions.map { ($0.path, $0) }) { first, _ in first }
            let found = hits.compactMap { hit in byPath[hit.sessionPath].map { ChatEntry.hit($0, hit) } }.prefix(40)
            if !found.isEmpty { out.append(ChatSection(title: "In conversations", entries: Array(found))) }
            return out
        }
        let visible = data.sessions.filter { data.isArchived($0.path) == showArchived }
        let known = Set(data.sessions.map(\.path))
        var active: [ChatEntry] = data.live.values
            .filter { ($0.streaming || $0.uiRequest != nil) && ($0.sessionPath.map { !known.contains($0) } ?? true) }
            .sorted { $0.chatId < $1.chatId }
            .map(ChatEntry.live)
        var rest: [SessionSummary] = []
        var pinned: [SessionSummary] = []
        for session in visible {
            if statusOf(session, unread) != nil {
                active.append(entry(session))
            } else if data.isPinned(session.path) {
                pinned.append(session)
            } else {
                rest.append(session)
            }
        }
        var out: [ChatSection] = []
        if !active.isEmpty { out.append(ChatSection(title: "Active", entries: active)) }
        if !pinned.isEmpty {
            pinned.sort { (data.meta[$0.path]?.pinned ?? 0) > (data.meta[$1.path]?.pinned ?? 0) }
            out.append(ChatSection(title: "Pinned", entries: pinned.map(entry)))
        }
        let limited = showAll ? rest : Array(rest.prefix(initialLimit))
        for group in groupByDate(limited) {
            out.append(ChatSection(title: group.group.rawValue, entries: group.items.map(entry)))
        }
        return out
    }

    private var total: Int { data.sessions.filter { data.isArchived($0.path) == showArchived }.count }
    private var archivedCount: Int { data.sessions.filter { data.isArchived($0.path) }.count }

    var body: some View {
        ZStack(alignment: .bottomTrailing) {
            List {
                Section {
                    SearchField(text: $query, placeholder: "Search chats and conversations")
                        .listRowInsets(EdgeInsets(top: Space.sm, leading: Space.lg, bottom: Space.sm, trailing: Space.lg))
                        .listRowSeparator(.hidden)
                        .listRowBackground(theme.bg)
                    if prefs.notifications == nil && data.loaded && !data.sessions.isEmpty {
                        notificationPrompt
                            .listRowInsets(EdgeInsets(top: 0, leading: Space.lg, bottom: Space.sm, trailing: Space.lg))
                            .listRowSeparator(.hidden)
                            .listRowBackground(theme.bg)
                    }
                }
                let sections = sections
                if sections.isEmpty {
                    emptyState
                        .frame(minHeight: 320)
                        .listRowSeparator(.hidden)
                        .listRowBackground(theme.bg)
                }
                ForEach(sections) { section in
                    Section {
                        ForEach(section.entries) { item in
                            row(item)
                                .listRowInsets(EdgeInsets())
                                .listRowSeparator(.hidden)
                                .listRowBackground(theme.bg)
                        }
                    } header: {
                        SectionLabel(section.title)
                            .padding(.horizontal, Space.lg)
                            .padding(.top, Space.sm)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .listRowInsets(EdgeInsets())
                            .textCase(nil)
                    }
                }
                if needle.isEmpty {
                    footer
                        .listRowSeparator(.hidden)
                        .listRowBackground(theme.bg)
                }
                Color.clear.frame(height: 72).listRowSeparator(.hidden).listRowBackground(theme.bg)
            }
            .listStyle(.plain)
            .scrollContentBackground(.hidden)
            .background(theme.bg)
            .scrollDismissesKeyboard(.immediately)
            .refreshable {
                async let lists: Void = (try? await data.refresh()) ?? ()
                async let live: Void = (try? await data.refreshLive()) ?? ()
                _ = await (lists, live)
            }

            Button {
                newChatOpen = true
            } label: {
                Label("New chat", systemImage: "plus")
                    .font(.system(size: 15, weight: .semibold))
                    .foregroundStyle(theme.onAccent)
                    .padding(.horizontal, Space.lg)
                    .frame(height: 52)
                    .background(RoundedRectangle(cornerRadius: Radius.lg).fill(theme.accent))
                    .shadow(color: .black.opacity(0.18), radius: 6, y: 2)
            }
            .padding(Space.lg)
            .accessibilityIdentifier("new-chat")
        }
        .task(id: needle) { await search() }
        .sheet(isPresented: $newChatOpen) {
            NewChatSheet { cwd in
                newChatOpen = false
                router.startChat(cwd)
            }
            .sheetChrome()
        }
    }

    // MARK: Rows

    @ViewBuilder
    private func row(_ item: ChatEntry) -> some View {
        switch item {
        case .session(let session, let status, let pinned):
            Button {
                router.openSession(session)
            } label: {
                SessionRow(session: session, status: status, pinned: pinned, projectless: session.cwd == workspaceDir)
            }
            .buttonStyle(RowButtonStyle())
            .contextMenu { sessionMenu(session) }
            .swipeActions(edge: .trailing) {
                Button(role: .destructive) {
                    Task { await remove(session) }
                } label: {
                    Label("Trash", systemImage: "trash")
                }
                Button {
                    archive(session)
                } label: {
                    Label(data.isArchived(session.path) ? "Unarchive" : "Archive", systemImage: "archivebox")
                }
                .tint(theme.muted)
            }
            .swipeActions(edge: .leading) {
                Button {
                    Task { await data.setMeta(session.path, pinned: !data.isPinned(session.path)) }
                } label: {
                    Label(data.isPinned(session.path) ? "Unpin" : "Pin", systemImage: "pin")
                }
                .tint(theme.accent)
            }
        case .hit(let session, let hit):
            Button {
                router.openSession(session)
            } label: {
                VStack(alignment: .leading, spacing: 2) {
                    Text(session.title.isEmpty ? "Untitled chat" : session.title).foregroundStyle(theme.text).lineLimit(1)
                    Text(hit.snippet).font(.system(size: 13)).foregroundStyle(theme.muted).lineLimit(2)
                    Text("\(hit.matches) \(hit.matches == 1 ? "match" : "matches") · \(baseName(session.cwd))")
                        .font(.mono(12))
                        .foregroundStyle(theme.muted)
                }
                .padding(.horizontal, Space.lg)
                .padding(.vertical, Space.sm)
                .frame(maxWidth: .infinity, minHeight: touchTarget + 12, alignment: .leading)
            }
            .buttonStyle(RowButtonStyle())
        case .live(let chat):
            Button {
                router.joinLive(chat)
            } label: {
                HStack(spacing: Space.md) {
                    if chat.cwd == workspaceDir { ScratchSigil() } else { Sigil(seed: chat.cwd) }
                    VStack(alignment: .leading, spacing: 1) {
                        Text("New chat on the computer").foregroundStyle(theme.text).lineLimit(1)
                        Text("\(baseName(chat.cwd)) · \(chat.uiRequest != nil ? "needs you" : "working")")
                            .font(.mono(12))
                            .foregroundStyle(theme.muted)
                    }
                    Spacer()
                    Pixel(tone: chat.uiRequest != nil ? .attention : .working)
                }
                .padding(.horizontal, Space.lg)
                .frame(minHeight: touchTarget + 12)
            }
            .buttonStyle(RowButtonStyle())
        }
    }

    @ViewBuilder
    private func sessionMenu(_ session: SessionSummary) -> some View {
        Button {
            Task { await data.setMeta(session.path, pinned: !data.isPinned(session.path)) }
        } label: {
            Label(data.isPinned(session.path) ? "Unpin" : "Pin", systemImage: "pin")
        }
        Button {
            archive(session)
        } label: {
            Label(data.isArchived(session.path) ? "Unarchive" : "Archive", systemImage: "archivebox")
        }
        Button {
            Task { await rename(session) }
        } label: {
            Label("Rename", systemImage: "pencil")
        }
        Button(role: .destructive) {
            Task { await remove(session) }
        } label: {
            Label("Move to Trash…", systemImage: "trash")
        }
    }

    private var notificationPrompt: some View {
        VStack(alignment: .leading, spacing: Space.sm) {
            Text("Know when pi is done").font(.system(size: 16, weight: .semibold)).foregroundStyle(theme.text)
            Text("Get a notification when a chat finishes or pi needs you, also with the app in the background.")
                .font(.system(size: 14))
                .foregroundStyle(theme.text2)
            HStack(spacing: Space.sm) {
                Button {
                    Background.shared.disable()
                } label: {
                    Text("Not now").frame(maxWidth: .infinity)
                }
                .buttonStyle(SecondaryButtonStyle())
                Button {
                    Task { await Background.shared.enable() }
                } label: {
                    Text("Turn on").frame(maxWidth: .infinity)
                }
                .buttonStyle(PrimaryButtonStyle())
            }
        }
        .padding(Space.md)
        .background(RoundedRectangle(cornerRadius: Radius.md).fill(theme.surface))
        .overlay(RoundedRectangle(cornerRadius: Radius.md).strokeBorder(theme.border, lineWidth: 1))
    }

    @ViewBuilder
    private var emptyState: some View {
        if !data.loaded, let error = data.loadError, connection.isOnline {
            EmptyState(title: "Could not load the chats", detail: error, actionTitle: "Try again") {
                Task { try? await data.refresh() }
            }
        } else if !data.loaded {
            LoadingLine(text: connection.isOnline ? "Loading chats…" : "Waiting for the computer…", tone: connection.isOnline ? .working : .idle)
                .padding(Space.xl)
                .frame(maxWidth: .infinity, alignment: .leading)
        } else if !needle.isEmpty {
            EmptyState(
                icon: "magnifyingglass",
                title: "No chat matches",
                detail: needle.count < 3 ? "Type three letters to search inside conversations too." : nil
            )
        } else {
            EmptyState(
                icon: "bubble.left.and.bubble.right",
                title: showArchived ? "No archived chats" : "No chats yet",
                detail: showArchived ? nil : "Start one with the New chat button."
            )
        }
    }

    private var footer: some View {
        VStack(alignment: .leading, spacing: Space.xs) {
            if !showAll && total > initialLimit {
                Button("Show older chats (\(total - initialLimit) more)") { showAll = true }
                    .font(.system(size: 14))
                    .frame(minHeight: touchTarget)
            }
            if archivedCount > 0 || showArchived {
                Button(showArchived ? "Back to chats" : "Archived chats (\(archivedCount))") { showArchived.toggle() }
                    .font(.system(size: 14))
                    .frame(minHeight: touchTarget)
            }
        }
        .padding(.horizontal, Space.lg)
        .foregroundStyle(theme.accent)
    }

    // MARK: Actions

    /// Full-text search of every conversation, once the query is long enough.
    private func search() async {
        guard needle.count >= 3, connection.isOnline else {
            hits = []
            return
        }
        try? await Task.sleep(nanoseconds: 300_000_000)
        guard !Task.isCancelled else { return }
        if let result = try? await API.search(needle), !Task.isCancelled { hits = result }
    }

    private func archive(_ session: SessionSummary) {
        let archive = !data.isArchived(session.path)
        Task { await data.setMeta(session.path, archived: archive) }
        if archive {
            toast("Chat archived", action: ToastAction(label: "Undo") {
                Task { await DataStore.shared.setMeta(session.path, archived: false) }
            })
        }
    }

    private func rename(_ session: SessionSummary) async {
        guard let name = await Dialogs.prompt(title: "Rename chat", initial: session.title, action: "Rename") else { return }
        do {
            try await API.rename(sessionPath: session.path, name: name)
            try? await data.refresh()
        } catch {
            toast("Could not rename: \(errorText(error))")
        }
    }

    private func remove(_ session: SessionSummary) async {
        let ok = await Dialogs.confirm(
            title: "Move this chat to the Trash?",
            message: "\"\(session.title)\" goes to the Trash on the computer.",
            action: "Move to Trash",
            danger: true
        )
        guard ok else { return }
        do {
            try await API.deleteSession(session.path)
        } catch {
            toast("Could not delete: \(errorText(error))")
        }
    }
}

/// "New chat in…": without a project, a recent project, or any folder.
struct NewChatSheet: View {
    let onPick: (String) -> Void
    @State private var data = DataStore.shared
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        ActionSheetView(title: "New chat in…") {
            if let workspace = data.appInfo?.workspaceDir {
                SheetAction(icon: "square.dashed", title: "Without a project", detail: "A scratch folder on the computer") {
                    onPick(workspace)
                }
            }
            ForEach(data.projects.prefix(8)) { project in
                SheetAction(icon: "folder", title: project.name) { onPick(project.cwd) }
            }
            SheetAction(icon: "plus", title: "Another folder…", detail: "Browse the computer's folders") {
                dismiss()
                Task {
                    guard let path = await Router.shared.pickFolder("New chat in…") else { return }
                    try? await API.addProject(path)
                    Router.shared.startChat(path)
                }
            }
        }
    }
}
