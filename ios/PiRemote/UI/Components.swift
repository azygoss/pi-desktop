import PiRemoteKit
import SwiftUI

// MARK: - Pixels

enum PixelTone {
    case working, attention, error, unread, ok, idle
}

/// Re-renders its content once a second while on screen, from a shared
/// clock — per-view TimelineViews inside lazy transcript rows could lock
/// the main thread in a layout loop.
struct LiveTick<Content: View>: View {
    var live = true
    @ViewBuilder var content: (Int) -> Content

    var body: some View {
        if live {
            LiveTickBody(content: content)
        } else {
            content(0)
        }
    }
}

private struct LiveTickBody<Content: View>: View {
    @ViewBuilder var content: (Int) -> Content

    var body: some View {
        content(LiveClock.shared.tick)
            .onAppear { LiveClock.shared.retain() }
            .onDisappear { LiveClock.shared.release() }
    }
}

/// A square status mark. `working` is hollow blue and blinks on the 1 Hz
/// clock; the others are solid.
struct Pixel: View {
    var tone: PixelTone
    var size: CGFloat = 8
    @Environment(\.theme) private var theme

    private var color: Color {
        switch tone {
        case .attention: return theme.warning
        case .error: return theme.danger
        case .ok: return theme.success
        case .idle: return theme.faint
        case .working, .unread: return theme.accent
        }
    }

    var body: some View {
        LiveTick(live: tone == .working) { tick in
            Group {
                if tone == .working {
                    RoundedRectangle(cornerRadius: Radius.pixel).strokeBorder(color, lineWidth: 1.5)
                } else {
                    RoundedRectangle(cornerRadius: Radius.pixel).fill(color)
                }
            }
            .frame(width: size, height: size)
            .opacity(tone == .working && tick % 2 == 1 ? 0.35 : 1)
        }
        .accessibilityHidden(true)
    }
}

/// A project's 3×3 pixel sigil, derived from its path.
struct Sigil: View {
    var seed: String
    var size: CGFloat = 18
    @Environment(\.theme) private var theme

    var body: some View {
        let pattern = sigilPattern(seed)
        let gap = max(1, (size / 12).rounded())
        let cell = (size - gap * 2) / 3
        VStack(spacing: gap) {
            ForEach(0..<3, id: \.self) { row in
                HStack(spacing: gap) {
                    ForEach(0..<3, id: \.self) { column in
                        RoundedRectangle(cornerRadius: 1)
                            .fill(pattern.cells[row * 3 + column] ? theme.sigils[pattern.hue] : Color.clear)
                            .frame(width: cell, height: cell)
                    }
                }
            }
        }
        .frame(width: size, height: size)
        .accessibilityHidden(true)
    }
}

/// Chats without a project: a dashed square.
struct ScratchSigil: View {
    var size: CGFloat = 18
    @Environment(\.theme) private var theme

    var body: some View {
        RoundedRectangle(cornerRadius: 3)
            .strokeBorder(theme.muted, style: StrokeStyle(lineWidth: 1.5, dash: [3, 2]))
            .frame(width: size, height: size)
            .accessibilityHidden(true)
    }
}

/// The pi mark in its own colors, on its 4×4 grid (build/pi-logo.svg).
struct PiMark: View {
    var cell: CGFloat = 14
    private static let cells: [UInt32?] = [
        0xF09082, 0xF09082, 0xF09082, nil,
        0x4D9ABF, nil, 0xF09082, nil,
        0x4D9ABF, 0x4D9ABF, nil, 0xF1BE58,
        0x4D9ABF, nil, nil, 0xF1BE58
    ]

    var body: some View {
        VStack(spacing: 0) {
            ForEach(0..<4, id: \.self) { row in
                HStack(spacing: 0) {
                    ForEach(0..<4, id: \.self) { column in
                        Rectangle()
                            .fill(Self.cells[row * 4 + column].map { Color(hex: $0) } ?? .clear)
                            .frame(width: cell, height: cell)
                    }
                }
            }
        }
        .accessibilityLabel("Pi Remote")
    }
}

// MARK: - Text

extension Text {
    func mono(_ size: CGFloat = 13, _ weight: MonoWeight = .regular) -> Text {
        font(.mono(size, weight))
    }
}

struct SectionLabel: View {
    var text: String
    @Environment(\.theme) private var theme

    init(_ text: String) {
        self.text = text
    }

    var body: some View {
        Text(text)
            .font(.system(size: 13, weight: .medium))
            .foregroundStyle(theme.muted)
            .accessibilityAddTraits(.isHeader)
    }
}

/// "+12 −3" in the diff colors.
struct DiffStatText: View {
    var added: Int
    var removed: Int
    var size: CGFloat = 12
    @Environment(\.theme) private var theme

