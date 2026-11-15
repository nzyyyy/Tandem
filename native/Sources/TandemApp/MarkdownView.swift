import SwiftUI
import Textual

struct ChatMarkdownParser: MarkupParser {
    func attributedString(for input: String) throws -> AttributedString {
        var content = (try? AttributedStringMarkdownParser(baseURL: nil).attributedString(for: input)) ?? AttributedString(input)
        for run in content.runs {
            // Model output is untrusted: preserve alt text without loading image URLs.
            content[run.range].imageURL = nil
            if let link = run.link, !Self.allows(link) { content[run.range].link = nil }
        }
        return content
    }
    static func allows(_ url: URL) -> Bool {
        ["https", "http"].contains(url.scheme?.lowercased() ?? "") && url.host != nil && url.user == nil && url.password == nil
    }
}

struct MarkdownView: View {
    let source: String
    init(_ source: String) { self.source = source }
    var body: some View {
        StructuredText(source, parser: ChatMarkdownParser())
            .textual.inlineStyle(InlineStyle.gitHub.link(.foregroundColor(TandemStyle.accent)))
            .textual.codeBlockStyle(ChatCodeBlockStyle())
            .textual.structuredTextStyle(.gitHub)
            .textual.textSelection(.enabled)
            .font(.system(size: 15)).foregroundStyle(TandemStyle.ink)
            .frame(maxWidth: .infinity, alignment: .leading)
            .environment(\.openURL, OpenURLAction { url in
                ChatMarkdownParser.allows(url) ? .systemAction(url) : .discarded
            })
    }
}

private struct ChatCodeBlockStyle: StructuredText.CodeBlockStyle {
    func makeBody(configuration: Configuration) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack {
                Text(configuration.languageHint ?? "代码").font(.caption).foregroundStyle(TandemStyle.secondary)
                Spacer()
                Button("复制代码") { configuration.codeBlock.copyToPasteboard() }
                    .buttonStyle(TandemButtonStyle(.plain)).font(.caption)
            }.padding(.horizontal, 14).padding(.vertical, 10)
            Divider()
            Overflow {
                configuration.label
                    .monospaced().textual.fontScale(0.87)
                    .textual.lineSpacing(.fontScaled(0.25))
                    .fixedSize(horizontal: false, vertical: true).padding(14)
            }
        }
        .background(TandemStyle.surface, in: RoundedRectangle(cornerRadius: 10))
        .overlay { RoundedRectangle(cornerRadius: 10).stroke(TandemStyle.border, lineWidth: 1) }
        .textual.blockSpacing(.init(top: 0, bottom: 16))
    }
}
