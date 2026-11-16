import XCTest
@testable import TandemApp

final class ConversationPositionTests: XCTestCase {
    @MainActor func testRelaunchRestoresTheActiveWindowAndItsReadingAnchor() throws {
        let suite = "tandem-reading-test-\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let running = ConversationPositionStore(defaults: defaults)
        let surface = running.claimSurface(preferred: "")
        let position = ConversationPosition(generation: "data-1", sequence: 42, atBottom: false, projectFilter: "project-a")
        running.activate(surface)
        running.save(position, for: surface)

        let relaunched = ConversationPositionStore(defaults: try XCTUnwrap(UserDefaults(suiteName: suite)))
        XCTAssertEqual(relaunched.claimSurface(preferred: ""), surface)
        XCTAssertEqual(relaunched.position(for: surface, generation: "data-1"), position)
    }

    @MainActor func testWindowsKeepIndependentPositionsAndRestoredSceneIdentity() throws {
        let suite = "tandem-reading-test-\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let running = ConversationPositionStore(defaults: defaults)
        let first = running.claimSurface(preferred: "")
        let second = running.claimSurface(preferred: "")
        XCTAssertNotEqual(first, second)
        let firstPosition = ConversationPosition(generation: "data", sequence: 4, atBottom: false, projectFilter: "*")
        let secondPosition = ConversationPosition(generation: "data", sequence: 80, atBottom: true, projectFilter: "")
        running.save(firstPosition, for: first)
        running.save(secondPosition, for: second)
        running.activate(second)

        let relaunched = ConversationPositionStore(defaults: defaults)
        XCTAssertEqual(relaunched.claimSurface(preferred: first), first)
        XCTAssertEqual(relaunched.claimSurface(preferred: second), second)
        XCTAssertEqual(relaunched.position(for: first, generation: "data"), firstPosition)
        XCTAssertEqual(relaunched.position(for: second, generation: "data"), secondPosition)
        XCTAssertNotEqual(relaunched.claimSurface(preferred: first), first)
        XCTAssertEqual(ConversationPositionStore(defaults: defaults).claimSurface(preferred: ""), second)
    }

    @MainActor func testDatabaseReplacementAndInvalidAnchorsDoNotRestoreStaleHistory() throws {
        let suite = "tandem-reading-test-\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let store = ConversationPositionStore(defaults: defaults)
        store.save(.init(generation: "old-data", sequence: 10, atBottom: false, projectFilter: "*"), for: "window")
        XCTAssertNil(store.position(for: "window", generation: "restored-data"))
        store.save(.init(generation: "restored-data", sequence: 20, atBottom: true, projectFilter: "*"), for: "window")
        XCTAssertEqual(store.position(for: "window", generation: "restored-data")?.sequence, 20)
        XCTAssertNil(store.position(for: "missing-window", generation: "restored-data"))
        store.save(.init(generation: "restored-data", sequence: 0, atBottom: false, projectFilter: "*"), for: "window")
        XCTAssertEqual(store.position(for: "window", generation: "restored-data")?.sequence, 20)
    }
}
