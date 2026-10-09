import PiRemoteKit
import SwiftUI

/// Output and diffs longer than this fold behind "Show all".
private let maxLines = 80
private let maxArgChars = 2000

enum StepState {
    case running, error, done
}

private func icon(_ category: ToolCategory) -> String {
    switch category {
    case .run: return "terminal"
    case .read: return "doc.text"
    case .edit: return "pencil"
    case .create: return "doc.badge.plus"
    case .search: return "magnifyingglass"
    case .browser: return "globe"
    case .computer: return "cursorarrow"
    case .image: return "photo"
    case .other: return "wrench.and.screwdriver"
    }
}

/// Blue while running (blinking on the 1 Hz clock), coral on failure.
private struct StepTile: View {
    let symbol: String
    let state: StepState
    @Environment(\.theme) private var theme

    var body: some View {
        LiveTick(live: state == .running) { tick in
            Image(systemName: symbol)
                .font(.system(size: 11, weight: .medium))
                .foregroundStyle(state == .running ? theme.accent : state == .error ? theme.danger : theme.muted)
                .frame(width: 24, height: 24)
                .background(RoundedRectangle(cornerRadius: Radius.sm).fill(theme.surface))
                .opacity(state == .running && tick % 2 == 1 ? 0.45 : 1)
        }
    }
}

/// The one-line header of a step that opens into its detail.
struct StepRow<Trailing: View>: View {
    let symbol: String
    let state: StepState
    let name: String
    var summary: String?
    let open: Bool
    let label: String
    let onToggle: () -> Void
    @ViewBuilder var trailing: Trailing
    @Environment(\.theme) private var theme

    var body: some View {
        Button(action: onToggle) {
            HStack(spacing: Space.sm) {
                StepTile(symbol: symbol, state: state)
                (Text(name).font(.mono(13, .medium)).foregroundColor(state == .error ? theme.danger : theme.text)
                    + Text(summary.map { "  \($0)" } ?? "").font(.mono(13)).foregroundColor(theme.muted))
                    .lineLimit(1)
                    .frame(maxWidth: .infinity, alignment: .leading)
                trailing
                Image(systemName: "chevron.right")
                    .font(.system(size: 11, weight: .semibold))
                    .foregroundStyle(theme.muted)
                    .rotationEffect(.degrees(open ? 90 : 0))
            }
            .padding(.vertical, Space.xs)
            .padding(.horizontal, Space.sm)
            .frame(minHeight: touchTarget - 4)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(label)
        .accessibilityValue(open ? "expanded" : "collapsed")
    }
}

/// Mono text that folds its middle away when long.
private struct FoldedText: View {
    let text: String
    var tail = false
    @State private var all = false
    @Environment(\.theme) private var theme

    var body: some View {
        let lines = text.components(separatedBy: "\n")
        let long = lines.count > maxLines
        let shown = !long || all ? text : (tail ? lines.suffix(maxLines) : lines.prefix(maxLines)).joined(separator: "\n")
        VStack(alignment: .leading, spacing: 0) {
            if long && !all && tail { showAll(lines.count) }
            Text(shown)
                .font(.mono(12))
                .foregroundStyle(theme.text2)
                .lineSpacing(2)
                .textSelection(.enabled)
                .padding(Space.sm)
                .frame(maxWidth: .infinity, alignment: .leading)
            if long && !all && !tail { showAll(lines.count) }
        }
    }

