import XCTest
import SwiftUI
import AppKit
import TandemCore
@testable import TandemApp

final class ConversationLayoutTests: XCTestCase {
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
