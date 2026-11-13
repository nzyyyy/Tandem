import SwiftUI
import TandemCore

struct ProjectView: View {
    @ObservedObject var model: AssistantModel
    @State private var selected = ""
    @State private var title = ""
    @State private var description = ""
    @State private var showArchived = false
    @State private var preview: ProjectDeletion?
    @State private var error: String?
    @State private var working = false

    private var project: TandemProject? { model.snapshot?.projects.first { $0.id == selected } }
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                Text("项目").font(.largeTitle.weight(.semibold))
                Text("项目承载长期目标。归档保留全部历史，恢复后可继续使用。").foregroundStyle(.secondary)
                Toggle("显示归档项目", isOn: $showArchived)
                HStack {
                    Picker("选择项目", selection: $selected) {
                        Text("创建新项目").tag("")
                        ForEach((model.snapshot?.projects ?? []).filter { showArchived || $0.status == "open" }) { p in
                            Text(p.title + (p.status == "archived" ? "（已归档）" : "")).tag(p.id)
                        }
                    }
                    Button("新建") { selected = ""; title = ""; description = ""; preview = nil }
                }
                TextField("项目名称", text: $title)
                TextField("目标或说明", text: $description, axis: .vertical).lineLimit(3...8)
                HStack {
                    Button(project == nil ? "创建项目" : "保存修改") { Task { await save(status: project?.status ?? "open") } }
                        .buttonStyle(.borderedProminent).disabled(title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || working)
                    if let p = project {
                        Button(p.status == "archived" ? "恢复项目" : "归档项目") { Task { await save(status: p.status == "archived" ? "open" : "archived") } }.disabled(working)
                        Spacer()
                        Button("预览永久删除…", role: .destructive) { Task { await deletionPreview(p.id) } }.disabled(working)
                    }
                }
                if let error { Text(error).foregroundStyle(.red) }
                if let error = model.error { Text(error).foregroundStyle(.red) }
                if let preview {
                    Divider()
                    Text("永久删除「\(preview.title)」").font(.headline)
                    Text("将删除 \(preview.interactions.count) 次交互、\(preview.messages.count) 条消息及 \(preview.runs.count) 次执行；\(preview.sharedSnapshots.count) 份快照含相关引用，将清理对应片段和 \(preview.derivedMessages.count) 条派生回答内容。共享会话中的其他交互保留，外部文件不受影响。")
                    Text("此操作无法撤销。归属已纠正但实际使用过本项目上下文的交互也在清理范围内。仅清理当前数据库；迁移保护副本及云端留存不随此操作删除，SQLite WAL 不承诺物理擦除。").foregroundStyle(.secondary)
                    HStack {
                        Button("确认永久删除", role: .destructive) {
                            Task {
                                working = true
                                if await model.perform("project.delete", ["token": preview.token, "confirm": true]) {
                                    self.preview = nil; selected = ""; title = ""; description = ""
                                }
                                working = false
                            }
                        }.disabled(working)
                        Button("取消") { self.preview = nil }
                    }
                }
            }.textFieldStyle(.roundedBorder).padding(32).frame(maxWidth: 760, alignment: .leading)
        }
        .onChange(of: selected) { _, _ in title = project?.title ?? ""; description = project?.description ?? ""; preview = nil; error = nil }
    }
    private func save(status: String) async {
        working = true
        defer { working = false }
        if let p = project {
            _ = await model.perform("project.update", ["id": p.id, "title": title, "description": description, "status": status, "expectedVersion": p.version])
        } else {
            if await model.perform("project.create", ["title": title, "description": description]) { title = ""; description = "" }
        }
        preview = nil
        if status == "archived" { showArchived = true }
    }
    private func deletionPreview(_ id: String) async {
        do { preview = try await model.call("project.deletePreview", payload: ["id": id], as: ProjectDeletion.self); error = nil }
        catch { self.error = "无法生成删除预览，请重试。" }
    }
}

