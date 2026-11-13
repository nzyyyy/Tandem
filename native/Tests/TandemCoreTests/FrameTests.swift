import XCTest
import Darwin
@testable import TandemCore

final class FrameTests: XCTestCase {
    func testBigEndianUTF8Frame() throws {
        let frame = try Frame.encode(["text": "你好"])
        let size = frame.prefix(4).reduce(0) { ($0 << 8) | Int($1) }
        XCTAssertEqual(size, frame.count - 4)
        let json = try JSONSerialization.jsonObject(with: frame.dropFirst(4)) as? [String: String]
        XCTAssertEqual(json?["text"], "你好")
    }

    func testOversizedFrameRejected() {
        XCTAssertThrowsError(try Frame.encode(["text": String(repeating: "a", count: Frame.maximum)]))
    }

    func testRejectSocketFromUnexpectedPID() throws {
        var template = Array("/tmp/tandem-peer-XXXXXX".utf8CString)
        let dir = String(cString: try XCTUnwrap(mkdtemp(&template)))
        defer { try? FileManager.default.removeItem(atPath: dir) }
        let server = socket(AF_UNIX, SOCK_STREAM, 0)
        XCTAssertGreaterThanOrEqual(server, 0)
        defer { Darwin.close(server) }
        var address = sockaddr_un()
        address.sun_family = sa_family_t(AF_UNIX)
        let path = dir + "/s"
        withUnsafeMutableBytes(of: &address.sun_path) { $0.copyBytes(from: Array(path.utf8) + [0]) }
        let result = withUnsafePointer(to: &address) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                Darwin.bind(server, $0, socklen_t(MemoryLayout<sockaddr_un>.size))
            }
        }
        XCTAssertEqual(result, 0)
        XCTAssertEqual(listen(server, 1), 0)
        XCTAssertThrowsError(try IPCConnection(path: path, expectedPID: getpid() + 1)) {
            guard case IPCError.peer = $0 else { return XCTFail("Expected peer identity rejection") }
        }
    }
}
