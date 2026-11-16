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
    public var name: String? = nil
    public var protocolName: String
    public var apiType: String
    public var url: String
    public var key: String
    public var modelNames: [String]
    enum CodingKeys: String, CodingKey { case id, name, protocolName = "protocol", apiType, url, key, modelNames }
    public var displayName: String {
        if let name { return name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? "未命名供应商" : name }
        return URL(string: url)?.host ?? "未命名供应商"
    }
    public func modelAdditionError(_ input: String) -> String? {
        let model = input.trimmingCharacters(in: .whitespacesAndNewlines)
        if model.isEmpty { return "请输入模型名。" }
        if model.utf16.count > 256 || model.unicodeScalars.contains(where: { $0.value < 32 || $0.value == 127 }) { return "模型名不能超过 256 个字符或包含控制字符。" }
        if modelNames.contains(model) { return "该模型已添加。" }
        if modelNames.count >= 20 { return "每个供应商最多添加 20 个模型。" }
        return nil
    }
    @discardableResult public mutating func addModel(_ input: String) -> Bool {
        guard modelAdditionError(input) == nil else { return false }
        modelNames.append(input.trimmingCharacters(in: .whitespacesAndNewlines))
        return true
    }
    public static func new() -> ModelConnection {
        ModelConnection(id: UUID().uuidString, name: "", protocolName: "openai", apiType: "chat_completions", url: "https://api.openai.com/v1", key: "", modelNames: [])
    }
}

public struct AppConfiguration: Codable, Equatable {
    public var schemaVersion = 1
    public var modelConnections: [ModelConnection] = []
    public var defaultModel: ModelSelection? = nil
    public init() {}
    public mutating func removeModel(_ modelName: String, from connectionId: String) {
        guard let index = modelConnections.firstIndex(where: { $0.id == connectionId }) else { return }
        modelConnections[index].modelNames.removeAll { $0 == modelName }
        if defaultModel == ModelSelection(connectionId: connectionId, modelName: modelName) { defaultModel = nil }
    }
}

