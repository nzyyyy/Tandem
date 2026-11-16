import Foundation
import Combine
import Darwin
import AppKit

@MainActor
public final class RuntimeSupervisor: ObservableObject {
    @Published public private(set) var status = "未启动"
    @Published public private(set) var isConnected = false
    @Published public private(set) var logs: [String] = []
    @Published public private(set) var nodePID: Int32 = 0
    @Published public private(set) var pongCount = 0
    @Published public private(set) var connectionCount = 0
    @Published public private(set) var restartCount = 0
    private var process: Process?
    private var input: Pipe?
    private var worker: Task<Void, Never>?
    private var connection: IPCConnection?
    private var directory: String?
    private var stopping = false
    public let directories = DirectoryAccess()
    private var dataGeneration: String?

    private func updateGeneration(_ value: String?) {
        guard let value else { return }
        if let previous = dataGeneration, previous != value {
            for grant in directories.registrations() { directories.revoke(grant["id"] as! String) }
        }
        dataGeneration = value
    }

    public init() {}

    private func log(_ event: String) {
        let line = "\(ISO8601DateFormatter().string(from: Date())) [host] \(event)"
        logs.append(line)
        if logs.count > 100 { logs.removeFirst(logs.count - 100) }
        FileHandle.standardError.write(Data((line + "\n").utf8))
    }

    public func start(node: URL, entry: URL, dataDirectory: URL? = nil) {
        guard worker == nil else { return }
        stopping = false
        worker = Task { await supervise(node: node, entry: entry, dataDirectory: dataDirectory) }
    }

    private func supervise(node: URL, entry: URL, dataDirectory: URL?) async {
        var attempt = 0
        while !Task.isCancelled && !stopping {
            var healthyPings = 0
            do {
                status = "启动中"
                var template = Array("/tmp/tandem-\(getuid())-XXXXXX".utf8CString)
                guard let path = mkdtemp(&template) else { throw IPCError.system(errno) }
                let dir = String(cString: path)
                directory = dir
                let socketPath = dir + "/runtime.sock"
                let token = UUID().uuidString.replacingOccurrences(of: "-", with: "").lowercased()
                    + UUID().uuidString.replacingOccurrences(of: "-", with: "").lowercased()
                let child = Process()
                let pipe = Pipe()
                child.executableURL = node
                child.arguments = [entry.path]
                child.standardInput = pipe
                child.standardOutput = FileHandle.nullDevice
                child.standardError = FileHandle.standardError
                try child.run()
                process = child
                input = pipe
                nodePID = child.processIdentifier
                log("runtime_started pid=\(nodePID)")
                var bootstrapObject: [String: Any] = [
                    "socketPath": socketPath, "token": token, "hostPid": ProcessInfo.processInfo.processIdentifier
                ]
                if let dataDirectory { bootstrapObject["dataDirectory"] = dataDirectory.path }
                var bootstrap = try JSONSerialization.data(withJSONObject: bootstrapObject)
                bootstrap.append(10)
                try pipe.fileHandleForWriting.write(contentsOf: bootstrap)
                var failures = 0
                while !Task.isCancelled && !stopping && child.isRunning {
                    do {
                        if connection == nil {
                            let pid = child.processIdentifier
                            connection = try await Task.detached {
                                let client = try IPCConnection(path: socketPath, expectedPID: pid)
                                let hello = try client.request("hello", payload: ["token": token])
                                guard hello["pid"] as? Int32 == pid,
                                      hello["arch"] as? String == "arm64",
                                      hello["nodeVersion"] as? String == "v24.22.2" else { throw IPCError.peer }
                                return client
                            }.value
                            let client = connection!
                            let info = try await Task.detached { try client.request("runtime.info") }.value
                            updateGeneration(info["generation"] as? String)
                            let registrations = directories.registrations()
                            let access = directories
                            try await Task.detached {
                                for grant in registrations {
                                    do { _ = try client.request("directory.register", payload: grant) }
                                    catch IPCError.remote("PROJECT_UNAVAILABLE") { access.revoke(grant["id"] as! String) }
                                }
                            }.value
                            isConnected = true
                            connectionCount += 1
                            log("ipc_connected")
                        }
                        let client = connection!
                        try await Task.detached {
                            let data = try client.request("ping")
                            guard data["pong"] as? Bool == true else { throw IPCError.response }
                        }.value
                        let access = directories
                        let next = try await Task.detached { try client.request("native.next") }.value
                        updateGeneration(next["generation"] as? String)
                        try await Task.detached {
                            let work = next["requests"] as? [[String: Any]] ?? []
                            for request in work {
                                let result = access.execute(request)
                                _ = try client.request("native.result", payload: ["id": request["id"]!, "result": result])
                            }
                        }.value
                        pongCount += 1
                        healthyPings += 1
                        if healthyPings >= 5 { attempt = 0 }
                        failures = 0
                        status = "已连接 · Ping/Pong 正常"
                        try await Task.sleep(for: .seconds(1))
                    } catch {
                        connection = nil
                        isConnected = false
                        if Task.isCancelled || stopping { break }
                        failures += 1
                        status = "连接中断，正在重连"
                        log("ipc_reconnect attempt=\(failures)")
                        // A live but unresponsive child is replaced after bounded reconnects.
                        if failures >= 5 { child.terminate(); break }
                        try await Task.sleep(for: .milliseconds(250 * (1 << min(failures - 1, 3))))
                    }
                }
            } catch {
                log("runtime_start_or_transport_failed")
            }
            await reap()
            if Task.isCancelled || stopping { break }
            attempt += 1
            restartCount += 1
            let delay = min(30, 1 << min(attempt - 1, 5))
            status = "Runtime 已退出，\(delay) 秒后重启"
            log("runtime_restart delay=\(delay)s")
            do { try await Task.sleep(for: .seconds(delay)) } catch { break }
        }
        status = "已停止"
    }

