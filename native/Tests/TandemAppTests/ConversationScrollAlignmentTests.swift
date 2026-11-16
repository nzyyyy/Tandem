import XCTest
import SwiftUI
@testable import TandemApp

final class ConversationScrollAlignmentTests: XCTestCase {
    private let geometry = ScrollGeometry(contentOffset: CGPoint(x: 0, y: 400),
                                          contentSize: CGSize(width: 900, height: 2000),
                                          contentInsets: EdgeInsets(),
                                          containerSize: CGSize(width: 900, height: 600))

    func testMeasuredPositionCorrectsLazyLayoutAndClampsAtTheEnd() {
        var alignment = ConversationScrollAlignment()
        alignment.request(3)
        XCTAssertEqual(alignment.correction(frame: CGRect(x: 0, y: 120, width: 700, height: 100), geometry: geometry), 520)
        var atTarget = geometry
        atTarget.contentOffset.y = 520
        XCTAssertNil(alignment.correction(frame: CGRect(x: 0, y: 0, width: 700, height: 100), geometry: atTarget))
        XCTAssertTrue(alignment.isAligned)

        alignment.request(35)
        XCTAssertEqual(alignment.correction(frame: CGRect(x: 0, y: 1200, width: 700, height: 100), geometry: geometry), 1400)
        atTarget.contentOffset.y = 1400
        XCTAssertNil(alignment.correction(frame: CGRect(x: 0, y: 200, width: 700, height: 100), geometry: atTarget))
        XCTAssertTrue(alignment.isAligned, "A final question that cannot reach the top must still be visible")
    }

    func testCorrectionBudgetAndCancellationPreventScrollLoops() {
        var alignment = ConversationScrollAlignment()
        alignment.request(3)
        let frame = CGRect(x: 0, y: 120, width: 700, height: 100)
        for _ in 0..<8 { XCTAssertEqual(alignment.correction(frame: frame, geometry: geometry), 520) }
        XCTAssertNil(alignment.correction(frame: frame, geometry: geometry))
        alignment.request(5)
        XCTAssertEqual(alignment.sequence, 5)
        XCTAssertEqual(alignment.correction(frame: frame, geometry: geometry), 520, "A new click gets a fresh correction budget")
        alignment.cancel()
        XCTAssertNil(alignment.sequence)
        XCTAssertNil(alignment.correction(frame: frame, geometry: geometry))
    }

    func testUnmeasuredTargetSeeksBetweenMeasuredNeighborsBeforeAligning() {
        var alignment = ConversationScrollAlignment()
        alignment.request(3)
        let frames = [1: CGRect(x: 0, y: -400, width: 700, height: 100),
                      5: CGRect(x: 0, y: 600, width: 700, height: 100)]
        XCTAssertEqual(alignment.correction(frames: frames, sequences: [1, 2, 3, 4, 5], geometry: geometry), 500)
        XCTAssertFalse(alignment.isAligned, "An estimate must not be persisted as a completed jump")
        var measured = geometry
        measured.contentOffset.y = 500
        XCTAssertEqual(alignment.correction(frames: [3: CGRect(x: 0, y: 60, width: 700, height: 100)],
                                            sequences: [1, 2, 3, 4, 5], geometry: measured), 560)
    }
}
