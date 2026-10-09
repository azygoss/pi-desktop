import PiRemoteKit
import SwiftUI

// MARK: - Models

private struct ModelSection: Identifiable {
    let title: String
    let models: [Model]
    var id: String { title }
}

/// Models grouped by provider, filtered by `query`.
private func modelSections(_ models: [Model], query: String, skip: Model? = nil) -> [ModelSection] {
    let needle = query.trimmingCharacters(in: .whitespaces).lowercased()
    var order: [String] = []
    var byProvider: [String: [Model]] = [:]
    for model in models {
        if let skip, model.provider == skip.provider, model.id == skip.id { continue }
        if !needle.isEmpty && !model.name.lowercased().contains(needle) && !model.id.lowercased().contains(needle)
            && !model.provider.lowercased().contains(needle)
        {
            continue
        }
        if byProvider[model.provider] == nil { order.append(model.provider) }
        byProvider[model.provider, default: []].append(model)
    }
    return order.map { ModelSection(title: providerLabel($0), models: byProvider[$0] ?? []) }
}

private struct ModelRowView: View {
    let model: Model
    let selected: Bool
    let onPick: () -> Void
    @Environment(\.theme) private var theme

    var body: some View {
        Button(action: onPick) {
            HStack(spacing: Space.md) {
                VStack(alignment: .leading, spacing: 1) {
                    Text(model.name.isEmpty ? model.id : model.name)
                        .font(.system(size: 16, weight: selected ? .semibold : .regular))
                        .foregroundStyle(theme.text)
                        .lineLimit(1)
                    Text("\(model.id) · \(compactNumber(model.contextWindow)) ctx").font(.mono(12)).foregroundStyle(theme.muted).lineLimit(1)
                }
                Spacer()
                if selected { Pixel(tone: .unread) }
            }
            .padding(.horizontal, Space.lg)
            .padding(.vertical, Space.sm)
            .frame(minHeight: touchTarget)
        }
        .buttonStyle(RowButtonStyle())
        .accessibilityAddTraits(selected ? .isSelected : [])
    }
}

/// Pick the chat's model (grouped by provider) and its thinking effort.
struct ModelSheet: View {
    let chat: ChatModel
    @Environment(\.theme) private var theme
    @Environment(\.dismiss) private var dismiss
    @State private var query = ""

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Text("Model").font(.system(size: 17, weight: .semibold)).foregroundStyle(theme.text)
                .padding(.horizontal, Space.lg).padding(.top, Space.xl).padding(.bottom, Space.sm)
            if chat.availableThinkingLevels.count > 1 {
                SectionLabel("Thinking effort").padding(.horizontal, Space.lg)
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: Space.sm) {
                        ForEach(chat.availableThinkingLevels, id: \.self) { level in
                            let selected = level == chat.thinkingLevel
                            Button {
                                Task {
                                    do {
                                        try await ChatStore.shared.setThinkingLevel(chat.chatId, level)
                                    } catch {
                                        toast(errorText(error))
                                    }
                                }
                            } label: {
                                Text(level.label)
                                    .font(.mono(13, selected ? .medium : .regular))
                                    .foregroundStyle(selected ? theme.accent : theme.text2)
                                    .frame(minWidth: 64, minHeight: 40)
                                    .padding(.horizontal, Space.sm)
                                    .background(RoundedRectangle(cornerRadius: Radius.md).fill(selected ? theme.accentSoft : Color.clear))
                                    .overlay(RoundedRectangle(cornerRadius: Radius.md).strokeBorder(selected ? theme.accent : theme.borderStrong, lineWidth: 1))
                            }
                            .accessibilityAddTraits(selected ? .isSelected : [])
                        }
                    }
                    .padding(.horizontal, Space.lg)
                    .padding(.vertical, Space.sm)
                }
            }
            if chat.models.count > 10 {
                SearchField(text: $query, placeholder: "Search models").padding(.horizontal, Space.lg).padding(.bottom, Space.sm)
            }
            let sections = modelSections(chat.models, query: query)
            if sections.isEmpty {
                EmptyState(title: chat.models.isEmpty ? "No models yet" : "No model matches", detail: chat.models.isEmpty ? "pi is still starting." : nil)
            } else {
                List {
                    ForEach(sections) { section in
                        Section {
                            ForEach(section.models, id: \.key) { model in
                                ModelRowView(model: model, selected: model.provider == chat.model?.provider && model.id == chat.model?.id) {
                                    dismiss()
                                    Task {
                                        do {
                                            try await ChatStore.shared.setModel(chat.chatId, provider: model.provider, modelId: model.id)
                                        } catch {
                                            toast("Could not switch model: \(errorText(error))")
                                        }
                                    }
                                }
                                .listRowInsets(EdgeInsets())
                                .listRowBackground(theme.raised)
                            }
                        } header: {
                            SectionLabel(section.title).textCase(nil)
                        }
                    }
                }
                .listStyle(.plain)
                .scrollContentBackground(.hidden)
            }
        }
        .background(theme.raised)
    }
}