public struct ConfigDocument: Codable { public var config: AppConfiguration; public var revision: String }
public struct ModelOption: Codable, Equatable, Identifiable {
    public var connectionId: String
    public var connectionName: String? = nil
    public var modelName: String
    public var apiType: String
    public var id: String { connectionId + "\u{0}" + modelName }
}
public struct TopicSession: Codable, Equatable, Identifiable {
    public var id: String
    public var title: String
    public var temporary: Int
    public var updatedAt: Double
    public var projectId: String?
}
public struct FocusState: Codable, Equatable {
    public var activeProjectId: String?
    public var contextMode: String
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
    public var routeReason: String?
    public var interactionId: String?
    public var interactionVersion: Int?
    public var projectId: String?
    public var executionInteractionVersion: Int?
    public var executionProjectId: String?
    public var snapshotId: String?
}
public struct AssistantSnapshot: Codable, Equatable {
    public var generation: String? = nil
    public var activity: ActivityState
    public var projects: [TandemProject]
    public var pendingInteractions: [PendingInteraction]
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

public struct TandemProject: Codable, Equatable, Identifiable {
    public var id: String
    public var title: String
    public var description: String
    public var status: String
    public var version: Int
}
public struct RouteCandidate: Codable, Equatable, Identifiable {
    public var sessionId: String
    public var projectId: String?
    public var title: String
    public var reason: String
    public var updatedAt: Double
    public var id: String { sessionId }
}
public struct RouteExplanation: Codable, Equatable {
    public var action: String
    public var reason: String
    public var candidates: [RouteCandidate]
}
public struct PendingInteraction: Codable, Equatable, Identifiable {
    public var id: String
    public var sequence: Int
    public var input: String
    public var version: Int
    public var route: RouteExplanation
}
public struct ContextFragment: Codable {
    public var sourceType: String
    public var sourceId: String
    public var sourceVersion: String
    public var projectId: String?
    public var role: String
    public var content: String
    public var deleted: Bool?
}
public struct RunContext: Codable {
    public var id: String
    public var mode: String
    public var projectId: String?
    public var fragments: [ContextFragment]
}
public struct DeletionItem: Codable { public var id: String }
public struct ProjectDeletion: Codable {
    public var token: String
    public var title: String
    public var interactions: [DeletionItem]
    public var messages: [DeletionItem]
    public var runs: [DeletionItem]
    public var tasks: [DeletionItem]
    public var memories: [DeletionItem]
    public var sharedSnapshots: [String]
    public var derivedMessages: [String]
}
public struct CorrectionRecord: Codable, Identifiable {
    public var id: String
    public var from_project: String?
    public var to_project: String?
    public var version: Int
    public var created_at: Double
}
public struct CorrectionHistory: Codable { public var corrections: [CorrectionRecord] }

public func userFacingError(_ code: String) -> String {
    let messages = [
        "BACKUP_BUSY": "正在恢复备份，请稍后再操作。",
        "BACKUP_SIZE": "备份超过大小限制或文件类型不受支持；当前最多 128 MiB 数据、4096 个文件。",
        "BACKUP_CHANGED": "备份源文件发生变化，请重新选择。",
        "BACKUP_DESTINATION": "请选择应用数据目录以外的新文件名，已有文件不会被覆盖。",
        "BACKUP_VERSION": "备份或数据版本不受支持，当前数据未被替换。",
        "BACKUP_FORMAT": "备份文件格式无效或内容不完整，当前数据未被替换。",
        "BACKUP_PATH": "备份包含不支持的路径、链接或文件结构，已拒绝。",
        "BACKUP_CHECKSUM": "备份内容与校验值不符，已拒绝恢复。",
        "BACKUP_DATABASE": "备份数据库未通过完整性或结构校验，已拒绝恢复。",
        "BACKUP_CREDENTIALS": "备份包含模型 Key，已拒绝恢复。请选择由 Tandem 导出的脱敏备份。",
        "RESTORE_PREVIEW_EXPIRED": "恢复预览已过期，请重新选择备份并核对。",
        "RESTORE_CONFIRM_REQUIRED": "请先核对备份预览，再明确确认替换并恢复。",
        "RESTORE_JOURNAL": "上次恢复尚未完成，保护副本已保留；请检查磁盘权限和恢复记录。",
        "TOOL_RESULT_UNKNOWN": "工具结果尚未核实，不能重复执行。请检查已有产物后手动重新处理。",
        "APPROVAL_RESTORED": "备份中的旧审批不可重用，请重新发起目录授权请求。",
        "PROJECT_LIMIT": "当前验证版本最多保留 200 个项目。请先整理已有项目。",
        "MEMORY_SENSITIVE": "记忆中可能包含敏感信息或凭据，未保存。",
        "MEMORY_FORGOTTEN": "此原始证据受遗忘标记保护。请先在长期记忆中明确允许重新记住。",
        "MEMORY_CONFLICT": "记忆已更新，请刷新后重试。",
        "MEMORY_EVIDENCE_CHANGED": "原始证据的归属或版本已变化，请重新核验来源。",
        "MEMORY_NOT_FOUND": "记忆已删除或不可用，请刷新。",
        "MEMORY_UNAVAILABLE": "执行使用的记忆已失效，请手动重新处理以获取当前上下文。",
        "MEMORY_CONFIRM_REQUIRED": "请明确确认此记忆操作。",
        "PROJECT_REQUIRED": "请先选择项目，再确认这条输入。",
        "PROJECT_UNAVAILABLE": "项目已归档或不可用，请恢复项目或重新选择。",
        "PROJECT_CONFLICT": "项目已被修改，请重新加载后重试。",
        "CONTEXT_SCOPE": "目标超出当前上下文范围，请明确切换项目或模式。",
        "INTERACTION_CONFLICT": "此交互已更新，请重新确认。",
        "INTERACTION_CHANGED": "交互归属已更正，请手动重新处理。",
        "DELETE_PREVIEW_CHANGED": "受影响内容已变化，请重新预览删除范围。",
        "DELETE_PREVIEW_EXPIRED": "删除预览已过期，请重新预览。",
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
        "TOOL_UNAVAILABLE": "模型请求的工具不在首版只读工具范围内。",
        "BUDGET_EXHAUSTED": "执行预算已用尽。请在 Activity 查看消耗并追加预算后继续。",
        "BUDGET_REQUIRED": "请明确追加预算后再继续。",
        "APPROVAL_EXPIRED": "审批已过期，请取消后重新处理以获取新审批。",
        "DIRECTORY_CHANGED": "所选目录与原授权不是同一资源，请选择原目录；目录已替换时请重新处理任务。",
        "DIRECTORY_UNAUTHORIZED": "目录授权已失效或撤销，请在 Activity 重新选择同一目录后继续。",
        "TASK_CONFLICT": "任务已有新修订，请重新加载。",
        "INTERRUPTED": "上次执行被应用退出或 Runtime 中断。可手动重试。",
        "CANCELLED": "已停止生成。",
        "CONFIG_CONFLICT": "配置文件已被修改。请重新加载后再保存。",
        "CONFIG_INVALID_JSON": "config.json 格式无效，请修复文件后重新加载。",
        "CONFIG_VERSION": "配置文件版本不受支持，未覆盖原文件。",
        "CONFIG_CONNECTION_NAME": "请填写不超过 120 个字符且不含控制字符的供应商名称。",
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
    @Published public var createTask = false
    @Published public var taskDeliverable = ""
    @Published public var taskCriteria = ""
    @Published public var selectedModel = ""
    @Published public var newTopic = false
    @Published public var temporary = false
    @Published public private(set) var snapshot: AssistantSnapshot?
    @Published public private(set) var messages: [TimelineMessage] = []
    @Published public private(set) var error: String?
    @Published public private(set) var sending = false
    @Published public private(set) var hasMore = false
    private var surfaceId = ""
    public var currentSurfaceId: String { surfaceId }
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
            if runtime.isConnected { await refresh() }
            do { try await Task.sleep(for: .milliseconds(snapshot == nil ? 100 : 400)) } catch { break }
        }
    }

