import XCTest
import SwiftUI
import AppKit
import TandemCore
@testable import TandemApp

final class ConversationLayoutTests: XCTestCase {
    func testNavigationTracksTheQuestionWhileReadingItsAnswer() throws {
        let data = try JSONSerialization.data(withJSONObject: [
            ["id": "q1", "sessionId": "topic", "sequence": 1, "role": "user", "content": "第一问"],
            ["id": "a1", "sessionId": "topic", "sequence": 2, "role": "assistant", "content": "第一答"],
            ["id": "q2", "sessionId": "topic", "sequence": 3, "role": "user", "content": "第二问"],
            ["id": "a2", "sessionId": "topic", "sequence": 4, "role": "assistant", "content": "第二答"]
        ])
        let messages = try JSONDecoder().decode([TimelineMessage].self, from: data)
        var navigation = ConversationNavigation(messages: messages, visibleSequence: 2, maximumHeight: 400, jump: { _ in })
        XCTAssertEqual(navigation.entries.map(\.id), ["q1", "q2"])
        XCTAssertEqual(navigation.activeMessageID, "q1")
        navigation = ConversationNavigation(messages: messages, visibleSequence: 2, maximumHeight: 400, isAtBottom: true, jump: { _ in })
        XCTAssertEqual(navigation.activeMessageID, "q2", "At the bottom, the previous answer's visible tail must not keep the previous question selected")
        navigation.isAtBottom = false
        XCTAssertEqual(navigation.activeMessageID, "q1", "Scrolling up must resume tracking the top visible message")
        navigation = ConversationNavigation(messages: Array(messages.prefix(2)), visibleSequence: 2, maximumHeight: 400, isAtBottom: true, jump: { _ in })
        XCTAssertEqual(navigation.activeMessageID, "q1", "The last question must come from the filtered timeline")
        navigation = ConversationNavigation(messages: messages, visibleSequence: 4, maximumHeight: 400, jump: { _ in })
        XCTAssertEqual(navigation.activeMessageID, "q2")
        navigation = ConversationNavigation(messages: [], visibleSequence: nil, maximumHeight: 400, jump: { _ in })
        XCTAssertTrue(navigation.entries.isEmpty)
        XCTAssertNil(navigation.activeMessageID)
        navigation.isAtBottom = true
        XCTAssertNil(navigation.activeMessageID)
    }

    func testUserBubblesStayCompactOnTheRightAndLongTextWraps() async throws {
        try await MainActor.run {
            let model = AssistantModel(runtime: RuntimeSupervisor())
            @MainActor func render(_ content: String) throws -> NSBitmapImageRep {
                let data = try JSONSerialization.data(withJSONObject: ["id": "test", "sessionId": "topic", "sequence": 1, "role": "user", "content": content])
                let message = try JSONDecoder().decode(TimelineMessage.self, from: data)
                let view = MessageView(message: message, model: model, maximumWidth: 420, showDetails: {})
                    .frame(width: 600).background(Color.white).environment(\.colorScheme, .light)
                let renderer = ImageRenderer(content: view)
                renderer.scale = 1
                let rendered = renderer.cgImage
                let image = try XCTUnwrap(rendered)
                return NSBitmapImageRep(cgImage: image)
            }
            func bubblePixels(_ image: NSBitmapImageRep) -> [Int] {
                (0..<image.pixelsWide).filter { x in
                    guard let color = image.colorAt(x: x, y: 18)?.usingColorSpace(.sRGB) else { return false }
                    return abs(color.redComponent - 242.0 / 255) < 0.012 && abs(color.greenComponent - 245.0 / 255) < 0.012 && abs(color.blueComponent - 243.0 / 255) < 0.012
                }
            }
            let short = try render("快要下班了")
            let shortPixels = bubblePixels(short)
            XCTAssertGreaterThan(try XCTUnwrap(shortPixels.first), 450, "Short messages should not stretch to fill the maximum bubble width")
            XCTAssertGreaterThan(try XCTUnwrap(shortPixels.last), 590, "User bubbles should reach the right edge")
            let long = try render(String(repeating: "这是一条需要换行的长消息。", count: 12))
            let longPixels = bubblePixels(long)
            XCTAssertGreaterThanOrEqual(try XCTUnwrap(longPixels.first), 180, "Long user messages must stay within 70% of the conversation width")
            XCTAssertLessThan(try XCTUnwrap(longPixels.first), 220)
            XCTAssertGreaterThan(long.pixelsHigh, short.pixelsHigh, "Long messages must wrap instead of clipping")
        }
    }