/// What to review the changes with: the chat's own model, or another one.
struct ReviewModelSheet: View {
    let chat: ChatModel
    let onPick: (Model?) -> Void
    @Environment(\.theme) private var theme
    @Environment(\.dismiss) private var dismiss
    @State private var query = ""

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Text("Review with").font(.system(size: 17, weight: .semibold)).foregroundStyle(theme.text)
                .padding(.horizontal, Space.lg).padding(.top, Space.xl).padding(.bottom, Space.sm)
            if let current = chat.model {
                SectionLabel("This chat's model").padding(.horizontal, Space.lg)
                ModelRowView(model: current, selected: true) {
                    dismiss()
                    onPick(current)
                }
                ThemedDivider()
            }
            SectionLabel("Another model").padding(.horizontal, Space.lg).padding(.top, Space.md)
            if chat.models.count > 10 {
                SearchField(text: $query, placeholder: "Search models").padding(.horizontal, Space.lg).padding(.vertical, Space.sm)
            }
            let sections = modelSections(chat.models, query: query, skip: chat.model)
            if sections.isEmpty {
                EmptyState(title: query.isEmpty ? "No other models" : "No model matches")
            } else {
                List {
                    ForEach(sections) { section in
                        Section {
                            ForEach(section.models, id: \.key) { model in
                                ModelRowView(model: model, selected: false) {
                                    dismiss()
                                    onPick(model)
                                }
                                .listRowInsets(EdgeInsets())
                                .listRowBackground(theme.raised)
                            }
                        } header: {
                            SectionLabel(section.title).textCase(nil)
                        }
                    }
                }
                .listStyle(.plain)
                .scrollContentBackground(.hidden)
            }
        }
        .background(theme.raised)
    }
}

// MARK: - pi's questions

/**
 * pi needs you: a confirm, a choice or some text an extension asked for.
 * Amber, because it waits on the user. Answering here also closes the same
 * dialog in the window on the computer.
 */
struct UiRequestCard: View {
    let chatId: String
    let request: ExtensionUiRequest
    @Environment(\.theme) private var theme
    @State private var value: String

    init(chatId: String, request: ExtensionUiRequest) {
        self.chatId = chatId
        self.request = request
        _value = State(initialValue: request.method == "editor" ? (request.prefill ?? "") : "")
    }

    private var store: ChatStore { ChatStore.shared }

