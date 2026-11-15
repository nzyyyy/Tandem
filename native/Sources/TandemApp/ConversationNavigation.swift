import SwiftUI
import TandemCore

struct ConversationNavigation: View {
    let messages: [TimelineMessage]
    let visibleSequence: Int?
    let maximumHeight: CGFloat
    var jump: (Int) -> Void
    @State private var hoveredID: String?

    // shortcut: Navigation covers loaded messages; add a summary query if full-history navigation is needed.
    var entries: [TimelineMessage] { messages.filter { $0.role == "user" } }
    var activeMessageID: String? {
        guard let visibleSequence else { return nil }
        return entries.last { $0.sequence <= visibleSequence }?.id
    }

    var body: some View {
        let questions = entries
        let activeID = activeMessageID
        ScrollView {
            VStack(spacing: 0) {
                ForEach(questions) { message in
                    Button { jump(message.sequence) } label: {
                        RoundedRectangle(cornerRadius: 1)
                            .fill(message.id == activeID ? TandemStyle.accent : TandemStyle.secondary.opacity(0.45))
                            .frame(width: message.id == activeID || message.id == hoveredID ? 22 : 12, height: 2)
                            .frame(width: 28, height: 24).contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("跳转到提问：" + message.content)
                    .accessibilityValue(message.id == activeID ? "当前位置" : "")
                    .onHover { if $0 { hoveredID = message.id } }
                }
            }
        }
        .scrollIndicators(.hidden)
        .frame(width: 28, height: min(maximumHeight, CGFloat(questions.count) * 24))
        .onHover { if !$0 { hoveredID = nil } }
        .overlay(alignment: .leading) {
            if let message = questions.first(where: { $0.id == hoveredID }) {
                VStack(alignment: .leading, spacing: 8) {
                    Text(message.content).font(.system(size: 13, weight: .medium)).lineLimit(2)
                    if let interactionID = message.interactionId,
                       let reply = messages.first(where: { $0.role == "assistant" && $0.interactionId == interactionID }),
                       !reply.content.isEmpty {
                        Text(reply.content).font(.system(size: 12)).foregroundStyle(TandemStyle.secondary).lineLimit(3)
                    }
                }
                .padding(12).frame(width: 300, alignment: .leading)
                .background(TandemStyle.surface, in: RoundedRectangle(cornerRadius: 10))
                .overlay { RoundedRectangle(cornerRadius: 10).stroke(TandemStyle.border, lineWidth: 1) }
                .shadow(color: .black.opacity(0.12), radius: 8, y: 3)
                .offset(x: 36).allowsHitTesting(false).accessibilityHidden(true)
            }
        }
    }
}
