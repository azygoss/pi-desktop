import PiRemoteKit
import SwiftUI

/**
 * The app's home: the computer's name and link state on top, four tabs at
 * the bottom (chats, projects, automations, settings).
 */
struct HomeView: View {
    @Environment(\.theme) private var theme
    @State private var connection = Connection.shared
    @State private var router = Router.shared

    private var phaseText: String {
        switch connection.phase {
        case .online: return "connected"
        case .offline: return "offline"
        default: return "connecting…"
        }
    }

    private var phaseTone: PixelTone {
        switch connection.phase {
        case .online: return .ok
        case .connecting, .loading: return .working
        default: return .error
        }
    }

    var body: some View {
        VStack(spacing: 0) {
            header
            if connection.phase == .offline {
                HStack(spacing: Space.md) {
                    Text("Cannot reach the computer. Trying again…")
                        .font(.system(size: 14))
                        .foregroundStyle(theme.text2)
                        .frame(maxWidth: .infinity, alignment: .leading)
                    Button("Retry") { connection.retry() }.buttonStyle(SecondaryButtonStyle())
                }
                .padding(.horizontal, Space.lg)
                .padding(.vertical, Space.sm)
                .background(theme.dangerSoft)
            }
            TabView(selection: $router.tab) {
                ChatsTab()
                    .tabItem { Label("Chats", systemImage: "bubble.left.and.bubble.right") }
                    .tag(HomeTab.chats)
                ProjectsTab()
                    .tabItem { Label("Projects", systemImage: "folder") }
                    .tag(HomeTab.projects)
                AutomationsTab()
                    .tabItem { Label("Automations", systemImage: "clock") }
                    .tag(HomeTab.automations)
                SettingsTab()
                    .tabItem { Label("Settings", systemImage: "gearshape") }
                    .tag(HomeTab.settings)
            }
        }
        .background(theme.bg.ignoresSafeArea())
        .toolbar(.hidden, for: .navigationBar)
        // The lists only follow the computer while this screen is on top.
        .onAppear { DataStore.shared.setListsVisible(true) }
        .onDisappear { DataStore.shared.setListsVisible(false) }
    }

    private var header: some View {
        HStack(spacing: Space.md) {
            Pixel(tone: phaseTone, size: 9)
            Menu {
                ForEach(connection.computers) { computer in
                    Button {
                        if computer.key != connection.pairing?.key {
                            Task { await connection.switchTo(computer.key) }
                        }
                    } label: {
                        Label(
                            "\(computer.name) · \(computer.isServer ? "pi-remote" : "Pi Desktop")",
                            systemImage: computer.key == connection.pairing?.key ? "checkmark" : (computer.isServer ? "server.rack" : "desktopcomputer")
                        )
                    }
                }
                Divider()
                Button {
                    router.addComputer = .init(link: nil)
                } label: {
                    Label("Pair another computer", systemImage: "plus")
                }
            } label: {
                VStack(alignment: .leading, spacing: 0) {
                    HStack(spacing: Space.xs) {
                        Text(connection.server?.name ?? connection.pairing?.name ?? "Computer")
                            .font(.system(size: 17, weight: .semibold))
                            .foregroundStyle(theme.text)
                            .lineLimit(1)
                        if connection.computers.count > 1 {
                            Image(systemName: "chevron.up.chevron.down").font(.system(size: 12)).foregroundStyle(theme.muted)
                        }
                    }
                    Text(phaseText).font(.mono(12)).foregroundStyle(theme.muted)
                }
                .frame(maxWidth: .infinity, minHeight: touchTarget, alignment: .leading)
                .contentShape(Rectangle())
            }
            .accessibilityLabel("\(connection.pairing?.name ?? "Computer"), \(phaseText). Computers")
        }
        .padding(.horizontal, Space.lg)
        .frame(minHeight: 52)
        .overlay(alignment: .bottom) { Rectangle().fill(theme.border).frame(height: 0.5) }
        .background(theme.bg)
    }
}

/// A search field in the app's style.
struct SearchField: View {
    @Binding var text: String
    var placeholder: String
    @Environment(\.theme) private var theme

    var body: some View {
        HStack(spacing: Space.sm) {
            Image(systemName: "magnifyingglass").foregroundStyle(theme.muted)
            TextField(placeholder, text: $text)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .submitLabel(.search)
            if !text.isEmpty {
                Button {
                    text = ""
                } label: {
                    Image(systemName: "xmark.circle.fill").foregroundStyle(theme.muted)
                }
                .accessibilityLabel("Clear search")
            }
        }
        .fieldStyle()
        .accessibilityElement(children: .contain)
    }
}
