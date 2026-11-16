import SwiftUI
import AppKit

// 经典黑白灰配色（参考 Claude 桌面端）：浅/深色跟随窗口外观，强调色与正文同色。
enum TandemStyle {
    private static func color(_ light: UInt32, _ dark: UInt32) -> Color {
        Color(nsColor: NSColor(name: nil) { _ in
            // Resolve from the app appearance, not the vibrant sidebar's drawing appearance.
            let isDark = NSApplication.shared.effectiveAppearance.bestMatch(from: [.aqua, .darkAqua]) == .darkAqua
            let hex = isDark ? dark : light
            return NSColor(srgbRed: CGFloat((hex >> 16) & 255) / 255,
                           green: CGFloat((hex >> 8) & 255) / 255,
                           blue: CGFloat(hex & 255) / 255, alpha: 1)
        })
    }
    static let canvas = color(0xFFFFFF, 0x1F1F1F)
    static let surface = color(0xF5F5F5, 0x2A2A2A)
    static let hover = color(0xEDEDED, 0x353535)
    static let ink = color(0x1A1A1A, 0xEDEDED)
    static let secondary = color(0x6B6B6B, 0xA0A0A0)
    static let accent = color(0x1A1A1A, 0xEDEDED)
    static let onAccent = color(0xFFFFFF, 0x1F1F1F)
    static let selection = color(0xE6E6E6, 0x454545)
    static let border = color(0xE5E5E5, 0x3A3A3A)
}

// 应用外观：auto 跟随系统，其余强制浅色/深色。
enum TandemAppearance {
    static let key = "tandem.appearance"
    static func apply(_ value: String) {
        switch value {
        case "light": NSApplication.shared.appearance = NSAppearance(named: .aqua)
        case "dark": NSApplication.shared.appearance = NSAppearance(named: .darkAqua)
        default: NSApplication.shared.appearance = nil
        }
    }
}

struct PageHeader<Actions: View>: View {
    let title: String
    @ViewBuilder var actions: Actions
    var body: some View {
        HStack(spacing: 12) {
            Text(title).font(.system(size: 17, weight: .semibold))
            Spacer(minLength: 12)
            actions
        }
        .controlSize(.large)
        .padding(.horizontal, 32).padding(.vertical, 16)
        .background(TandemStyle.canvas)
        .overlay(alignment: .bottom) { Divider() }
    }
}

