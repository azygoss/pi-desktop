import Foundation
import Observation
import SwiftUI

enum ThemePref: String, CaseIterable {
    case system, light, dark

    var label: String {
        switch self {
        case .system: return "System"
        case .light: return "Light"
        case .dark: return "Dark"
        }
    }

    var colorScheme: ColorScheme? {
        switch self {
        case .system: return nil
        case .light: return .light
        case .dark: return .dark
        }
    }
}

/// This phone's own preferences (nothing here reaches the computer).
@MainActor
@Observable
final class Prefs {
    static let shared = Prefs()

    private static let key = "pi-remote.prefs"

    var theme: ThemePref = .system { didSet { save() } }
    var haptics = true { didSet { save() } }
    /// Background notifications: nil until the user has been asked.
    var notifications: Bool? { didSet { save() } }

    @ObservationIgnored private var loading = true

    private init() {
        if let data = UserDefaults.standard.data(forKey: Self.key),
            let stored = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
        {
            theme = (stored["theme"] as? String).flatMap(ThemePref.init(rawValue:)) ?? .system
            haptics = stored["haptics"] as? Bool ?? true
            notifications = stored["notifications"] as? Bool
        }
        loading = false
    }

    private func save() {
        guard !loading else { return }
        var stored: [String: Any] = ["theme": theme.rawValue, "haptics": haptics]
        if let notifications { stored["notifications"] = notifications }
        if let data = try? JSONSerialization.data(withJSONObject: stored) {
            UserDefaults.standard.set(data, forKey: Self.key)
        }
    }
}
