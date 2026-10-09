import PiRemoteKit
import SwiftUI

private let maxSessions = 30

/// Projects on the computer, each opening to its chats.
struct ProjectsTab: View {
    @Environment(\.theme) private var theme
    @State private var data = DataStore.shared
    @State private var router = Router.shared
    @State private var expanded: Set<String> = []
    @State private var menu: ProjectSummary?
    @State private var branchesCwd: BranchTarget?

    struct BranchTarget: Identifiable {
        let cwd: String
        var id: String { cwd }
    }

    var body: some View {
        List {
            Group {
                Button {
                    Task { await addProject() }
                } label: {
                    rowLabel(icon: AnyView(Image(systemName: "folder.badge.plus").foregroundStyle(theme.text2)), title: "Add a project", detail: "a folder on the computer")
                }
                .buttonStyle(RowButtonStyle())
                Button {
                    if let workspace = data.appInfo?.workspaceDir {
                        router.startChat(workspace)
                    } else {
                        toast("Not connected to the computer")
                    }
                } label: {
                    rowLabel(icon: AnyView(ScratchSigil()), title: "Without a project", detail: "new chat in the scratch folder", trailing: "plus")
                }
                .buttonStyle(RowButtonStyle())
                .disabled(data.appInfo == nil)
                SectionLabel("Projects")
                    .padding(.horizontal, Space.lg)
                    .padding(.top, Space.lg)
                if data.projects.isEmpty {
                    EmptyState(
                        icon: "folder",
                        title: data.loaded ? "No projects yet" : "Loading…",
                        detail: data.loaded ? "Add a folder on the computer to start chats in it." : "Waiting for the computer."
                    )
                    .frame(minHeight: 240)
                }
                ForEach(data.projects) { project in
                    projectRow(project)
                    if expanded.contains(project.cwd) {
                        projectChats(project)
                    }
                }
            }
            .listRowInsets(EdgeInsets())
            .listRowSeparator(.hidden)
            .listRowBackground(theme.bg)
        }
        .listStyle(.plain)
        .scrollContentBackground(.hidden)
        .background(theme.bg)
        .refreshable {
            do {
                try await data.refresh()
            } catch {
                toast(errorText(error))
            }
        }
        .sheet(item: $menu) { project in
            projectMenu(project).sheetChrome([.medium])
        }
        .sheet(item: $branchesCwd) { target in
            BranchSheet(cwd: target.cwd, busy: false).sheetChrome([.large])
        }
    }

    private func rowLabel(icon: AnyView, title: String, detail: String, trailing: String? = nil) -> some View {
        HStack(spacing: Space.md) {
            icon.frame(width: 20)
            VStack(alignment: .leading, spacing: 1) {
                Text(title).foregroundStyle(theme.text)
                Text(detail).font(.mono(12)).foregroundStyle(theme.muted).lineLimit(1)
            }
            Spacer()
            if let trailing { Image(systemName: trailing).foregroundStyle(theme.muted) }
        }
        .padding(.horizontal, Space.lg)
        .padding(.vertical, 10)
        .frame(minHeight: touchTarget + 12)
    }

    private func detail(_ project: ProjectSummary) -> String {
        [
            "\(project.sessionCount) \(project.sessionCount == 1 ? "chat" : "chats")",
            project.worktree == true ? "worktree" : "",
            relativeTime(iso: project.lastModified)
        ].filter { !$0.isEmpty }.joined(separator: " · ")
    }

    private func projectRow(_ project: ProjectSummary) -> some View {
        let open = expanded.contains(project.cwd)
        return Button {
            if open { expanded.remove(project.cwd) } else { expanded.insert(project.cwd) }
        } label: {
            HStack(spacing: Space.md) {
                Sigil(seed: project.cwd)
                VStack(alignment: .leading, spacing: 1) {
                    Text(project.name).foregroundStyle(theme.text).lineLimit(1)
                    Text(detail(project)).font(.mono(12)).foregroundStyle(theme.muted).lineLimit(1)
                }
                Spacer()
                Image(systemName: open ? "chevron.down" : "chevron.right").font(.system(size: 13)).foregroundStyle(theme.muted)
            }
            .padding(.horizontal, Space.lg)
            .padding(.vertical, 10)
            .frame(minHeight: touchTarget + 12)
        }
        .buttonStyle(RowButtonStyle())
        .accessibilityLabel("\(project.name), \(detail(project))")
        .accessibilityValue(open ? "expanded" : "collapsed")
        .contextMenu {
            Button { router.startChat(project.cwd) } label: { Label("New chat", systemImage: "plus") }
            Button { branchesCwd = BranchTarget(cwd: project.cwd) } label: { Label("Branches and worktrees", systemImage: "arrow.triangle.branch") }
            if project.worktree == true {
                Button(role: .destructive) { Task { await removeWorktree(project, deleteBranch: false) } } label: {
                    Label("Remove worktree…", systemImage: "trash")
                }
            } else {
                Button { Task { await createWorktree(project.cwd) } } label: {
                    Label("New chat in a worktree", systemImage: "arrow.triangle.branch")
                }
            }
            Button { menu = project } label: { Label("More…", systemImage: "ellipsis") }
        }
    }

