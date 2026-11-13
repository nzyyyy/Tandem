import SwiftUI
import TandemCore

struct AssistantView: View {
    @StateObject private var model: AssistantModel
    @ObservedObject private var runtime: RuntimeSupervisor
    @SceneStorage("tandem.surfaceId") private var surfaceId = UUID().uuidString
    @State private var navigation = EditorSelection(value: "assistant")
    @State private var hasUnsavedChanges = false
    @State private var editorBusy = false
    @State private var pendingSession: String?
    @State private var confirmNavigation = false
    @State private var showDiagnostics = false
    @State private var filterProject = "*"
    @SwiftUI.FocusState private var composerFocused: Bool

    init(runtime: RuntimeSupervisor) {
        _model = StateObject(wrappedValue: AssistantModel(runtime: runtime))
        self.runtime = runtime
    }

    var body: some View {
        NavigationSplitView {
            VStack(alignment: .leading, spacing: 0) {
                HStack(spacing: 10) {
                    Image(systemName: "circle.lefthalf.filled")
                        .foregroundStyle(TandemStyle.onAccent).padding(8)
                        .background(TandemStyle.accent, in: RoundedRectangle(cornerRadius: 9))
                    Text("Tandem").font(.system(size: 22, weight: .semibold))
                }
                .padding(.top, 20).padding(.horizontal, 20)
                Text("让想法，持续向前。")
                    .font(.caption).foregroundStyle(TandemStyle.secondary)
                    .padding(.horizontal, 20).padding(.top, 12).padding(.bottom, 28)
                VStack(spacing: 4) {
                    SelectionRow(title: "对话", symbol: "bubble.left.and.bubble.right", selected: navigation.value == "assistant") { navigate("assistant") }
                    SelectionRow(title: "项目", symbol: "folder", selected: navigation.value == "projects") { navigate("projects") }
                    SelectionRow(title: "模型设置", symbol: "slider.horizontal.3", selected: navigation.value == "settings") { navigate("settings") }
                }.padding(.horizontal, 12)
                Text("最近话题").font(.caption.weight(.medium)).foregroundStyle(TandemStyle.secondary)
                    .padding(.horizontal, 24).padding(.top, 32).padding(.bottom, 12)
                ScrollView {
                    LazyVStack(spacing: 4) {
                        ForEach(model.snapshot?.sessions ?? []) { session in
                            SelectionRow(title: session.title, symbol: session.temporary == 1 ? "bubble.left" : "text.bubble",
                                         selected: navigation.value == "assistant" && session.id == model.snapshot?.focus.activeSessionId) {
                                if navigation.value == "assistant" { Task { await model.focus(session.id) } }
                                else { navigate("assistant", sessionId: session.id) }
                            }
                        }
                        if model.snapshot?.sessions.isEmpty == true {
                            Text("话题会随对话出现在这里").font(.caption).foregroundStyle(TandemStyle.secondary).padding(12)
                        }
                    }.padding(.horizontal, 12)
                }
                VStack(alignment: .leading, spacing: 10) {
                    Divider()
                    Button { showDiagnostics = true } label: {
                        VStack(alignment: .leading, spacing: 8) {
                            Label("运行状态", systemImage: "waveform.path").font(.system(size: 13, weight: .medium))
                            Text("本地运行 · \(runtime.status)").font(.caption).foregroundStyle(TandemStyle.secondary)
                        }.frame(maxWidth: .infinity, alignment: .leading).padding(.vertical, 8).contentShape(Rectangle())
                    }.buttonStyle(.plain)
                }.padding(20)
            }
            .background(TandemStyle.surface)
            .disabled(editorBusy)
            .navigationSplitViewColumnWidth(min: 200, ideal: 238, max: 300)
        } detail: {
            Group {
                if navigation.value == "settings" { ModelSettingsView(model: model, hasUnsavedChanges: $hasUnsavedChanges, busy: $editorBusy) }
                else if navigation.value == "projects" { ProjectView(model: model, hasUnsavedChanges: $hasUnsavedChanges, working: $editorBusy) }
                else { conversation }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .background(TandemStyle.canvas)
        }
        .tint(TandemStyle.accent).foregroundStyle(TandemStyle.ink)
        .buttonStyle(TandemButtonStyle())
        .frame(minWidth: 860, minHeight: 600)
        .defaultFocus($composerFocused, true)
        .task { await model.poll(surfaceId: surfaceId) }
        .onChange(of: navigation.value) { _, _ in
            hasUnsavedChanges = false
        }
        .confirmationDialog("放弃未保存的修改？", isPresented: $confirmNavigation) {
            Button("放弃修改并离开", role: .destructive) { navigation.discard(); focusPendingSession() }
            Button("继续编辑", role: .cancel) { navigation.pending = nil; pendingSession = nil }
        } message: { Text("当前页面的修改尚未保存。") }
        .sheet(isPresented: $showDiagnostics) {
            VStack {
                DiagnosticsView(runtime: model.runtime)
                Button("关闭") { showDiagnostics = false }.keyboardShortcut(.cancelAction).padding(.bottom)
            }
        }
    }

    private func navigate(_ section: String, sessionId: String? = nil) {
        pendingSession = sessionId
        navigation.select(section, hasChanges: hasUnsavedChanges)
        confirmNavigation = navigation.pending != nil
        if !confirmNavigation { focusPendingSession() }
    }

    private func focusPendingSession() {
        if let pendingSession { Task { await model.focus(pendingSession) }; self.pendingSession = nil }
    }

    private var conversation: some View {
        VStack(spacing: 0) {
            PageHeader(title: "对话") {
                if let interrupted = model.snapshot?.focus.interruptedSessionId {
                    Button("恢复原话题") { Task { await model.focus(interrupted) } }
                }
                Menu { topicActions } label: { TandemMenuLabel { Label("新话题", systemImage: "square.and.pencil") } }
                    .menuStyle(.borderlessButton).menuIndicator(.hidden).fixedSize().focusEffectDisabled()
            }
            ViewThatFits(in: .horizontal) {
                HStack(spacing: 16) { topicTitle; Spacer(); historyFilter }
                VStack(alignment: .leading, spacing: 12) { topicTitle; historyFilter }
            }
            .padding(.horizontal, 32).padding(.vertical, 16)
            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 32) {
                        if model.hasMore { Button("加载更早的消息") { Task { await model.loadEarlier() } }.frame(maxWidth: .infinity) }
                        if model.snapshot == nil {
                            VStack(alignment: .leading, spacing: 16) {
                                if let error = model.error {
                                    Label("暂时无法载入对话", systemImage: "exclamationmark.triangle").font(.headline)
                                    Text(error).font(.callout).foregroundStyle(TandemStyle.secondary)
                                    Button("重试加载") { Task { await model.refresh() } }
                                } else {
                                    ProgressView(runtime.isConnected ? "正在载入对话…" : "正在启动本地运行环境…")
                                    Text(runtime.status).font(.caption).foregroundStyle(TandemStyle.secondary)
                                }
                            }.padding(.top, 64)
                        } else if model.messages.isEmpty && model.snapshot?.pendingInteractions.isEmpty == true {
                            VStack(alignment: .leading, spacing: 16) {
                                Image(systemName: "circle.lefthalf.filled").font(.system(size: 28)).foregroundStyle(TandemStyle.accent)
                                Text("从一个想法开始").font(.system(size: 28, weight: .semibold))
                                Text("说说你正在思考的事。\n话题与历史保存在本机，也可以不关联项目。")
                                    .font(.system(size: 15)).foregroundStyle(TandemStyle.secondary).lineSpacing(5)
                                if model.snapshot?.models.isEmpty == true { Button("配置第一个模型") { navigate("settings") }.buttonStyle(TandemButtonStyle(.primary)) }
                            }.padding(.top, 64)
                        } else if timelineSequences.isEmpty {
                            Text("此项目暂无消息").foregroundStyle(TandemStyle.secondary).padding(.top, 64)
                        }
                        ForEach(timelineSequences, id: \.self) { sequence in
                            if let message = model.messages.first(where: { $0.sequence == sequence }) {
                                MessageView(message: message, model: model)
                            } else if let pending = model.snapshot?.pendingInteractions.first(where: { $0.sequence == sequence }) {
                                PendingInteractionView(interaction: pending, model: model)
                            }
                        }
                        Color.clear.frame(height: 1).id("bottom")
                    }
                    .frame(maxWidth: 724, alignment: .leading)
                    .padding(.horizontal, 32).padding(.vertical, 24)
                    .frame(maxWidth: .infinity)
                }
                .onChange(of: model.messages.last?.id) { _, _ in proxy.scrollTo("bottom", anchor: .bottom) }
            }
            composer
        }
    }

    private var topicTitle: some View {
        Text("当前话题：" + activeTitle).font(.system(size: 13)).foregroundStyle(TandemStyle.secondary).lineLimit(1).help(activeTitle)
    }
    private var historyFilter: some View {
        TandemPicker(title: "历史筛选", value: historyFilterTitle, selection: $filterProject) {
            Text("全部项目历史").tag("*")
            Text("未关联项目").tag("")
            ForEach(model.snapshot?.projects ?? []) { Text($0.title + ($0.status == "archived" ? "（归档）" : "")).tag($0.id) }
        }.labelsHidden().frame(width: 190).accessibilityLabel("历史筛选")
    }
    private var historyFilterTitle: String {
        if filterProject == "*" { return "全部项目历史" }
        guard let project = model.snapshot?.projects.first(where: { $0.id == filterProject }) else { return "未关联项目" }
        return project.title + (project.status == "archived" ? "（归档）" : "")
    }
    private var selectedModelTitle: String {
        guard !model.selectedModel.isEmpty else { return defaultModelTitle }
        guard let option = model.snapshot?.models.first(where: { $0.id == model.selectedModel }) else { return "所选模型已失效" }
        return "\(option.modelName) · \(model.connectionTitle(option.connectionId))"
    }
    @ViewBuilder private var topicActions: some View {
        Button("新话题") { model.newTopic = true; model.temporary = false }
        Button("临时插话") { model.temporary = true; model.newTopic = false }
    }

    private var composer: some View {
        VStack(alignment: .leading, spacing: 12) {
            if model.snapshot != nil, let error = model.error { Text(error).font(.callout).foregroundStyle(.red).textSelection(.enabled) }
            if let error = model.snapshot?.configError {
                Button(userFacingError(error) + " 打开模型设置") { navigate("settings") }.foregroundStyle(.red)
            }
            ContextControls(model: model)
            VStack(alignment: .leading, spacing: 16) {
                TextField("继续这个想法，或开始一个新问题…", text: $model.draft, axis: .vertical)
                    .font(.system(size: 15)).lineLimit(2...7).textFieldStyle(.plain)
                    .focused($composerFocused)
                    .onSubmit { Task { await model.send() } }
                    .accessibilityLabel("消息内容")
                HStack(alignment: .bottom, spacing: 12) {
                    VStack(alignment: .leading, spacing: 8) {
                        TandemPicker(title: "模型", value: selectedModelTitle, selection: $model.selectedModel) {
                            Text(defaultModelTitle).tag("")
                            ForEach(model.snapshot?.models ?? []) { option in Text("\(option.modelName) · \(model.connectionTitle(option.connectionId))").tag(option.id) }
                            if !model.selectedModel.isEmpty && !(model.snapshot?.models.contains { $0.id == model.selectedModel } ?? false) { Text("所选模型已失效").tag(model.selectedModel) }
                        }.labelsHidden().frame(maxWidth: 330).accessibilityLabel("模型")
                        if model.newTopic || model.temporary {
                            Button { model.newTopic = false; model.temporary = false } label: {
                                Label(model.temporary ? "下条为临时插话" : "下条为新话题", systemImage: "xmark.circle.fill")
                            }.buttonStyle(TandemButtonStyle(.plain)).font(.caption)
                        }
                    }
                    Spacer(minLength: 0)
                    Menu { topicActions } label: { Image(systemName: "ellipsis") }
                        .menuStyle(.borderlessButton).menuIndicator(.hidden).fixedSize().help("新话题或临时插话").accessibilityLabel("消息选项")
                    Button { Task { await model.send() } } label: {
                        Image(systemName: "arrow.up").font(.system(size: 16, weight: .semibold)).frame(width: 24, height: 26)
                    }
                    .buttonStyle(TandemButtonStyle(.primary)).controlSize(.large)
                    .disabled(model.sending || model.snapshot == nil || model.draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                    .keyboardShortcut(.return, modifiers: .command)
                    .help("发送消息（⌘Return）").accessibilityLabel("发送消息")
                }
            }
            .padding(18)
            .background(TandemStyle.canvas, in: RoundedRectangle(cornerRadius: 14))
            .overlay { RoundedRectangle(cornerRadius: 14).stroke(composerFocused ? TandemStyle.accent : TandemStyle.border, lineWidth: composerFocused ? 2 : 1) }
            Text("全局连续历史 · 模型仅接收当前话题的相关消息 · ⌘Return 发送")
                .font(.caption).foregroundStyle(TandemStyle.secondary)
        }
        .frame(maxWidth: 724).padding(.horizontal, 32).padding(.top, 12).padding(.bottom, 20)
        .frame(maxWidth: .infinity).background(TandemStyle.canvas)
    }

    private var timelineSequences: [Int] {
        Array(Set(model.messages.filter { filterProject == "*" || ($0.projectId ?? "") == filterProject }.map(\.sequence) + (filterProject == "*" ? (model.snapshot?.pendingInteractions.map(\.sequence) ?? []) : []))).sorted()
    }
    private var activeTitle: String {
        model.snapshot?.sessions.first { $0.id == model.snapshot?.focus.activeSessionId }?.title ?? "准备开始新话题"
    }
    private var defaultModelTitle: String {
        if let selected = model.snapshot?.defaultModel { return "默认：\(selected.modelName) · \(model.connectionTitle(selected.connectionId))" }
        return "使用全局默认（尚未设置）"
    }
}

