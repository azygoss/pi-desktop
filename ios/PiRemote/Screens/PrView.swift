import PiRemoteKit
import SwiftUI

private let autoRefreshSeconds: UInt64 = 30
/// The end of a failed job's log is where the error is.
private let logTailChars = 6000

private enum LogState {
    case loading
    case done(String)
    case error(String)
}

/// The pull request of the project's branch: state, checks, failed logs.
struct PrView: View {
    let cwd: String
    let chatId: String?

    @Environment(\.theme) private var theme
    @Environment(\.dismiss) private var dismiss
    @Environment(\.scenePhase) private var scenePhase
    @State private var status: PrStatus?
    @State private var error: String?
    @State private var expanded: Set<String> = []
    @State private var logs: [String: LogState] = [:]
    @State private var fixing = false
    @State private var headSha: String?

    private var pr: PullRequest? { status?.pr }
    private var pending: Bool { pr?.checks.contains { $0.state == .pending } ?? false }

    var body: some View {
        content
            .background(theme.bg.ignoresSafeArea())
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .principal) {
                    VStack(spacing: 0) {
                        Text("Pull request").font(.system(size: 16, weight: .semibold)).foregroundStyle(theme.text)
                        if let pr { Text("#\(pr.number)").font(.mono(12)).foregroundStyle(theme.muted) }
                    }
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Button { Task { await load() } } label: { Image(systemName: "arrow.clockwise") }.accessibilityLabel("Refresh")
                }
            }
            .task { await load() }
            .task(id: "\(pending)|\(scenePhase == .active)") {
                guard pending, scenePhase == .active else { return }
                while !Task.isCancelled {
                    try? await Task.sleep(nanoseconds: autoRefreshSeconds * 1_000_000_000)
                    guard !Task.isCancelled else { return }
                    await load(quiet: true)
                }
            }
    }

    @ViewBuilder
    private var content: some View {
        if status == nil, let error {
            EmptyState(icon: "arrow.triangle.pull", title: "Could not load the pull request", detail: error, actionTitle: "Retry") { Task { await load() } }
        } else if let status {
            if !status.available {
                EmptyState(icon: "arrow.triangle.pull", title: "GitHub CLI not available", detail: error ?? "gh must be installed and signed in on the computer.", actionTitle: "Retry") {
                    Task { await load() }
                }
            } else if let pr {
                List {
                    Group {
                        if let error {
                            Text(error).font(.system(size: 14)).foregroundStyle(theme.danger).padding(.horizontal, Space.lg).padding(.top, Space.md)
                        }
                        head(pr)
                        if pr.checks.isEmpty {
                            Text("This pull request has no checks.").font(.system(size: 14)).foregroundStyle(theme.muted).padding(.horizontal, Space.lg)
                        }
                        ForEach(Array(pr.checks.enumerated()), id: \.offset) { _, check in
                            checkRow(check)
                        }
                    }
                    .listRowInsets(EdgeInsets())
                    .listRowSeparator(.hidden)
                    .listRowBackground(theme.bg)
                }
                .listStyle(.plain)
                .scrollContentBackground(.hidden)
                .refreshable { await load() }
            } else {
                EmptyState(icon: "arrow.triangle.pull", title: "No pull request for this branch", detail: error, actionTitle: "Refresh") { Task { await load() } }
            }
        } else {
            LoadingLine(text: "Loading…").frame(maxWidth: .infinity, maxHeight: .infinity)
        }
    }

    private func head(_ pr: PullRequest) -> some View {
        let summary = summarizeChecks(pr.checks)
        let failing = pr.checks.filter { $0.state == .fail }.count
        let state = pr.state == "MERGED" ? "Merged" : pr.state == "CLOSED" ? "Closed" : pr.draft ? "Draft" : "Open"
        let review: String? = {
            switch pr.reviewDecision {
            case "APPROVED": return "Approved"
            case "CHANGES_REQUESTED": return "Changes requested"
            case "REVIEW_REQUIRED": return "Review required"
            default: return nil
            }
        }()
        let canFix = chatId != nil && failing > 0
        return VStack(alignment: .leading, spacing: Space.md) {
            VStack(alignment: .leading, spacing: Space.xs) {
                Text("#\(pr.number)").font(.mono(13)).foregroundStyle(theme.muted)
                Text(pr.title).font(.system(size: 17, weight: .semibold)).foregroundStyle(theme.text)
            }
            HStack(spacing: Space.md) {
                Text(state).font(.system(size: 14)).foregroundStyle(theme.text2)
                if let review {
                    Text(review).font(.system(size: 14)).foregroundStyle(pr.reviewDecision == "CHANGES_REQUESTED" ? theme.warning : theme.text2)
                }
                switch summary {
                case .pending:
                    HStack(spacing: Space.sm) { Pixel(tone: .working); Text("running").font(.system(size: 14)).foregroundStyle(theme.accent) }
                case .failing:
                    HStack(spacing: Space.sm) { Pixel(tone: .error); Text("\(failing) failing").font(.system(size: 14)).foregroundStyle(theme.danger) }
                case .passing:
                    HStack(spacing: Space.sm) { Pixel(tone: .ok); Text("passing").font(.system(size: 14)).foregroundStyle(theme.success) }
                case .none:
                    EmptyView()
                }
            }
            HStack(spacing: Space.sm) {
                if canFix {
                    Button {
                        Task { await askFix(pr) }
                    } label: {
                        Label(fixing ? "Ask pi to fix…" : "Ask pi to fix", systemImage: "wrench.and.screwdriver")
                    }
                    .buttonStyle(PrimaryButtonStyle())
                    .disabled(fixing)
                }
                if let url = URL(string: pr.url), !pr.url.isEmpty {
                    Link(destination: url) {
                        Label("Open on GitHub", systemImage: "arrow.up.right.square")
                    }
                    .buttonStyle(SecondaryButtonStyle())
                }
            }
            if !pr.checks.isEmpty { SectionLabel("Checks").padding(.top, Space.sm) }
        }
        .padding(Space.lg)
    }

    private func checkRow(_ check: PrCheck) -> some View {
        let expandable = check.state == .fail && check.runId != nil
        let key = "\(check.name)|\(check.url ?? "")"
        let open = expandable && expanded.contains(key)
        let tone: PixelTone = check.state == .pass ? .ok : check.state == .fail ? .error : check.state == .pending ? .working : .idle
        let word: String = check.state == .pass ? "passed" : check.state == .fail ? "failed" : check.state == .pending ? "running" : "skipped"
        return VStack(alignment: .leading, spacing: 0) {
            Button {
                guard expandable, let runId = check.runId else { return }
                // Jobs of one workflow run share its log: what is open is tracked per check.
                if open { expanded.remove(key) } else { expanded.insert(key) }
                switch logs[runId] {
                case nil, .error?: fetchLog(runId)
                default: break
                }
            } label: {
                HStack(spacing: Space.md) {
                    Pixel(tone: tone)
                    Text(check.name).font(.mono(13)).foregroundStyle(theme.text).lineLimit(2).frame(maxWidth: .infinity, alignment: .leading)
                    Text(expandable ? (open ? "hide log" : "show log") : word).font(.mono(12)).foregroundStyle(check.state == .fail ? theme.danger : theme.muted)
                }
                .padding(.horizontal, Space.lg)
                .padding(.vertical, Space.sm)
                .frame(minHeight: touchTarget)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .disabled(!expandable)
            .accessibilityLabel("\(check.name), \(word)\(expandable ? ". \(open ? "Hide" : "Show") the log" : "")")
            if open, let runId = check.runId {
                Group {
                    switch logs[runId] {
                    case .done(let text)?:
                        Text(text.isEmpty ? "The log is empty." : text).font(.mono(12)).foregroundStyle(theme.text2).textSelection(.enabled)
                    case .error(let text)?:
                        Text(text).font(.system(size: 14)).foregroundStyle(theme.danger)
                    default:
                        LoadingLine(text: "Loading the log…")
                    }
                }
                .padding(Space.md)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(RoundedRectangle(cornerRadius: Radius.sm).fill(theme.codeBg))
                .overlay(RoundedRectangle(cornerRadius: Radius.sm).strokeBorder(theme.border, lineWidth: 1))
                .padding(.horizontal, Space.lg)
                .padding(.bottom, Space.md)
            }
        }
    }

    private func load(quiet: Bool = false) async {
        do {
            let next = try await API.prStatus(cwd)
            // A new push re-runs the jobs: logs fetched for the old commit are stale.
            if headSha != nil && headSha != next.pr?.headSha {
                logs = [:]
                expanded = []
            }
            headSha = next.pr?.headSha
            status = next
            error = nil
        } catch {
            if !quiet { self.error = errorText(error) }
        }
    }

    private func fetchLog(_ runId: String) {
        logs[runId] = .loading
        Task {
            do {
                let text = try await API.failedLog(cwd, runId: runId)
                logs[runId] = .done(String(text.suffix(logTailChars)).trimmed)
            } catch {
                logs[runId] = .error(errorText(error))
            }
        }
    }

    private func askFix(_ pr: PullRequest) async {
        guard let chatId, !fixing else { return }
        fixing = true
        defer { fixing = false }
        var log = ""
        if let runId = pr.checks.first(where: { $0.state == .fail && $0.runId != nil })?.runId {
            // Without the log the prompt still names the failing checks.
            if case .done(let text)? = logs[runId] {
                log = text
            } else {
                log = (try? await API.failedLog(cwd, runId: runId)) ?? ""
            }
        }
        ChatStore.shared.seedComposer(chatId, fixChecksPrompt(pr, log: log))
        toast("The request is in the composer")
        dismiss()
    }
}
