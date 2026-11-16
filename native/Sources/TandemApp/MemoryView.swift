import SwiftUI
import TandemCore

private struct MemoryRecord: Decodable, Identifiable {
    var id: String
    var kind: String
    var subject: String
    var predicate: String
    var content: String
    var project_id: String?
    var status: String
    var origin: String
    var confirmed_at: Double?
    var supersedes_id: String?
    var rationale: String
    var version: Int
}
private struct ForgetMarker: Decodable, Identifiable {
    var id: String
    var scope: String
    var key_hash: String
    var created_at: Double
}
private struct MemoryList: Decodable { var memories: [MemoryRecord]; var markers: [ForgetMarker] }
private struct MemoryEvidence: Decodable, Identifiable {
    var session_id: String
    var message_id: String
    var interaction_id: String
    var interaction_version: Int
    var current_version: Int
    var valid: Int
    var content: String
    var id: String { message_id }
}
private struct MemoryDetail: Decodable { var evidence: [MemoryEvidence] }

struct MemoryView: View {
    @ObservedObject var model: AssistantModel
    @Binding var working: Bool
    var openSource: (String) -> Void
    @State private var records: [MemoryRecord] = []
    @State private var markers: [ForgetMarker] = []
    @State private var query = ""
    @State private var selected: MemoryRecord?
    @State private var evidence: [MemoryEvidence] = []
    @State private var editedContent = ""
    @State private var error: String?
    @State private var sourceId = ""
    @State private var kind = "fact"
    @State private var subject = "用户"
    @State private var relation = ""
    @State private var content = ""
    @State private var confirmed = false
    @State private var showSave = false
    @State private var forgetTarget: MemoryRecord?

    var body: some View {
        VStack(spacing: 0) {
            PageHeader(title: "长期记忆") {
                Button("从用户消息保存") { showSave = true }
                Button("刷新") { Task { await reload() } }
            }
            ScrollView {
                VStack(alignment: .leading, spacing: 20) {
                    TextField("搜索记忆", text: $query).textFieldStyle(TandemTextFieldStyle())
                        .accessibilityLabel("搜索事实、决策及历史")
                        .onSubmit { Task { await reload() } }
                    if let error { Text(error).foregroundStyle(.red) }
                    let groups = Dictionary(grouping: records) { $0.project_id ?? "" }
                    ForEach(groups.keys.sorted(), id: \.self) { scope in
                        VStack(alignment: .leading, spacing: 0) {
                            Label(scope.isEmpty ? "全局" : model.projectTitle(scope), systemImage: scope.isEmpty ? "globe" : "folder")
                                .font(.system(size: 13, weight: .semibold)).foregroundStyle(TandemStyle.secondary)
                                .padding(.bottom, 8)
                            ForEach(groups[scope] ?? []) { record in
                                VStack(alignment: .leading, spacing: 8) {
                                    HStack {
                                        Text(record.kind == "decision" ? "决策" : "事实").font(.caption.weight(.semibold))
                                        Text(statusTitle(record.status)).font(.caption).foregroundStyle(TandemStyle.secondary)
                                            .help("暂停、候选及历史版本不会作为现行知识使用。")
                                        Spacer()
                                        Button("证据与修正") { Task { await select(record) } }
                                        Button("遗忘", role: .destructive) { forgetTarget = record }
                                    }
                                    Text("\(record.subject) · \(record.predicate)：\(record.content)").textSelection(.enabled)
                                    Text(record.confirmed_at == nil ? (record.origin == "user_statement" ? "用户陈述 · 未确认" : "用户消息 · 候选") : "已确认")
                                        .font(.caption).foregroundStyle(TandemStyle.secondary)
                                    if let old = record.supersedes_id { Text("替代版本：\(old)").font(.caption).textSelection(.enabled) }
                                }.padding(.vertical, 16)
                                    .overlay(alignment: .bottom) { Divider() }
                            }
                        }
                    }
                    if records.isEmpty { Text("暂无匹配记忆").foregroundStyle(TandemStyle.secondary) }
                    if !markers.isEmpty {
                        Divider()
                        Text("遗忘标记").font(.headline)
                        Text("标记只保留键摘要和原证据标识。允许重新记住后仍需重新提取及校验，不会恢复旧正文。")
                            .font(.caption).foregroundStyle(TandemStyle.secondary)
                        ForEach(markers) { marker in
                            HStack {
                                Text("\(model.projectTitle(marker.scope.isEmpty ? nil : marker.scope)) · \(marker.key_hash.prefix(12))").font(.caption)
                                Spacer()
                                Button("允许重新记住") { Task { await action("memory.allow", ["id": marker.id, "confirm": true]) } }
                            }
                        }
                    }
                }.padding(28).frame(maxWidth: 900, alignment: .leading).frame(maxWidth: .infinity)
            }
        }
        .disabled(working)
        .task(id: "\(model.snapshot?.cursor ?? 0):\(model.snapshot?.focus.version ?? 0)") { await reload() }
        .sheet(isPresented: $showSave) { saveForm }
        .sheet(item: $selected) { record in detail(record) }
        .confirmationDialog("遗忘这条记忆及其派生副本？", isPresented: Binding(get: { forgetTarget != nil }, set: { if !$0 { forgetTarget = nil } })) {
            Button("遗忘", role: .destructive) {
                if let record = forgetTarget { Task { await action("memory.forget", ["id": record.id, "expectedVersion": record.version]); forgetTarget = nil } }
            }
            Button("取消", role: .cancel) { forgetTarget = nil }
        } message: { Text("原聊天仍保留；同一原证据不会自动重新生成此记忆。已有备份及云端副本不随本地删除改变。") }
    }

