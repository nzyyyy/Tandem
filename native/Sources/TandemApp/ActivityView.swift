import SwiftUI
import TandemCore

struct ApprovalCards: View {
    @ObservedObject var model: AssistantModel
    var body: some View {
        ForEach(model.snapshot?.activity.approvals ?? []) { approval in
            VStack(alignment: .leading, spacing: 10) {
                Label("待审批 · 选择只读目录", systemImage: "hand.raised").font(.headline)
                Text(approval.reason).textSelection(.enabled)
                Text("工具：\(approval.name) · \(model.projectTitle(model.snapshot?.activity.runs.first { $0.id == approval.run_id }?.project_id))")
                    .font(.caption).foregroundStyle(TandemStyle.secondary)
                Text("批准后由你选择目录；只允许读取 UTF-8 文本，不修改源文件。文件片段可能发送给所选模型。审批十分钟有效。")
                    .font(.caption).foregroundStyle(TandemStyle.secondary)
                HStack {
                    Button("批准一次并选择目录") { Task { await model.approve(approval, allow: true) } }
                        .disabled(Date().timeIntervalSince1970 * 1000 >= approval.expires_at)
                    Button("拒绝") { Task { await model.approve(approval, allow: false) } }
                }
            }.padding(16).frame(maxWidth: .infinity, alignment: .leading)
                .background(TandemStyle.surface, in: RoundedRectangle(cornerRadius: 12))
        }
    }
}

struct ActivityView: View {
    @ObservedObject var model: AssistantModel
    @State private var result: String?
    @State private var resultIsMarkdown = true
    @State private var editing: PersistentTask?
    @State private var loadError: String?
    var body: some View {
        VStack(spacing: 0) {
            PageHeader(title: "Activity") {
                Button("授权只读目录") { Task { await model.authorizeDirectory() } }
            }
            ScrollView {
                VStack(alignment: .leading, spacing: 24) {
                    if let error = model.error ?? loadError { Text(error).foregroundStyle(.red) }
                    ApprovalCards(model: model)
                    Text("授权目录").font(.title3.weight(.semibold))
                    Text("授权保留到应用退出，可随时撤销；重新启动后请主动重新选择目录。")
                        .font(.caption).foregroundStyle(TandemStyle.secondary)
                    ForEach(model.snapshot?.activity.grants ?? []) { grant in
                        HStack {
                            Label(grant.label, systemImage: "folder")
                            Text(model.projectTitle(grant.project_id)).foregroundStyle(TandemStyle.secondary)
                            Spacer()
                            if grant.status == "active" { Button("撤销") { Task { await model.revokeDirectory(grant.id) } } }
                            else { Button("重新选择同一目录") { Task { await model.authorizeDirectory(grant) } } }
                        }
                    }
                    Text("持续任务").font(.title3.weight(.semibold))
                    ForEach(model.snapshot?.activity.tasks ?? []) { task in
                        VStack(alignment: .leading, spacing: 10) {
                            HStack {
                                Text(task.deliverable).font(.headline)
                                Spacer()
                                Text("修订 \(task.revision) · \(executionStatus(task.status))").font(.caption)
                            }
                            Text(model.projectTitle(task.project_id)).font(.caption).foregroundStyle(TandemStyle.secondary)
                            ForEach(Array(task.criteriaList.enumerated()), id: \.offset) { index, criterion in
                                Text("\(index + 1). \(criterion)")
                            }
                            if task.status != "completed" {
                                Text("尚未完成：需要核验全部标准、工具步骤并持久化产物；Run 结束不会直接完成任务。")
                                    .font(.caption).foregroundStyle(TandemStyle.secondary)
                            }
                            ForEach(Array(task.evidenceList.enumerated()), id: \.offset) { index, evidence in
                                Text("完成依据 \(index + 1)：\(evidence)").font(.callout)
                            }
                            HStack {
                                if let id = task.result_ref { Button("打开 Markdown 结果") { openResult(id) } }
                                Button("修改任务") { editing = task }
                                Button("查看历次交付") {
                                    Task {
                                        do {
                                            struct History: Decodable { var revisions: [Revision] }
                                            struct Revision: Decodable { var revision: Int; var deliverable: String; var status: String; var result_ref: String? }
                                            // Results are opened through the same permission-checked endpoint.
                                            let history = try await model.call("task.history", payload: ["id": task.id, "surfaceId": model.currentSurfaceId], as: History.self)
                                            var texts: [String] = []
                                            for revision in history.revisions {
                                                var content: String?
                                                if let id = revision.result_ref { content = try await model.result(id) }
                                                texts.append("## 修订 \(revision.revision) · \(executionStatus(revision.status))\n\(revision.deliverable)\n\n\(content ?? "尚无已完成交付物")")
                                            }
                                            resultIsMarkdown = true; result = texts.joined(separator: "\n\n")
                                        } catch { loadError = "无法读取历史交付，请重新加载。" }
                                    }
                                }
                            }
                        }.padding(16).background(TandemStyle.surface, in: RoundedRectangle(cornerRadius: 12))
                    }
                    Text("执行记录").font(.title3.weight(.semibold))
                    ForEach(model.snapshot?.activity.runs ?? []) { run in
                        VStack(alignment: .leading, spacing: 10) {
                            HStack {
                                Text(executionStatus(run.status)).font(.headline)
                                Text(run.modelName).font(.caption).foregroundStyle(TandemStyle.secondary)
                                Spacer()
                                Button("查看当前输出") { openResult(run.assistant_message_id) }
                            }
                            Text(model.projectTitle(run.project_id)).font(.caption)
                            Text("步骤 \(run.steps)/\(run.step_limit) · Token \(run.tokens)/\(run.token_limit)\(run.estimated == 1 ? "（含保守估算）" : "") · 活跃时间 \(run.active_ms / 1000)/\(run.time_limit / 1000) 秒")
                                .font(.caption).foregroundStyle(TandemStyle.secondary)
                            if let error = run.error_code { Text(userFacingError(error)).font(.callout) }
                            HStack {
                                if ["paused", "interrupted"].contains(run.status) {
                                    Button(run.pause_reason == "budget_exhausted" ? "追加预算并继续" : "继续") {
                                        Task { await model.continueRun(run, addBudget: run.pause_reason == "budget_exhausted") }
                                    }
                                    if run.pause_reason == "budget_exhausted" { Text("+24 步 / 64000 Token / 300 秒").font(.caption) }
                                }
                                if ["queued", "running", "paused", "waiting_approval", "interrupted"].contains(run.status) {
                                    Button("取消执行") { Task { await model.cancel(run.id) } }
                                }
                                if run.status == "failed" { Button("重试") { Task { await model.retry(run.id) } } }
                            }
                            DisclosureGroup("步骤与实际上下文") {
                                ForEach(run.stepsDetail) { step in
                                    HStack {
                                        Text("\(executionStatus(step.status)) · \(step.summary)").font(.caption).textSelection(.enabled)
                                        Spacer()
                                        if let id = step.snapshot_id {
                                            Button("上下文") {
                                                Task {
                                                    do {
                                                        let context = try await model.context(id)
                                                        resultIsMarkdown = false; result = context.fragments.map { "\($0.sourceType) · \($0.sourceVersion)\n\($0.content)" }.joined(separator: "\n\n")
                                                    } catch { loadError = "上下文不可用或超出当前范围。" }
                                                }
                                            }
                                        }
                                    }
                                }
                            }
                        }.padding(16).background(TandemStyle.surface, in: RoundedRectangle(cornerRadius: 12))
                    }
                }.padding(28)
            }
        }
        .sheet(isPresented: Binding(get: { result != nil }, set: { if !$0 { result = nil } })) {
            VStack(alignment: .leading, spacing: 16) {
                HStack {
                    Text("执行结果与来源").font(.headline)
                    Spacer()
                    Button(resultIsMarkdown ? "复制 Markdown" : "复制原文") { NSPasteboard.general.clearContents(); NSPasteboard.general.setString(result ?? "", forType: .string) }
                    Button("关闭") { result = nil }
                }
                ScrollView {
                    if resultIsMarkdown { MarkdownView(result ?? "") }
                    else { Text(result ?? "").textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading) }
                }
            }.padding(24).frame(minWidth: 650, minHeight: 480)
        }
        .sheet(item: $editing) { task in TaskRevisionView(model: model, task: task) }
    }
    private func openResult(_ id: String) {
        Task { do { let content = try await model.result(id); resultIsMarkdown = true; result = content } catch { loadError = "结果不可用或超出当前范围。" } }
    }
}

