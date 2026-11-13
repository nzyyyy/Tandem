import XCTest
import SwiftUI
@testable import TandemApp

final class ControlLayoutTests: XCTestCase {
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
}