    private func showAll(_ count: Int) -> some View {
        Button("⋯ show all \(count) lines") { all = true }
            .font(.mono(12))
            .foregroundStyle(theme.muted)
            .padding(.horizontal, Space.sm)
            .frame(minHeight: touchTarget)
    }
}

/// A unified diff of an edit: removed and added lines interleaved.
struct DiffBlockView: View {
    let lines: [DiffLine?]
    @State private var all = false
    @Environment(\.theme) private var theme

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            ForEach(Array((all ? lines : Array(lines.prefix(maxLines))).enumerated()), id: \.offset) { _, line in
                if let line {
                    Text("\(line.kind == .added ? "+" : line.kind == .removed ? "−" : " ") \(line.text)")
                        .font(.mono(12))
                        .foregroundStyle(line.kind == .context ? theme.text2 : theme.text)
                        .padding(.horizontal, Space.sm)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .background(line.kind == .added ? theme.successSoft : line.kind == .removed ? theme.dangerSoft : Color.clear)
                } else {
                    Text("⋯").font(.mono(12)).foregroundStyle(theme.muted).padding(.horizontal, Space.sm)
                }
            }
            if lines.count > maxLines && !all {
                Button("⋯ \(lines.count - maxLines) more lines") { all = true }
                    .font(.mono(12))
                    .foregroundStyle(theme.muted)
                    .padding(.horizontal, Space.sm)
                    .frame(minHeight: touchTarget)
            }
        }
        .padding(.vertical, Space.xs)
        .background(RoundedRectangle(cornerRadius: Radius.sm).fill(theme.codeBg))
        .overlay(RoundedRectangle(cornerRadius: Radius.sm).strokeBorder(theme.border, lineWidth: 0.5))
        .clipShape(RoundedRectangle(cornerRadius: Radius.sm))
    }
}

private func resultText(_ run: ToolRun?) -> String {
    guard let run else { return "" }
    if let result = run.result {
        return result.content.compactMap { block in
            if case .text(let text) = block { return text }
            return nil
        }.joined(separator: "\n")
    }
    return run.partialText ?? ""
}

private func trimTrailingNewlines(_ text: String) -> String {
    var out = text
    while out.hasSuffix("\n") { out.removeLast() }
    return out
}

private struct TermBox<Content: View>: View {
    @ViewBuilder var content: Content
    @Environment(\.theme) private var theme

    var body: some View {
        VStack(alignment: .leading, spacing: 0) { content }
            .background(RoundedRectangle(cornerRadius: Radius.sm).fill(theme.codeBg))
            .overlay(RoundedRectangle(cornerRadius: Radius.sm).strokeBorder(theme.border, lineWidth: 0.5))
            .clipShape(RoundedRectangle(cornerRadius: Radius.sm))
    }
}

private struct ToolDetail: View {
    let call: ToolCallBlock
    let run: ToolRun?
    let category: ToolCategory
    @Environment(\.theme) private var theme

    private var args: [String: JSONValue] {
        if let run, !run.args.isEmpty { return run.args }
        return call.arguments
    }