    private var sources: [TimelineMessage] {
        model.messages.filter { $0.role == "user" && $0.interactionVersion != nil &&
            (model.snapshot?.focus.contextMode == "automatic" || ($0.projectId != nil && $0.projectId == model.snapshot?.focus.activeProjectId)) }
    }
    private var source: TimelineMessage? { sources.first { $0.id == sourceId } }
    private var saveForm: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text("从用户证据保存").font(.title2)
            Text("仅列出当前已加载的用户消息。先核对来源和项目；敏感信息不能在此保存。")
                .font(.caption).foregroundStyle(TandemStyle.secondary)
            Picker("原始消息", selection: $sourceId) {
                Text("请选择").tag("")
                ForEach(sources) { message in
                    Text("\(model.projectTitle(message.projectId)) · \(message.content.prefix(65))").tag(message.id)
                }
            }
            if let source { Text(source.content).textSelection(.enabled).lineLimit(6) }
            Picker("类型", selection: $kind) { Text("事实").tag("fact"); Text("决策").tag("decision") }
            TextField("主体，例如：用户、项目", text: $subject)
            TextField("属性，例如：数据库、主要开发语言", text: $relation)
            TextField("内容", text: $content, axis: .vertical).lineLimit(2...5)
            Toggle("我已核验证据并明确确认此内容（可替代同键现行版本）", isOn: $confirmed)
            if let error { Text(error).foregroundStyle(.red) }
            HStack {
                Button("取消") { showSave = false }
                Spacer()
                Button("保存") {
                    guard let source, let version = source.interactionVersion else { return }
                    Task {
                        if await action("memory.save", ["messageId": source.id, "expectedInteractionVersion": version, "kind": kind, "subject": subject, "predicate": relation, "content": content, "confirmed": confirmed]) {
                            content = ""; relation = ""; confirmed = false; showSave = false
                        }
                    }
                }.disabled(source == nil || subject.isEmpty || relation.isEmpty || content.isEmpty)
            }
        }.padding(28).frame(width: 620).disabled(working)
        .interactiveDismissDisabled(working)
    }

    private func detail(_ record: MemoryRecord) -> some View {
        VStack(alignment: .leading, spacing: 16) {
            Text("\(record.subject) · \(record.predicate)").font(.title2)
            Text("\(statusTitle(record.status)) · \(record.rationale)").font(.caption)
            ScrollView {
                VStack(alignment: .leading, spacing: 12) {
                    ForEach(evidence) { item in
                        Text(item.content).textSelection(.enabled)
                        Text("消息 \(item.message_id) · 原版本 \(item.interaction_version) / 当前 \(item.current_version) · \(item.valid == 1 ? "有效" : "归属已纠正，证据停用")")
                            .font(.caption).foregroundStyle(TandemStyle.secondary).textSelection(.enabled)
                        Button("打开来源话题") {
                            selected = nil; openSource(item.session_id)
                        }
                        Divider()
                    }
                }
            }.frame(maxHeight: 240)
            TextField("修正内容", text: $editedContent, axis: .vertical).lineLimit(2...5)
            Text("确认或修正会创建带原始证据的新版本，不迁移已失效的证据，也不更改任务。")
                .font(.caption).foregroundStyle(TandemStyle.secondary)
            if let error { Text(error).foregroundStyle(.red) }
            HStack {
                Button("关闭") { selected = nil }
                Spacer()
                Button(editedContent == record.content ? "确认此版本" : "确认修正") {
                    Task {
                        if await action(editedContent == record.content ? "memory.confirm" : "memory.update", ["id": record.id, "expectedVersion": record.version, "content": editedContent, "confirm": true]) { selected = nil }
                    }
                }.disabled(record.status == "superseded" || record.status == "suspended" || editedContent.isEmpty)
            }
        }.padding(28).frame(width: 650).disabled(working).interactiveDismissDisabled(working)
    }
    private func statusTitle(_ value: String) -> String {
        ["active": "现行", "candidate": "待确认 / 可能冲突", "superseded": "历史版本", "suspended": "证据停用，待核验"][value] ?? value
    }
    private func reload() async {
        do {
            let result = try await model.call("memory.list", payload: ["surfaceId": model.currentSurfaceId, "query": query], as: MemoryList.self)
            records = result.memories; markers = result.markers
        } catch { records = []; markers = []; show(error) }
    }
    private func select(_ record: MemoryRecord) async {
        do {
            let detail = try await model.call("memory.get", payload: ["surfaceId": model.currentSurfaceId, "id": record.id], as: MemoryDetail.self)
            evidence = detail.evidence; editedContent = record.content; selected = record; error = nil
        } catch { show(error) }
    }
    @discardableResult private func action(_ method: String, _ payload: [String: Any]) async -> Bool {
        working = true; defer { working = false }
        do {
            var payload = payload; payload["surfaceId"] = model.currentSurfaceId
            _ = try await model.runtime.request(method, payload: payload)
            error = nil; await model.refresh(); await reload(); return true
        } catch { show(error); return false }
    }
    private func show(_ failure: Error) {
        if case IPCError.remote(let code) = failure { error = userFacingError(code) }
        else { error = "无法读取或更新记忆，请重试。" }
    }
}