    @MainActor func testFirstNavigationInUnmeasuredHistoryReachesTheQuestion() async throws {
        _ = NSApplication.shared
        for (count, sequence) in [(18, 29), (18, 3), (18, 17), (18, 1), (18, 35),
                                  (60, 95), (60, 3), (60, 61), (60, 1), (60, 119)] {
            let messages = try navigationMessages(count: count)
            let driver = NavigationScrollDriver()
            let host = NSHostingView(rootView: NavigationScrollFixture(driver: driver, messages: messages))
            let window = NSWindow(contentRect: NSRect(x: -10000, y: -10000, width: 900, height: 600),
                                  styleMask: [.borderless], backing: .buffered, defer: false)
            window.isReleasedWhenClosed = false; window.contentView = host
            window.orderFront(nil)
            defer { window.orderOut(nil); window.contentView = nil; window.close() }
            host.layoutSubtreeIfNeeded()
            try await Task.sleep(for: .milliseconds(150))
            driver.position.scrollTo(id: sequence, anchor: .top)
            host.layoutSubtreeIfNeeded()
            try await settleLayout(host)
            let frame = try XCTUnwrap(driver.frames[sequence], "First target \(sequence), measured: \(driver.frames.keys.sorted())")
            XCTAssertEqual(frame.minY, 0, accuracy: 2, "First jump to question \(sequence) must align without traversing history")
        }
    }

    @MainActor private func settleLayout(_ host: NSView) async throws {
        // Offscreen windows need explicit layout passes while scroll callbacks settle.
        for _ in 0..<15 {
            host.layoutSubtreeIfNeeded()
            try await Task.sleep(for: .milliseconds(20))
        }
    }

    private func navigationMessages(count: Int = 18) throws -> [TimelineMessage] {
        let rows: [[String: Any]] = (0..<count).flatMap { index in
            [["id": "q\(index)", "sessionId": "topic", "sequence": index * 2 + 1, "role": "user", "content": "问题 \(index)"],
             ["id": "a\(index)", "sessionId": "topic", "sequence": index * 2 + 2, "role": "assistant", "content": """
             ## 回答 \(index)

             \(String(repeating: "这是带有 **强调** 和 `code` 的长回答，用于检查连续跳转时的富文本布局。\n\n", count: index.isMultiple(of: 2) ? 2 : 12))
             | 项目 | 说明 |
             | --- | --- |
             | A | 第一项 |
             | B | 第二项 |

             ```swift
             let value = "navigation"
             ```
             """]]
        }
        return try JSONDecoder().decode([TimelineMessage].self, from: JSONSerialization.data(withJSONObject: rows))
    }

