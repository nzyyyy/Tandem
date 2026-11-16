import AppKit
import SwiftUI
import UniformTypeIdentifiers
import TandemCore

private struct RestorePreview: Decodable {
    var token: String
    var createdAt: String
    var appVersion: String
    var databaseSchema: Int
    var messages: Int
    var projects: Int
    var memories: Int
    var tasks: Int
    var attachments: Int
}

struct BackupSettingsView: View {
    @ObservedObject var model: AssistantModel
    @Binding var busy: Bool
    var hasUnsavedChanges: Bool
    var didRestore: () async -> Void
    @State private var preview: RestorePreview?
    @State private var notice: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Label("备份与恢复", systemImage: "externaldrive").font(.system(size: 15, weight: .semibold))
            Text("明文备份：包含聊天、项目、记忆、证据、执行历史及受管附件。API Key 会清空，外部授权目录不复制。请妥善保管备份文件。")
                .font(.callout).foregroundStyle(TandemStyle.secondary)
            HStack(spacing: 12) {
                Button("导出备份…") { Task { await export() } }
                Button("选择备份并预览…") { Task { await chooseRestore() } }
            }.disabled(busy || hasUnsavedChanges)
            if hasUnsavedChanges {
                Text("请先保存或放弃模型设置的修改，再进行备份或恢复。")
                    .font(.caption).foregroundStyle(TandemStyle.secondary)
            }
            if let preview {
                VStack(alignment: .leading, spacing: 12) {
                    Text("恢复预览").font(.headline)
                    Text("备份时间：\(preview.createdAt) · Tandem \(preview.appVersion)")
                        .font(.caption).textSelection(.enabled)
                    Text("\(preview.messages) 条消息 · \(preview.projects) 个项目 · \(preview.memories) 条记忆 · \(preview.tasks) 个任务 · \(preview.attachments) 个附件")
                    Text("恢复将替换当前全部业务数据和模型配置，切换前保留本机保护副本。当前尚未解除的遗忘标记会继续生效。恢复后需重新填写 API Key、选择目录，并手动继续任务；预算用量保留。")
                        .font(.callout).foregroundStyle(TandemStyle.secondary)
                    HStack(spacing: 12) {
                        Button("确认替换并恢复", role: .destructive) { Task { await restore(preview.token) } }
                        Button("取消") { Task { await cancel(preview.token) } }
                    }.disabled(busy || hasUnsavedChanges)
                }.padding(16).background(TandemStyle.canvas, in: RoundedRectangle(cornerRadius: 10))
            }
            if let notice { Text(notice).font(.callout).textSelection(.enabled) }
        }.padding(20).frame(maxWidth: .infinity, alignment: .leading)
            .background(TandemStyle.surface, in: RoundedRectangle(cornerRadius: 12))
    }

    private func show(_ error: Error) {
        if case IPCError.remote(let code) = error { notice = userFacingError(code) }
        else { notice = "备份操作未完成，请检查本地连接、文件权限和可用磁盘空间。" }
    }
    private func export() async {
        busy = true; defer { busy = false }
        let panel = NSSavePanel()
        panel.title = "导出明文备份"; panel.allowedContentTypes = [.json]
        panel.nameFieldStringValue = "Tandem-\(Date.now.formatted(.iso8601).replacingOccurrences(of: ":", with: "-"))-backup.json"
        guard await panel.begin() == .OK, let url = panel.url else { return }
        do {
            _ = try await model.runtime.request("backup.export", payload: ["path": url.path])
            notice = "备份已导出：\(url.path)"
        } catch { show(error) }
    }
    private func chooseRestore() async {
        busy = true; defer { busy = false }
        let panel = NSOpenPanel()
        panel.title = "选择 Tandem 明文备份"; panel.allowedContentTypes = [.json]
        panel.canChooseDirectories = false; panel.allowsMultipleSelection = false
        guard await panel.begin() == .OK, let url = panel.url else { return }
        preview = nil; notice = nil
        do { preview = try await model.call("backup.preview", payload: ["path": url.path], as: RestorePreview.self) }
        catch { show(error) }
    }
    private func restore(_ token: String) async {
        busy = true; defer { busy = false }
        do {
            let result = try await model.runtime.request("backup.restore", payload: ["token": token, "confirm": true])
            preview = nil
            notice = "恢复完成。请重新填写 API Key 并选择目录。原本机数据保护副本：\(result["protectionPath"] as? String ?? "")"
            await didRestore()
        } catch { preview = nil; show(error) }
    }
    private func cancel(_ token: String) async {
        busy = true; defer { busy = false }
        do { _ = try await model.runtime.request("backup.cancel", payload: ["token": token]); preview = nil }
        catch { show(error) }
    }
}