    var body: some View {
        if added > 0 || removed > 0 {
            (Text("+\(added)").foregroundColor(theme.success) + Text(" ") + Text("−\(removed)").foregroundColor(theme.danger))
                .font(.mono(size))
                .accessibilityLabel("\(added) lines added, \(removed) removed")
        }
    }
}

// MARK: - States

struct EmptyState: View {
    var icon: String?
    var title: String
    var detail: String?
    var actionTitle: String?
    var action: (() -> Void)?
    @Environment(\.theme) private var theme

    var body: some View {
        VStack(spacing: Space.md) {
            if let icon {
                Image(systemName: icon)
                    .font(.system(size: 26, weight: .light))
                    .foregroundStyle(theme.muted)
            }
            Text(title)
                .font(.system(size: 16, weight: .semibold))
                .foregroundStyle(theme.text)
                .multilineTextAlignment(.center)
            if let detail {
                Text(detail)
                    .font(.system(size: 14))
                    .foregroundStyle(theme.muted)
                    .multilineTextAlignment(.center)
            }
            if let actionTitle, let action {
                Button(actionTitle, action: action).buttonStyle(SecondaryButtonStyle())
            }
        }
        .padding(Space.xxl)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

/// A pixel and a muted line: "Loading…", "Starting pi · 4s".
struct LoadingLine: View {
    var text: String
    var tone: PixelTone = .working
    @Environment(\.theme) private var theme

    var body: some View {
        HStack(spacing: Space.sm) {
            Pixel(tone: tone)
            Text(text).font(.mono(12)).foregroundStyle(theme.muted)
        }
        .accessibilityElement(children: .combine)
    }
}

// MARK: - Buttons

struct PrimaryButtonStyle: ButtonStyle {
    @Environment(\.theme) private var theme
    @Environment(\.isEnabled) private var enabled

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.system(size: 15, weight: .semibold))
            .foregroundStyle(theme.onAccent)
            .padding(.horizontal, Space.lg)
            .frame(minHeight: touchTarget)
            .background(RoundedRectangle(cornerRadius: Radius.md).fill(theme.accent))
            .opacity(enabled ? (configuration.isPressed ? 0.8 : 1) : 0.45)
    }
}

struct SecondaryButtonStyle: ButtonStyle {
    var danger = false
    @Environment(\.theme) private var theme
    @Environment(\.isEnabled) private var enabled

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.system(size: 15, weight: .semibold))
            .foregroundStyle(danger ? theme.danger : theme.text)
            .padding(.horizontal, Space.lg)
            .frame(minHeight: touchTarget)
            .background(
                RoundedRectangle(cornerRadius: Radius.md)
                    .fill(danger ? theme.dangerSoft : (configuration.isPressed ? theme.pressed : theme.surface))
            )
            .overlay(
                RoundedRectangle(cornerRadius: Radius.md)
                    .strokeBorder(danger ? Color.clear : theme.borderStrong, lineWidth: 0.5)
            )
            .opacity(enabled ? 1 : 0.45)
    }
}

/// A plain row button that still shows it was pressed.
struct RowButtonStyle: ButtonStyle {
    @Environment(\.theme) private var theme

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .contentShape(Rectangle())
            .background(configuration.isPressed ? theme.pressed : Color.clear)
    }
}

// MARK: - Session row

/**
 * One chat in a list: the project's sigil, the title, and a mono readout of
 * project and age. A status pixel replaces the age while pi works (hollow
 * blue), waits on the user (amber) or has an unread reply (blue).
 */
struct SessionRow: View {
    var session: SessionSummary
    var status: PixelTone?
    var pinned = false
    var projectless = false
    var showProject = true
    @Environment(\.theme) private var theme

    private var statusWord: String {
        switch status {
        case .working: return "working"
        case .attention: return "needs you"
        case .unread: return "new reply"
        default: return ""
        }
    }

    var body: some View {
        HStack(spacing: Space.md) {
            if projectless { ScratchSigil() } else { Sigil(seed: session.cwd) }
            VStack(alignment: .leading, spacing: 1) {
                Text(session.title.isEmpty ? "Untitled chat" : session.title)
                    .font(.system(size: 16, weight: status == .unread ? .semibold : .regular))
                    .foregroundStyle(theme.text)
                    .lineLimit(1)
                Text((showProject && !projectless ? "\(baseName(session.cwd)) · " : "") + (statusWord.isEmpty ? relativeTime(iso: session.modified) : statusWord))
                    .font(.mono(12))
                    .foregroundStyle(theme.muted)
                    .lineLimit(1)
            }
            Spacer(minLength: 0)
            if pinned {
                Image(systemName: "pin").font(.system(size: 12)).foregroundStyle(theme.muted)
            }
            if let status { Pixel(tone: status) }
        }
        .padding(.horizontal, Space.lg)
        .padding(.vertical, 10)
        .frame(minHeight: touchTarget + 12)
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(session.title)\(statusWord.isEmpty ? "" : ", \(statusWord)")")
    }
}