    @MainActor func testNavigationJumpSettlesWithoutReversing() async throws {
        _ = NSApplication.shared
        let messages = try navigationMessages()
        let driver = NavigationScrollDriver()
        let host = NSHostingView(rootView: NavigationScrollFixture(driver: driver, messages: messages))
        let window = NSWindow(contentRect: NSRect(x: -10000, y: -10000, width: 900, height: 600),
                              styleMask: [.borderless], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false; window.contentView = host
        window.orderFront(nil)
        defer { window.orderOut(nil); window.contentView = nil; window.close() }
        host.layoutSubtreeIfNeeded()
        try await Task.sleep(for: .milliseconds(150))

        for sequence in [29, 3, 1, 35, 15, 27, 7] {
            driver.position.scrollTo(id: sequence, anchor: .top)
            host.layoutSubtreeIfNeeded()
            var samples: [CGFloat] = []
            for _ in 0..<25 {
                try await Task.sleep(for: .milliseconds(8))
                host.layoutSubtreeIfNeeded()
                if let y = driver.frames[sequence]?.minY { samples.append(y) }
            }
            XCTAssertEqual(try XCTUnwrap(samples.last), 0, accuracy: 2,
                           "Question \(sequence) must settle at the viewport top")
            var direction = 0
            for (from, to) in zip(samples, samples.dropFirst()) where abs(to - from) > 2 {
                let next = to > from ? 1 : -1
                XCTAssertTrue(direction == 0 || next == direction,
                              "Question \(sequence) jittered after the jump: \(samples)")
                direction = next
            }
        }
    }

    @MainActor func testRapidNavigationAcrossRichRepliesKeepsTheMainActorResponsive() async throws {
        let messages = try navigationMessages()
        let driver = NavigationScrollDriver()
        let host = NSHostingView(rootView: NavigationScrollFixture(driver: driver, messages: messages))
        _ = NSApplication.shared
        let window = NSWindow(contentRect: NSRect(x: -10000, y: -10000, width: 900, height: 600),
                              styleMask: [.borderless], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false; window.contentView = host
        window.orderFront(nil)
        defer { window.orderOut(nil); window.contentView = nil; window.close() }
        host.layoutSubtreeIfNeeded()
        try await Task.sleep(for: .milliseconds(150))

        var ticks = 0
        let heartbeat = Task { @MainActor in
            while !Task.isCancelled {
                ticks += 1
                do { try await Task.sleep(for: .milliseconds(5)) } catch { break }
            }
        }
        defer { heartbeat.cancel() }
        for sequence in [29, 3, 1, 35, 15] {
            driver.position.scrollTo(id: sequence, anchor: .top)
            host.layoutSubtreeIfNeeded()
            try await settleLayout(host)
            let frame = try XCTUnwrap(driver.frames[sequence])
            XCTAssertEqual(frame.minY, 0, accuracy: 2, "An unmeasured question \(sequence) must actually reach the viewport top")
        }
        for sequence in Array(repeating: [1, 9, 3, 11, 5], count: 6).flatMap({ $0 }) {
            driver.position.scrollTo(id: sequence, anchor: .top)
            host.layoutSubtreeIfNeeded()
            try await Task.sleep(for: .milliseconds(25))
        }
        try await settleLayout(host)
        XCTAssertGreaterThan(ticks, 30, "Navigation must leave the main actor available between jumps")
        XCTAssertEqual(driver.viewport.visibleSequence, 5, "The final click must win")
        for sequence in [1, 9, 3, 11, 5] {
            driver.position.scrollTo(id: sequence, anchor: .top)
            host.layoutSubtreeIfNeeded()
            try await settleLayout(host)
            let frame = try XCTUnwrap(driver.frames[sequence])
            XCTAssertEqual(frame.minY, 0, accuracy: 2, "Question \(sequence) must actually reach the viewport top")
        }
    }
}

@MainActor private final class NavigationScrollDriver: ObservableObject {
    @Published var position = ScrollPosition(edge: .bottom)
    var viewport = ConversationViewport()
    var frames: [Int: CGRect] = [:]
}

private struct NavigationScrollFixture: View {
    @ObservedObject var driver: NavigationScrollDriver
    let messages: [TimelineMessage]
    @StateObject private var model = AssistantModel(runtime: RuntimeSupervisor())

    var body: some View {
        ConversationScrollView(position: $driver.position, messages: messages, lastSequence: messages.last?.sequence,
                               ready: true, sending: false, navigationHeight: 560, savePosition: { driver.viewport = $0 }) {
            LazyVStack(alignment: .leading, spacing: 32) {
                ForEach(messages.map(\.sequence), id: \.self) { sequence in
                    VStack(spacing: 20) {
                        if let message = messages.first(where: { $0.sequence == sequence }) {
                            if sequence % 4 == 1 { Text("话题 \(sequence)").font(.caption) }
                            MessageView(message: message, model: model, maximumWidth: 507, showDetails: {})
                        }
                    }.conversationMessageTarget(sequence)
                        .onGeometryChange(for: CGRect.self) { geometry in
                            geometry.frame(in: .named("navigation-test-viewport"))
                        } action: { frame in driver.frames[sequence] = frame }
                }
            }.scrollTargetLayout().frame(maxWidth: 724, alignment: .leading)
                .padding(.horizontal, 32).padding(.vertical, 24).frame(maxWidth: .infinity)
        }.frame(width: 900, height: 600).coordinateSpace(name: "navigation-test-viewport")
    }
}
