import PiRemoteKit
import SwiftUI

/// Child path with the separator the computer's own paths use.
private func join(_ parent: String, _ name: String) -> String {
    let sep = parent.contains("\\") && !parent.contains("/") ? "\\" : "/"
    return parent.hasSuffix(sep) ? parent + name : parent + sep + name
}

/// Browse folders on the computer and choose one.
struct FolderPickerView: View {
    let title: String

    @Environment(\.theme) private var theme
    @Environment(\.dismiss) private var dismiss
    @State private var data = DataStore.shared
    @State private var listing: RemoteDirListing?
    @State private var busy = true
    @State private var failed: String?
    @State private var typed = ""
    @State private var chosen = false
    @State private var sequence = 0

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: Space.sm) {
                TextField("/absolute/path", text: $typed)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .submitLabel(.go)
                    .onSubmit(go)
                    .fieldStyle()
                    .accessibilityLabel("Folder path on the computer")
                Button("Go", action: go).buttonStyle(SecondaryButtonStyle()).disabled(typed.trimmed.isEmpty)
            }
            .padding(.horizontal, Space.lg)
            .padding(.vertical, Space.md)
            .overlay(alignment: .bottom) { Rectangle().fill(theme.border).frame(height: 0.5) }

            if let listing {
                List {
                    Group {
                        if busy { LoadingLine(text: "Loading…").padding(Space.lg) }
                        if let parent = listing.parent {
                            Button {
                                Task { await load(parent) }
                            } label: {
                                HStack(spacing: Space.md) {
                                    Image(systemName: "arrow.turn.left.up").foregroundStyle(theme.muted)
                                    Text("..").font(.mono(14)).foregroundStyle(theme.text2)
                                    Spacer()
                                }
                                .padding(.horizontal, Space.lg)
                                .frame(minHeight: touchTarget + 4)
                            }
                            .buttonStyle(RowButtonStyle())
                            .accessibilityLabel("Go to the parent folder")
                        }
                        if listing.dirs.isEmpty {
                            Text("no folders inside").font(.mono(13)).foregroundStyle(theme.muted).padding(Space.lg)
                        }
                        ForEach(listing.dirs, id: \.self) { name in
                            Button {
                                Task { await load(join(listing.path, name)) }
                            } label: {
                                HStack(spacing: Space.md) {
                                    Image(systemName: "folder").foregroundStyle(theme.text2)
                                    Text(name).foregroundStyle(theme.text).lineLimit(1)
                                    Spacer()
                                }
                                .padding(.horizontal, Space.lg)
                                .frame(minHeight: touchTarget + 4)
                            }
                            .buttonStyle(RowButtonStyle())
                            .accessibilityLabel("Open folder \(name)")
                        }
                    }
                    .listRowInsets(EdgeInsets())
                    .listRowSeparator(.hidden)
                    .listRowBackground(theme.bg)
                }
                .listStyle(.plain)
                .scrollContentBackground(.hidden)
            } else if busy {
                LoadingLine(text: "Loading…").padding(Space.lg).frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
            } else {
                EmptyState(title: "Could not list folders", detail: failed, actionTitle: "Retry") { Task { await load(nil) } }
            }

            VStack(alignment: .leading, spacing: Space.sm) {
                if listing?.repo == true {
                    HStack(spacing: Space.sm) {
                        Pixel(tone: .idle, size: 6)
                        Text("git repository").font(.mono(12)).foregroundStyle(theme.muted)
                    }
                }
                Button {
                    guard let listing else { return }
                    chosen = true
                    Router.shared.resolveFolder(listing.path)
                    dismiss()
                } label: {
                    Text("Choose this folder").frame(maxWidth: .infinity)
                }
                .buttonStyle(PrimaryButtonStyle())
                .disabled(listing == nil)
            }
            .padding(Space.lg)
            .overlay(alignment: .top) { Rectangle().fill(theme.border).frame(height: 0.5) }
            .background(theme.bg)
        }
        .background(theme.bg.ignoresSafeArea())
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .principal) {
                VStack(spacing: 0) {
                    Text(title).font(.system(size: 16, weight: .semibold)).foregroundStyle(theme.text)
                    if let listing {
                        Text(tildePath(listing.path, homeDir: data.appInfo?.homeDir)).font(.mono(12)).foregroundStyle(theme.muted).lineLimit(1).truncationMode(.head)
                    }
                }
            }
        }
        .task { await load(nil) }
        // Leaving without a choice answers the caller with nil.
        .onDisappear { if !chosen { Router.shared.resolveFolder(nil) } }
    }

    private func go() {
        let path = typed.trimmed
        if !path.isEmpty { Task { await load(path) } }
    }

    private func load(_ path: String?) async {
        sequence += 1
        let mine = sequence
        busy = true
        defer { if mine == sequence { busy = false } }
        do {
            let next = try await API.listDirs(path)
            guard mine == sequence else { return }
            listing = next
            typed = next.path
            failed = nil
        } catch {
            guard mine == sequence else { return }
            // Stay where we are; only the very first load has nothing to show.
            let text = errorText(error)
            failed = text
            toast(text.range(of: "not connected", options: .caseInsensitive) != nil ? text : "That folder cannot be opened")
        }
    }
}
