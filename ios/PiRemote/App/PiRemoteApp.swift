import PiRemoteKit
import SwiftUI
import UIKit

final class AppDelegate: NSObject, UIApplicationDelegate {
    func application(
        _ application: UIApplication,
        didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
    ) -> Bool {
        // Background tasks must be registered before launch finishes.
        Background.registerTasks()
        MainActor.assumeIsolated {
            // The bridges listen for the whole life of the app; wire them
            // before the first connection so no broadcast is missed.
            DataStore.shared.wire()
            ChatStore.shared.wire()
            Background.shared.wire()
            ChatStore.shared.openChatHandler = { chatId in
                if ChatStore.shared.chat(chatId) != nil { Router.shared.openChat(chatId) }
            }
            Connection.shared.start()
        }
        return true
    }
}

@main
struct PiRemoteApp: App {
    @UIApplicationDelegateAdaptor(AppDelegate.self) private var delegate
    @Environment(\.scenePhase) private var scenePhase
    @State private var prefs = Prefs.shared

    var body: some Scene {
        WindowGroup {
            RootView()
                .themed()
                .preferredColorScheme(prefs.theme.colorScheme)
                .onOpenURL { url in Router.shared.handle(url: url) }
        }
        .onChange(of: scenePhase) { _, phase in
            switch phase {
            case .active:
                Connection.shared.appBecameActive()
                Background.shared.appBecameActive()
            case .background:
                Background.shared.appWentToBackground()
                Connection.shared.appWentToBackground()
                DataStore.shared.writeCache()
            default:
                break
            }
        }
    }
}

/// Pairing when nothing is paired, otherwise the home tabs and every screen
/// pushed over them.
struct RootView: View {
    @State private var connection = Connection.shared
    @State private var router = Router.shared
    @Environment(\.theme) private var theme

    var body: some View {
        Group {
            if connection.phase == .loading {
                theme.bg.ignoresSafeArea()
            } else if connection.pairing == nil {
                PairView(adding: false, link: nil)
                    .transition(.opacity)
            } else {
                NavigationStack(path: $router.path) {
                    HomeView()
                        .navigationDestination(for: Route.self) { route in
                            destination(route).themed()
                        }
                }
                .sheet(item: $router.addComputer) { request in
                    PairView(adding: true, link: request.link).themed()
                }
            }
        }
        .background(theme.bg.ignoresSafeArea())
        .background(ToastInstaller())
    }

    @ViewBuilder
    private func destination(_ route: Route) -> some View {
        switch route {
        case .chat(let chatId): ChatView(chatId: chatId)
        case .diff(let cwd, let chatId): DiffView(cwd: cwd, chatId: chatId)
        case .pr(let cwd, let chatId): PrView(cwd: cwd, chatId: chatId)
        case .file(let cwd, let path): FileView(cwd: cwd, path: path)
        case .side(let chatId, let question): SideChatView(chatId: chatId, question: question)
        case .automationEdit(let id): AutomationEditView(id: id)
        case .usage: UsageView()
        case .folderPicker(let title): FolderPickerView(title: title)
        }
    }
}

/// Installs the toast window once the scene exists.
private struct ToastInstaller: UIViewRepresentable {
    func makeUIView(context: Context) -> UIView {
        let view = UIView()
        view.isUserInteractionEnabled = false
        DispatchQueue.main.async {
            if let scene = view.window?.windowScene { ToastWindow.install(in: scene) }
        }
        return view
    }

    func updateUIView(_ view: UIView, context: Context) {
        if let scene = view.window?.windowScene { ToastWindow.install(in: scene) }
    }
}
