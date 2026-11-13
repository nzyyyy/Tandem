import Foundation
import Combine

public struct ModelSelection: Codable, Equatable, Hashable {
    public var connectionId: String
    public var modelName: String
    public var identifier: String { connectionId + "\u{0}" + modelName }
    public init(connectionId: String, modelName: String) { self.connectionId = connectionId; self.modelName = modelName }
}

public struct ModelConnection: Codable, Equatable, Identifiable {
    public var id: String
    public var protocolName: String
    public var apiType: String
    public var url: String
    public var key: String
    public var modelNames: [String]
    enum CodingKeys: String, CodingKey { case id, protocolName = "protocol", apiType, url, key, modelNames }
    public static func new() -> ModelConnection {
        ModelConnection(id: UUID().uuidString, protocolName: "openai", apiType: "chat_completions", url: "https://api.openai.com/v1", key: "", modelNames: [""])
    }
}

public struct AppConfiguration: Codable, Equatable {
    public var schemaVersion = 1
    public var modelConnections: [ModelConnection] = []
    public var defaultModel: ModelSelection? = nil
    public init() {}
}

public struct ConfigDocument: Codable { public var config: AppConfiguration; public var revision: String }
public struct ModelOption: Codable, Equatable, Identifiable {
    public var connectionId: String
    public var modelName: String
    public var apiType: String
    public var id: String { connectionId + "\u{0}" + modelName }
}
public struct TopicSession: Codable, Equatable, Identifiable {
    public var id: String
    public var title: String
    public var temporary: Int
    public var updatedAt: Double
}
public struct FocusState: Codable, Equatable {
    public var activeSessionId: String?
    public var interruptedSessionId: String?
    public var version: Int
}
public struct TimelineMessage: Codable, Equatable, Identifiable {
    public var id: String
    public var sessionId: String
    public var sequence: Int
    public var role: String
    public var content: String
    public var status: String?
    public var runId: String?
    public var errorCode: String?
    public var modelName: String?
    public var connectionId: String?
    public var attempt: Int?
}
public struct AssistantSnapshot: Codable, Equatable {
    public var focus: FocusState
    public var models: [ModelOption]
    public var defaultModel: ModelSelection?
    public var configError: String?
    public var sessions: [TopicSession]
    public var messages: [TimelineMessage]
    public var changedMessages: [TimelineMessage]
    public var cursor: Int
    public var hasMore: Bool
}

public func userFacingError(_ code: String) -> String {
    let messages = [
        "MODEL_REQUIRED": "请先在设置中配置默认模型，或手动选择一个模型。",
        "MODEL_UNAVAILABLE": "所选模型已失效，请检查接入项和模型名。",
        "MODEL_KEY_REQUIRED": "请在设置中填写此接入项的 API Key。",
        "MODEL_BINDING_CHANGED": "原接入地址或协议已改变，请明确选择模型后重试。",
        "MODEL_AUTH": "认证失败，请检查 API Key。",
        "MODEL_RATE_LIMIT": "服务限流，请稍后手动重试。",
        "MODEL_TIMEOUT": "模型请求超时，已有输出已保留。",
        "MODEL_CONNECTION_OR_RESPONSE": "无法连接模型，或返回格式无效。请检查地址和 API 类型后重试。",
        "MODEL_STREAM_INTERRUPTED": "流式响应中断，已有输出已保留。",
        "MODEL_STREAM_FAILED": "模型返回流式错误，已有输出已保留。",
        "MODEL_INCOMPLETE": "模型未完整完成回答，已有输出已保留。",
        "MODEL_EMPTY_RESPONSE": "模型未返回文本。",
        "MODEL_OUTPUT_LIMIT": "回答超过当前长度限制，已有输出已保留。",
        "MODEL_REFUSED": "模型拒绝了此请求。",
        "TOOLS_UNAVAILABLE": "模型请求了工具；本阶段尚不支持工具执行，未执行任何操作。",
        "INTERRUPTED": "上次执行被应用退出或 Runtime 中断。可手动重试。",
        "CANCELLED": "已停止生成。",
        "CONFIG_CONFLICT": "配置文件已被修改。请重新加载后再保存。",
        "CONFIG_INVALID_JSON": "config.json 格式无效，请修复文件后重新加载。",
        "CONFIG_VERSION": "配置文件版本不受支持，未覆盖原文件。",
        "CONFIG_PROTOCOL": "协议与 API 类型不匹配。",
        "CONFIG_URL": "请填写不含账号、查询参数或片段的 API Base URL。",
        "CONFIG_HTTPS_REQUIRED": "远程模型地址须使用 HTTPS；本机测试地址可使用 HTTP。",
        "CONFIG_MODELS": "请填写至少一个非空且不重复的模型名。",
        "CONFIG_DEFAULT_MODEL": "默认模型必须属于已配置的接入项。",
        "CONFIG_KEY": "API Key 格式无效。",
        "FOCUS_CONFLICT": "话题焦点已更新，请重试选择。",
        "CONTEXT_TOO_LARGE": "当前话题上下文过长，请新建话题后继续。",
        "RUNTIME_DISCONNECTED": "正在连接本地运行环境，请稍后重试。",
        "LOCAL_STORAGE_ERROR": "本地读写失败，请检查文件权限和可用磁盘空间。"
    ]
    return messages[code] ?? "操作未完成（\(code)）。请检查设置后重试。"
}

