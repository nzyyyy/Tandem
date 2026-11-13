import Foundation
import Darwin

public enum IPCError: Error { case system(Int32), frame, peer, response, remote(String) }

public enum Frame {
    public static let maximum = 4_194_304
    public static func encode(_ object: [String: Any]) throws -> Data {
        let body = try JSONSerialization.data(withJSONObject: object)
        guard !body.isEmpty, body.count <= maximum else { throw IPCError.frame }
        var length = UInt32(body.count).bigEndian
        var result = Data(bytes: &length, count: 4)
        result.append(body)
        return result
    }
}

// Used only by the supervisor's sequential I/O tasks.
final class IPCConnection: @unchecked Sendable {
    private var fd: Int32 = -1
    private let lock = NSLock()

    init(path: String, expectedPID: Int32) throws {
        fd = Darwin.socket(AF_UNIX, SOCK_STREAM, 0)
        guard fd >= 0 else { throw IPCError.system(errno) }
        do {
            var timeout = timeval(tv_sec: 2, tv_usec: 0)
            setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &timeout, socklen_t(MemoryLayout.size(ofValue: timeout)))
            setsockopt(fd, SOL_SOCKET, SO_SNDTIMEO, &timeout, socklen_t(MemoryLayout.size(ofValue: timeout)))
            var noSignal: Int32 = 1
            setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, &noSignal, socklen_t(MemoryLayout<Int32>.size))
            var address = sockaddr_un()
            address.sun_family = sa_family_t(AF_UNIX)
            let bytes = Array(path.utf8) + [0]
            guard bytes.count <= MemoryLayout.size(ofValue: address.sun_path) else { throw IPCError.frame }
            withUnsafeMutableBytes(of: &address.sun_path) { $0.copyBytes(from: bytes) }
            let result = withUnsafePointer(to: &address) {
                $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                    Darwin.connect(fd, $0, socklen_t(MemoryLayout<sockaddr_un>.size))
                }
            }
            guard result == 0 else { throw IPCError.system(errno) }
            var uid: uid_t = 0
            var gid: gid_t = 0
            var pid: pid_t = 0
            var size = socklen_t(MemoryLayout<pid_t>.size)
            guard getpeereid(fd, &uid, &gid) == 0, uid == getuid(),
                  getsockopt(fd, SOL_LOCAL, LOCAL_PEERPID, &pid, &size) == 0,
                  pid == expectedPID else { throw IPCError.peer }
        } catch {
            close()
            throw error
        }
    }

    deinit { close() }
    func close() { if fd >= 0 { Darwin.close(fd); fd = -1 } }

    private func readExactly(_ count: Int) throws -> Data {
        var data = Data(count: count)
        try data.withUnsafeMutableBytes { buffer in
            var offset = 0
            while offset < count {
                let n = Darwin.recv(fd, buffer.baseAddress!.advanced(by: offset), count - offset, 0)
                if n < 0 && errno == EINTR { continue }
                guard n > 0 else { throw IPCError.system(n == 0 ? ECONNRESET : errno) }
                offset += n
            }
        }
        return data
    }

    func request(_ method: String, payload: [String: Any] = [:]) throws -> [String: Any] {
        lock.lock()
        defer { lock.unlock() }
        let id = UUID().uuidString
        let frame = try Frame.encode([
            "protocolVersion": 1, "requestId": id, "method": method,
            "payload": payload, "idempotencyKey": NSNull(), "expectedVersion": NSNull()
        ])
        try frame.withUnsafeBytes { buffer in
            var offset = 0
            while offset < frame.count {
                let n = Darwin.send(fd, buffer.baseAddress!.advanced(by: offset), frame.count - offset, 0)
                if n < 0 && errno == EINTR { continue }
                guard n > 0 else { throw IPCError.system(errno) }
                offset += n
            }
        }
        let prefix = try readExactly(4)
        let length = prefix.reduce(0) { ($0 << 8) | Int($1) }
        guard length > 0, length <= Frame.maximum else { throw IPCError.frame }
        guard let response = try JSONSerialization.jsonObject(with: readExactly(length)) as? [String: Any],
              response["protocolVersion"] as? Int == 1,
              response["requestId"] as? String == id else { throw IPCError.response }
        if response["ok"] as? Bool == false {
            let error = response["error"] as? [String: Any]
            throw IPCError.remote(error?["code"] as? String ?? "REQUEST_FAILED")
        }
        guard response["ok"] as? Bool == true,
              let data = response["data"] as? [String: Any] else { throw IPCError.response }
        return data
    }
}