    public func refresh() async {
        guard !surfaceId.isEmpty, !refreshing else { return }
        refreshing = true
        defer { refreshing = false }
        var payload: [String: Any] = ["surfaceId": surfaceId]
        if let generation = snapshot?.generation { payload["generation"] = generation }
        if let cursor { payload["afterSequence"] = cursor }
        do {
            let state = try await call("state.get", payload: payload, as: AssistantSnapshot.self)
            if snapshot?.generation != state.generation { messages = []; cursor = nil; error = nil }
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

    public func loadHistory(through sequence: Int) async {
        // shortcut: restore reads existing pages one at a time; batch reads if deep-history startup becomes slow.
        while !Task.isCancelled, hasMore, let first = messages.first, first.sequence > sequence {
            await loadEarlier()
            guard messages.first?.sequence != first.sequence else { return }
        }
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
        let signature = "\(submitted)\u{0}\(selectedModel)\u{0}\(newTopic)\u{0}\(temporary)\u{0}\(createTask)\u{0}\(taskDeliverable)\u{0}\(taskCriteria)"
        if pendingSignature != signature { pendingSignature = signature; pendingKey = UUID().uuidString }
        do {
            var payload: [String: Any] = ["surfaceId": surfaceId, "text": submitted,
                "selection": selectionPayload(), "newTopic": newTopic, "temporary": temporary, "idempotencyKey": pendingKey!]
            if createTask { payload["task"] = ["deliverable": taskDeliverable, "criteria": taskCriteria.components(separatedBy: .newlines).filter { !$0.trimmingCharacters(in: .whitespaces).isEmpty }] }
            _ = try await runtime.request("message.send", payload: payload)
            if draft == submitted { draft = "" }
            pendingKey = nil; pendingSignature = nil
            newTopic = false; temporary = false; createTask = false; taskDeliverable = ""; taskCriteria = ""; error = nil
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

    public func perform(_ method: String, _ payload: [String: Any]) async -> Bool {
        do {
            _ = try await runtime.request(method, payload: payload)
            error = nil
            await refresh()
            return true
        } catch { show(error); return false }
    }

    public func setContext(mode: String, projectId: String) async {
        guard let version = snapshot?.focus.version else { return }
        _ = await perform("context.set", ["surfaceId": surfaceId, "mode": mode,
            "projectId": projectId.isEmpty ? NSNull() : projectId as Any, "expectedVersion": version])
    }

    public func confirm(_ interaction: PendingInteraction, sessionId: String?) async {
        guard let version = snapshot?.focus.version else { return }
        _ = await perform("interaction.confirm", ["surfaceId": surfaceId, "interactionId": interaction.id,
            "expectedVersion": interaction.version, "expectedFocusVersion": version, "sessionId": sessionId as Any? ?? NSNull()])
    }

    public func correct(_ message: TimelineMessage, projectId: String) async {
        guard let id = message.interactionId, let version = message.interactionVersion else { return }
        _ = await perform("interaction.correct", ["surfaceId": surfaceId, "interactionId": id, "expectedVersion": version,
            "projectId": projectId.isEmpty ? NSNull() : projectId as Any])
    }

    public func context(_ id: String) async throws -> RunContext {
        try await call("snapshot.get", payload: ["id": id, "surfaceId": surfaceId], as: RunContext.self)
    }

    public func approve(_ approval: ApprovalCard, allow: Bool) async {
        do {
            var payload: [String: Any] = ["id": approval.id, "approve": allow]
            if allow {
                let project = snapshot?.activity.runs.first { $0.id == approval.run_id }?.project_id
                guard let grant = try await runtime.chooseDirectory(projectId: project) else { return }
                payload["grantId"] = grant
            }
            _ = await perform("approval.decide", payload)
        } catch { show(error) }
    }
    public func authorizeDirectory(_ grant: DirectoryGrant? = nil) async {
        do { _ = try await runtime.chooseDirectory(projectId: grant == nil ? snapshot?.focus.activeProjectId : grant?.project_id, renewing: grant?.id); await refresh() }
        catch { show(error) }
    }
    public func revokeDirectory(_ id: String) async {
        runtime.directories.revoke(id)
        _ = await perform("directory.revoke", ["id": id])
    }
    public func continueRun(_ run: ActivityRun, addBudget: Bool) async {
        _ = await perform("run.continue", ["runId": run.id, "expectedVersion": run.version,
            "idempotencyKey": "continue-\(run.id)-\(run.version)", "steps": addBudget ? 24 : 0,
            "tokens": addBudget ? 64000 : 0, "activeMs": addBudget ? 300000 : 0])
    }
    public func reviseTask(_ task: PersistentTask, request: String, deliverable: String, criteria: String, key: String) async -> Bool {
        await perform("message.send", ["surfaceId": surfaceId, "text": request, "sessionId": task.session_id,
            "selection": selectionPayload(), "idempotencyKey": key,
            "task": ["id": task.id, "expectedRevision": task.revision, "deliverable": deliverable,
                     "criteria": criteria.components(separatedBy: .newlines).filter { !$0.trimmingCharacters(in: .whitespaces).isEmpty }]])
    }
    public func result(_ messageId: String) async throws -> String {
        struct Result: Decodable { var content: String }
        return try await call("result.get", payload: ["surfaceId": surfaceId, "messageId": messageId], as: Result.self).content
    }

    public func connectionTitle(_ id: String?) -> String {
        snapshot?.models.first { $0.connectionId == id }?.connectionName ?? "历史供应商"
    }

    public func projectTitle(_ id: String?) -> String {
        guard let id else { return "未关联项目" }
        return snapshot?.projects.first { $0.id == id }?.title ?? "历史项目"
    }

    public func cancel(_ runId: String) async {
        do { _ = try await runtime.request("message.cancel", payload: ["runId": runId]); await refresh() }
        catch { show(error) }
    }
}