private struct MessageView: View {
    let message: TimelineMessage
    @ObservedObject var model: AssistantModel
    @State private var showContext = false
    @State private var showRoute = false
    @State private var history: CorrectionHistory?
    @State private var historyError: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            HStack(alignment: .firstTextBaseline, spacing: 10) {
                if message.role == "assistant" {
                    Image(systemName: "circle.lefthalf.filled").foregroundStyle(TandemStyle.accent)
                }
                Text(message.role == "user" ? "你" : "Tandem").font(.system(size: 14, weight: .semibold))
                if let name = message.modelName {
                    Text("\(name) · \(model.connectionTitle(message.connectionId))")
                        .font(.caption).foregroundStyle(TandemStyle.secondary).lineLimit(1)
                        .help("\(name) · \(model.connectionTitle(message.connectionId))")
                }
                Spacer(minLength: 0)
                Text(model.snapshot?.sessions.first { $0.id == message.sessionId }?.title ?? "历史话题")
                    .font(.caption).foregroundStyle(TandemStyle.secondary).lineLimit(1).frame(maxWidth: 180, alignment: .trailing)
            }
            if !message.content.isEmpty {
                Text(message.content).font(.system(size: 15)).textSelection(.enabled)
                    .lineSpacing(6).frame(maxWidth: .infinity, alignment: .leading)
            }
            if message.role == "assistant", message.executionInteractionVersion != message.interactionVersion {
                VStack(alignment: .leading, spacing: 8) {
                    Text("原回答使用：\(model.projectTitle(message.executionProjectId))。更改归属不会改写历史上下文。")
                        .font(.caption).foregroundStyle(TandemStyle.secondary)
                    if let id = message.runId { Button("按当前归属重新处理") { Task { await model.retry(id) } }.disabled(model.sending) }
                }.padding(12).background(TandemStyle.surface, in: RoundedRectangle(cornerRadius: 8))
            }
            if let status = message.status, status != "completed" {
                HStack(alignment: .top, spacing: 12) {
                    if status == "queued" || status == "running" {
                        ProgressView().controlSize(.small)
                        Text(status == "queued" ? "排队中" : "正在生成…").font(.callout).foregroundStyle(TandemStyle.secondary)
                        if let id = message.runId { Button("停止") { Task { await model.cancel(id) } }.buttonStyle(TandemButtonStyle(.plain)) }
                    } else {
                        VStack(alignment: .leading, spacing: 8) {
                            Text(userFacingError(message.errorCode ?? "INTERRUPTED")).font(.callout).foregroundStyle(status == "cancelled" ? Color.secondary : Color.red)
                            if let id = message.runId {
                                Button(model.selectedModel.isEmpty ? "使用原模型重试" : "使用所选模型重试") { Task { await model.retry(id) } }.disabled(model.sending)
                            }
                        }
                    }
                }
            }
            ViewThatFits(in: .horizontal) {
                HStack(spacing: 16) { metadata }
                VStack(alignment: .leading, spacing: 10) { metadata }
            }.font(.caption)
            if showRoute, let reason = message.routeReason {
                Text("话题选择：" + reason).font(.caption).foregroundStyle(TandemStyle.secondary)
            }
            if let historyError { Text(historyError).font(.caption).foregroundStyle(.red) }
            if let history {
                if history.corrections.isEmpty { Text("尚无归属纠正记录").font(.caption).foregroundStyle(TandemStyle.secondary) }
                ForEach(history.corrections) { record in
                    Text("\(model.projectTitle(record.from_project)) → \(model.projectTitle(record.to_project)) · \(Date(timeIntervalSince1970: record.created_at / 1000).formatted())")
                        .font(.caption).foregroundStyle(TandemStyle.secondary)
                }
            }
        }
        .sheet(isPresented: $showContext) { if let id = message.snapshotId { RunContextView(id: id, model: model) } }
        .padding(message.role == "user" ? 20 : 0)
        .background(message.role == "user" ? TandemStyle.surface : .clear, in: RoundedRectangle(cornerRadius: 12))
    }

    @ViewBuilder private var metadata: some View {
        if message.interactionId != nil {
            Menu {
                Button("未关联项目") { Task { await model.correct(message, projectId: "") } }
                ForEach((model.snapshot?.projects ?? []).filter { $0.status == "open" }) { project in
                    Button(project.title) { Task { await model.correct(message, projectId: project.id) } }
                }
            } label: { Label(model.projectTitle(message.projectId), systemImage: "folder") }
                .menuStyle(.borderlessButton).menuIndicator(.hidden).fixedSize(horizontal: false, vertical: true)
                .help("纠正此交互的项目归属").accessibilityLabel("项目归属：" + model.projectTitle(message.projectId))
        } else { Label(model.projectTitle(message.projectId), systemImage: "folder").foregroundStyle(TandemStyle.secondary) }
        if message.snapshotId != nil {
            Button { showContext = true } label: { Label("执行上下文", systemImage: "doc.text.magnifyingglass") }
                .buttonStyle(TandemButtonStyle(.plain)).foregroundStyle(TandemStyle.secondary)
        }
        Menu {
            if message.interactionId != nil {
                Button(history == nil ? "查看纠正记录" : "收起纠正记录") {
                    if history != nil { history = nil }
                    else {
                        Task {
                            do {
                                history = try await model.call("interaction.history", payload: ["interactionId": message.interactionId!], as: CorrectionHistory.self)
                                historyError = nil
                            } catch { historyError = "无法读取纠正记录，请重试。" }
                        }
                    }
                }
            }
            if message.role == "user", message.routeReason != nil { Button(showRoute ? "收起话题选择原因" : "查看话题选择原因") { showRoute.toggle() } }
        } label: { Image(systemName: "ellipsis") }
        .menuStyle(.borderlessButton).menuIndicator(.hidden).fixedSize().help("消息详情").accessibilityLabel("消息详情")
    }
}