    private func reap() async {
        log("runtime_stopping")
        isConnected = false
        connection = nil
        try? input?.fileHandleForWriting.close()
        input = nil
        if let child = process {
            if child.isRunning { child.terminate() }
            await Task.detached {
                for _ in 0..<20 {
                    if !child.isRunning { break }
                    try? await Task.sleep(for: .milliseconds(100))
                }
                if child.isRunning { kill(child.processIdentifier, SIGKILL) }
                child.waitUntilExit()
            }.value
        }
        process = nil
        nodePID = 0
        if let directory { try? FileManager.default.removeItem(atPath: directory) }
        directory = nil
    }

    public func stop() async {
        stopping = true
        isConnected = false
        worker?.cancel()
        // The worker owns all socket I/O and cleanup; cancellation stops dispatch first.
        await worker?.value
        worker = nil
        log("runtime_stopped")
    }

    public func chooseDirectory(projectId: String?, renewing: String? = nil) async throws -> String? {
        let panel = NSOpenPanel()
        panel.canChooseFiles = false; panel.canChooseDirectories = true
        panel.allowsMultipleSelection = false; panel.prompt = "授权只读"
        guard await panel.begin() == .OK, let url = panel.url else { return nil }
        let id = try directories.authorize(url, projectId: projectId, renewing: renewing)
        do {
            _ = try await request("directory.register", payload: directories.registrations().first { $0["id"] as? String == id }!)
        } catch { directories.revoke(id); throw error }
        return id
    }

    public func reconnect() { connection = nil; isConnected = false }
    public func injectCrash() { if let process, process.isRunning { kill(process.processIdentifier, SIGKILL) } }

    public func request(_ method: String, payload: [String: Any] = [:]) async throws -> [String: Any] {
        guard !stopping, let client = connection else { throw IPCError.remote("RUNTIME_DISCONNECTED") }
        let result = try await Task.detached { try client.request(method, payload: payload) }.value
        if method == "backup.restore" { updateGeneration(result["generation"] as? String) }
        return result
    }
}
