import XCTest
import Foundation
@testable import TandemCore

final class DirectoryAccessTests: XCTestCase {
    func testReadOnlyUTF8ScopeVersionAndRevocation() throws {
        let root = URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let file = root.appendingPathComponent("notes.md")
        let data = Data("\u{FEFF}第一行\r\n第二行\n第三行".utf8)
        try data.write(to: file)
        try FileManager.default.createSymbolicLink(atPath: root.appendingPathComponent("escape").path, withDestinationPath: "/etc")
        try FileManager.default.createSymbolicLink(atPath: root.appendingPathComponent("alias.md").path, withDestinationPath: file.path)
        let access = DirectoryAccess(), id = try access.authorize(root, projectId: "project")
        func read(_ path: String, project: String = "project") -> [String: Any] {
            access.execute(["method":"read_file", "grantId":id, "path":path, "projectId":project, "startLine":2, "endLine":3])
        }
        let result = read("notes.md")
        XCTAssertEqual(result["content"] as? String, "第二行\n第三行")
        XCTAssertEqual(result["startLine"] as? Int, 2)
        XCTAssertEqual(result["endLine"] as? Int, 3)
        XCTAssertEqual((result["version"] as? String)?.count, 64)
        XCTAssertEqual(result["version"] as? String, read("notes.md")["version"] as? String)
        for path in ["../notes.md", "/etc/passwd", "escape/passwd", "alias.md", "a/../notes.md", "a//notes.md"] {
            XCTAssertNotNil(read(path)["error"], path)
        }
        XCTAssertEqual(read("notes.md", project:"other")["error"] as? String, "DIRECTORY_UNAUTHORIZED")
        XCTAssertEqual(read(".")["error"] as? String, "NOT_REGULAR_FILE")
        XCTAssertEqual(try Data(contentsOf: file), data)
        access.revoke(id)
        XCTAssertEqual(read("notes.md")["error"] as? String, "DIRECTORY_UNAUTHORIZED")
    }
    func testUnsupportedEncodingBinaryBoundsAndDirectoryReplacement() throws {
        let root = URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent(UUID().uuidString)
        let moved = root.appendingPathExtension("moved")
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root); try? FileManager.default.removeItem(at: moved) }
        let access = DirectoryAccess(), id = try access.authorize(root, projectId: nil)
        func read(_ path: String) -> [String: Any] {
            access.execute(["method":"read_file", "grantId":id, "path":path, "startLine":1, "endLine":400])
        }
        for (name, data, error) in [("invalid.txt",Data([0xff,0xfe]),"INVALID_UTF8"), ("binary.txt",Data([65,0,66]),"BINARY_CONTENT"), ("fake.pdf",Data("plain text".utf8),"UNSUPPORTED_FORMAT"), ("huge.txt",Data(repeating:65,count:1_048_577),"FILE_TOO_LARGE")] {
            try data.write(to:root.appendingPathComponent(name))
            XCTAssertEqual(read(name)["error"] as? String, error)
        }
        let large = root.appendingPathComponent("large.txt")
        try String(repeating:"汉",count:20000).write(to:large,atomically:true,encoding:.utf8)
        let result = read("large.txt")
        XCTAssertEqual(result["truncated"] as? Bool,true)
        XCTAssertEqual(result["partialLine"] as? Bool,true)
        let output = try XCTUnwrap(result["content"] as? String)
        XCTAssertLessThanOrEqual(output.utf8.count,32768)
        XCTAssertFalse(output.contains("�"))
        for i in 0..<101 { try Data().write(to:root.appendingPathComponent("item-\(i)")) }
        let listing = access.execute(["method":"list_directory", "grantId":id, "path":"."])
        XCTAssertEqual((listing["entries"] as? [String])?.count,100)
        XCTAssertEqual(listing["truncated"] as? Bool,true)
        try FileManager.default.moveItem(at:root,to:moved)
        try FileManager.default.createDirectory(at:root,withIntermediateDirectories:true)
        XCTAssertNotNil(read("large.txt")["error"])
    }
}