struct ContextControls: View {
    @ObservedObject var model: AssistantModel
    @State private var mode = "automatic"
    @State private var projectId = ""
    var body: some View {
        HStack {
            Picker("上下文", selection: $mode) {
                Text("自动").tag("automatic")
                Text("固定项目").tag("pinned")
                Text("隔离项目").tag("isolated")
            }.frame(maxWidth: 210)
            Picker("项目", selection: $projectId) {
                Text("未指定项目").tag("")
                ForEach((model.snapshot?.projects ?? []).filter { $0.status == "open" }) { Text($0.title).tag($0.id) }
            }.frame(maxWidth: 250)
            if mode != model.snapshot?.focus.contextMode || projectId != (model.snapshot?.focus.activeProjectId ?? "") {
                Button("应用范围") { Task { await model.setContext(mode: mode, projectId: projectId) } }
            }
            if model.snapshot?.focus.contextMode == "isolated" { Text("仅使用此项目的来源").font(.caption).foregroundStyle(.secondary) }
        }
        .onChange(of: model.snapshot?.focus.version, initial: true) { _, _ in
            mode = model.snapshot?.focus.contextMode ?? "automatic"
            projectId = model.snapshot?.focus.activeProjectId ?? ""
        }
    }
}

struct PendingInteractionView: View {
    let interaction: PendingInteraction
    @ObservedObject var model: AssistantModel
    @State private var sessionId = ""
    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Label("待确认话题", systemImage: "questionmark.bubble").font(.headline)
            Text(interaction.input).textSelection(.enabled)
            Text(interaction.route.reason).foregroundStyle(.secondary)
            ForEach(interaction.route.candidates) { candidate in
                VStack(alignment: .leading, spacing: 4) {
                    Button(candidate.title) { Task { await model.confirm(interaction, sessionId: candidate.sessionId) } }
                    Text("\(model.projectTitle(candidate.projectId)) · \(candidate.reason) · \(Date(timeIntervalSince1970: candidate.updatedAt / 1000).formatted(date: .abbreviated, time: .shortened))")
                        .font(.caption).foregroundStyle(.secondary)
                }
            }
            HStack {
                Picker("其他话题", selection: $sessionId) {
                    Text("新建话题").tag("")
                    ForEach(model.snapshot?.sessions ?? []) { Text($0.title).tag($0.id) }
                }.frame(maxWidth: 360)
                Button("确认归属并发送") { Task { await model.confirm(interaction, sessionId: sessionId.isEmpty ? nil : sessionId) } }
            }
        }.padding(16).frame(maxWidth: .infinity, alignment: .leading)
            .background(Color.accentColor.opacity(0.06), in: RoundedRectangle(cornerRadius: 10))
    }
}

struct RunContextView: View {
    let id: String
    @ObservedObject var model: AssistantModel
    @Environment(\.dismiss) private var dismiss
    @State private var context: RunContext?
    @State private var error: String?
    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            HStack { Text("实际执行上下文").font(.title2); Spacer(); Button("关闭") { dismiss() } }
            if let context {
                Text("\(model.projectTitle(context.projectId)) · \(context.mode)").foregroundStyle(.secondary)
                ScrollView {
                    VStack(alignment: .leading, spacing: 18) {
                        ForEach(context.fragments.indices, id: \.self) { index in
                            let fragment = context.fragments[index]
                            VStack(alignment: .leading, spacing: 6) {
                                Text("\(fragment.role == "user" ? "用户输入" : "回答") · \(model.projectTitle(fragment.projectId))").font(.headline)
                                Text(fragment.content).textSelection(.enabled)
                                Text("来源 \(fragment.sourceId)\n版本 \(fragment.sourceVersion)").font(.caption.monospaced()).foregroundStyle(.secondary).textSelection(.enabled)
                            }
                        }
                    }.frame(maxWidth: .infinity, alignment: .leading)
                }
            } else if let error { Text(error).foregroundStyle(.red) }
            else { ProgressView() }
        }.padding(24).frame(width: 680, height: 560)
        .task {
            do { context = try await model.context(id) }
            catch { self.error = "当前范围无法查看此快照，请先明确切换项目或模式。" }
        }
    }
}
