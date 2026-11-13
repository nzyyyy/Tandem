import XCTest
@testable import TandemApp

final class EditorSelectionTests: XCTestCase {
    func testCleanEditorSwitchesImmediately() {
        var selection = EditorSelection(value: "projects")
        selection.select("settings", hasChanges: false)
        XCTAssertEqual(selection.value, "settings")
        XCTAssertNil(selection.pending)
    }

    func testDirtyEditorKeepsDraftUntilDiscardIsConfirmed() {
        var selection = EditorSelection(value: "first-project")
        selection.select("second-project", hasChanges: true)
        XCTAssertEqual(selection.value, "first-project")
        XCTAssertEqual(selection.pending, "second-project")
        selection.discard()
        XCTAssertEqual(selection.value, "second-project")
        XCTAssertNil(selection.pending)
    }

    func testCancelAndReselectCurrentEditorPreserveSelection() {
        var selection = EditorSelection(value: "settings")
        selection.select("projects", hasChanges: true)
        selection.pending = nil
        selection.select("settings", hasChanges: true)
        XCTAssertEqual(selection.value, "settings")
        XCTAssertNil(selection.pending)
        selection.discard()
        XCTAssertEqual(selection.value, "settings")
    }
}
