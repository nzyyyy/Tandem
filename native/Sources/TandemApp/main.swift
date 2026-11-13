import SwiftUI
import AppKit
import TandemCore

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate {
    let runtime = RuntimeSupervisor()
    private var mainWindow: NSWindow?

    func applicationDidFinishLaunching(_ notification: Notification) {
        let resources = Bundle.main.resourceURL!
        let node = resources.appendingPathComponent("node")
        let entry = resources.appendingPathComponent("runtime/main.js")
        let testDirectory = CommandLine.arguments.contains("--lifecycle-test")
            ? ProcessInfo.processInfo.environment["TANDEM_TEST_DATA_DIR"].map { URL(fileURLWithPath: $0) } : nil
        runtime.start(node: node, entry: entry, dataDirectory: testDirectory)
        NSApp.setActivationPolicy(.regular)
        NSApp.activate(ignoringOtherApps: true)
        if CommandLine.arguments.contains("--lifecycle-test") {
            Task { await verifyWindowLifecycle() }
        }
    }

    func applicationDidBecomeActive(_ notification: Notification) {
        if mainWindow == nil { mainWindow = NSApp.windows.first { $0.title == "Tandem" } }
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { false }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        if !flag { (mainWindow ?? sender.windows.first { $0.title == "Tandem" })?.makeKeyAndOrderFront(nil) }
        return true
    }

    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        fputs("[host] application_terminate_requested\n", stderr)
        Task {
            await runtime.stop()
            sender.reply(toApplicationShouldTerminate: true)
        }
        return .terminateLater
    }

    private func verifyWindowLifecycle() async {
        do {
            for _ in 0..<100 {
                if runtime.pongCount > 0, NSApp.windows.contains(where: { $0.title == "Tandem" && $0.isVisible }) { break }
                try await Task.sleep(for: .milliseconds(100))
            }
            guard runtime.pongCount > 0,
                  let window = NSApp.windows.first(where: { $0.title == "Tandem" && $0.isVisible }) else { throw IPCError.response }
            mainWindow = window
            fputs("[lifecycle] window_ready\n", stderr)
            let pid = runtime.nodePID
            let count = runtime.pongCount
            window.performClose(nil)
            fputs("[lifecycle] window_closed\n", stderr)
            try await Task.sleep(for: .seconds(2))
            guard !window.isVisible, runtime.nodePID == pid, runtime.pongCount > count else { throw IPCError.response }
            _ = applicationShouldHandleReopen(NSApp, hasVisibleWindows: false)
            fputs("[lifecycle] window_reopened\n", stderr)
            guard window.isVisible else { throw IPCError.response }
            print("PASS App lifecycle: close last window, continue Ping/Pong, reopen, terminate")
            // Enter termination from the AppKit run loop, outside a task/main-queue job.
            Timer.scheduledTimer(withTimeInterval: 0.05, repeats: false) { _ in NSApp.terminate(nil) }
        } catch {
            await runtime.stop()
            fputs("FAIL App lifecycle\n", stderr)
            exit(1)
        }
    }
}

struct DiagnosticsView: View {
    @ObservedObject var runtime: RuntimeSupervisor
    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text("Tandem").font(.largeTitle.bold())
            Text("本地运行环境").foregroundStyle(.secondary)
            Divider()
            Label(runtime.status, systemImage: "network")
            LabeledContent("Node PID", value: String(runtime.nodePID))
            LabeledContent("Ping/Pong", value: String(runtime.pongCount))
            LabeledContent("IPC 连接次数", value: String(runtime.connectionCount))
            LabeledContent("异常重启次数", value: String(runtime.restartCount))
            HStack {
                Button("断开并重连") { runtime.reconnect() }
                Button("模拟 Runtime 崩溃") { runtime.injectCrash() }
            }
            Text("关闭窗口后继续运行；使用 ⌘Q 完整退出。").font(.callout).foregroundStyle(.secondary)
            ScrollView {
                Text(runtime.logs.joined(separator: "\n"))
                    .font(.system(.caption, design: .monospaced))
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .textSelection(.enabled)
            }
            .padding(12)
            .background(.quaternary.opacity(0.4), in: RoundedRectangle(cornerRadius: 8))
        }
        .padding(24)
        .frame(minWidth: 580, minHeight: 480)
    }
}

struct TandemApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) var delegate
    var body: some Scene {
        WindowGroup("Tandem", id: "main") { AssistantView(runtime: delegate.runtime) }
    }
}