// MARK: - Cards

struct Card<Content: View>: View {
    var label: String?
    @ViewBuilder var content: Content
    @Environment(\.theme) private var theme

    var body: some View {
        VStack(alignment: .leading, spacing: Space.sm) {
            if let label { SectionLabel(label) }
            VStack(spacing: 0) { content }
                .background(RoundedRectangle(cornerRadius: Radius.md).fill(theme.surface))
                .overlay(RoundedRectangle(cornerRadius: Radius.md).strokeBorder(theme.border, lineWidth: 0.5))
                .clipShape(RoundedRectangle(cornerRadius: Radius.md))
        }
    }
}

struct Readout: View {
    var label: String
    var value: String
    @Environment(\.theme) private var theme

    var body: some View {
        HStack(spacing: Space.md) {
            Text(label).font(.system(size: 14)).foregroundStyle(theme.text2)
            Spacer(minLength: Space.sm)
            Text(value)
                .font(.mono(13))
                .foregroundStyle(theme.text2)
                .lineLimit(1)
                .truncationMode(.middle)
        }
        .padding(.horizontal, Space.lg)
        .padding(.vertical, Space.sm)
        .frame(minHeight: touchTarget)
        .accessibilityElement(children: .combine)
    }
}

struct ThemedDivider: View {
    var inset: CGFloat = Space.lg
    @Environment(\.theme) private var theme

    var body: some View {
        Rectangle().fill(theme.border).frame(height: 0.5).padding(.leading, inset)
    }
}

/// A themed text field with the app's surface and border.
struct FieldStyle: ViewModifier {
    @Environment(\.theme) private var theme

    func body(content: Content) -> some View {
        content
            .font(.system(size: 16))
            .foregroundStyle(theme.text)
            .padding(.horizontal, Space.md)
            .padding(.vertical, Space.sm)
            .frame(minHeight: touchTarget)
            .background(RoundedRectangle(cornerRadius: Radius.md).fill(theme.surface))
            .overlay(RoundedRectangle(cornerRadius: Radius.md).strokeBorder(theme.borderStrong, lineWidth: 0.5))
    }
}

extension View {
    func fieldStyle() -> some View { modifier(FieldStyle()) }

    /// A sheet's content: themed, with a grabber and scalable detents.
    func sheetChrome(_ detents: Set<PresentationDetent> = [.medium, .large]) -> some View {
        self
            .themed()
            .presentationDetents(detents)
            .presentationDragIndicator(.visible)
    }
}

/// A row of a menu sheet.
struct SheetAction: View {
    var icon: String?
    var title: String
    var detail: String?
    var danger = false
    var selected = false
    var action: () -> Void
    @Environment(\.theme) private var theme

    var body: some View {
        Button(action: action) {
            HStack(spacing: Space.md) {
                if let icon {
                    Image(systemName: icon)
                        .font(.system(size: 17))
                        .foregroundStyle(danger ? theme.danger : theme.text2)
                        .frame(width: 24)
                }
                VStack(alignment: .leading, spacing: 2) {
                    Text(title).font(.system(size: 16)).foregroundStyle(danger ? theme.danger : theme.text)
                    if let detail {
                        Text(detail).font(.system(size: 13)).foregroundStyle(theme.muted).lineLimit(2)
                    }
                }
                Spacer(minLength: 0)
                if selected { Pixel(tone: .unread) }
            }
            .padding(.horizontal, Space.lg)
            .padding(.vertical, Space.md)
            .frame(minHeight: touchTarget + 8)
        }
        .buttonStyle(RowButtonStyle())
        .accessibilityAddTraits(selected ? .isSelected : [])
    }
}

/// A titled list of sheet actions.
struct ActionSheetView<Content: View>: View {
    var title: String?
    @ViewBuilder var content: Content
    @Environment(\.theme) private var theme

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                if let title {
                    Text(title)
                        .font(.system(size: 17, weight: .semibold))
                        .foregroundStyle(theme.text)
                        .lineLimit(2)
                        .padding(.horizontal, Space.lg)
                        .padding(.top, Space.xl)
                        .padding(.bottom, Space.sm)
                }
                content
            }
            .padding(.bottom, Space.lg)
        }
        .background(theme.raised)
    }
}