    var body: some View {
        let title = request.title ?? (request.method == "confirm" ? "Confirm" : "pi needs your input")
        VStack(alignment: .leading, spacing: Space.md) {
            HStack(spacing: Space.sm) {
                Pixel(tone: .attention)
                Text(title).font(.system(size: 16, weight: .semibold)).foregroundStyle(theme.text)
            }
            if let message = request.message {
                ScrollView {
                    Text(message).font(.system(size: 14)).foregroundStyle(theme.text2).frame(maxWidth: .infinity, alignment: .leading)
                }
                .frame(maxHeight: 120)
            }
            switch request.method {
            case "select":
                ScrollView {
                    VStack(spacing: Space.sm) {
                        ForEach(request.options, id: \.self) { option in
                            Button {
                                store.respondUi(chatId, id: request.id, value: option)
                            } label: {
                                Text(option).frame(maxWidth: .infinity)
                            }
                            .buttonStyle(SecondaryButtonStyle())
                        }
                        Button("Cancel") { store.respondUi(chatId, id: request.id, cancelled: true) }
                            .foregroundStyle(theme.text2)
                            .frame(minHeight: touchTarget)
                    }
                }
                .frame(maxHeight: 264)
            case "confirm":
                HStack(spacing: Space.sm) {
                    Button {
                        store.respondUi(chatId, id: request.id, confirmed: false, cancelled: true)
                    } label: {
                        Text("Cancel").frame(maxWidth: .infinity)
                    }
                    .buttonStyle(SecondaryButtonStyle())
                    Button {
                        store.respondUi(chatId, id: request.id, confirmed: true)
                    } label: {
                        Text("Confirm").frame(maxWidth: .infinity)
                    }
                    .buttonStyle(PrimaryButtonStyle())
                }
            default:
                TextField(request.placeholder ?? "", text: $value, axis: .vertical)
                    .lineLimit(request.method == "editor" ? 4...8 : 1...3)
                    .fieldStyle()
                    .accessibilityLabel(title)
                HStack(spacing: Space.sm) {
                    Button {
                        store.respondUi(chatId, id: request.id, cancelled: true)
                    } label: {
                        Text("Cancel").frame(maxWidth: .infinity)
                    }
                    .buttonStyle(SecondaryButtonStyle())
                    Button {
                        store.respondUi(chatId, id: request.id, value: value)
                    } label: {
                        Text("Send").frame(maxWidth: .infinity)
                    }
                    .buttonStyle(PrimaryButtonStyle())
                }
            }
        }
        .padding(Space.md)
        .background(RoundedRectangle(cornerRadius: Radius.md).fill(theme.warningSoft))
        .overlay(RoundedRectangle(cornerRadius: Radius.md).strokeBorder(theme.warning, lineWidth: 1))
        .padding(.horizontal, Space.md)
        .padding(.bottom, Space.sm)
        .accessibilityElement(children: .contain)
    }
}

// MARK: - Session stats

struct StatsSheet: View {
    let chat: ChatModel
    let onCompact: (() -> Void)?
    @Environment(\.theme) private var theme
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        ActionSheetView(title: "Session") {
            if let stats = chat.stats {
                let rows: [(String, String)] = [
                    ("Context", stats.contextPercent.map { "\(Int($0.rounded()))% of \(compactNumber(stats.contextWindow ?? 0))" } ?? "—"),
                    ("Messages", "\(stats.userMessages ?? 0) prompts · \(stats.assistantMessages ?? 0) replies"),
                    ("Tool calls", "\(stats.toolCalls ?? 0)"),
                    ("Input tokens", compactNumber(stats.tokens?.input ?? 0)),
                    ("Output tokens", compactNumber(stats.tokens?.output ?? 0)),
                    ("Cache read / write", "\(compactNumber(stats.tokens?.cacheRead ?? 0)) / \(compactNumber(stats.tokens?.cacheWrite ?? 0))"),
                    ("Cost", formatCost(stats.cost ?? 0))
                ]
                ForEach(rows, id: \.0) { row in
                    Readout(label: row.0, value: row.1)
                }
            } else {
                EmptyState(title: "No stats yet", detail: "They appear once pi has answered.").frame(minHeight: 160)
            }
            if let path = chat.sessionPath {
                VStack(alignment: .leading, spacing: 2) {
                    Text("Session file").foregroundStyle(theme.text)
                    Text(path).font(.system(size: 13)).foregroundStyle(theme.muted).lineLimit(3).textSelection(.enabled)
                }
                .padding(.horizontal, Space.lg)
                .padding(.vertical, Space.md)
                .contextMenu {
                    Button { copyToClipboard(path, "Path copied") } label: { Label("Copy path", systemImage: "doc.on.doc") }
                }
            }
            if let onCompact {
                let percent = chat.stats?.contextPercent ?? 0
                VStack(alignment: .leading, spacing: Space.xs) {
                    if percent >= 70 {
                        Button {
                            dismiss()
                            onCompact()
                        } label: {
                            Text("Compact now").frame(maxWidth: .infinity)
                        }
                        .buttonStyle(PrimaryButtonStyle())
                    } else {
                        Button {
                            dismiss()
                            onCompact()
                        } label: {
                            Text("Compact now").frame(maxWidth: .infinity)
                        }
                        .buttonStyle(SecondaryButtonStyle())
                    }
                    Text(percent >= 70
                        ? "Context is filling up: a summary of earlier messages frees room for the rest of the work."
                        : "Summarizes earlier messages to free up context.")
                        .font(.system(size: 13))
                        .foregroundStyle(theme.muted)
                }
                .padding(.horizontal, Space.lg)
                .padding(.top, Space.sm)
            }
        }
    }
}

