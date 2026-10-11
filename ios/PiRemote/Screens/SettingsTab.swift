import PiRemoteKit
import SwiftUI

/// The paired computers, this phone's preferences, and what runs where.
struct SettingsTab: View {
    @Environment(\.theme) private var theme
    @State private var connection = Connection.shared
    @State private var prefs = Prefs.shared
    @State private var router = Router.shared
    @State private var runtime: PiRuntimeInfo?
    @State private var cua: CuaPermissions?
    @State private var bag = SubscriptionBag()

    private var appVersion: String {
        let version = Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "?"
        let build = Bundle.main.infoDictionary?["CFBundleVersion"] as? String ?? "?"
        return "\(version) (\(build))"
    }

    private var status: (tone: PixelTone, text: String) {
        switch connection.phase {
        case .online: return (.ok, "Connected")
        case .offline: return (.error, "Offline")
        default: return (.working, "Connecting…")
        }
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: Space.xl) {
                computersCard
                inUseCard
                appearanceCard
                notificationsCard
                Card(label: "Usage") {
                    Button {
                        router.push(.usage)
                    } label: {
                        HStack {
                            VStack(alignment: .leading, spacing: 2) {
                                Text("Usage").foregroundStyle(theme.text)
                                Text("Tokens and cost over the last 30 days").uiFont(13).foregroundStyle(theme.muted)
                            }
                            Spacer()
                            Image(systemName: "chevron.right").foregroundStyle(theme.muted)
                        }
                        .padding(.horizontal, Space.lg)
                        .padding(.vertical, Space.md)
                    }
                    .buttonStyle(RowButtonStyle())
                }
                computerUseCard
                Card(label: "About") {
                    Readout(label: "Pi Remote", value: appVersion)
                    ForEach(aboutLinks, id: \.title) { link in
                        ThemedDivider()
                        Link(destination: link.url) {
                            HStack {
                                Text(link.title).foregroundStyle(theme.text)
                                Spacer()
                                Image(systemName: "arrow.up.right").foregroundStyle(theme.muted)
                            }
                            .padding(.horizontal, Space.lg)
                            .padding(.vertical, Space.md)
                            .frame(minHeight: touchTarget)
                        }
                        .buttonStyle(RowButtonStyle())
                    }
                }
                Text("Pi Remote is a community project, not affiliated with or endorsed by pi or Earendil.")
                    .font(.footnote)
                    .foregroundStyle(theme.muted)
                    .padding(.horizontal, Space.xs)
            }
            .padding(Space.lg)
            .padding(.bottom, Space.xl)
            // A readable column on iPad.
            .frame(maxWidth: 720)
            .frame(maxWidth: .infinity)
        }
        .background(theme.bg)
        .task {
            // Subscribe first: a tab left while `load` runs must not leave a listener behind.
            bag.add(connection.onOnline { Task { await load() } })
            await load()
        }
        .onDisappear { bag.cancelAll() }
    }

    private var aboutLinks: [(title: String, url: URL)] {
        [
            ("Privacy policy", "https://github.com/azygoss/pi-desktop/blob/main/docs/privacy.md"),
            ("Help and support", "https://github.com/azygoss/pi-desktop/issues"),
            ("Source code", "https://github.com/azygoss/pi-desktop")
        ].compactMap { title, address in URL(string: address).map { (title, $0) } }
    }

    private func load() async {
        runtime = try? await API.runtime()
        cua = try? await API.cuaPermissions()
    }

    // MARK: Computers

    private var computersCard: some View {
        Card(label: "Computers") {
            ForEach(Array(connection.computers.enumerated()), id: \.element.key) { index, computer in
                if index > 0 { ThemedDivider() }
                let inUse = computer.key == connection.pairing?.key
                Button {
                    guard !inUse else { return }
                    Haptic.tap.play()
                    Task {
                        await connection.switchTo(computer.key)
                        toast("Using \(computer.name)")
                    }
                } label: {
                    HStack(spacing: Space.md) {
                        Image(systemName: computer.isServer ? "server.rack" : "desktopcomputer")
                            .foregroundStyle(inUse ? theme.accent : theme.muted)
                            .frame(width: 22)
                        VStack(alignment: .leading, spacing: 2) {
                            Text(computer.name).foregroundStyle(theme.text).lineLimit(1)
                            Text("\(computer.isServer ? "pi-remote" : "Pi Desktop") · \(computer.address):\(computer.port)")
                                .uiFont(13)
                                .foregroundStyle(theme.muted)
                                .lineLimit(1)
                        }
                        Spacer()
                        if inUse {
                            HStack(spacing: Space.sm) {
                                Pixel(tone: status.tone)
                                Text(status.text).uiFont(13).foregroundStyle(theme.text2).lineLimit(1)
                            }
                            .fixedSize()
                        }
                    }
                    .padding(.horizontal, Space.lg)
                    .padding(.vertical, Space.md)
                }
                .buttonStyle(RowButtonStyle())
                .contextMenu {
                    Button(role: .destructive) { Task { await forget(computer) } } label: { Label("Forget \(computer.name)…", systemImage: "trash") }
                }
            }
            ThemedDivider()
            VStack(alignment: .leading, spacing: Space.sm) {
                if connection.computers.count > 1 {
                    Text("Tap a computer to use it. Touch and hold to forget it.").uiFont(13).foregroundStyle(theme.muted)
                }
                Button {
                    router.addComputer = .init(link: nil)
                } label: {
                    Label("Pair another computer", systemImage: "plus").frame(maxWidth: .infinity)
                }
                .buttonStyle(SecondaryButtonStyle())
                .disabled(connection.computers.count >= PairingStorage.maxComputers)
            }
            .padding(.horizontal, Space.lg)
            .padding(.vertical, Space.md)
        }
    }

    private var inUseCard: some View {
        Card(label: "In use") {
            VStack(alignment: .leading, spacing: Space.sm) {
                Text(connection.server?.name ?? connection.pairing?.name ?? "Computer")
                    .uiFont(16, weight: .semibold)
                    .foregroundStyle(theme.text)
                    .lineLimit(1)
                HStack(spacing: Space.sm) {
                    Pixel(tone: status.tone)
                    Text(status.text).uiFont(14).foregroundStyle(theme.text2)
                }
                if connection.phase == .offline {
                    if let error = connection.error {
                        Text(error).uiFont(14).foregroundStyle(theme.danger)
                    }
                    Button("Retry") { connection.retry() }.buttonStyle(SecondaryButtonStyle())
                }
            }
            .padding(.horizontal, Space.lg)
            .padding(.vertical, Space.md)
            .frame(maxWidth: .infinity, alignment: .leading)
            ThemedDivider()
            Readout(label: "Address", value: connection.pairing.map { "\($0.address):\($0.port)" } ?? "—")
            ThemedDivider()
            Readout(label: connection.server?.kind == "server" ? "pi-remote" : "Pi Desktop", value: connection.server?.version ?? "—")
            ThemedDivider()
            Readout(label: "pi runtime", value: runtime.map { "\($0.kind) \($0.version ?? "unknown version")" } ?? "—")
            ThemedDivider()
            VStack(alignment: .leading, spacing: Space.sm) {
                Text("End-to-end encrypted between this phone and the computer.").uiFont(14).foregroundStyle(theme.muted)
                Button {
                    Task { await addAddress() }
                } label: {
                    Text("Use another address").frame(maxWidth: .infinity)
                }
                .buttonStyle(SecondaryButtonStyle())
                Button {
                    Task { if let pairing = connection.pairing { await forget(pairing) } }
                } label: {
                    Text("Forget this computer").frame(maxWidth: .infinity)
                }
                .buttonStyle(SecondaryButtonStyle(danger: true))
            }
            .padding(.horizontal, Space.lg)
            .padding(.vertical, Space.md)
        }
    }

    private var appearanceCard: some View {
        Card(label: "Appearance") {
            VStack(alignment: .leading, spacing: Space.sm) {
                Text("Theme").uiFont(14).foregroundStyle(theme.text2)
                Picker("Theme", selection: $prefs.theme) {
                    ForEach(ThemePref.allCases, id: \.self) { option in Text(option.label).tag(option) }
                }
                .pickerStyle(.segmented)
            }
            .padding(.horizontal, Space.lg)
            .padding(.vertical, Space.md)
            ThemedDivider()
            Toggle("Haptics", isOn: $prefs.haptics)
                .foregroundStyle(theme.text)
                .padding(.horizontal, Space.lg)
                .padding(.vertical, Space.sm)
                .frame(minHeight: touchTarget + 8)
        }
    }

    private var notificationsCard: some View {
        Card(label: "Notifications") {
            Toggle(
                isOn: Binding(
                    get: { prefs.notifications == true },
                    set: { value in
                        if value {
                            Task {
                                if !(await Background.shared.enable()) {
                                    toast("Notifications are off for Pi Remote in the system settings")
                                }
                            }
                        } else {
                            Background.shared.disable()
                        }
                    }
                )
            ) {
                VStack(alignment: .leading, spacing: 2) {
                    Text("When pi finishes or needs you").foregroundStyle(theme.text)
                    Text(
                        "When you leave the app while pi works, it stays connected as long as iOS allows and tells you when a chat is done. iOS also wakes it now and then to check on longer runs."
                    )
                    .uiFont(13)
                    .foregroundStyle(theme.muted)
                }
            }
            .accessibilityLabel("Notify when pi finishes or needs you")
            .padding(.horizontal, Space.lg)
            .padding(.vertical, Space.md)
        }
    }

    private var computerUseCard: some View {
        Card(label: "Computer use") {
            if let cua {
                if cua.available {
                    Readout(label: "Accessibility", value: cua.accessibility ? "granted" : "not granted")
                    ThemedDivider()
                    Readout(label: "Screen Recording", value: cua.screenRecording ? "granted" : "not granted")
                    ThemedDivider()
                    Text("Permissions are changed on the computer, in Pi Desktop's settings.")
                        .uiFont(14)
                        .foregroundStyle(theme.muted)
                        .padding(.horizontal, Space.lg)
                        .padding(.vertical, Space.md)
                        .frame(maxWidth: .infinity, alignment: .leading)
                } else {
                    Text("Not available on this computer")
                        .uiFont(14)
                        .foregroundStyle(theme.text2)
                        .padding(Space.lg)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
            } else {
                Text(connection.isOnline ? "Loading…" : "Not connected")
                    .font(.mono(13))
                    .foregroundStyle(theme.muted)
                    .padding(Space.lg)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
    }

    // MARK: Actions

    private func forget(_ computer: StoredPairing) async {
        let sure = await Dialogs.confirm(
            title: "Forget \(computer.name)?",
            message: "This phone stops connecting to it. To use it again, pair with a new QR code. Also remove this phone on that computer (Settings → Remote control, or \"pi-remote revoke\" on a server).",
            action: "Forget",
            danger: true
        )
        guard sure else { return }
        await connection.unpair(computer.key)
        toast("\(computer.name) forgotten")
    }

    private func addAddress() async {
        guard let value = await Dialogs.prompt(
            title: "Computer address",
            message: "The computer's IP address or name on this network (for example its Tailscale address). It is tried first from now on.",
            placeholder: "100.64.0.1",
            action: "Use this address"
        ) else { return }
        do {
            try connection.addHost(value)
            toast("Address added")
        } catch {
            toast(errorText(error))
        }
    }
}
