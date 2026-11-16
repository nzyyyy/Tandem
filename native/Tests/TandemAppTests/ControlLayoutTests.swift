import XCTest
import SwiftUI
@testable import TandemApp

final class ControlLayoutTests: XCTestCase {
    func testComposerControlsShareCompactHeight() async throws {
        try await MainActor.run {
            let send = Button {} label: {
                Image(systemName: "arrow.up").font(.system(size: 14, weight: .semibold)).frame(width: 16, height: 16)
            }.buttonStyle(TandemButtonStyle(.send)).controlSize(.small).fixedSize()
            let menu = TandemMenuLabel { Text("默认 · model-a") }.controlSize(.small).fixedSize()
            let sendImage = try XCTUnwrap(ImageRenderer(content: send).cgImage)
            let menuImage = try XCTUnwrap(ImageRenderer(content: menu).cgImage)
            XCTAssertEqual(sendImage.width, 32)
            XCTAssertEqual(sendImage.height, 32)
            XCTAssertEqual(menuImage.height, sendImage.height)
        }
    }

    func testMenuTriggerKeepsItsIntrinsicWidth() async {
        await MainActor.run {
            let label = TandemMenuLabel { Label("新话题", systemImage: "square.and.pencil") }.fixedSize()
            let renderer = ImageRenderer(content: label)
            guard let image = renderer.cgImage else { return XCTFail("Menu label did not render") }
            XCTAssertGreaterThan(image.width, 70)
            XCTAssertLessThan(image.width, 180, "A toolbar menu must not stretch across the page")
            XCTAssertGreaterThanOrEqual(image.height, 30)
            XCTAssertLessThan(image.height, 50)
        }
    }

    func testPrimaryButtonKeepsCompactLayout() async {
        await MainActor.run {
            let button = Button("配置第一个模型") {}.buttonStyle(TandemButtonStyle(.primary)).fixedSize()
            let renderer = ImageRenderer(content: button)
            guard let image = renderer.cgImage else { return XCTFail("Primary button did not render") }
            XCTAssertGreaterThan(image.width, 90)
            XCTAssertLessThan(image.width, 220)
            XCTAssertGreaterThanOrEqual(image.height, 30)
            XCTAssertLessThan(image.height, 50)
        }
    }

    func testHeaderKeepsLongTopicWithinNarrowDetailColumn() async throws {
        try await MainActor.run {
            let header = PageHeader(title: "对话", subtitle: String(repeating: "很长的当前话题", count: 20)) {
                TandemMenuLabel { Label("新话题", systemImage: "square.and.pencil") }.fixedSize()
            }.frame(width: 554)
            let image = try XCTUnwrap(ImageRenderer(content: header).cgImage)
            XCTAssertEqual(image.width, 554)
            XCTAssertLessThanOrEqual(image.height, 84, "Topic text must truncate instead of pushing actions or adding header rows")
        }
    }
}