// MARK: - Compact

struct CompactSheet: View {
    let onSubmit: (String) -> Void
    @Environment(\.theme) private var theme
    @Environment(\.dismiss) private var dismiss
    @State private var instructions = ""
    @FocusState private var focused: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: Space.md) {
            Text("Compact context").font(.system(size: 17, weight: .semibold)).foregroundStyle(theme.text)
            Text("What should the summary keep? (optional)").font(.system(size: 14)).foregroundStyle(theme.text2)
            TextField("", text: $instructions, axis: .vertical)
                .lineLimit(4...8)
                .fieldStyle()
                .focused($focused)
            Button {
                dismiss()
                onSubmit(instructions.trimmingCharacters(in: .whitespacesAndNewlines))
            } label: {
                Text("Compact").frame(maxWidth: .infinity)
            }
            .buttonStyle(PrimaryButtonStyle())
            Spacer()
        }
        .padding(Space.lg)
        .padding(.top, Space.md)
        .background(theme.raised)
        .onAppear { focused = true }
    }
}

// MARK: - Fork and tree

/// Pick an earlier prompt to branch the session from.
struct ForkSheet: View {
    let chatId: String
    @Environment(\.theme) private var theme
    @Environment(\.dismiss) private var dismiss
    @State private var messages: [ForkMessage]?

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Text("Fork from a prompt").font(.system(size: 17, weight: .semibold)).foregroundStyle(theme.text)
                .padding(.horizontal, Space.lg).padding(.top, Space.xl)
            Text("The chat continues on a new branch from before that prompt; its text returns to the message box.")
                .font(.system(size: 14)).foregroundStyle(theme.muted)
                .padding(.horizontal, Space.lg).padding(.vertical, Space.sm)
            if let messages {
                if messages.isEmpty {
                    EmptyState(title: "Nothing to fork from yet")
                } else {
                    List(messages) { item in
                        Button {
                            dismiss()
                            Task {
                                do {
                                    try await ChatStore.shared.forkAtEntry(chatId, entryId: item.entryId)
                                } catch {
                                    toast("Could not fork: \(errorText(error))")
                                }
                            }
                        } label: {
                            Text(String(collapseWhitespace(item.text).prefix(120)).isEmpty ? "(empty prompt)" : String(collapseWhitespace(item.text).prefix(120)))
                                .foregroundStyle(theme.text)
                                .lineLimit(2)
                                .frame(maxWidth: .infinity, minHeight: touchTarget, alignment: .leading)
                        }
                        .listRowBackground(theme.raised)
                    }
                    .listStyle(.plain)
                    .scrollContentBackground(.hidden)
                }
            } else {
                LoadingLine(text: "Loading…").padding(Space.lg)
                Spacer()
            }
        }
        .background(theme.raised)
        .task {
            do {
                messages = try await API.forkMessages(chatId).reversed()
            } catch {
                toast(errorText(error))
                dismiss()
            }
        }
    }
}

