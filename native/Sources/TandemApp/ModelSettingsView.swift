import SwiftUI
import TandemCore

struct ModelSettingsView: View {
    @ObservedObject var model: AssistantModel
    @Binding var hasUnsavedChanges: Bool
    @Binding var busy: Bool
    @State private var loading = false
    private var isWorking: Bool { busy || loading }
    @State private var configuration = AppConfiguration()
    @State private var savedConfiguration = AppConfiguration()
    @State private var revision: String?
    @State private var notice: String?
    @State private var selected = ""
    @State private var confirmReload = false
    @State private var modelDrafts: [String: String] = [:]

    private var hasModelDrafts: Bool { modelDrafts.values.contains { !$0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty } }
    private var dirty: Bool { configuration != savedConfiguration || hasModelDrafts }
    private func providerName(_ id: String) -> String { configuration.modelConnections.first { $0.id == id }?.displayName ?? "已移除供应商" }

    var body: some View {
        VStack(spacing: 0) {
            PageHeader(title: "模型设置") {
                if isWorking { ProgressView().controlSize(.small) }
                if dirty { Text("未保存修改").font(.caption).foregroundStyle(TandemStyle.secondary) }
                Button("重新加载") {
                    if dirty { confirmReload = true } else { Task { await load() } }
                }.disabled(isWorking)
                Button("保存配置") { Task { await save() } }
                    .buttonStyle(TandemButtonStyle(.primary)).disabled(isWorking || revision == nil || hasModelDrafts)
            }
            ScrollView {
                VStack(alignment: .leading, spacing: 32) {
                    defaultModel
                    HStack {
                        Text("模型供应商").font(.system(size: 15, weight: .semibold))
                        Spacer()
                        Button {
                            let connection = ModelConnection.new()
                            configuration.modelConnections.append(connection); selected = connection.id
                        } label: { Label("添加供应商", systemImage: "plus") }.disabled(revision == nil || isWorking)
                    }
                    if configuration.modelConnections.isEmpty {
                        Label("还没有供应商", systemImage: "network").font(.headline)
                            .padding(24).frame(maxWidth: .infinity, alignment: .leading)
                            .background(TandemStyle.surface, in: RoundedRectangle(cornerRadius: 12))
                    } else {
                        ViewThatFits(in: .horizontal) {
                            HStack(alignment: .top, spacing: 28) {
                                connectionList.frame(width: 196)
                                Divider()
                                connectionDetail.frame(minWidth: 400, maxWidth: .infinity)
                            }.frame(minWidth: 653)
                            VStack(alignment: .leading, spacing: 24) {
                                TandemPicker(title: "模型供应商", value: providerName(selected), selection: $selected) {
                                    ForEach(configuration.modelConnections) { Text($0.displayName).tag($0.id) }
                                }
                                connectionDetail
                            }
                        }
                    }
                    if let notice {
                        Label(notice, systemImage: notice == "已保存。" ? "checkmark.circle" : "info.circle")
                            .font(.callout).textSelection(.enabled)
                            .padding(16).frame(maxWidth: .infinity, alignment: .leading)
                            .background(TandemStyle.surface, in: RoundedRectangle(cornerRadius: 10))
                    }
                    VStack(alignment: .leading, spacing: 8) {
                        Label("本机保存", systemImage: "internaldrive").font(.system(size: 13, weight: .medium))
                        Text("API Key 以明文保存在当前用户可读写的 config.json。正常退出后保留，不写入聊天数据库或日志。")
                            .font(.caption).foregroundStyle(TandemStyle.secondary)
                        Text("~/.tandem/config.json").font(.caption.monospaced()).foregroundStyle(TandemStyle.secondary).textSelection(.enabled)
                    }.padding(20).frame(maxWidth: .infinity, alignment: .leading)
                        .background(TandemStyle.surface, in: RoundedRectangle(cornerRadius: 12))
                    BackupSettingsView(model: model, busy: $busy, hasUnsavedChanges: dirty) {
                        await load()
                        await model.refresh()
                    }
                }.padding(32).frame(maxWidth: 1060, alignment: .leading).frame(maxWidth: .infinity)
            }
            .disabled(isWorking)
        }
        .textFieldStyle(TandemTextFieldStyle())
        .task { await load() }
        .onChange(of: model.snapshot?.generation) { old, new in
            if old != nil, new != old, !dirty, !busy { Task { await load() } }
        }
        .onChange(of: dirty, initial: true) { _, value in hasUnsavedChanges = value }
        .confirmationDialog("放弃修改并重新加载？", isPresented: $confirmReload) {
            Button("放弃修改并重新加载", role: .destructive) { Task { await load() } }
            Button("继续编辑", role: .cancel) { }
        } message: { Text("将从本机配置重新读取所有接入项。") }
    }