    var body: some View {
        let text = resultText(run)
        switch category {
        case .run:
            let (output, status) = splitShellStatus(text)
            TermBox {
                (Text("$ ").foregroundColor(theme.muted) + Text(args["command"]?.stringValue ?? "").foregroundColor(theme.text2))
                    .font(.mono(12))
                    .textSelection(.enabled)
                    .padding([.horizontal, .top], Space.sm)
                if !output.trimmed.isEmpty {
                    FoldedText(text: trimTrailingNewlines(output), tail: true)
                } else {
                    Color.clear.frame(height: Space.sm)
                }
                HStack {
                    let label = run?.status == .running ? "running" : status?.label ?? (run?.status == .error ? "failed" : "exit 0")
                    Text(label)
                        .font(.mono(12))
                        .foregroundStyle(run?.status == .running ? theme.accent : (status != nil || run?.status == .error) ? theme.danger : theme.success)
                    Spacer()
                    Button {
                        copyToClipboard(output)
                    } label: {
                        Image(systemName: "doc.on.doc").font(.system(size: 12)).foregroundStyle(theme.muted).frame(width: 40, height: 36)
                    }
                    .accessibilityLabel("Copy output")
                }
                .padding(.leading, Space.sm)
                .overlay(alignment: .top) { Rectangle().fill(theme.border).frame(height: 0.5) }
            }
        case .edit where !editEntries(args).isEmpty:
            ForEach(Array(editEntries(args).enumerated()), id: \.offset) { _, entry in
                DiffBlockView(lines: trimContext(diffLines(entry.oldText ?? "", entry.newText ?? "")))
            }
            if run?.status == .error, !text.isEmpty { failure(text) }
        case .create where args["content"]?.stringValue != nil:
            let content = args["content"]?.stringValue ?? ""
            DiffBlockView(lines: (content.hasSuffix("\n") ? String(content.dropLast()) : content).components(separatedBy: "\n").map { DiffLine(kind: .added, text: $0) })
            if run?.status == .error, !text.isEmpty { failure(text) }
        default:
            let argText = JSONValue.object(args).prettyString()
            if argText != "{\n\n}" && argText != "{}" && category != .read {
                TermBox {
                    Text(argText.count > maxArgChars ? String(argText.prefix(maxArgChars)) + "\n⋯" : argText)
                        .font(.mono(12))
                        .foregroundStyle(theme.text2)
                        .textSelection(.enabled)
                        .padding(Space.sm)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
            }
            if !text.trimmed.isEmpty {
                TermBox { FoldedText(text: trimTrailingNewlines(text)) }
            }
        }
    }

    private func failure(_ text: String) -> some View {
        Text(text).font(.mono(12)).foregroundStyle(theme.danger).padding(Space.sm)
    }
}

private func stateOf(_ run: ToolRun?, live: Bool) -> StepState {
    // No run yet: pi is still writing the call (live) or the session was
    // reopened without its result.
    guard let run else { return live ? .running : .done }
    switch run.status {
    case .running: return .running
    case .error: return .error
    case .done: return .done
    }
}

private func editStat(_ category: ToolCategory, _ args: [String: JSONValue]) -> (added: Int, removed: Int)? {
    if category == .edit {
        var added = 0
        var removed = 0
        for entry in editEntries(args) {
            let change = changedLines(entry.oldText, entry.newText)
            added += change.added.count
            removed += change.removed.count
        }
        return (added, removed)
    }
    if category == .create, let content = args["content"]?.stringValue {
        return ((content.hasSuffix("\n") ? String(content.dropLast()) : content).components(separatedBy: "\n").count, 0)
    }
    return nil
}

/// "0:42" on a step that is still running.
private struct StepElapsed: View {
    let since: Double
    @Environment(\.theme) private var theme

    var body: some View {
        LiveTick { _ in
            let ms = nowMs() - since
            if ms >= minShownDurationMs {
                Text(formatElapsed(ms)).font(.mono(12)).foregroundStyle(theme.accent)
            }
        }
    }
}

/// One tool call: a one-line row that opens into its detail.
struct ToolStepView: View {
    let call: ToolCallBlock
    let run: ToolRun?
    let cwd: String
    let live: Bool
    var onOpenFile: ((String) -> Void)?
    @State private var open = false
    @Environment(\.theme) private var theme

    var body: some View {
        let name = run?.name ?? call.name
        let args = (run?.args.isEmpty == false ? run?.args : nil) ?? call.arguments
        let category = toolCategory(name)
        let state = stateOf(run, live: live)
        let summary = toolCallSummary(name, args, cwd: cwd, details: run?.result?.details)
        let stat = state == .running ? nil : editStat(category, args)
        let duration = run?.durationMs.flatMap { $0 >= minShownDurationMs ? formatDuration($0) : nil }
        let path = args["path"]?.stringValue ?? args["file_path"]?.stringValue
        VStack(alignment: .leading, spacing: 0) {
            StepRow(
                symbol: icon(category),
                state: state,
                // A shell step reads as its command; the rest as tool + target.
                name: category == .run && !summary.isEmpty ? summary : name,
                summary: category == .run ? nil : (summary.isEmpty ? nil : summary),
                open: open,
                label: "\(name) \(summary), \(state)",
                onToggle: { open.toggle() }
            ) {
                if let stat { DiffStatText(added: stat.added, removed: stat.removed) }
                if state == .running, let started = run?.startedAt {
                    StepElapsed(since: started)
                } else if let duration {
                    Text(duration).font(.mono(12)).foregroundStyle(theme.muted)
                }
            }
            if open {
                VStack(alignment: .leading, spacing: Space.sm) {
                    ToolDetail(call: call, run: run, category: category)
                    if let path, let onOpenFile, category == .read || category == .edit || category == .create {
                        Button("Open file") { onOpenFile(path) }
                            .font(.system(size: 14))
                            .foregroundStyle(theme.accent)
                            .frame(minHeight: touchTarget)
                    }
                }
                .padding(.horizontal, Space.sm)
                .padding(.bottom, Space.sm)
            }
        }
        .background(open ? RoundedRectangle(cornerRadius: Radius.md).fill(theme.surface) : nil)
    }
}

/// A reasoning block: "Thought for 12s", opening into the text.
struct ThinkingStepView: View {
    let block: ThinkingBlock
    let live: Bool
    @State private var open = false
    @Environment(\.theme) private var theme

