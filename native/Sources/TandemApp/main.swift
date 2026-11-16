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
            _ = try await runtime.request("message.send", payload: ["surfaceId": "lifecycle", "text": "lifecycle-background", "newTopic": true,
                "idempotencyKey": "lifecycle-background", "task": ["deliverable": "后台报告", "criteria": ["关窗后生成报告"]]])
            window.performClose(nil)
            fputs("[lifecycle] window_closed\n", stderr)
            try await Task.sleep(for: .seconds(2))
            guard !window.isVisible, runtime.nodePID == pid, runtime.pongCount > count else { throw IPCError.response }
            let activity = try await runtime.request("activity.get", payload: ["surfaceId": "lifecycle"])
            guard let tasks = activity["tasks"] as? [[String: Any]], tasks.first?["status"] as? String == "completed",
                  tasks.first?["result_ref"] as? String != nil else { throw IPCError.response }
            _ = applicationShouldHandleReopen(NSApp, hasVisibleWindows: false)
            fputs("[lifecycle] window_reopened\n", stderr)
            guard window.isVisible else { throw IPCError.response }
            _ = try await runtime.request("message.send", payload: ["surfaceId": "lifecycle", "text": "lifecycle-hold", "newTopic": true, "idempotencyKey": "lifecycle-hold"])
            try await Task.sleep(for: .milliseconds(150))
            print("PASS App lifecycle: close last window, complete background Task, reopen, interrupt in-flight request on quit")
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
    init() { TandemAppearance.apply(UserDefaults.standard.string(forKey: TandemAppearance.key) ?? "auto") }
    var body: some Scene {
        WindowGroup("Tandem", id: "main") { AssistantView(runtime: delegate.runtime) }
            .defaultSize(width: 1280, height: 820)
            .windowStyle(.hiddenTitleBar)
    }
}