/// /tree: the session's branches. A prompt forks from before it.
struct TreeSheet: View {
    let chatId: String
    @Environment(\.theme) private var theme
    @Environment(\.dismiss) private var dismiss
    @State private var rows: [TreeRow]?

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Text("Session tree").font(.system(size: 17, weight: .semibold)).foregroundStyle(theme.text)
                .padding(.horizontal, Space.lg).padding(.top, Space.xl)
            let branches = rows?.filter(\.branchStart).count ?? 0
            Text(branches > 0
                ? "\(branches) branches. The one pi is on is highlighted; tap a prompt to fork from before it."
                : "Tap a prompt to continue on a new branch from before it.")
                .font(.system(size: 14)).foregroundStyle(theme.muted)
                .padding(.horizontal, Space.lg).padding(.vertical, Space.sm)
            if let rows {
                if rows.isEmpty {
                    EmptyState(title: "Empty session")
                } else {
                    ScrollView {
                        LazyVStack(alignment: .leading, spacing: 0) {
                            ForEach(rows) { row in
                                Button {
                                    dismiss()
                                    Task {
                                        do {
                                            try await ChatStore.shared.forkAtEntry(chatId, entryId: row.id)
                                        } catch {
                                            toast("Could not fork: \(errorText(error))")
                                        }
                                    }
                                } label: {
                                    HStack(spacing: Space.sm) {
                                        Text(row.role).font(.mono(11)).foregroundStyle(row.role == "user" ? theme.accent : theme.muted)
                                            .frame(width: 64, alignment: .leading).lineLimit(1)
                                        Text(row.snippet).font(.system(size: 14)).foregroundStyle(row.active ? theme.text : theme.text2).lineLimit(1)
                                        Spacer(minLength: 0)
                                        if row.leaf { Text("here").font(.mono(11)).foregroundStyle(theme.accent) }
                                    }
                                    .padding(.leading, Space.lg + CGFloat(row.depth) * 14)
                                    .padding(.trailing, Space.lg)
                                    .frame(minHeight: 40)
                                    .opacity(row.active ? 1 : 0.62)
                                    .overlay(alignment: .top) {
                                        if row.branchStart { Rectangle().fill(theme.border).frame(height: 1) }
                                    }
                                }
                                .buttonStyle(RowButtonStyle())
                                .disabled(!row.forkable)
                                .accessibilityLabel("\(row.role): \(row.snippet)\(row.leaf ? ", current position" : "")\(row.forkable ? ". Fork from here" : "")")
                            }
                        }
                    }
                }
            } else {
                LoadingLine(text: "Loading…").padding(Space.lg)
                Spacer()
            }
        }
        .background(theme.raised)
        .task {
            do {
                rows = flattenSessionTree(try await API.tree(chatId))
            } catch {
                toast(errorText(error))
                dismiss()
            }
        }
    }
}

// MARK: - Branches

private enum BranchRow: Identifiable {
    case branch(name: String, current: Bool, worktree: String?, detail: String)
    case remote(name: String, detail: String)
    case worktree(path: String, label: String, detail: String, current: Bool)
    case createBranch(String)
    case createWorktree(String?)

    var id: String {
        switch self {
        case .branch(let name, _, _, _): return "b:\(name)"
        case .remote(let name, _): return "r:\(name)"
        case .worktree(let path, _, _, _): return "w:\(path)"
        case .createBranch: return "c:branch"
        case .createWorktree: return "c:worktree"
        }
    }
}

private struct BranchSection: Identifiable {
    let title: String
    let rows: [BranchRow]
    var id: String { title }
}

/**
 * A project's branches and worktrees: switch this folder to a branch,
 * create one, open a branch in a new worktree chat, or go to a worktree.
 */
struct BranchSheet: View {
    let cwd: String
    /// pi is running in this folder: no switching under it.
    let busy: Bool
    @Environment(\.theme) private var theme
    @Environment(\.dismiss) private var dismiss
    @State private var data: RepoBranches?
    @State private var error: String?
    @State private var query = ""
    @State private var working = false
    @State private var bag = SubscriptionBag()

    private var typed: String { query.trimmingCharacters(in: .whitespaces) }

