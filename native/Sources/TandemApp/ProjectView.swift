import SwiftUI
import TandemCore

struct ProjectView: View {
    @ObservedObject var model: AssistantModel
    @Binding var hasUnsavedChanges: Bool
    @State private var selection = EditorSelection(value: "")
    @State private var title = ""
    @State private var description = ""
    @State private var savedTitle = ""
    @State private var savedDescription = ""
    @State private var showArchived = false
    @State private var confirmSelection = false
    @State private var preview: ProjectDeletion?
    @State private var error: String?
    @Binding var working: Bool

    private var project: TandemProject? { model.snapshot?.projects.first { $0.id == selection.value } }
    private var projects: [TandemProject] { (model.snapshot?.projects ?? []).filter { showArchived || $0.status == "open" } }
    private var dirty: Bool { title != savedTitle || description != savedDescription }

    var body: some View {
        VStack(spacing: 0) {
            PageHeader(title: "项目") {
                Button { selectProject("") } label: { Label("新建项目", systemImage: "plus") }
                    .buttonStyle(TandemButtonStyle(.primary)).disabled(working || selection.value.isEmpty)
            }
            ScrollView {
                VStack(alignment: .leading, spacing: 32) {
                    VStack(alignment: .leading, spacing: 12) {
                        Text("长期目标，持续积累").font(.system(size: 24, weight: .semibold))
                        Text("项目用于整理相关对话；普通问题也可以不关联项目。")
                            .font(.system(size: 14)).foregroundStyle(TandemStyle.secondary)
                    }
                    ViewThatFits(in: .horizontal) {
                        HStack(alignment: .top, spacing: 32) {
                            projectList.frame(width: 240)
                            Divider()
                            editor.frame(minWidth: 400, maxWidth: .infinity)
                        }.frame(minWidth: 737)
                        VStack(alignment: .leading, spacing: 24) {
                            TandemPicker(title: "选择项目", value: project?.title ?? "创建新项目", selection: Binding(get: { selection.value }, set: { selectProject($0) })) {
                                Text("创建新项目").tag("")
                                ForEach(projects) { Text($0.title + ($0.status == "archived" ? "（已归档）" : "")).tag($0.id) }
                                if let project, !projects.contains(where: { $0.id == project.id }) { Text(project.title + "（已归档）").tag(project.id) }
                            }
                            Toggle("显示归档项目", isOn: $showArchived).toggleStyle(.switch).controlSize(.small)
                            editor
                        }
                    }
                }.padding(32).frame(maxWidth: 1060, alignment: .leading).frame(maxWidth: .infinity)
            }.disabled(working)
        }
        .textFieldStyle(TandemTextFieldStyle())
        .onChange(of: selection.value) { _, _ in loadDraft() }
        .onChange(of: dirty, initial: true) { _, value in hasUnsavedChanges = value }
        .confirmationDialog("放弃当前项目的修改？", isPresented: $confirmSelection) {
            Button("放弃修改并切换", role: .destructive) { selection.discard() }
            Button("继续编辑", role: .cancel) { selection.pending = nil }
        }
    }

    private var projectList: some View {
        VStack(alignment: .leading, spacing: 16) {
            HStack {
                Text(showArchived ? "全部项目" : "进行中").font(.system(size: 13, weight: .semibold))
                Spacer()
                Text("\(projects.count) 个项目").font(.caption).foregroundStyle(TandemStyle.secondary)
            }.padding(.horizontal, 12)
            ForEach(projects) { project in
                SelectionRow(title: project.title, symbol: project.status == "archived" ? "archivebox" : "folder",
                             subtitle: project.status == "archived" ? "已归档" : project.description,
                             selected: selection.value == project.id) {
                    selectProject(project.id)
                }
            }
            if projects.isEmpty { Text("还没有项目，先创建一个长期目标。")
                .font(.callout).foregroundStyle(TandemStyle.secondary).padding(12) }
            Divider().padding(.top, 8)
            Toggle("显示归档项目", isOn: $showArchived).toggleStyle(.switch).controlSize(.small).font(.system(size: 13))
        }
    }

