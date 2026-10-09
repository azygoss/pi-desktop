import PiRemoteKit
import SwiftUI

/// Side chats whose close could not reach the computer: closed once it is back.
@MainActor
private enum UnclosedSides {
    static var ids = Set<String>()
    static var watching = false

    static func add(_ id: String) {
        ids.insert(id)
        guard !watching else { return }
        watching = true
        Connection.shared.onOnline {
            for id in ids {
                Task {
                    if (try? await API.closeSide(id)) != nil { ids.remove(id) }
                }
            }
        }
    }
}

/// Events reduced into a mutable state, published to SwiftUI at most every 60ms.
@MainActor
@Observable
private final class SideModel {
    var messages: [DisplayMessage] = []
    var status: ChatStatus = .idle
    var phase: Phase = .starting
    var error: String?

    enum Phase { case starting, ready, error, ended }

    @ObservationIgnored var view = ChatViewState()
    @ObservationIgnored private var publishTask: Task<Void, Never>?

    func publishNow() {
        publishTask?.cancel()
        publishTask = nil
        messages = view.messages
        status = view.status
    }

    func publishSoon() {
        guard publishTask == nil else { return }
        publishTask = Task { [weak self] in
            try? await Task.sleep(nanoseconds: 60_000_000)
            guard !Task.isCancelled, let self else { return }
            self.publishTask = nil
            self.messages = self.view.messages
            self.status = self.view.status
        }
    }
}

/**
 * A side chat: questions answered with the chat's context that leave
 * nothing behind in it. pi runs on a scratch copy of the session on the
 * computer; leaving the screen ends it.
 */
struct SideChatView: View {
    let chatId: String
    let question: String?

    @Environment(\.theme) private var theme
    @State private var model = SideModel()
    @State private var text = ""
    @State private var generation = 0
    @State private var hasHistory = true
    @State private var sideId = ""
    @State private var opened: Task<Void, Error>?
    @State private var asked = false
    @State private var counter = 0

    private var streaming: Bool { model.status == .streaming }
    private var dead: Bool { model.phase == .error || model.phase == .ended }