    @ViewBuilder
    private func projectChats(_ project: ProjectSummary) -> some View {
        Button {
            router.startChat(project.cwd)
        } label: {
            HStack(spacing: Space.md) {
                Image(systemName: "plus").foregroundStyle(theme.text2)
                Text("New chat").foregroundStyle(theme.text2)
                Spacer()
            }
            .padding(.leading, Space.lg + Space.xl)
            .padding(.trailing, Space.lg)
            .frame(minHeight: touchTarget)
        }
        .buttonStyle(RowButtonStyle())
        let own = data.sessions
            .filter { $0.cwd == project.cwd && !data.isArchived($0.path) }
            .sorted { $0.modified > $1.modified }
            .prefix(maxSessions)
        if own.isEmpty {
            Text("no chats yet")
                .font(.mono(12))
                .foregroundStyle(theme.muted)
                .padding(.leading, Space.lg + Space.xl)
                .frame(minHeight: touchTarget, alignment: .leading)
        }
        ForEach(Array(own)) { session in
            Button {
                router.openSession(session)
            } label: {
                SessionRow(
                    session: session,
                    status: data.liveState(session.path).map { $0 == .working ? .working : .attention },
                    pinned: data.isPinned(session.path),
                    showProject: false
                )
                .padding(.leading, Space.xl)
            }
            .buttonStyle(RowButtonStyle())
        }
    }

    private func projectMenu(_ project: ProjectSummary) -> some View {
        ActionSheetView(title: project.name) {
            SheetAction(icon: "plus", title: "New chat") {
                menu = nil
                router.startChat(project.cwd)
            }
            SheetAction(icon: "arrow.triangle.branch", title: "Branches and worktrees", detail: "Switch or create a branch, or open one in a worktree") {
                menu = nil
                branchesCwd = BranchTarget(cwd: project.cwd)
            }
            if project.worktree == true {
                SheetAction(icon: "trash", title: "Remove worktree…", detail: "Its branch is kept", danger: true) {
                    menu = nil
                    Task { await removeWorktree(project, deleteBranch: false) }
                }
                SheetAction(icon: "trash", title: "Remove worktree and its branch…", detail: "The branch is deleted only if it is merged", danger: true) {
                    menu = nil
                    Task { await removeWorktree(project, deleteBranch: true) }
                }
            } else {
                SheetAction(icon: "arrow.triangle.branch", title: "New chat in a worktree", detail: "An isolated copy of the project on its own branch") {
                    menu = nil
                    Task { await createWorktree(project.cwd) }
                }
            }
        }
    }

    // MARK: Actions

    private func addProject() async {
        guard let path = await router.pickFolder("Add a project") else { return }
        do {
            try await API.addProject(path)
            try await data.refresh()
            toast("Added \(baseName(path))")
        } catch {
            toast(errorText(error))
        }
    }

    private func createWorktree(_ cwd: String) async {
        do {
            toast("Creating a worktree…")
            let worktree = try await API.createWorktree(cwd)
            try? await data.refresh()
            router.startChat(worktree.cwd)
        } catch {
            toast(errorText(error))
        }
    }

    private func removeWorktree(_ project: ProjectSummary, deleteBranch: Bool) async {
        let sure = await Dialogs.confirm(
            title: "Remove the worktree \"\(project.name)\"?",
            message: deleteBranch
                ? "Its folder is deleted on the computer, and its branch too if it is merged."
                : "Its folder is deleted on the computer. The branch is kept.",
            action: "Remove",
            danger: true
        )
        guard sure else { return }
        do {
            var result = try await API.removeWorktree(project.cwd, force: false, deleteBranch: deleteBranch)
            if !result.ok {
                let force = await Dialogs.confirm(
                    title: "Remove anyway?",
                    message: "\(result.message)\n\nRemove anyway? The folder, uncommitted changes and all, goes to the computer's trash.",
                    action: "Remove anyway",
                    danger: true
                )
                guard force else { return }
                result = try await API.removeWorktree(project.cwd, force: true, deleteBranch: deleteBranch)
            }
            toast(result.message)
        } catch {
            toast(errorText(error))
        }
        try? await data.refresh()
    }
}