private struct TaskRevisionView: View {
    @ObservedObject var model: AssistantModel
    let task: PersistentTask
    @Environment(\.dismiss) private var dismiss
    @State private var request = ""
    @State private var deliverable = ""
    @State private var criteria = ""
    @State private var key = UUID().uuidString
    @State private var busy = false
    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text("修改任务 · 新建修订 \(task.revision + 1)").font(.headline)
            Text("旧执行停止派发；既有交付与完成依据保留，新修订重新核验。使用输入区当前选定模型或全局默认模型。")
                .font(.caption).foregroundStyle(TandemStyle.secondary)
            TextField("修改要求", text: $request, axis: .vertical)
            TextField("预期交付物", text: $deliverable, axis: .vertical)
            Text("完成标准（每行一条）")
            TextEditor(text: $criteria).frame(height: 120)
            if let error = model.error { Text(error).foregroundStyle(.red) }
            HStack {
                Button("取消") { dismiss() }
                Spacer()
                Button("保存修订并执行") {
                    busy = true
                    Task {
                        if await model.reviseTask(task, request: request, deliverable: deliverable, criteria: criteria, key: key) { dismiss() }
                        busy = false
                    }
                }.disabled(busy || request.isEmpty || deliverable.isEmpty || criteria.isEmpty)
            }
        }.padding(24).frame(width: 600).onAppear { deliverable = task.deliverable; criteria = task.criteriaList.joined(separator: "\n") }
    }
}
