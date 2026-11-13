import Foundation
import Darwin
import CryptoKit

// Directory descriptors are held by Swift, never accepted from model output.
public final class DirectoryAccess: @unchecked Sendable {
    private struct Grant { let fd: Int32; let path: String; let project: String?; let resourceId: String }
    private var grants: [String: Grant] = [:]
    private let lock = NSLock()
    public init() {}
    deinit { for grant in grants.values { Darwin.close(grant.fd) } }

    public func authorize(_ url: URL, projectId: String?, renewing: String? = nil) throws -> String {
        let path = url.standardizedFileURL.path
        let fd = Darwin.open(path, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
        guard fd >= 0 else { throw IPCError.remote("DIRECTORY_UNAVAILABLE") }
        lock.lock(); defer { lock.unlock() }
        let id = renewing ?? UUID().uuidString
        var info = stat()
        guard fstat(fd, &info) == 0 else { Darwin.close(fd); throw IPCError.remote("DIRECTORY_UNAVAILABLE") }
        let canonical: String
        do { canonical = try self.path(fd) } catch { Darwin.close(fd); throw error }
        if let old = grants[id] { Darwin.close(old.fd) }
        grants[id] = Grant(fd: fd, path: canonical, project: projectId, resourceId: "\(info.st_dev):\(info.st_ino)")
        return id
    }
    public func registrations() -> [[String: Any]] {
        lock.lock(); defer { lock.unlock() }
        return grants.map { id, grant in
            ["id": id, "resourceId": grant.resourceId, "label": (grant.path as NSString).lastPathComponent, "projectId": grant.project as Any? ?? NSNull()]
        }
    }
    public func revoke(_ id: String) {
        lock.lock(); defer { lock.unlock() }
        if let grant = grants.removeValue(forKey: id) { Darwin.close(grant.fd) }
    }
    private func path(_ fd: Int32) throws -> String {
        var bytes = [CChar](repeating: 0, count: Int(MAXPATHLEN))
        guard fcntl(fd, F_GETPATH, &bytes) == 0 else { throw IPCError.remote("FILE_CHANGED") }
        return String(cString: bytes)
    }
    private func verify(_ fd: Int32, _ grant: Grant, relative: String) throws {
        let root = try path(grant.fd)
        let actual = try path(fd)
        guard root == grant.path, actual == root || actual.hasPrefix(root == "/" ? root : root + "/") else { throw IPCError.remote("DIRECTORY_SCOPE") }
        let expected = relative == "." ? root : (root == "/" ? "" : root) + "/" + relative
        guard actual == expected else { throw IPCError.remote("FILE_CHANGED") }
        var current = stat(), held = stat()
        guard lstat(grant.path, &current) == 0, fstat(grant.fd, &held) == 0,
              current.st_dev == held.st_dev, current.st_ino == held.st_ino else { throw IPCError.remote("DIRECTORY_UNAVAILABLE") }
    }
    public func execute(_ request: [String: Any]) -> [String: Any] {
        lock.lock(); defer { lock.unlock() }
        do {
            guard let id = request["grantId"] as? String, let grant = grants[id],
                  grant.project == request["projectId"] as? String else { throw IPCError.remote("DIRECTORY_UNAUTHORIZED") }
            guard let relative = request["path"] as? String, !relative.hasPrefix("/"), !relative.utf8.contains(0), relative.utf8.count <= 1024 else { throw IPCError.remote("DIRECTORY_SCOPE") }
            let parts = relative.split(separator: "/", omittingEmptySubsequences: false).map(String.init)
            guard relative == "." || (!parts.isEmpty && parts.allSatisfy { !$0.isEmpty && $0 != "." && $0 != ".." }) else { throw IPCError.remote("DIRECTORY_SCOPE") }
            var fd = dup(grant.fd)
            guard fd >= 0 else { throw IPCError.remote("FILE_UNAVAILABLE") }
            defer { Darwin.close(fd) }
            if relative != "." {
                for (index, part) in parts.enumerated() {
                    let next = openat(fd, part, O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC | (index < parts.count - 1 ? O_DIRECTORY : 0))
                    guard next >= 0 else { throw IPCError.remote(errno == ELOOP ? "DIRECTORY_SCOPE" : "FILE_UNAVAILABLE") }
                    Darwin.close(fd); fd = next
                }
            }
            try verify(fd, grant, relative: relative)
            var before = stat()
            guard fstat(fd, &before) == 0 else { throw IPCError.remote("FILE_UNAVAILABLE") }
            if request["method"] as? String == "list_directory" {
                guard before.st_mode & S_IFMT == S_IFDIR, let dir = fdopendir(dup(fd)) else { throw IPCError.remote("NOT_DIRECTORY") }
                defer { closedir(dir) }
                var entries: [String] = []
                var truncated = false
                while let entry = readdir(dir) {
                    let name = withUnsafePointer(to: &entry.pointee.d_name) { pointer in
                        pointer.withMemoryRebound(to: CChar.self, capacity: Int(MAXNAMLEN) + 1) { String(cString: $0) }
                    }
                    if name == "." || name == ".." { continue }
                    if entries.count == 100 { truncated = true; break }
                    entries.append(name)
                }
                try verify(fd, grant, relative: relative)
                var after = stat()
                guard fstat(fd, &after) == 0, before.st_mtimespec == after.st_mtimespec, before.st_ctimespec == after.st_ctimespec else { throw IPCError.remote("FILE_CHANGED") }
                return ["grantId": id, "path": relative, "entries": entries.sorted(), "truncated": truncated]
            }
            guard request["method"] as? String == "read_file", before.st_mode & S_IFMT == S_IFREG else { throw IPCError.remote("NOT_REGULAR_FILE") }
            guard before.st_size <= 1_048_576 else { throw IPCError.remote("FILE_TOO_LARGE") }
            let ext = (relative as NSString).pathExtension.lowercased()
            guard !["pdf", "doc", "docx", "rtf", "pages", "xlsx", "pptx", "png", "jpg", "jpeg", "zip"].contains(ext) else { throw IPCError.remote("UNSUPPORTED_FORMAT") }
            guard let first = request["startLine"] as? Int, let last = request["endLine"] as? Int,
                  first > 0, last >= first, last - first < 400 else { throw IPCError.remote("TOOL_ARGUMENTS") }
            var data = Data(), buffer = [UInt8](repeating: 0, count: 16384)
            let deadline = Date().addingTimeInterval(3)
            while true {
                guard Date() < deadline else { throw IPCError.remote("NATIVE_TIMEOUT") }
                let n = Darwin.read(fd, &buffer, buffer.count)
                if n < 0 && errno == EINTR { continue }
                guard n >= 0 else { throw IPCError.remote("FILE_UNAVAILABLE") }
                if n == 0 { break }
                data.append(contentsOf: buffer.prefix(n))
                guard data.count <= 1_048_576 else { throw IPCError.remote("FILE_TOO_LARGE") }
            }
            var after = stat()
            guard fstat(fd, &after) == 0, before.st_size == after.st_size,
                  before.st_mtimespec == after.st_mtimespec, before.st_ctimespec == after.st_ctimespec else { throw IPCError.remote("FILE_CHANGED") }
            try verify(fd, grant, relative: relative)
            guard var content = String(data: data, encoding: .utf8) else { throw IPCError.remote("INVALID_UTF8") }
            guard !content.unicodeScalars.contains(where: { $0.properties.generalCategory == .control && ![9, 10, 13].contains($0.value) }) else { throw IPCError.remote("BINARY_CONTENT") }
            if content.first == "\u{FEFF}" { content.removeFirst() }
            let lines = content.replacingOccurrences(of: "\r\n", with: "\n").replacingOccurrences(of: "\r", with: "\n").components(separatedBy: "\n")
            guard first <= lines.count else { throw IPCError.remote("LINE_RANGE") }
            let end = min(last, lines.count)
            var selected = "", actualEnd = first, clipped = false, partial = false
            for number in first...end {
                let line = lines[number - 1]
                let remaining = 32768 - selected.utf8.count
                let separatorBytes = number == first ? 0 : 1
                if remaining < separatorBytes { actualEnd = number - 1; clipped = true; break }
                if line.utf8.count + separatorBytes > remaining {
                    var fragment = String(line.prefix(remaining))
                    while fragment.utf8.count + separatorBytes > remaining { fragment.removeLast() }
                    selected += (number == first ? "" : "\n") + fragment
                    actualEnd = number; clipped = true; partial = true; break
                }
                selected += (number == first ? "" : "\n") + line; actualEnd = number
            }
            let version = SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
            return ["resourceId": id + ":" + relative, "grantId": id, "path": relative, "version": version,
                    "startLine": first, "endLine": actualEnd, "totalLines": lines.count, "content": selected,
                    "truncated": clipped || actualEnd < lines.count, "partialLine": partial]
        } catch IPCError.remote(let code) { return ["error": code] }
        catch { return ["error": "FILE_UNAVAILABLE"] }
    }
}

private func == (left: timespec, right: timespec) -> Bool { left.tv_sec == right.tv_sec && left.tv_nsec == right.tv_nsec }