@MainActor
func smokeTest() async {
    let arguments = CommandLine.arguments
    guard arguments.count == 5 else { exit(2) }
    let runtime = RuntimeSupervisor()
    let sandbox = FileManager.default.temporaryDirectory.appendingPathComponent("tandem-smoke-\(UUID().uuidString)")
    let dataDirectory = sandbox.appendingPathComponent("live")
    func waitFor(_ condition: () -> Bool) async throws {
        for _ in 0..<200 {
            if condition() { return }
            try await Task.sleep(for: .milliseconds(100))
        }
        throw NSError(domain: "SmokeTimeout", code: 1)
    }
    do {
        let assistant = AssistantModel(runtime: runtime)
        let polling = Task { await assistant.poll(surfaceId: "smoke") }
        defer { polling.cancel() }
        try await Task.sleep(for: .milliseconds(150))
        guard assistant.snapshot == nil, assistant.error == nil, !runtime.isConnected else { throw IPCError.response }
        var mainActorTicks = 0
        let responsiveness = Task { @MainActor in
            while !Task.isCancelled {
                mainActorTicks += 1
                do { try await Task.sleep(for: .milliseconds(25)) } catch { break }
            }
        }
        defer { responsiveness.cancel() }
        let startup = ContinuousClock.now
        runtime.start(node: URL(fileURLWithPath: arguments[2]), entry: URL(fileURLWithPath: arguments[3]), dataDirectory: dataDirectory)
        try await waitFor { assistant.snapshot != nil }
        let elapsed = startup.duration(to: .now)
        print("[smoke] cold-start snapshot ready after \(elapsed), main-actor ticks=\(mainActorTicks)")
        guard elapsed < .seconds(5), mainActorTicks >= 2, assistant.error == nil else { throw IPCError.response }
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
        await assistant.refresh()
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
        await assistant.setContext(mode: "isolated", projectId: "")
        assistant.draft = "M2 scoped question"
        await assistant.send()
        try await waitFor { assistant.snapshot?.pendingInteractions.count == 1 }
        guard let pending = assistant.snapshot?.pendingInteractions.first else { throw IPCError.response }
        let created = try await runtime.request("project.create", payload: ["title": "M2 project", "description": ""])
        guard let projectId = created["id"] as? String else { throw IPCError.response }
        await assistant.setContext(mode: "isolated", projectId: projectId)
        await assistant.confirm(pending, sessionId: nil)
        try await waitFor { assistant.messages.filter { $0.status == "completed" }.count == 4 }
        guard let scoped = assistant.messages.last, let snapshotId = scoped.snapshotId else { throw IPCError.response }
        let actual = try await assistant.context(snapshotId)
        guard actual.mode == "isolated", actual.projectId == projectId, actual.fragments.count == 1,
              actual.fragments.first?.content == "M2 scoped question" else { throw IPCError.response }
        let target = try await runtime.request("project.create", payload: ["title": "M2 target", "description": ""])
        guard let targetId = target["id"] as? String else { throw IPCError.response }
        await assistant.setContext(mode: "automatic", projectId: targetId)
        await assistant.correct(scoped, projectId: targetId)
        guard let oldRun = scoped.runId else { throw IPCError.response }
        await assistant.retry(oldRun)
        try await waitFor { assistant.messages.filter { $0.status == "completed" }.count == 5 }
        guard assistant.messages.last?.executionProjectId == targetId else { throw IPCError.response }
        let unchanged = try await assistant.context(snapshotId)
        guard unchanged.projectId == projectId, unchanged.fragments.first?.content == "M2 scoped question" else { throw IPCError.response }
        let resources = sandbox.appendingPathComponent("resources")
        try FileManager.default.createDirectory(at: resources, withIntermediateDirectories: true)
        let source = resources.appendingPathComponent("notes.md")
        try "原生读取资料\n第二行".write(to: source, atomically: true, encoding: .utf8)
        let grantId = try runtime.directories.authorize(resources, projectId: targetId)
        _ = try await runtime.request("directory.register", payload: runtime.directories.registrations().first { $0["id"] as? String == grantId }!)
        assistant.selectedModel = ModelSelection(connectionId: "chat", modelName: "smoke-model").identifier
        assistant.newTopic = true
        assistant.createTask = true; assistant.taskDeliverable = "M3 原生读取报告"; assistant.taskCriteria = "引用原生文件与版本"
        assistant.draft = "M3 native read"
        await assistant.send()
        try await waitFor { assistant.snapshot?.activity.tasks.contains { $0.status == "completed" } == true }
        guard let task = assistant.snapshot?.activity.tasks.first, let resultId = task.result_ref,
              try await assistant.result(resultId).contains("原生读取资料"),
              try String(contentsOf: source, encoding: .utf8) == "原生读取资料\n第二行" else { throw IPCError.response }
        guard let evidence = assistant.messages.first(where: { $0.role == "user" && $0.interactionId == scoped.interactionId }),
              let evidenceVersion = evidence.interactionVersion else { throw IPCError.response }
        let savedMemory = try await runtime.request("memory.save", payload: ["surfaceId": "smoke", "messageId": evidence.id,
            "expectedInteractionVersion": evidenceVersion, "kind": "decision", "subject": "项目", "predicate": "数据库", "content": "SQLite", "confirmed": true])
        guard let memoryId = savedMemory["id"] as? String else { throw IPCError.response }
        assistant.newTopic = true; assistant.draft = "M4 current decision"
        await assistant.send()
        try await waitFor { assistant.messages.last?.status == "completed" }
        guard let memorySnapshotId = assistant.messages.last?.snapshotId else { throw IPCError.response }
        let memoryContext = try await assistant.context(memorySnapshotId)
        guard memoryContext.fragments.contains(where: { $0.sourceType == "memory" && $0.sourceId == memoryId && $0.content.contains("SQLite") }) else { throw IPCError.response }
        let detail = try await runtime.request("memory.get", payload: ["surfaceId": "smoke", "id": memoryId])
        guard let version = detail["version"] as? Int,
              (detail["evidence"] as? [[String: Any]])?.first?["message_id"] as? String == evidence.id else { throw IPCError.response }
        let backup = sandbox.appendingPathComponent("backup.json")
        _ = try await runtime.request("backup.export", payload: ["path": backup.path])
        _ = try await runtime.request("memory.forget", payload: ["surfaceId": "smoke", "id": memoryId, "expectedVersion": version])
        let forgotten = try await runtime.request("memory.list", payload: ["surfaceId": "smoke"])
        guard (forgotten["memories"] as? [[String: Any]])?.isEmpty == true,
              (forgotten["markers"] as? [[String: Any]])?.count == 1 else { throw IPCError.response }
        let sanitized = try await assistant.context(memorySnapshotId)
        guard sanitized.fragments.contains(where: { $0.sourceId == memoryId && $0.deleted == true && !$0.content.contains("SQLite") }) else { throw IPCError.response }
        assistant.newTopic = true; assistant.draft = "Core after backup"
        await assistant.send()
        try await waitFor { assistant.messages.last?.status == "completed" }
        let otherWindow = AssistantModel(runtime: runtime)
        let otherPolling = Task { await otherWindow.poll(surfaceId: "smoke-other") }
        defer { otherPolling.cancel() }
        try await waitFor { otherWindow.messages.contains { $0.content == "Core after backup" } }
        let generation = assistant.snapshot?.generation
        let preview = try await runtime.request("backup.preview", payload: ["path": backup.path])
        guard let token = preview["token"] as? String else { throw IPCError.response }
        let restoration = try await runtime.request("backup.restore", payload: ["token": token, "confirm": true])
        try await waitFor {
            assistant.snapshot?.generation != generation && otherWindow.snapshot?.generation != generation
                && !assistant.messages.contains { $0.content == "Core after backup" }
                && !otherWindow.messages.contains { $0.content == "Core after backup" }
        }
        let restoredConfig = try await runtime.request("config.get")
        let restoredMemories = try await runtime.request("memory.list", payload: ["surfaceId": "smoke"])
        guard runtime.directories.registrations().isEmpty,
              ((restoredConfig["config"] as? [String: Any])?["modelConnections"] as? [[String: Any]])?.allSatisfy({ $0["key"] as? String == "" }) == true,
              (restoredMemories["memories"] as? [[String: Any]])?.isEmpty == true,
              (restoredMemories["markers"] as? [[String: Any]])?.count == 1,
              let protection = restoration["protectionPath"] as? String,
              FileManager.default.fileExists(atPath: protection + "/config.json"),
              try String(contentsOf: source, encoding: .utf8) == "原生读取资料\n第二行" else { throw IPCError.response }
        let reopenedWindow = AssistantModel(runtime: runtime)
        let reopenedPolling = Task { await reopenedWindow.poll(surfaceId: "smoke") }
        defer { reopenedPolling.cancel() }
        try await waitFor { reopenedWindow.snapshot != nil }
        guard reopenedWindow.messages.first?.sequence != 1 else { throw IPCError.response }
        await reopenedWindow.loadHistory(through: 1)
        guard reopenedWindow.messages.first?.sequence == 1, reopenedWindow.messages.count > 10 else { throw IPCError.response }
        reopenedPolling.cancel()
        polling.cancel()
        otherPolling.cancel()
        await runtime.stop()
        try await Task.sleep(for: .seconds(2))
        guard runtime.nodePID == 0, kill(lastPID, 0) == -1, errno == ESRCH else { throw IPCError.peer }
        try? FileManager.default.removeItem(at: sandbox)
        print("PASS Swift → Node: three-API chat, M2 routing/correction, M3 native Task, M4 memory, Core backup/restore/forget protection/two-window reload, reading-anchor history reload, persistence, reconnect, crash restart, quit cleanup")
        exit(0)
    } catch {
        await runtime.stop()
        try? FileManager.default.removeItem(at: sandbox)
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
