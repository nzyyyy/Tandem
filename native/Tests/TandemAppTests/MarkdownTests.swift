import XCTest
import SwiftUI
import AppKit
import Textual
@testable import TandemApp

final class MarkdownTests: XCTestCase {
    func testBlockAndInlineFormattingSurvivesTheSafeParser() async throws {
        try await MainActor.run {
            let value = try ChatMarkdownParser().attributedString(for: """
            # 标题

            正文 **加粗** *斜体* `let x` [网页](https://example.com)

            3. 第三项
            4. 第四项
               - 子项

            > 引用

            ---
            """)
            let runs = Array(value.runs)
            XCTAssertTrue(runs.contains { $0.presentationIntent?.components.contains { $0.kind == .header(level: 1) } == true })
            XCTAssertTrue(runs.contains { $0.presentationIntent?.components.contains { $0.kind == .listItem(ordinal: 3) } == true })
            XCTAssertTrue(runs.contains { $0.presentationIntent?.components.contains { $0.kind == .unorderedList } == true })
            XCTAssertTrue(runs.contains { $0.presentationIntent?.components.contains { $0.kind == .blockQuote } == true })
            XCTAssertTrue(runs.contains { $0.inlinePresentationIntent?.contains(.stronglyEmphasized) == true })
            XCTAssertTrue(runs.contains { $0.inlinePresentationIntent?.contains(.emphasized) == true })
            XCTAssertTrue(runs.contains { $0.inlinePresentationIntent?.contains(.code) == true })
            XCTAssertTrue(runs.contains { $0.link == URL(string: "https://example.com") })
        }
    }

    func testIncompleteStreamedCodeAndEmphasisStayReadable() async throws {
        try await MainActor.run {
            let source = "```swift\nlet value = \"**不是粗体**\"\n  print(value)"
            let parser = ChatMarkdownParser()
            let partial = try parser.attributedString(for: source)
            XCTAssertTrue(String(partial.characters).contains("**不是粗体**"))
            XCTAssertTrue(partial.runs.contains { $0.presentationIntent?.components.contains { $0.kind == .codeBlock(languageHint: "swift") } == true })
            XCTAssertFalse(partial.runs.contains { $0.inlinePresentationIntent?.contains(.stronglyEmphasized) == true })
            let completed = try parser.attributedString(for: source + "\n```\n\n结束")
            XCTAssertTrue(String(completed.characters).hasSuffix("结束"))
            for end in source.indices { _ = try parser.attributedString(for: String(source[..<end])) }
            XCTAssertTrue(String(try parser.attributedString(for: "尚未闭合的 **加粗").characters).contains("加粗"))
        }
    }

    func testTablesPreserveColumnAlignmentAndEmptyCellPositions() async throws {
        try await MainActor.run {
            let table = try ChatMarkdownParser().attributedString(for: """
            | 名称 | 数量 | 说明 |
            | :--- | ---: | :---: |
            | **A** | 2 | |
            | B | 10 | `code` |
            """)
            let components = table.runs.flatMap { $0.presentationIntent?.components ?? [] }
            let columns = components.compactMap { component -> [PresentationIntent.TableColumn]? in
                if case .table(let columns) = component.kind { return columns }; return nil
            }.first
            XCTAssertEqual(columns?.map(\.alignment), [.left, .right, .center])
            XCTAssertTrue(components.contains { $0.kind == .tableHeaderRow })
            XCTAssertTrue(components.contains { $0.kind == .tableCell(columnIndex: 2) })
            XCTAssertTrue(table.runs.contains { $0.inlinePresentationIntent?.contains(.stronglyEmphasized) == true })
            XCTAssertTrue(String(table.characters).contains("code"))
        }
    }

    func testUnsafeLinksAndAllImageLoadsAreRemovedBeforeRendering() async throws {
        try await MainActor.run {
            for value in ["https://example.com/path", "http://localhost:8000"] { XCTAssertTrue(ChatMarkdownParser.allows(URL(string: value)!)) }
            for value in ["javascript:alert(1)", "file:///etc/passwd", "tandem://delete", "data:text/html,hello", "relative.md", "https://user:password@example.com"] {
                XCTAssertFalse(ChatMarkdownParser.allows(URL(string: value)!))
                let content = try ChatMarkdownParser().attributedString(for: "[链接](\(value))")
                XCTAssertFalse(content.runs.contains { $0.link != nil })
            }
            for url in ["https://example.com/tracker.png", "file:///etc/passwd", "/tmp/private.png"] {
                let content = try ChatMarkdownParser().attributedString(for: "![图片说明](\(url))")
                XCTAssertEqual(String(content.characters), "图片说明")
                XCTAssertFalse(content.runs.contains { $0.imageURL != nil || $0.link != nil })
            }
        }
    }

    @MainActor func testRichDocumentLaysOutAtChatWidthWithoutClipping() async throws {
        let source = """
        # 渲染测试

        **加粗**、*斜体*和 `inline code`。

        - 第一项
          - 嵌套项

        > 重要引用

        ```swift
        let message = "你好"
        ```

        | 名称 | 数量 |
        | --- | ---: |
        | A | 2 |
        """
        let host = NSHostingView(rootView: MarkdownView(source).frame(width: 420).background(TandemStyle.canvas))
        host.frame = NSRect(x: 0, y: 0, width: 420, height: 1000)
        host.layoutSubtreeIfNeeded()
        try await Task.sleep(for: .milliseconds(150))
        host.layoutSubtreeIfNeeded()
        XCTAssertEqual(host.fittingSize.width, 420, accuracy: 1)
        XCTAssertGreaterThan(host.fittingSize.height, 300)
        XCTAssertLessThan(host.fittingSize.height, 1500)
    }
}