    private var sections: [BranchSection] {
        guard let data else { return [] }
        let needle = typed.lowercased()
        func match(_ text: String) -> Bool { needle.isEmpty || text.lowercased().contains(needle) }
        let branches: [BranchRow] = data.branches.filter { match($0.name) }.map { branch in
            let detail = [
                branch.current ? "checked out here" : branch.worktree != nil ? "in a worktree" : "",
                branch.ahead.map { "↑\($0)" } ?? "",
                branch.behind.map { "↓\($0)" } ?? "",
                branch.subject
            ].filter { !$0.isEmpty }.joined(separator: " · ")
            return .branch(name: branch.name, current: branch.current, worktree: branch.worktree, detail: detail)
        }
        let remotes: [BranchRow] = data.remotes.filter { match($0.name) }.map { .remote(name: $0.name, detail: $0.subject) }
        let worktrees: [BranchRow] = data.worktrees.filter { !$0.prunable && (match($0.path) || match($0.branch ?? "")) }.map { entry in
            let label = entry.path.split(whereSeparator: { $0 == "/" || $0 == "\\" }).suffix(2).joined(separator: "/")
            let detail = [entry.current ? "this chat" : "", entry.main ? "main checkout" : "", entry.branch ?? "detached"]
                .filter { !$0.isEmpty }.joined(separator: " · ")
            return .worktree(path: entry.path, label: label, detail: detail, current: entry.current)
        }
        let exists = data.branches.contains { $0.name == typed } || data.remotes.contains { $0.name == typed || $0.branch == typed }
        let create: [BranchRow] = typed.isEmpty ? [.createWorktree(nil)] : exists ? [] : [.createBranch(typed), .createWorktree(typed)]
        return [
            BranchSection(title: "", rows: create),
            BranchSection(title: "Branches", rows: branches),
            BranchSection(title: "Remote branches", rows: remotes),
            BranchSection(title: "Worktrees", rows: worktrees)
        ].filter { !$0.rows.isEmpty }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: Space.sm) {
            Text("Branches").font(.system(size: 17, weight: .semibold)).foregroundStyle(theme.text)
                .padding(.horizontal, Space.lg).padding(.top, Space.xl)
            SearchField(text: $query, placeholder: "Find a branch or name a new one").padding(.horizontal, Space.lg)
            Group {
                if let data, data.changes > 0 {
                    Text("\(data.changes) changed \(data.changes == 1 ? "file comes" : "files come") along on a switch; git refuses if they would be overwritten.")
                }
                if data?.truncated == true { Text("Showing the newest branches: type to search them all.") }
                if busy { Text("pi is working in this folder: switching waits until it is done.") }
            }
            .font(.system(size: 14))
            .foregroundStyle(theme.muted)
            .padding(.horizontal, Space.lg)
            if sections.isEmpty {
                if let error {
                    EmptyState(title: "Could not read the branches", detail: error)
                } else if data == nil {
                    EmptyState(title: "Reading branches…")
                } else {
                    EmptyState(title: "No branch matches")
                }
            } else {
                List {
                    ForEach(sections) { section in
                        Section {
                            ForEach(section.rows) { row in
                                rowView(row).listRowInsets(EdgeInsets()).listRowBackground(theme.raised)
                            }
                        } header: {
                            if !section.title.isEmpty { SectionLabel(section.title).textCase(nil) }
                        }
                    }
                }
                .listStyle(.plain)
                .scrollContentBackground(.hidden)
            }
        }
        .background(theme.raised)
        .task(id: typed) {
            // The typed name also searches on the computer (debounced).
            if !typed.isEmpty { try? await Task.sleep(nanoseconds: 300_000_000) }
            guard !Task.isCancelled else { return }
            await load()
        }
        .task {
            bag.add(Connection.shared.on(RemoteEvent.gitChanged) { _ in Task { await load() } })
        }
        .onDisappear { bag.cancelAll() }
    }

    private func load() async {
        do {
            data = try await API.branches(cwd, query: typed)
            error = nil
        } catch {
            self.error = errorText(error)
        }
    }

    @ViewBuilder
    private func rowView(_ row: BranchRow) -> some View {
        let (symbol, title, detail, current): (String, String, String, Bool) = {
            switch row {
            case .branch(let name, let current, _, let detail): return (current ? "checkmark" : "arrow.triangle.branch", name, detail, current)
            case .remote(let name, let detail): return ("arrow.triangle.branch", name, detail, false)
            case .worktree(_, let label, let detail, _): return ("folder.badge.gearshape", label, detail, false)
            case .createBranch(let name): return ("plus", "Create “\(name)” and switch to it", "", false)
            case .createWorktree(let name): return ("plus", name.map { "New worktree chat on “\($0)”" } ?? "New worktree chat (new pi/ branch)", "", false)
            }
        }()
        let branchOff: String? = {
            switch row {
            case .branch(let name, let current, let worktree, _) where !current && worktree == nil: return name
            case .remote(let name, _): return name
            default: return nil
            }
        }()
        HStack(spacing: 0) {
            Button {
                Task { await press(row) }
            } label: {
                HStack(spacing: Space.md) {
                    Image(systemName: symbol).foregroundStyle(current ? theme.accent : theme.text2).frame(width: 20)
                    VStack(alignment: .leading, spacing: 1) {
                        Text(title).font(.system(size: 16, weight: current ? .semibold : .regular)).foregroundStyle(theme.text).lineLimit(1)
                        if !detail.isEmpty { Text(detail).font(.mono(12)).foregroundStyle(theme.muted).lineLimit(1) }
                    }
                    Spacer(minLength: 0)
                }
                .padding(.horizontal, Space.lg)
                .padding(.vertical, Space.sm)
                .frame(minHeight: touchTarget)
            }
            .buttonStyle(RowButtonStyle())
            .disabled(working)
            if let branchOff {
                Button {
                    Task { await newWorktree(.existing(branch: branchOff)) }
                } label: {
                    Image(systemName: "folder.badge.plus").foregroundStyle(theme.text2).frame(width: touchTarget, height: touchTarget)
                }
                .accessibilityLabel("Open \(branchOff) in a new worktree chat")
            }
        }
    }

    private func close() {
        query = ""
        dismiss()
    }

    private func openWorktree(_ path: String) async {
        do {
            try await API.addProject(path)
            try? await DataStore.shared.refresh()
            close()
            Router.shared.startChat(path)
        } catch {
            toast(errorText(error))
        }
    }

    private func newWorktree(_ source: WorktreeSource?) async {
        working = true
        defer { working = false }
        do {
            toast("Creating a worktree…")
            let worktree = try await API.createWorktree(cwd, source: source)
            try? await DataStore.shared.refresh()
            Haptic.success.play()
            close()
            Router.shared.startChat(worktree.cwd)
            toast("New worktree on \(worktree.branch)")
        } catch {
            toast("Could not create a worktree: \(errorText(error))")
        }
    }

    private func press(_ row: BranchRow) async {
        guard !working else { return }
        switch row {
        case .worktree(let path, _, _, let current):
            if current { close() } else { await openWorktree(path) }
            return
        case .branch(_, true, _, _):
            close()
            return
        case .branch(_, _, let worktree?, _):
            // Git checks a branch out in one place only: go to where it is.
            await openWorktree(worktree)
            return
        case .createWorktree(let name):
            await newWorktree(name.map { .new(branch: $0) })
            return
        default:
            break
        }
        if busy {
            toast("pi is working in this folder: wait for it to finish, or use a worktree")
            return
        }
        working = true
        defer { working = false }
        do {
            let result: GitActionResult
            switch row {
            case .createBranch(let name): result = try await API.createBranch(cwd, name)
            case .branch(let name, _, _, _), .remote(let name, _): result = try await API.switchBranch(cwd, name)
            default: return
            }
            toast(result.ok ? result.message : "Git refused: \(result.message)")
            if result.ok {
                Haptic.success.play()
                close()
            }
        } catch {
            toast(errorText(error))
        }
    }
}
