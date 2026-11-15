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
        navigation = ConversationNavigation(messages: messages, visibleSequence: 4, maximumHeight: 400, jump: { _ in })
        XCTAssertEqual(navigation.activeMessageID, "q2")
        navigation = ConversationNavigation(messages: [], visibleSequence: nil, maximumHeight: 400, jump: { _ in })
        XCTAssertTrue(navigation.entries.isEmpty)
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
}