    private var editor: some View {
        VStack(alignment: .leading, spacing: 28) {
            HStack {
                Label(project == nil ? "创建新项目" : "项目详情", systemImage: "folder")
                    .font(.system(size: 17, weight: .semibold))
                Spacer()
                if let project { Text(project.status == "archived" ? "已归档" : "进行中").font(.caption).foregroundStyle(TandemStyle.accent) }
            }
            EditorField(title: "项目名称") { TextField("为这个目标起个名字", text: $title).accessibilityLabel("项目名称") }
            EditorField(title: "目标或说明") {
                TextField("想达成什么？写下目标或背景…", text: $description, axis: .vertical)
                    .lineLimit(5...10).accessibilityLabel("目标或说明")
            }
            HStack(spacing: 12) {
                Button(project == nil ? "创建项目" : "保存修改") { Task { await save(status: project?.status ?? "open") } }
                    .buttonStyle(TandemButtonStyle(.primary)).controlSize(.large)
                    .disabled(title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || working)
                if working { ProgressView().controlSize(.small) }
                else if dirty { Text("未保存修改").font(.caption).foregroundStyle(TandemStyle.secondary) }
            }
            if let error { Text(error).font(.callout).foregroundStyle(.red) }
            if let error = model.error { Text(error).font(.callout).foregroundStyle(.red).textSelection(.enabled) }
            if let p = project {
                Divider()
                VStack(alignment: .leading, spacing: 16) {
                    Text("项目管理").font(.system(size: 14, weight: .semibold))
                    Text("归档后保留全部历史，可以随时恢复。").font(.callout).foregroundStyle(TandemStyle.secondary)
                    Button(p.status == "archived" ? "恢复项目" : "归档项目") {
                        Task { await save(status: p.status == "archived" ? "open" : "archived") }
                    }.disabled(working || title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                    Button("预览永久删除…", role: .destructive) { Task { await deletionPreview(p.id) } }.disabled(working)
                    Text("先查看影响范围，再确认删除。").font(.caption).foregroundStyle(TandemStyle.secondary)
                }
            }
            if let preview { deletionConfirmation(preview) }
        }
    }

    private func deletionConfirmation(_ preview: ProjectDeletion) -> some View {
        VStack(alignment: .leading, spacing: 16) {
            Label("永久删除「\(preview.title)」", systemImage: "exclamationmark.triangle").font(.headline)
            Text("将删除 \(preview.interactions.count) 次交互、\(preview.messages.count) 条消息及 \(preview.runs.count) 次执行；\(preview.sharedSnapshots.count) 份快照含相关引用，将清理对应片段和 \(preview.derivedMessages.count) 条派生回答内容。共享会话中的其他交互保留，外部文件不受影响。")
            Text("将影响 \(Set(preview.tasks.map(\.id)).count) 个任务：清理本项目任务及历史交付，移除共享产物引用与完成依据。")
            Text("此操作无法撤销。归属已纠正但实际使用过本项目上下文的交互也在清理范围内。仅清理当前数据库；迁移保护副本及云端留存不随此操作删除，SQLite WAL 不承诺物理擦除。")
                .foregroundStyle(TandemStyle.secondary)
            HStack {
                Button("确认永久删除", role: .destructive) {
                    Task {
                        working = true
                        if await model.perform("project.delete", ["token": preview.token, "confirm": true]) {
                            self.preview = nil; selection.value = ""; loadDraft()
                        }
                        working = false
                    }
                }.disabled(working)
                Button("取消") { self.preview = nil }.disabled(working)
            }
        }.font(.callout).padding(20).background(TandemStyle.surface, in: RoundedRectangle(cornerRadius: 12))
    }

    private func selectProject(_ id: String) {
        selection.select(id, hasChanges: dirty)
        confirmSelection = selection.pending != nil
    }

    private func loadDraft() {
        title = project?.title ?? ""; description = project?.description ?? ""
        savedTitle = title; savedDescription = description; preview = nil; error = nil
    }
    private func save(status: String) async {
        working = true
        defer { working = false }
        let succeeded: Bool
        if let p = project {
            succeeded = await model.perform("project.update", ["id": p.id, "title": title, "description": description, "status": status, "expectedVersion": p.version])
        } else {
            succeeded = await model.perform("project.create", ["title": title, "description": description])
            if succeeded { title = ""; description = "" }
        }
        if succeeded {
            savedTitle = title; savedDescription = description; preview = nil
            if status == "archived" { showArchived = true }
        }
    }
    private func deletionPreview(_ id: String) async {
        working = true
        defer { working = false }
        do { preview = try await model.call("project.deletePreview", payload: ["id": id], as: ProjectDeletion.self); error = nil }
        catch { self.error = "无法生成删除预览，请重试。" }
    }
}

struct ContextControls: View {
    @ObservedObject var model: AssistantModel
    @State private var mode = "automatic"
    @State private var projectId = ""
    @State private var applying = false
    private var changed: Bool {
        guard let focus = model.snapshot?.focus else { return false }
        return mode != focus.contextMode || projectId != (focus.activeProjectId ?? "")
    }
    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            ViewThatFits(in: .horizontal) {
                HStack(spacing: 12) { modePicker; projectPicker; applyButton }
                VStack(alignment: .leading, spacing: 10) {
                    HStack(spacing: 12) { modePicker; projectPicker }
                    applyButton
                }
            }
            if let focus = model.snapshot?.focus, changed || focus.contextMode != "automatic" {
                Text("生效范围：\(modeTitle(model.snapshot?.focus.contextMode ?? "automatic")) · \(model.projectTitle(model.snapshot?.focus.activeProjectId))" + (model.snapshot?.focus.contextMode == "isolated" ? " · 仅使用此项目的来源" : ""))
                    .font(.caption).foregroundStyle(TandemStyle.secondary)
            }
        }
        .disabled(model.snapshot == nil || applying)
        .onChange(of: model.snapshot?.focus.version, initial: true) { _, _ in
            mode = model.snapshot?.focus.contextMode ?? "automatic"
            projectId = model.snapshot?.focus.activeProjectId ?? ""
        }
    }
    private func modeTitle(_ mode: String) -> String {
        switch mode { case "pinned": return "固定项目"; case "isolated": return "隔离项目"; default: return "自动" }
    }
    private var modePicker: some View {
        TandemPicker(title: "上下文", value: "上下文：" + modeTitle(mode), selection: $mode) {
            Text("自动").tag("automatic")
            Text("固定项目").tag("pinned")
            Text("隔离项目").tag("isolated")
        }
        .frame(maxWidth: 210)
    }
    private var projectPicker: some View {
        TandemPicker(title: "项目", value: "项目：" + (projectId.isEmpty ? "未指定项目" : model.projectTitle(projectId)), selection: $projectId) {
            Text("未指定项目").tag("")
            ForEach((model.snapshot?.projects ?? []).filter { $0.status == "open" }) { Text($0.title).tag($0.id) }
        }
        .frame(maxWidth: 280)
    }
    @ViewBuilder private var applyButton: some View {
        if changed {
            Button(applying ? "应用中…" : "应用范围") {
                Task { applying = true; await model.setContext(mode: mode, projectId: projectId); applying = false }
            }.buttonStyle(TandemButtonStyle(.primary)).fixedSize()
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
                TandemPicker(title: "其他话题", value: model.snapshot?.sessions.first { $0.id == sessionId }?.title ?? "新建话题", selection: $sessionId) {
                    Text("新建话题").tag("")
                    ForEach(model.snapshot?.sessions ?? []) { Text($0.title).tag($0.id) }
                }.frame(maxWidth: 360)
                Button("确认归属并发送") { Task { await model.confirm(interaction, sessionId: sessionId.isEmpty ? nil : sessionId) } }
            }
        }.padding(16).frame(maxWidth: .infinity, alignment: .leading)
            .background(TandemStyle.selection, in: RoundedRectangle(cornerRadius: 12))
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
        }.padding(32).frame(width: 680, height: 560)
        .background(TandemStyle.canvas).foregroundStyle(TandemStyle.ink)
        .task {
            do { context = try await model.context(id) }
            catch { self.error = "当前范围无法查看此快照，请先明确切换项目或模式。" }
        }
    }
}