@MainActor
public final class AssistantModel: ObservableObject {
    @Published public var draft = ""
    @Published public var selectedModel = ""
    @Published public var newTopic = false
    @Published public var temporary = false
    @Published public private(set) var snapshot: AssistantSnapshot?
    @Published public private(set) var messages: [TimelineMessage] = []
    @Published public private(set) var error: String?
    @Published public private(set) var sending = false
    @Published public private(set) var hasMore = false
    private var surfaceId = ""
    private var cursor: Int?
    private var pendingSignature: String?
    private var pendingKey: String?
    private var retryKeys: [String: String] = [:]
    private var refreshing = false
    public let runtime: RuntimeSupervisor

    public init(runtime: RuntimeSupervisor) { self.runtime = runtime }

    public func call<T: Decodable>(_ method: String, payload: [String: Any] = [:], as type: T.Type) async throws -> T {
        let result = try await runtime.request(method, payload: payload)
        return try JSONDecoder().decode(type, from: JSONSerialization.data(withJSONObject: result))
    }

    private func show(_ error: Error) {
        if case IPCError.remote(let code) = error { self.error = userFacingError(code) }
        else { self.error = "本地连接暂时不可用，请稍后重试。" }
    }

    private func merge(_ incoming: [TimelineMessage]) {
        var combined = Dictionary(uniqueKeysWithValues: messages.map { ($0.id, $0) })
        for message in incoming { combined[message.id] = message }
        let updated = combined.values.sorted { $0.sequence < $1.sequence }
        if updated != messages { messages = updated }
    }

    public func poll(surfaceId: String) async {
        self.surfaceId = surfaceId
        while !Task.isCancelled {
            await refresh()
            do { try await Task.sleep(for: .milliseconds(400)) } catch { break }
        }
    }

    public func refresh() async {
        guard !surfaceId.isEmpty, !refreshing else { return }
        refreshing = true
        defer { refreshing = false }
        var payload: [String: Any] = ["surfaceId": surfaceId]
        if let cursor { payload["afterSequence"] = cursor }
        do {
            let state = try await call("state.get", payload: payload, as: AssistantSnapshot.self)
            if snapshot == nil { error = nil }
            if cursor == nil { hasMore = state.hasMore }
            merge(state.messages)
            merge(state.changedMessages)
            cursor = state.cursor
            if snapshot != state { snapshot = state }
        } catch {
            if case IPCError.remote("GAP_REQUIRED") = error { cursor = nil; messages = [] }
            else if snapshot == nil { show(error) }
        }
    }

    public func loadEarlier() async {
        guard let first = messages.first else { return }
        struct Page: Decodable { var messages: [TimelineMessage] }
        do {
            let page = try await call("timeline.list", payload: ["beforeSequence": first.sequence], as: Page.self)
            merge(page.messages)
            hasMore = page.messages.count == 10
        } catch { show(error) }
    }

    private func selectionPayload() -> Any {
        guard !selectedModel.isEmpty else { return NSNull() }
        let components = selectedModel.split(separator: "\u{0}", omittingEmptySubsequences: false)
        guard components.count == 2 else { return NSNull() }
        return ["connectionId": String(components[0]), "modelName": String(components[1])]
    }

    public func send() async {
        guard !sending, !draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return }
        sending = true
        defer { sending = false }
        let submitted = draft
        let signature = "\(submitted)\u{0}\(selectedModel)\u{0}\(newTopic)\u{0}\(temporary)"
        if pendingSignature != signature { pendingSignature = signature; pendingKey = UUID().uuidString }
        do {
            _ = try await runtime.request("message.send", payload: ["surfaceId": surfaceId, "text": submitted,
                "selection": selectionPayload(), "newTopic": newTopic, "temporary": temporary, "idempotencyKey": pendingKey!])
            if draft == submitted { draft = "" }
            pendingKey = nil; pendingSignature = nil
            newTopic = false; temporary = false; error = nil
            await refresh()
        } catch { show(error) }
    }

    public func focus(_ id: String) async {
        guard let version = snapshot?.focus.version else { return }
        do {
            _ = try await runtime.request("session.focus", payload: ["surfaceId": surfaceId, "sessionId": id, "expectedVersion": version])
            newTopic = false; temporary = false; error = nil
            await refresh()
        } catch { show(error) }
    }

    public func retry(_ runId: String) async {
        guard !sending else { return }
        sending = true
        defer { sending = false }
        let signature = runId + "\u{0}" + selectedModel
        let key = retryKeys[signature] ?? UUID().uuidString
        retryKeys[signature] = key
        do {
            _ = try await runtime.request("message.retry", payload: ["runId": runId, "idempotencyKey": key, "selection": selectionPayload()])
            error = nil
            await refresh()
        } catch { show(error) }
    }

    public func cancel(_ runId: String) async {
        do { _ = try await runtime.request("message.cancel", payload: ["runId": runId]); await refresh() }
        catch { show(error) }
    }
}
