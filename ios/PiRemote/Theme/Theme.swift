import SwiftUI

/**
 * Pi Desktop's design language on a phone (docs/design.md): color is signal
 * — blue = pi is working / active, amber = pi needs you, coral = error or
 * stop — and everything else is ink on graphite (dark) or paper (light).
 * Readouts use IBM Plex Mono; status marks are square pixels.
 */
struct Theme: Equatable {
    var dark: Bool
    /// Window frame: behind the lists and the tab bar.
    var chrome: Color
    var bg: Color
    var surface: Color
    var raised: Color
    var pressed: Color
    var active: Color
    var border: Color
    var borderStrong: Color
    var codeBg: Color
    var text: Color
    var text2: Color
    var muted: Color
    /// Decorative only (empty cells, rules) — never text.
    var faint: Color
    var accent: Color
    var onAccent: Color
    var accentSoft: Color
    var danger: Color
    var dangerSoft: Color
    var success: Color
    var successSoft: Color
    var warning: Color
    var warningSoft: Color
    var userBlock: Color
    var sigils: [Color]

    static let darkTheme = Theme(
        dark: true,
        chrome: Color(hex: 0x0E0F11),
        bg: Color(hex: 0x141517),
        surface: Color(hex: 0x1A1B1E),
        raised: Color(hex: 0x1F2023),
        pressed: Color(hex: 0x222327),
        active: Color(hex: 0x292A2F),
        border: Color(hex: 0x242529),
        borderStrong: Color(hex: 0x33343A),
        codeBg: Color(hex: 0x111214),
        text: Color(hex: 0xECECEE),
        text2: Color(hex: 0xB4B5BA),
        muted: Color(hex: 0x8A8B91),
        faint: Color(hex: 0x45464C),
        accent: Color(hex: 0x62B0DC),
        onAccent: Color(hex: 0x06121B),
        accentSoft: Color(hex: 0x62B0DC, alpha: 0.14),
        danger: Color(hex: 0xF09082),
        dangerSoft: Color(hex: 0xF09082, alpha: 0.13),
        success: Color(hex: 0x77C690),
        successSoft: Color(hex: 0x77C690, alpha: 0.13),
        warning: Color(hex: 0xE9B04E),
        warningSoft: Color(hex: 0xE9B04E, alpha: 0.13),
        userBlock: Color(hex: 0x1C1D20),
        sigils: [0xF09082, 0x62B0DC, 0xE9B04E, 0x86C79A, 0xB59CF0, 0x6FC6C0].map { Color(hex: $0) }
    )

    static let lightTheme = Theme(
        dark: false,
        chrome: Color(hex: 0xECECE9),
        bg: Color(hex: 0xFBFBFA),
        surface: Color(hex: 0xFFFFFF),
        raised: Color(hex: 0xFFFFFF),
        pressed: Color(hex: 0xF1F1EE),
        active: Color(hex: 0xE7E7E3),
        border: Color(hex: 0xE7E7E3),
        borderStrong: Color(hex: 0xD4D4CF),
        codeBg: Color(hex: 0xF5F5F2),
        text: Color(hex: 0x16171A),
        text2: Color(hex: 0x46474C),
        muted: Color(hex: 0x6A6B70),
        faint: Color(hex: 0xC8C8C3),
        accent: Color(hex: 0x2A77AA),
        onAccent: Color(hex: 0xFFFFFF),
        accentSoft: Color(hex: 0x2A77AA, alpha: 0.1),
        danger: Color(hex: 0xB8463A),
        dangerSoft: Color(hex: 0xB8463A, alpha: 0.09),
        success: Color(hex: 0x2C8445),
        successSoft: Color(hex: 0x2C8445, alpha: 0.1),
        warning: Color(hex: 0x8F6210),
        warningSoft: Color(hex: 0x8F6210, alpha: 0.1),
        userBlock: Color(hex: 0xF3F3F0),
        sigils: [0xD9604F, 0x2F86BD, 0xC98A14, 0x3F9A5C, 0x7D5FD0, 0x2A9A93].map { Color(hex: $0) }
    )

    static func of(_ scheme: ColorScheme) -> Theme { scheme == .dark ? darkTheme : lightTheme }
}

/// 4pt spacing scale.
enum Space {
    static let xs: CGFloat = 4
    static let sm: CGFloat = 8
    static let md: CGFloat = 12
    static let lg: CGFloat = 16
    static let xl: CGFloat = 24
    static let xxl: CGFloat = 32
}

enum Radius {
    static let pixel: CGFloat = 2
    static let sm: CGFloat = 6
    static let md: CGFloat = 10
    static let lg: CGFloat = 14
}

/// Smallest comfortable touch target (Apple HIG: 44pt).
let touchTarget: CGFloat = 44

enum MonoWeight {
    case regular, medium, semibold

    var fontName: String {
        switch self {
        case .regular: return "IBMPlexMono-Regular"
        case .medium: return "IBMPlexMono-Medium"
        case .semibold: return "IBMPlexMono-SemiBold"
        }
    }
}

extension Font {
    /// Readouts — times, tokens, models, tool names, paths, code.
    static func mono(_ size: CGFloat, _ weight: MonoWeight = .regular) -> Font {
        .custom(weight.fontName, size: size, relativeTo: size >= 16 ? .body : .footnote).monospacedDigit()
    }
}

extension UIFont {
    static func mono(_ size: CGFloat, _ weight: MonoWeight = .regular) -> UIFont {
        UIFont(name: weight.fontName, size: size) ?? .monospacedSystemFont(ofSize: size, weight: .regular)
    }
}

extension Color {
    init(hex: UInt32, alpha: Double = 1) {
        self.init(
            .sRGB,
            red: Double((hex >> 16) & 0xFF) / 255,
            green: Double((hex >> 8) & 0xFF) / 255,
            blue: Double(hex & 0xFF) / 255,
            opacity: alpha
        )
    }
}

private struct ThemeKey: EnvironmentKey {
    static let defaultValue = Theme.darkTheme
}

extension EnvironmentValues {
    var theme: Theme {
        get { self[ThemeKey.self] }
        set { self[ThemeKey.self] = newValue }
    }
}

/// Puts the theme matching the color scheme into the environment.
struct ThemeProvider: ViewModifier {
    @Environment(\.colorScheme) private var scheme

    func body(content: Content) -> some View {
        let theme = Theme.of(scheme)
        content
            .environment(\.theme, theme)
            .tint(theme.accent)
    }
}

extension View {
    func themed() -> some View { modifier(ThemeProvider()) }
}