    var body: some View {
        VStack(spacing: 0) {
            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: Space.lg) {
                        ForEach(model.messages) { message in
                            messageView(message)
                        }
                        footer.id("footer")
                    }
                    .padding(.horizontal, Space.lg)
                    .padding(.vertical, Space.md)
                }
                .defaultScrollAnchor(.bottom)
                .scrollDismissesKeyboard(.interactively)
                .onChange(of: model.messages.last?.key) { _, _ in proxy.scrollTo("footer", anchor: .bottom) }
            }
            HStack(alignment: .bottom, spacing: Space.sm) {
                TextField("Ask a side question", text: $text, axis: .vertical)
                    .lineLimit(1...5)
                    .fieldStyle()
                    .disabled(dead)
                    .accessibilityLabel("Side question")
                if streaming {
                    Button { submit() } label: {
                        Image(systemName: "stop.fill").foregroundStyle(theme.danger).frame(width: touchTarget, height: touchTarget)
                    }
                    .accessibilityLabel("Stop")
                } else {
                    Button { submit() } label: {
                        Image(systemName: "arrow.up.circle.fill").font(.system(size: 28)).foregroundStyle(theme.accent).frame(width: touchTarget, height: touchTarget)
                    }
                    .disabled(dead || text.trimmed.isEmpty)
                    .accessibilityLabel("Ask")
                }
            }
            .padding(.horizontal, Space.md)
            .padding(.vertical, Space.sm)
            .overlay(alignment: .top) { Rectangle().fill(theme.border).frame(height: 1) }
            .background(theme.bg)
        }
        .background(theme.bg.ignoresSafeArea())
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .principal) {
                VStack(spacing: 0) {
                    Text("Side chat").font(.system(size: 16, weight: .semibold)).foregroundStyle(theme.text)
                    Text("Nothing here is added to the chat").font(.mono(12)).foregroundStyle(theme.muted)
                }
            }
            ToolbarItem(placement: .topBarTrailing) {
                Button { generation += 1 } label: { Image(systemName: "arrow.counterclockwise") }
                    .accessibilityLabel("Start over with the chat as it is now")
            }
        }
        .task(id: generation) { await run() }
    }

    @ViewBuilder
    private func messageView(_ message: DisplayMessage) -> some View {
        switch message {
        case .user(let user):
            HStack(alignment: .top, spacing: Space.sm) {
                Text("›").font(.mono(15)).foregroundStyle(theme.muted)
                Text(user.text).foregroundStyle(theme.text).textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading)
            }
            .padding(.horizontal, Space.md)
            .padding(.vertical, Space.sm)
            .background(RoundedRectangle(cornerRadius: Radius.md).fill(theme.userBlock))
        case .notice(let notice):
            Text(notice.text).font(.system(size: 14)).foregroundStyle(notice.tone == .error ? theme.danger : theme.muted)
        case .assistant(let assistant):
            VStack(alignment: .leading, spacing: Space.sm) {
                ForEach(Array(assistant.blocks.enumerated()), id: \.offset) { _, block in
                    switch block {
                    case .text(let value):
                        if !value.isEmpty { MarkdownView(text: value) }
                    case .thinking(let thinking):
                        Text(assistant.streaming && thinking.durationMs == nil ? "thinking…" : "thought").font(.mono(12)).foregroundStyle(theme.muted)
                    case .toolCall(let call):
                        Text(call.name).font(.mono(12)).foregroundStyle(theme.muted).lineLimit(1)
                    case .image:
                        EmptyView()
                    }
                }
                if let error = assistant.errorMessage {
                    Text(error).font(.system(size: 14)).foregroundStyle(theme.danger)
                }
            }
        case .bash:
            EmptyView()
        }
    }

    private var footer: some View {
        VStack(alignment: .leading, spacing: Space.md) {
            if model.messages.isEmpty && !dead {
                Text(hasHistory
                    ? "pi answers with this chat as context. Nothing said here is added to the chat."
                    : "This chat has no history yet, so pi answers without its context.")
                    .font(.system(size: 14))
                    .foregroundStyle(theme.muted)
            }
            if model.phase == .starting {
                LoadingLine(text: "Starting…")
            } else if streaming {
                HStack(spacing: Space.sm) {
                    Pixel(tone: .working)
                    Text("Working").font(.system(size: 14)).foregroundStyle(theme.accent)
                }
            }
            if dead, let error = model.error {
                HStack(spacing: Space.sm) {
                    Pixel(tone: .error)
                    Text(error).font(.system(size: 14)).foregroundStyle(theme.danger)
                }
                Button {
                    generation += 1
                } label: {
                    Label("Start again", systemImage: "arrow.counterclockwise")
                }
                .buttonStyle(SecondaryButtonStyle())
            }
        }
    }

    /// One side chat, for as long as this screen (and generation) lasts.
    private func run() async {
        // Read once per start: the side chat is a snapshot of the chat right now.
        model.view = ChatViewState()
        model.publishNow()
        guard let chat = ChatStore.shared.chat(chatId) else {
            model.phase = .error
            model.error = "This chat is no longer open."
            return
        }
        let id = "s-\(UUID().uuidString.lowercased())"
        sideId = id
        model.phase = .starting
        model.error = nil
        hasHistory = chat.sessionPath != nil
        let bag = SubscriptionBag()
        bag.add(Connection.shared.on(RemoteEvent.sideEvent) { payload in
            guard payload["sideId"]?.stringValue == id else { return }
            for event in payload["events"]?.arrayValue ?? [] { model.view.reduce(PiEvent(json: event)) }
            model.publishSoon()
        })
        bag.add(Connection.shared.on(RemoteEvent.sideExit) { payload in
            guard payload["sideId"]?.stringValue == id else { return }
            model.view.status = .idle
            model.publishNow()
            model.phase = .ended
            model.error = "The side chat stopped"
        })
        // Side events are not replayed: after a dropped link never stay stuck on "Working".
        bag.add(Connection.shared.onOnline {
            if model.view.status == .streaming {
                model.view.status = .idle
                model.publishNow()
            }
        })
        let open = Task {
            try await API.openSide(
                sideId: id,
                cwd: chat.cwd,
                sessionPath: chat.sessionPath,
                model: chat.model.map { SideModelInput(provider: $0.provider, modelId: $0.id) }
            )
        }
        opened = open
        do {
            try await open.value
            if model.phase == .starting { model.phase = .ready }
            // A question handed over with the route is asked once.
            if let question, !asked {
                asked = true
                await send(question)
            }
        } catch {
            if !Task.isCancelled {
                model.view.status = .idle
                model.publishNow()
                model.phase = .error
                model.error = errorText(error)
            }
        }
        // Wait until the screen (or generation) goes away, then end the side chat.
        while !Task.isCancelled {
            try? await Task.sleep(nanoseconds: 3_600_000_000_000)
        }
        bag.cancelAll()
        Task {
            do { try await API.closeSide(id) } catch { UnclosedSides.add(id) }
        }
    }

    private func send(_ message: String) async {
        let value = message.trimmed
        let id = sideId
        guard !value.isEmpty, !id.isEmpty, model.view.status != .streaming else { return }
        counter += 1
        model.view.messages.append(.user(UserDisplay(key: "side-user-\(counter)", text: value, images: [])))
        model.view.status = .streaming
        model.publishNow()
        do {
            try await opened?.value
            try await API.sendSide(id, value)
        } catch {
            if sideId == id {
                model.view.status = .idle
                model.publishNow()
                toast(errorText(error))
            }
        }
    }

    private func submit() {
        if streaming {
            let id = sideId
            Task {
                do { try await API.abortSide(id) } catch { toast(errorText(error)) }
            }
            return
        }
        guard !text.trimmed.isEmpty, !dead else { return }
        let value = text
        text = ""
        Task { await send(value) }
    }
}
