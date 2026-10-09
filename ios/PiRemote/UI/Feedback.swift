import Observation
import SwiftUI
import UIKit

// Toasts, haptics, confirms, text prompts and the share sheet. Toasts live
// in their own pass-through window and dialogs are presented on the topmost
// view controller, so both work above sheets and full-screen covers.

enum Haptic {
    case tap, success, warning

    @MainActor
    func play() {
        guard Prefs.shared.haptics else { return }
        switch self {
        case .tap: UIImpactFeedbackGenerator(style: .light).impactOccurred()
        case .success: UINotificationFeedbackGenerator().notificationOccurred(.success)
        case .warning: UINotificationFeedbackGenerator().notificationOccurred(.warning)
        }
    }
}

struct ToastAction {
    let label: String
    let run: () -> Void
}

@MainActor
@Observable
final class ToastCenter {
    static let shared = ToastCenter()

    struct Item: Identifiable {
        let id: Int
        let text: String
        let action: ToastAction?
    }

    private(set) var current: Item?
    @ObservationIgnored private var counter = 0
    @ObservationIgnored private var timer: Task<Void, Never>?

    func show(_ text: String, action: ToastAction? = nil) {
        counter += 1
        let item = Item(id: counter, text: text, action: action)
        withAnimation(.easeOut(duration: 0.18)) { current = item }
        UIAccessibility.post(notification: .announcement, argument: text)
        timer?.cancel()
        timer = Task { [weak self] in
            try? await Task.sleep(nanoseconds: action == nil ? 3_500_000_000 : 6_000_000_000)
            guard !Task.isCancelled, let self, self.current?.id == item.id else { return }
            withAnimation(.easeIn(duration: 0.18)) { self.current = nil }
        }
    }

    func dismiss() {
        withAnimation(.easeIn(duration: 0.18)) { current = nil }
    }
}

/// One line at the bottom of the screen, optionally with an action.
@MainActor
func toast(_ text: String, action: ToastAction? = nil) {
    ToastCenter.shared.show(text, action: action)
}

private struct ToastOverlay: View {
    @State private var center = ToastCenter.shared

    var body: some View {
        VStack {
            Spacer()
            if let item = center.current {
                HStack(spacing: 8) {
                    Text(item.text)
                        .font(.system(size: 14))
                        .foregroundStyle(Color(hex: 0xECECEE))
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(.vertical, 12)
                    if let action = item.action {
                        Button {
                            action.run()
                            center.dismiss()
                        } label: {
                            Text(action.label)
                                .font(.system(size: 14, weight: .semibold))
                                .foregroundStyle(Color(hex: 0x7CC0E6))
                                .frame(minWidth: 44, minHeight: 44)
                        }
                    }
                }
                .padding(.leading, 16)
                .padding(.trailing, 8)
                .background(RoundedRectangle(cornerRadius: 10).fill(Color(hex: 0x2B2C31)))
                .padding(.horizontal, 16)
                .padding(.bottom, 72)
                .transition(.move(edge: .bottom).combined(with: .opacity))
                .accessibilityElement(children: .combine)
            }
        }
        .ignoresSafeArea(.keyboard, edges: [])
    }
}

/// A window that only takes touches on its toast.
private final class PassThroughWindow: UIWindow {
    override func hitTest(_ point: CGPoint, with event: UIEvent?) -> UIView? {
        guard let hit = super.hitTest(point, with: event), let root = rootViewController?.view else { return nil }
        if #available(iOS 18, *) {
            // SwiftUI answers for the whole hosting view: only take points
            // that land on one of its rendered subviews (the toast).
            for subview in root.subviews.reversed() {
                let local = subview.convert(point, from: root)
                if subview.isUserInteractionEnabled, subview.bounds.contains(local), subview.point(inside: local, with: event) {
                    return hit
                }
            }
            return nil
        }
        return hit === root ? nil : hit
    }
}

@MainActor
enum ToastWindow {
    private static var window: UIWindow?

    static func install(in scene: UIWindowScene) {
        guard window == nil else { return }
        let host = UIHostingController(rootView: ToastOverlay())
        host.view.backgroundColor = .clear
        let overlay = PassThroughWindow(windowScene: scene)
        overlay.rootViewController = host
        overlay.windowLevel = .alert + 1
        overlay.backgroundColor = .clear
        overlay.isHidden = false
        window = overlay
    }
}

// MARK: - Dialogs

@MainActor
enum Dialogs {
    static func topViewController() -> UIViewController? {
        let scene = UIApplication.shared.connectedScenes
            .compactMap { $0 as? UIWindowScene }
            .first { $0.activationState == .foregroundActive } ?? UIApplication.shared.connectedScenes.first as? UIWindowScene
        let window = scene?.windows.first { $0.isKeyWindow } ?? scene?.windows.first { !($0 is PassThroughWindow) }
        var top = window?.rootViewController
        while let presented = top?.presentedViewController { top = presented }
        return top
    }

    /// A native confirm; true when the action button is chosen.
    static func confirm(title: String, message: String? = nil, action: String, danger: Bool = false) async -> Bool {
        await withCheckedContinuation { continuation in
            let alert = UIAlertController(title: title, message: message, preferredStyle: .alert)
            alert.addAction(UIAlertAction(title: "Cancel", style: .cancel) { _ in continuation.resume(returning: false) })
            alert.addAction(UIAlertAction(title: action, style: danger ? .destructive : .default) { _ in continuation.resume(returning: true) })
            guard let top = topViewController() else {
                continuation.resume(returning: false)
                return
            }
            top.present(alert, animated: true)
        }
    }

    /// A one-line text prompt; nil when cancelled.
    static func prompt(title: String, message: String? = nil, initial: String = "", placeholder: String = "", action: String) async -> String? {
        await withCheckedContinuation { continuation in
            let alert = UIAlertController(title: title, message: message, preferredStyle: .alert)
            alert.addTextField { field in
                field.text = initial
                field.placeholder = placeholder
                field.clearButtonMode = .whileEditing
                field.autocapitalizationType = .sentences
            }
            alert.addAction(UIAlertAction(title: "Cancel", style: .cancel) { _ in continuation.resume(returning: nil) })
            alert.addAction(UIAlertAction(title: action, style: .default) { _ in
                let value = alert.textFields?.first?.text?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
                continuation.resume(returning: value.isEmpty ? nil : value)
            })
            guard let top = topViewController() else {
                continuation.resume(returning: nil)
                return
            }
            top.present(alert, animated: true)
        }
    }

    /// The system share sheet (save, send, open elsewhere).
    static func share(_ items: [Any]) {
        guard let top = topViewController() else { return }
        let sheet = UIActivityViewController(activityItems: items, applicationActivities: nil)
        sheet.popoverPresentationController?.sourceView = top.view
        sheet.popoverPresentationController?.sourceRect = CGRect(x: top.view.bounds.midX, y: top.view.bounds.midY, width: 0, height: 0)
        top.present(sheet, animated: true)
    }
}

@MainActor
func copyToClipboard(_ text: String, _ message: String = "Copied") {
    UIPasteboard.general.string = text
    toast(message)
}