    var body: some View {
        let thinking = live && block.durationMs == nil && block.startedAt != nil
        let label = thinking
            ? "Thinking"
            : (block.durationMs.map { $0 >= 1000 ? "Thought for \(formatDuration($0))" : "Thought" } ?? "Thought")
        let peek = String((block.thinking.trimmed.components(separatedBy: "\n").last ?? "").prefix(80))
        VStack(alignment: .leading, spacing: 0) {
            StepRow(symbol: "lightbulb", state: thinking ? .running : .done, name: label, summary: open || peek.isEmpty ? nil : peek, open: open, label: label, onToggle: { open.toggle() }) {
                EmptyView()
            }
            if open {
                Text(block.thinking.trimmed.isEmpty ? "…" : block.thinking.trimmed)
                    .font(.system(size: 14))
                    .foregroundStyle(theme.text2)
                    .lineSpacing(3)
                    .textSelection(.enabled)
                    .padding(.horizontal, Space.sm)
                    .padding(.bottom, Space.sm)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
        .background(open ? RoundedRectangle(cornerRadius: Radius.md).fill(theme.surface) : nil)
    }
}

func runInfos(_ calls: [ToolCallBlock], _ toolRuns: [String: ToolRun], live: Bool) -> [ToolRunInfo] {
    calls.map { call in
        let run = toolRuns[call.id]
        return ToolRunInfo(
            name: run?.name ?? call.name,
            args: (run?.args.isEmpty == false ? run?.args : nil) ?? call.arguments,
            status: run?.status ?? (live ? .running : .done)
        )
    }
}

/// Consecutive tool calls folded into one row with a count and diff stats.
struct ToolGroupView: View {
    let calls: [ToolCallBlock]
    let toolRuns: [String: ToolRun]
    let cwd: String
    let live: Bool
    var onOpenFile: ((String) -> Void)?
    @State private var open = false
    @Environment(\.theme) private var theme

    var body: some View {
        let summary = summarizeToolRuns(runInfos(calls, toolRuns, live: live))
        let running = summary.running > 0
        VStack(alignment: .leading, spacing: 0) {
            StepRow(
                symbol: "list.bullet.indent",
                state: running ? .running : summary.failed > 0 ? .error : .done,
                name: summary.text,
                open: open,
                label: "\(summary.text), \(calls.count) tools",
                onToggle: { open.toggle() }
            ) {
                if !running, let diff = summary.diff { DiffStatText(added: diff.added, removed: diff.removed) }
                Text("\(calls.count)").font(.mono(12)).foregroundStyle(theme.muted)
            }
            if open {
                VStack(alignment: .leading, spacing: 0) {
                    ForEach(calls, id: \.id) { call in
                        ToolStepView(call: call, run: toolRuns[call.id], cwd: cwd, live: live, onOpenFile: onOpenFile)
                    }
                }
                .padding(.leading, Space.xs)
                .overlay(alignment: .leading) { Rectangle().fill(theme.border).frame(width: 0.5) }
                .padding(.leading, Space.md)
            }
        }
    }
}