    private var defaultModel: some View {
        VStack(alignment: .leading, spacing: 12) {
            Label("全局默认模型", systemImage: "circle.hexagongrid").font(.system(size: 14, weight: .semibold))
            TandemPicker(title: "全局默认", value: configuration.defaultModel.map { "\($0.modelName) · \(providerName($0.connectionId))" } ?? "未设置", selection: $configuration.defaultModel) {
                Text("未设置").tag(Optional<ModelSelection>.none)
                ForEach(configuration.modelConnections) { connection in
                    ForEach(Array(connection.modelNames.enumerated()), id: \.offset) { _, name in
                        if !name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                            Text("\(name) · \(connection.displayName)").tag(Optional(ModelSelection(connectionId: connection.id, modelName: name)))
                        }
                    }
                }
            }.labelsHidden().frame(maxWidth: 420).disabled(revision == nil).accessibilityLabel("全局默认模型")
        }.padding(20).frame(maxWidth: .infinity, alignment: .leading)
            .background(TandemStyle.surface, in: RoundedRectangle(cornerRadius: 12))
            .help("手动选择优先；已有回答与排队中的请求保留原模型。")
    }

    private var connectionList: some View {
        VStack(spacing: 6) {
            ForEach(configuration.modelConnections) { connection in
                SelectionRow(title: connection.displayName, symbol: "network",
                             subtitle: connection.protocolName == "anthropic" ? "Anthropic 兼容" : "OpenAI 兼容",
                             selected: selected == connection.id) { selected = connection.id }
            }
        }
    }

    private var connectionDetail: some View {
        VStack(alignment: .leading, spacing: 24) {
            ForEach($configuration.modelConnections) { $connection in
                if connection.id == selected {
                    Text("供应商设置").font(.system(size: 17, weight: .semibold))
                    ConnectionEditor(connection: $connection, newModelName: Binding(
                        get: { modelDrafts[connection.id] ?? "" },
                        set: { modelDrafts[connection.id] = $0 }
                    ), removeModel: { name in
                        let id = connection.id
                        configuration.removeModel(name, from: id)
                    })
                    .id(connection.id)
                    Button("移除此供应商", role: .destructive) {
                        let id = connection.id
                        configuration.modelConnections.removeAll { $0.id == id }
                        modelDrafts.removeValue(forKey: id)
                        if configuration.defaultModel?.connectionId == id { configuration.defaultModel = nil }
                        selected = configuration.modelConnections.first?.id ?? ""
                    }
                    .disabled(isWorking || revision == nil)
                }
            }
        }.disabled(revision == nil)
    }

    private func errorMessage(_ error: Error) -> String {
        if case IPCError.remote(let code) = error { return userFacingError(code) }
        return "无法读取或保存本地配置，请检查运行状态后重试。"
    }
    private func load() async {
        loading = true
        defer { loading = false }
        do {
            let document = try await model.call("config.get", as: ConfigDocument.self)
            configuration = document.config; savedConfiguration = document.config; revision = document.revision; notice = nil; modelDrafts = [:]
            if !configuration.modelConnections.contains(where: { $0.id == selected }) { selected = configuration.modelConnections.first?.id ?? "" }
        } catch { notice = errorMessage(error) }
    }
    private func save() async {
        guard let revision else { return }
        busy = true
        defer { busy = false }
        do {
            let encoded = try JSONEncoder().encode(configuration)
            let config = try JSONSerialization.jsonObject(with: encoded)
            let document = try await model.call("config.save", payload: ["config": config, "expectedRevision": revision], as: ConfigDocument.self)
            configuration = document.config; savedConfiguration = document.config; self.revision = document.revision; notice = "已保存。"
            await model.refresh()
        } catch { notice = errorMessage(error) }
    }
}

