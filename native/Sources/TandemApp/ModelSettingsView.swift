import SwiftUI
import TandemCore

struct ModelSettingsView: View {
    @ObservedObject var model: AssistantModel
    @State private var configuration = AppConfiguration()
    @State private var revision: String?
    @State private var notice: String?
    @State private var busy = false

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack {
                Text("模型设置").font(.title2.weight(.semibold))
                Spacer()
                Button("重新加载") { Task { await load() } }.disabled(busy)
                Button("保存") { Task { await save() } }.buttonStyle(.borderedProminent).disabled(busy || revision == nil)
            }
            .padding(20)
            Divider()
            Form {
                Section("默认模型") {
                    Picker("全局默认", selection: $configuration.defaultModel) {
                        Text("未设置").tag(Optional<ModelSelection>.none)
                        ForEach(configuration.modelConnections) { connection in
                            ForEach(Array(connection.modelNames.enumerated()), id: \.offset) { _, name in
                                if !name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                                    Text("\(name) · \(connection.id)").tag(Optional(ModelSelection(connectionId: connection.id, modelName: name)))
                                }
                            }
                        }
                    }
                    Text("默认模型用于新消息；手动选择优先。已有回答与排队中的请求保留原模型。").font(.callout).foregroundStyle(.secondary)
                }
                ForEach($configuration.modelConnections) { $connection in
                    Section {
                        ConnectionEditor(connection: $connection)
                        Button("移除此接入项", role: .destructive) {
                            let id = connection.id
                            configuration.modelConnections.removeAll { $0.id == id }
                            if configuration.defaultModel?.connectionId == id { configuration.defaultModel = nil }
                        }
                    } header: { Text("接入项 · \(connection.id)").textSelection(.enabled) }
                }
                Button { configuration.modelConnections.append(.new()) } label: { Label("添加接入项", systemImage: "plus") }
                    .disabled(revision == nil)
                Section("本机保存") {
                    Text("API Key 以明文保存在当前用户可读写的 config.json。正常退出后保留，不写入聊天数据库或日志。")
                    Text("~/.tandem/config.json").font(.caption.monospaced()).textSelection(.enabled)
                }
                if let notice { Section { Text(notice).textSelection(.enabled) } }
            }
            .formStyle(.grouped)
        }
        .task { await load() }
    }

    private func errorMessage(_ error: Error) -> String {
        if case IPCError.remote(let code) = error { return userFacingError(code) }
        return "无法读取或保存本地配置，请检查运行状态后重试。"
    }
    private func load() async {
        busy = true
        defer { busy = false }
        do {
            let document = try await model.call("config.get", as: ConfigDocument.self)
            configuration = document.config; revision = document.revision; notice = nil
        } catch { revision = nil; notice = errorMessage(error) }
    }
    private func save() async {
        guard let revision else { return }
        busy = true
        defer { busy = false }
        do {
            let encoded = try JSONEncoder().encode(configuration)
            let config = try JSONSerialization.jsonObject(with: encoded)
            let document = try await model.call("config.save", payload: ["config": config, "expectedRevision": revision], as: ConfigDocument.self)
            configuration = document.config; self.revision = document.revision; notice = "已保存。"
            await model.refresh()
        } catch { notice = errorMessage(error) }
    }
}

private struct ConnectionEditor: View {
    @Binding var connection: ModelConnection
    var body: some View {
        Picker("协议", selection: $connection.protocolName) {
            Text("OpenAI 兼容").tag("openai")
            Text("Anthropic 兼容").tag("anthropic")
        }
        .onChange(of: connection.protocolName) { _, value in
            connection.apiType = value == "anthropic" ? "messages" : "chat_completions"
            if connection.url == "https://api.openai.com/v1" && value == "anthropic" { connection.url = "https://api.anthropic.com/v1" }
            else if connection.url == "https://api.anthropic.com/v1" && value == "openai" { connection.url = "https://api.openai.com/v1" }
        }
        if connection.protocolName == "openai" {
            Picker("API 类型", selection: $connection.apiType) {
                Text("Chat Completions").tag("chat_completions")
                Text("Responses").tag("responses")
            }
        } else { LabeledContent("API 类型", value: "Messages") }
        TextField("API Base URL", text: $connection.url)
            .textContentType(.URL)
        Text("将追加 /\(connection.apiType == "chat_completions" ? "chat/completions" : connection.apiType)。需要 /v1 的服务，请在 Base URL 中包含 /v1。").font(.caption).foregroundStyle(.secondary)
        SecureField("API Key", text: $connection.key)
        TextField("模型名（每行一个）", text: Binding(
            get: { connection.modelNames.joined(separator: "\n") },
            set: { connection.modelNames = $0.components(separatedBy: "\n") }
        ), axis: .vertical).lineLimit(2...8)
    }
}