@MainActor
func smokeTest() async {
    let arguments = CommandLine.arguments
    guard arguments.count == 5 else { exit(2) }
    let runtime = RuntimeSupervisor()
    let dataDirectory = FileManager.default.temporaryDirectory.appendingPathComponent("tandem-smoke-\(UUID().uuidString)")
    func waitFor(_ condition: () -> Bool) async throws {
        for _ in 0..<200 {
            if condition() { return }
            try await Task.sleep(for: .milliseconds(100))
        }
        throw NSError(domain: "SmokeTimeout", code: 1)
    }
    do {
        runtime.start(node: URL(fileURLWithPath: arguments[2]), entry: URL(fileURLWithPath: arguments[3]), dataDirectory: dataDirectory)
        try await waitFor { runtime.pongCount >= 1 }
        let document = try await runtime.request("config.get")
        guard document["revision"] as? String == "missing" else { throw IPCError.response }
        let configuration: [String: Any] = ["schemaVersion": 1, "modelConnections": [
            ["id": "smoke", "protocol": "openai", "apiType": "responses", "url": arguments[4], "key": "smoke-private-key", "modelNames": ["smoke-model", "another-model"]],
            ["id": "chat", "protocol": "openai", "apiType": "chat_completions", "url": arguments[4], "key": "smoke-private-key", "modelNames": ["smoke-model"]],
            ["id": "anthropic", "protocol": "anthropic", "apiType": "messages", "url": arguments[4], "key": "smoke-private-key", "modelNames": ["smoke-model"]]
        ], "defaultModel": ["connectionId": "smoke", "modelName": "smoke-model"]]
        _ = try await runtime.request("config.save", payload: ["config": configuration, "expectedRevision": "missing"])
        let state = try await runtime.request("state.get", payload: ["surfaceId": "smoke"])
        let snapshot = try JSONDecoder().decode(AssistantSnapshot.self, from: JSONSerialization.data(withJSONObject: state))
        guard snapshot.defaultModel?.modelName == "smoke-model" else { throw IPCError.response }
        let assistant = AssistantModel(runtime: runtime)
        let polling = Task { await assistant.poll(surfaceId: "smoke") }
        try await waitFor { assistant.snapshot != nil }
        for (index, connectionId) in ["smoke", "chat", "anthropic"].enumerated() {
            assistant.selectedModel = index == 0 ? "" : ModelSelection(connectionId: connectionId, modelName: "smoke-model").identifier
            assistant.draft = "你好 \(index)"
            await assistant.send()
            try await waitFor { assistant.messages.filter { $0.status == "completed" }.count == index + 1 }
            guard assistant.error == nil, assistant.messages.last?.content == "你好，M1" else { throw IPCError.response }
        }
        let firstPID = runtime.nodePID
        let connections = runtime.connectionCount
        runtime.reconnect()
        try await waitFor { runtime.connectionCount > connections && runtime.pongCount >= 2 }
        guard runtime.nodePID == firstPID else { throw IPCError.peer }
        assistant.draft = "crash-request"
        await assistant.send()
        try await waitFor { assistant.messages.last?.status == "running" && assistant.messages.last?.content == "partial" }
        runtime.injectCrash()
        try await waitFor { runtime.nodePID != 0 && runtime.nodePID != firstPID && runtime.connectionCount >= connections + 2 }
        let lastPID = runtime.nodePID
        let restored = try await runtime.request("config.get")
        guard (restored["config"] as? [String: Any])?["defaultModel"] != nil else { throw IPCError.response }
        let restoredState = try await runtime.request("state.get", payload: ["surfaceId": "smoke"])
        let recovered = try JSONDecoder().decode(AssistantSnapshot.self, from: JSONSerialization.data(withJSONObject: restoredState))
        guard recovered.messages.count == 8, recovered.messages.last?.status == "interrupted",
              recovered.messages.last?.content == "partial" else { throw IPCError.response }
        polling.cancel()
        await runtime.stop()
        try await Task.sleep(for: .seconds(2))
        guard runtime.nodePID == 0, kill(lastPID, 0) == -1, errno == ESRCH else { throw IPCError.peer }
        try? FileManager.default.removeItem(at: dataDirectory)
        print("PASS Swift → Node: three-API AssistantModel chat, config/history persistence, reconnect, crash restart, quit cleanup")
        exit(0)
    } catch {
        await runtime.stop()
        try? FileManager.default.removeItem(at: dataDirectory)
        fputs("FAIL supervisor smoke test\n", stderr)
        exit(1)
    }
}

if CommandLine.arguments.contains("--smoke-test") {
    Task { await smokeTest() }
    dispatchMain()
} else {
    TandemApp.main()
}