private struct ConnectionEditor: View {
    @Binding var connection: ModelConnection
    @Binding var newModelName: String
    let removeModel: (String) -> Void
    var body: some View {
        EditorField(title: "供应商名称") {
            TextField("例如 OpenAI、我的模型服务", text: Binding(get: { connection.name ?? connection.displayName }, set: { connection.name = $0 }))
                .accessibilityLabel("供应商名称")
        }
        ViewThatFits(in: .horizontal) {
            HStack(alignment: .top, spacing: 20) { protocolPicker; apiType }.frame(minWidth: 440)
            VStack(alignment: .leading, spacing: 24) { protocolPicker; apiType }
        }
        EditorField(title: "API Base URL") {
            TextField("https://api.example.com/v1", text: $connection.url).textContentType(.URL).accessibilityLabel("API Base URL")
        }
        .help("将追加 /\(connection.apiType == "chat_completions" ? "chat/completions" : connection.apiType)。需要 /v1 的服务，请在 Base URL 中包含 /v1。")
        EditorField(title: "API Key") { SecureField("输入 API Key", text: $connection.key).accessibilityLabel("API Key") }
        EditorField(title: "模型（\(connection.modelNames.count)/20）") {
            VStack(alignment: .leading, spacing: 12) {
                if connection.modelNames.isEmpty {
                    Text("暂无模型").font(.callout).foregroundStyle(TandemStyle.secondary)
                } else {
                    VStack(spacing: 0) {
                        ForEach(connection.modelNames, id: \.self) { name in
                            HStack(spacing: 12) {
                                Text(name).font(.system(size: 14)).textSelection(.enabled)
                                Spacer(minLength: 12)
                                Button(role: .destructive) { removeModel(name) } label: { Image(systemName: "minus.circle") }
                                    .buttonStyle(TandemButtonStyle(.plain)).accessibilityLabel("移除模型 " + name).help("移除模型")
                            }.padding(12)
                            if name != connection.modelNames.last { Divider() }
                        }
                    }.background(TandemStyle.surface, in: RoundedRectangle(cornerRadius: 8))
                }
                HStack(spacing: 12) {
                    TextField("输入模型名，例如 model-a", text: $newModelName)
                        .accessibilityLabel("新模型名称").onSubmit(addModel)
                    Button(action: addModel) { Label("添加", systemImage: "plus") }
                        .disabled(connection.modelAdditionError(newModelName) != nil)
                }
                if !newModelName.isEmpty {
                    Text(connection.modelAdditionError(newModelName) ?? "模型尚未添加")
                        .font(.caption).foregroundStyle(TandemStyle.secondary)
                }
            }
        }
    }
    private func addModel() {
        if connection.addModel(newModelName) { newModelName = "" }
    }

    private var protocolPicker: some View {
        EditorField(title: "协议") {
            TandemPicker(title: "协议", value: connection.protocolName == "anthropic" ? "Anthropic 兼容" : "OpenAI 兼容", selection: $connection.protocolName) {
                Text("OpenAI 兼容").tag("openai")
                Text("Anthropic 兼容").tag("anthropic")
            }.labelsHidden().accessibilityLabel("协议")
            .onChange(of: connection.protocolName) { _, value in
                connection.apiType = value == "anthropic" ? "messages" : "chat_completions"
                if connection.url == "https://api.openai.com/v1" && value == "anthropic" { connection.url = "https://api.anthropic.com/v1" }
                else if connection.url == "https://api.anthropic.com/v1" && value == "openai" { connection.url = "https://api.openai.com/v1" }
            }
        }
    }
    private var apiType: some View {
        EditorField(title: "API 类型") {
            if connection.protocolName == "openai" {
                TandemPicker(title: "API 类型", value: connection.apiType == "responses" ? "Responses" : "Chat Completions", selection: $connection.apiType) {
                    Text("Chat Completions").tag("chat_completions")
                    Text("Responses").tag("responses")
                }.labelsHidden().accessibilityLabel("API 类型")
            } else { Text("Messages").font(.system(size: 14)).padding(.vertical, 4) }
        }
    }
}