struct SelectionRow: View {
    let title: String
    let symbol: String
    var subtitle: String? = nil
    let selected: Bool
    let action: () -> Void
    @State private var hovered = false
    @FocusState private var focused: Bool
    var body: some View {
        Button { focused = false; action() } label: {
            HStack(alignment: .top, spacing: 12) {
                Image(systemName: symbol).font(.system(size: 17)).frame(width: 22)
                VStack(alignment: .leading, spacing: 6) {
                    Text(title).font(.system(size: 14, weight: selected ? .semibold : .regular)).lineLimit(2)
                    if let subtitle { Text(subtitle).font(.caption).foregroundStyle(TandemStyle.secondary).lineLimit(2) }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            .foregroundStyle(selected ? TandemStyle.accent : TandemStyle.ink)
            .padding(12)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(selected ? TandemStyle.selection : hovered ? TandemStyle.hover : .clear, in: RoundedRectangle(cornerRadius: 8))
            .contentShape(Rectangle())
        }
        .buttonStyle(TandemButtonStyle(.plain))
        .focused($focused).focusEffectDisabled()
        .onChange(of: selected) { _, selected in if !selected { focused = false } }
        .onHover { hovered = $0 }
        .accessibilityAddTraits(selected ? .isSelected : [])
        .help(title)
    }
}

struct EditorField<Content: View>: View {
    let title: String
    @ViewBuilder var content: Content
    var body: some View {
        VStack(alignment: .leading, spacing: 9) {
            Text(title).font(.system(size: 12, weight: .medium)).foregroundStyle(TandemStyle.secondary)
            content.frame(maxWidth: .infinity, alignment: .leading)
        }
    }
}

struct TandemTextFieldStyle: TextFieldStyle {
    @FocusState private var focused: Bool
    func _body(configuration: TextField<Self._Label>) -> some View {
        configuration
            .textFieldStyle(.plain).font(.system(size: 14))
            .padding(12).focused($focused)
            .background(TandemStyle.canvas, in: RoundedRectangle(cornerRadius: 8))
            .overlay { RoundedRectangle(cornerRadius: 8).stroke(focused ? TandemStyle.accent : TandemStyle.border, lineWidth: focused ? 2 : 1) }
    }
}

// Used for both page and project switching so an edit is never discarded implicitly.
struct EditorSelection {
    var value: String
    var pending: String?
    mutating func select(_ next: String, hasChanges: Bool) {
        pending = nil
        guard next != value else { return }
        if hasChanges { pending = next } else { value = next }
    }
    mutating func discard() {
        if let pending { value = pending }
        pending = nil
    }
}

struct TandemButtonStyle: ButtonStyle {
    enum Kind { case standard, primary, plain }
    var kind: Kind = .standard
    @Environment(\.isEnabled) private var enabled
    @Environment(\.isFocused) private var focused
    @Environment(\.controlSize) private var controlSize
    @State private var hovered = false

    init(_ kind: Kind = .standard) { self.kind = kind }

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.system(size: 13, weight: .medium))
            .foregroundStyle(configuration.role == .destructive ? Color.red : kind == .primary ? TandemStyle.onAccent : TandemStyle.ink)
            .padding(.horizontal, kind == .plain ? 0 : controlSize == .small ? 8 : 14)
            .padding(.vertical, kind == .plain ? 0 : controlSize == .small ? 8 : 9)
            .background(background, in: RoundedRectangle(cornerRadius: 8))
            .overlay {
                RoundedRectangle(cornerRadius: 8)
                    .stroke(focused ? TandemStyle.accent : kind == .standard ? TandemStyle.border : .clear, lineWidth: focused ? 2 : 1)
            }
            .opacity(!enabled ? 0.45 : configuration.isPressed ? 0.75 : 1)
            .contentShape(RoundedRectangle(cornerRadius: 8))
            .onHover { hovered = $0 }
            .focusEffectDisabled()
    }
    private var background: Color {
        switch kind {
        case .primary: return TandemStyle.accent
        case .standard: return hovered && enabled ? TandemStyle.hover : TandemStyle.canvas
        case .plain: return .clear
        }
    }
}

struct TandemMenuLabel<Content: View>: View {
    @ViewBuilder var content: Content
    @Environment(\.isEnabled) private var enabled
    @Environment(\.isFocused) private var focused
    @Environment(\.controlSize) private var controlSize
    @State private var hovered = false
    var body: some View {
        HStack(spacing: 10) {
            content.lineLimit(1).frame(maxWidth: .infinity, alignment: .leading)
            Image(systemName: "chevron.down").font(.system(size: 10, weight: .semibold))
                .foregroundStyle(TandemStyle.secondary).accessibilityHidden(true)
        }
        .font(.system(size: 13, weight: .medium)).foregroundStyle(TandemStyle.ink)
        .padding(.horizontal, 12).padding(.vertical, controlSize == .small ? 8 : 9)
        .background(hovered && enabled ? TandemStyle.hover : TandemStyle.canvas, in: RoundedRectangle(cornerRadius: 8))
        .overlay { RoundedRectangle(cornerRadius: 8).stroke(focused ? TandemStyle.accent : TandemStyle.border, lineWidth: focused ? 2 : 1) }
        .opacity(enabled ? 1 : 0.45)
        .contentShape(RoundedRectangle(cornerRadius: 8))
        .onHover { hovered = $0 }
    }
}

// Keep native menu selection, checkmarks and keyboard handling; replace only the closed control.
struct TandemPicker<Selection: Hashable, Content: View>: View {
    let title: String
    let value: String
    @Binding var selection: Selection
    @ViewBuilder var content: Content
    var body: some View {
        Menu {
            Picker(title, selection: $selection) { content }.pickerStyle(.inline)
        } label: {
            TandemMenuLabel { Text(value) }
        }
        .menuStyle(.borderlessButton).menuIndicator(.hidden).focusEffectDisabled()
        .accessibilityLabel(title).accessibilityValue(value).help(value)
    }
}
