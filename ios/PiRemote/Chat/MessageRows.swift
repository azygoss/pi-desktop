import PiRemoteKit
import SwiftUI

/// What rows can ask the chat screen to do.
struct RowActions {
    /// Prompt actions: copy, edit and resend, retry, restore files.
    var onUserMenu: (UserDisplay, Int) -> Void
    var onCopy: (String) -> Void
    var onImage: (UIImage) -> Void
    var onOpenFile: (String) -> Void
}

// MARK: - User prompt

/// A prompt, not a bubble: a › in the gutter.
struct UserRow: View, Equatable {
    let message: UserDisplay
    let userIndex: Int
    let actions: RowActions
    @Environment(\.theme) private var theme

    nonisolated static func == (lhs: UserRow, rhs: UserRow) -> Bool {
        lhs.message == rhs.message && lhs.userIndex == rhs.userIndex
    }

    var body: some View {
        let (skills, rest) = parseSkillPrefix(message.text)
        HStack(alignment: .top, spacing: Space.sm) {
            Text("›").font(.mono(16)).foregroundStyle(theme.muted)
            VStack(alignment: .leading, spacing: Space.sm) {
                if !skills.isEmpty {
                    Text(skills.map { "/skill:\($0.name)" }.joined(separator: " ")).font(.mono(12)).foregroundStyle(theme.accent)
                }
                if !rest.trimmed.isEmpty {
                    mentionText(rest).lineSpacing(4)
                }
                if !message.images.isEmpty {
                    HStack(spacing: Space.sm) {
                        ForEach(Array(message.images.enumerated()), id: \.offset) { _, image in
                            if let ui = image.uiImage {
                                Button {
                                    actions.onImage(ui)
                                } label: {
                                    Image(uiImage: ui).resizable().scaledToFill().frame(width: 72, height: 72)
                                        .clipShape(RoundedRectangle(cornerRadius: Radius.sm))
                                }
                                .accessibilityLabel("Open attached image")
                            }
                        }
                    }
                }
                if message.queued {
                    Text("queued · waiting for pi to start").font(.mono(12)).foregroundStyle(theme.muted)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .padding(Space.md)
        .background(RoundedRectangle(cornerRadius: Radius.md).fill(theme.userBlock))
        .contentShape(RoundedRectangle(cornerRadius: Radius.md))
        .onLongPressGesture(minimumDuration: 0.35) {
            Haptic.tap.play()
            actions.onUserMenu(message, userIndex)
        }
        .accessibilityAction(named: "Prompt actions") { actions.onUserMenu(message, userIndex) }
        .padding(.horizontal, Space.lg)
        .padding(.vertical, Space.sm)
    }

    private func mentionText(_ text: String) -> Text {
        splitMentions(text).reduce(Text("")) { result, segment in
            switch segment {
            case .text(let plain):
                return result + Text(plain).font(.system(size: 16)).foregroundColor(theme.text)
            case .mention(_, let path):
                return result + Text("@\(baseName(path))").font(.mono(14)).foregroundColor(theme.accent)
            }
        }
    }
}

// MARK: - Assistant

private enum RenderItem {
    case block(DisplayBlock)
    case toolGroup([ToolCallBlock])
}

/// Runs of consecutive tool calls fold into one group; a lone call stays a row.
private func groupToolCalls(_ blocks: [DisplayBlock]) -> [RenderItem] {
    var items: [RenderItem] = []
    for block in blocks {
        guard case .toolCall(let call) = block else {
            items.append(.block(block))
            continue
        }
        switch items.last {
        case .toolGroup(let calls)?:
            items[items.count - 1] = .toolGroup(calls + [call])
        case .block(.toolCall(let previous))?:
            items[items.count - 1] = .toolGroup([previous, call])
        default:
            items.append(.block(block))
        }
    }
    return items
}

struct AssistantBody: View {
    let message: AssistantDisplay
    let toolRuns: [String: ToolRun]
    let cwd: String
    let live: Bool
    let actions: RowActions
    @Environment(\.theme) private var theme

    var body: some View {
        let streaming = live && message.streaming
        VStack(alignment: .leading, spacing: Space.sm) {
            ForEach(Array(groupToolCalls(message.blocks).enumerated()), id: \.offset) { _, item in
                switch item {
                case .block(.text(let text)):
                    if !text.trimmed.isEmpty {
                        // Selectable once it has settled.
                        MarkdownView(text: text, selectable: !streaming)
                    }
                case .block(.thinking(let block)):
                    ThinkingStepView(block: block, live: streaming).padding(.horizontal, -Space.sm)
                case .block(.toolCall(let call)):
                    ToolStepView(call: call, run: toolRuns[call.id], cwd: cwd, live: live, onOpenFile: actions.onOpenFile)
                        .padding(.horizontal, -Space.sm)
                case .toolGroup(let calls):
                    ToolGroupView(calls: calls, toolRuns: toolRuns, cwd: cwd, live: live, onOpenFile: actions.onOpenFile)
                        .padding(.horizontal, -Space.sm)
                case .block(.image(let image)):
                    if let ui = image.uiImage {
                        Button {
                            actions.onImage(ui)
                        } label: {
                            Image(uiImage: ui).resizable().scaledToFit().frame(maxHeight: 200)
                                .clipShape(RoundedRectangle(cornerRadius: Radius.sm))
                        }
                        .accessibilityLabel("Image in the reply")
                    }
                }
            }
            if let error = message.errorMessage {
                Text(error)
                    .font(.system(size: 14))
                    .foregroundStyle(theme.danger)
                    .textSelection(.enabled)
                    .padding(.leading, Space.md)
                    .padding(.vertical, Space.xs)
                    .overlay(alignment: .leading) { Rectangle().fill(theme.danger).frame(width: 2) }
            } else if message.stopReason == .aborted {
                Text("stopped").font(.mono(12)).foregroundStyle(theme.muted)
            }
        }
    }
}

/// Images the row's tools produced, outside the folded steps.
struct ShotsView: View {
    let messages: [AssistantDisplay]
    let toolRuns: [String: ToolRun]
    let actions: RowActions
    @Environment(\.theme) private var theme

    var body: some View {
        let shots = collectToolShots(messages, toolRuns)
        if !shots.isEmpty {
            let shown = shots.filter(\.shown)
            let screenshots = shots.filter { !$0.shown }
            VStack(alignment: .leading, spacing: Space.sm) {
                ForEach(shown) { shot in
                    if let image = shot.uiImage {
                        VStack(alignment: .leading, spacing: Space.xs) {
                            Button {
                                actions.onImage(image)
                            } label: {
                                Image(uiImage: image)
                                    .resizable()
                                    .scaledToFit()
                                    .frame(maxWidth: .infinity, maxHeight: 520)
                                    .background(theme.codeBg)
                                    .clipShape(RoundedRectangle(cornerRadius: Radius.md))
                            }
                            .accessibilityLabel(shot.caption.map { "Open image: \($0)" } ?? "Open image")
                            if let caption = shot.caption {
                                Text(caption).font(.system(size: 14)).foregroundStyle(theme.text2)
                            }
                        }
                    }
                }
                if !screenshots.isEmpty {
                    ScrollView(.horizontal, showsIndicators: false) {
                        HStack(spacing: Space.sm) {
                            ForEach(screenshots) { shot in
                                if let image = shot.uiImage {
                                    Button {
                                        actions.onImage(image)
                                    } label: {
                                        Image(uiImage: image).resizable().scaledToFill().frame(width: 136, height: 88)
                                            .clipShape(RoundedRectangle(cornerRadius: Radius.sm))
                                            .overlay(RoundedRectangle(cornerRadius: Radius.sm).strokeBorder(theme.border, lineWidth: 0.5))
                                    }
                                    .accessibilityLabel(shot.caption.map { "Open screenshot: \($0)" } ?? "Open screenshot")
                                }
                            }
                        }
                    }
                }
            }
            .padding(.top, Space.sm)
        }
    }
}

/// Only the runs this message's tool calls point at matter for a re-render.
private func sameRuns(_ message: AssistantDisplay, _ a: [String: ToolRun], _ b: [String: ToolRun]) -> Bool {
    for block in message.blocks {
        if case .toolCall(let call) = block, a[call.id] != b[call.id] { return false }
    }
    return true
}

struct AssistantRow: View, Equatable {
    let message: AssistantDisplay
    let toolRuns: [String: ToolRun]
    let cwd: String
    let live: Bool
    let actions: RowActions

    nonisolated static func == (lhs: AssistantRow, rhs: AssistantRow) -> Bool {
        lhs.message == rhs.message && lhs.cwd == rhs.cwd && lhs.live == rhs.live && sameRuns(rhs.message, lhs.toolRuns, rhs.toolRuns)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            AssistantBody(message: message, toolRuns: toolRuns, cwd: cwd, live: live, actions: actions)
            ShotsView(messages: [message], toolRuns: toolRuns, actions: actions)
        }
        .padding(.horizontal, Space.lg)
        .padding(.vertical, Space.sm)
    }
}

// MARK: - Work group

/**
 * A stretch of agent work — many small messages that are only thinking and
 * tool calls — as one row: "Worked for 2m 10s · read 4 files". Open while
 * the turn is live, folded once it settles; the user's toggle wins.
 */
struct WorkGroupRow: View, Equatable {
    let messages: [AssistantDisplay]
    let toolRuns: [String: ToolRun]
    let cwd: String
    let live: Bool
    let startedAt: Double?
    let endedAt: Double?
    let actions: RowActions
    @State private var userOpen: Bool?
    @Environment(\.theme) private var theme

    nonisolated static func == (lhs: WorkGroupRow, rhs: WorkGroupRow) -> Bool {
        lhs.live == rhs.live && lhs.cwd == rhs.cwd && lhs.endedAt == rhs.endedAt && lhs.messages.count == rhs.messages.count
            && zip(lhs.messages, rhs.messages).allSatisfy { $0 == $1 && sameRuns($1, lhs.toolRuns, rhs.toolRuns) }
    }

    var body: some View {
        let open = userOpen ?? live
        var thoughts = 0
        var calls: [ToolCallBlock] = []
        for message in messages {
            for block in message.blocks {
                if case .thinking = block { thoughts += 1 }
                if case .toolCall(let call) = block { calls.append(call) }
            }
        }
        let summary = summarizeToolRuns(runInfos(calls, toolRuns, live: false))
        let running = summary.running > 0
        let span = startedAt.flatMap { start in endedAt.map { $0 - start } }
        let label = live ? "Working" : (span.map { $0 >= 1000 ? "Worked for \(formatDuration($0))" : "Worked" } ?? "Worked")
        let counts = [
            calls.isEmpty ? "" : "\(calls.count) \(calls.count == 1 ? "tool" : "tools")",
            thoughts == 0 ? "" : "\(thoughts) \(thoughts == 1 ? "thought" : "thoughts")"
        ].filter { !$0.isEmpty }.joined(separator: " · ")
        return VStack(alignment: .leading, spacing: 0) {
            StepRow(
                symbol: "list.bullet.indent",
                state: running ? .running : summary.failed > 0 ? .error : .done,
                name: label,
                summary: calls.isEmpty ? counts : summary.text,
                open: open,
                label: "\(label) \(calls.isEmpty ? counts : summary.text)",
                onToggle: { userOpen = !open }
            ) {
                if !running, let diff = summary.diff { DiffStatText(added: diff.added, removed: diff.removed) }
            }
            .padding(.horizontal, -Space.sm)
            if open {
                VStack(alignment: .leading, spacing: 0) {
                    ForEach(messages, id: \.key) { message in
                        AssistantBody(message: message, toolRuns: toolRuns, cwd: cwd, live: live, actions: actions)
                            .padding(.horizontal, Space.sm)
                            .padding(.vertical, Space.xs)
                    }
                }
                .padding(.leading, Space.xs)
                .overlay(alignment: .leading) { Rectangle().fill(theme.border).frame(width: 0.5) }
                .padding(.leading, Space.md)
            }
            ShotsView(messages: messages, toolRuns: toolRuns, actions: actions)
        }
        .padding(.horizontal, Space.lg)
        .padding(.vertical, Space.xs)
    }
}

// MARK: - Shell, notice, meta

/// A `!command` the user ran: the same terminal card as a shell step, opened.
struct BashRow: View, Equatable {
    let message: BashDisplay
    @Environment(\.theme) private var theme

    nonisolated static func == (lhs: BashRow, rhs: BashRow) -> Bool { lhs.message == rhs.message }

    var body: some View {
        let failed = !message.running && (message.cancelled || (message.exitCode ?? 0) != 0)
        var trimmed = message.output
        while trimmed.hasSuffix("\n") { trimmed.removeLast() }
        let lines = trimmed.components(separatedBy: "\n")
        let output = lines.count > 120 ? "⋯\n" + lines.suffix(120).joined(separator: "\n") : trimmed
        return VStack(alignment: .leading, spacing: 0) {
            (Text("$ ").foregroundColor(theme.muted) + Text(message.command).foregroundColor(theme.text2))
                .font(.mono(12))
                .textSelection(.enabled)
                .padding([.horizontal, .top], Space.md)
                .padding(.bottom, output.trimmed.isEmpty ? Space.md : 0)
            if !output.trimmed.isEmpty {
                Text(output)
                    .font(.mono(12))
                    .foregroundStyle(theme.text2)
                    .lineSpacing(2)
                    .textSelection(.enabled)
                    .padding(Space.md)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            Text(message.running ? "running" : message.cancelled ? ShellStatus.aborted.label : ShellStatus.exit(message.exitCode ?? 0).label)
                .font(.mono(12))
                .foregroundStyle(message.running ? theme.accent : failed ? theme.danger : theme.success)
                .padding(.horizontal, Space.md)
                .padding(.vertical, Space.sm)
                .frame(maxWidth: .infinity, alignment: .leading)
                .overlay(alignment: .top) { Rectangle().fill(theme.border).frame(height: 0.5) }
        }
        .background(RoundedRectangle(cornerRadius: Radius.md).fill(theme.codeBg))
        .overlay(RoundedRectangle(cornerRadius: Radius.md).strokeBorder(theme.border, lineWidth: 0.5))
        .clipShape(RoundedRectangle(cornerRadius: Radius.md))
        .padding(.horizontal, Space.lg)
        .padding(.vertical, Space.sm)
    }
}

struct NoticeRow: View, Equatable {
    let message: NoticeDisplay
    @State private var open = false
    @Environment(\.theme) private var theme

    nonisolated static func == (lhs: NoticeRow, rhs: NoticeRow) -> Bool { lhs.message == rhs.message }

    var body: some View {
        VStack(alignment: .leading, spacing: Space.sm) {
            let line = HStack(spacing: Space.sm) {
                Pixel(tone: message.tone == .error ? .error : .idle, size: 6)
                Text(message.text + (message.detail == nil ? "" : open ? "  ▾" : "  ▸"))
                    .font(.mono(12))
                    .foregroundStyle(message.tone == .error ? theme.danger : theme.muted)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            if message.detail != nil {
                Button { open.toggle() } label: { line.frame(minHeight: 40).contentShape(Rectangle()) }
                    .buttonStyle(.plain)
                    .accessibilityValue(open ? "expanded" : "collapsed")
            } else {
                line
            }
            if open, let detail = message.detail {
                MarkdownView(text: detail)
            }
        }
        .padding(.horizontal, Space.lg)
        .padding(.vertical, Space.sm)
    }
}

/// "model · 14:02 · 1.8k tokens out · $0.04" under a finished turn.
struct MetaRow: View {
    let text: String
    let reply: String
    let onCopy: (String) -> Void
    var onRetry: (() -> Void)?
    @Environment(\.theme) private var theme

    var body: some View {
        HStack(spacing: 0) {
            Text(text).font(.mono(12)).foregroundStyle(theme.muted).frame(maxWidth: .infinity, alignment: .leading)
            if let onRetry {
                Button(action: onRetry) {
                    Image(systemName: "arrow.counterclockwise").font(.system(size: 13)).foregroundStyle(theme.muted)
                        .frame(width: touchTarget, height: 36)
                }
                .accessibilityLabel("Retry: ask pi again from this prompt")
            }
            if !reply.isEmpty {
                Button { onCopy(reply) } label: {
                    Image(systemName: "doc.on.doc").font(.system(size: 13)).foregroundStyle(theme.muted)
                        .frame(width: touchTarget, height: 36)
                }
                .accessibilityLabel("Copy reply")
            }
        }
        .padding(.leading, Space.lg)
        .padding(.trailing, Space.xs)
    }
}
