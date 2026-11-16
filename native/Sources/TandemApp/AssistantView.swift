import SwiftUI
import TandemCore

private struct AppearanceOption {
    let value: String
    let symbol: String
    let title: String
    static let all = [
        AppearanceOption(value: "auto", symbol: "display", title: "跟随系统"),
        AppearanceOption(value: "light", symbol: "sun.max", title: "浅色"),
        AppearanceOption(value: "dark", symbol: "moon", title: "深色"),
    ]
}

struct AssistantView: View {
    @StateObject private var model: AssistantModel
    @ObservedObject private var runtime: RuntimeSupervisor
    @SceneStorage("tandem.surfaceId") private var surfaceId = ""
    @Environment(\.controlActiveState) private var controlActiveState
    @State private var claimedSurface = false
    @State private var readingPositionReady = false
    @State private var scrollPosition = ScrollPosition(edge: .bottom)
    @State private var navigation = EditorSelection(value: "assistant")
    @State private var hasUnsavedChanges = false
    @State private var editorBusy = false
    @State private var pendingSession: String?
    @State private var confirmNavigation = false
    @State private var showDiagnostics = false
    @State private var filterProject = "*"
    @State private var detailMessageId: String?
    @AppStorage(TandemAppearance.key) private var appearance = "auto"
    @AppStorage("tandem.sidebarWidth") private var sidebarWidth = 238.0
    @SwiftUI.FocusState private var composerFocused: Bool
    @GestureState private var sidebarDragOrigin: CGFloat?
    @State private var hoveringDivider = false
    @State private var scrollSettled = false

    init(runtime: RuntimeSupervisor) {
        _model = StateObject(wrappedValue: AssistantModel(runtime: runtime))
        self.runtime = runtime
    }

    var body: some View {
        HStack(spacing: 0) {
            sidebar
            sidebarDivider
            detail
        }
        .ignoresSafeArea(.container, edges: .top)
        .tint(TandemStyle.accent).foregroundStyle(TandemStyle.ink)
        .buttonStyle(TandemButtonStyle())
        .frame(minWidth: 860, minHeight: 600)
        .defaultFocus($composerFocused, true)
        .task {
            if !claimedSurface {
                surfaceId = ConversationPositionStore.shared.claimSurface(preferred: surfaceId)
                claimedSurface = true
            }
            if controlActiveState == .key { ConversationPositionStore.shared.activate(surfaceId) }
            await Task.yield()
            composerFocused = true
            await model.poll(surfaceId: surfaceId)
        }
        .onChange(of: controlActiveState) { _, state in
            if state == .key { ConversationPositionStore.shared.activate(surfaceId) }
        }
        .onChange(of: navigation.value) { _, _ in
            hasUnsavedChanges = false
            composerFocused = navigation.value == "assistant"
            detailMessageId = nil
        }
        .onChange(of: appearance) { _, value in TandemAppearance.apply(value) }
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

    private var sidebar: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 10) {
                Image(systemName: "circle.lefthalf.filled")
                    .foregroundStyle(TandemStyle.onAccent).padding(8)
                    .background(TandemStyle.accent, in: RoundedRectangle(cornerRadius: 9))
                Text("Tandem").font(.system(size: 22, weight: .semibold))
            }
            .padding(.top, 46).padding(.horizontal, 20).padding(.bottom, 24)
            .frame(maxWidth: .infinity, alignment: .leading)
            .gesture(WindowDragGesture())
            VStack(spacing: 4) {
                SelectionRow(title: "对话", symbol: "bubble.left.and.bubble.right", selected: navigation.value == "assistant") { navigate("assistant") }
                SelectionRow(title: "Activity", symbol: "list.bullet.rectangle", selected: navigation.value == "activity") { navigate("activity") }
                SelectionRow(title: "项目", symbol: "folder", selected: navigation.value == "projects") { navigate("projects") }
                SelectionRow(title: "长期记忆", symbol: "brain", selected: navigation.value == "memory") { navigate("memory") }
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
                }.padding(.horizontal, 12)
            }
            VStack(alignment: .leading, spacing: 10) {
                Divider()
                appearanceSwitcher
                Button { showDiagnostics = true } label: {
                    VStack(alignment: .leading, spacing: 8) {
                        Label("运行状态", systemImage: "waveform.path").font(.system(size: 13, weight: .medium))
                        Text("本地运行 · \(runtime.status)").font(.caption).foregroundStyle(TandemStyle.secondary)
                    }.frame(maxWidth: .infinity, alignment: .leading).padding(.vertical, 8).contentShape(Rectangle())
                }.buttonStyle(.plain)
            }.padding(20)
        }
        .background(TandemStyle.surface)
        .frame(width: CGFloat(sidebarWidth))
        .contentShape(Rectangle())
        .onTapGesture { composerFocused = false }
        .disabled(editorBusy)
    }

    private var sidebarDivider: some View {
        Rectangle()
            .fill(TandemStyle.surface)
            .frame(width: 6)
            .overlay(alignment: .trailing) { Rectangle().fill(TandemStyle.border).frame(width: 1) }
            .contentShape(Rectangle())
            .onHover { inside in
                guard inside != hoveringDivider else { return }
                hoveringDivider = inside
                if inside { NSCursor.resizeLeftRight.push() } else { NSCursor.pop() }
            }
            .gesture(
                // Global coordinates: the divider moves with the drag, so a local space feeds back on itself.
                DragGesture(minimumDistance: 1, coordinateSpace: .global)
                    .updating($sidebarDragOrigin) { _, origin, _ in
                        if origin == nil { origin = CGFloat(sidebarWidth) }
                    }
                    .onChanged { value in
                        let base = sidebarDragOrigin ?? CGFloat(sidebarWidth)
                        sidebarWidth = Double(min(300, max(200, base + value.translation.width)))
                    }
            )
            .accessibilityLabel("调整侧栏宽度")
    }

    private var detail: some View {
        ZStack {
            // Keep the scroll view mounted so page changes preserve its exact offset.
            conversation
                .opacity(navigation.value == "assistant" ? 1 : 0)
                .disabled(navigation.value != "assistant")
                .allowsHitTesting(navigation.value == "assistant")
                .accessibilityHidden(navigation.value != "assistant")
            if navigation.value == "settings" { ModelSettingsView(model: model, hasUnsavedChanges: $hasUnsavedChanges, busy: $editorBusy).ignoresSafeArea(.container, edges: .top) }
            else if navigation.value == "projects" { ProjectView(model: model, hasUnsavedChanges: $hasUnsavedChanges, working: $editorBusy).ignoresSafeArea(.container, edges: .top) }
            else if navigation.value == "activity" { ActivityView(model: model).ignoresSafeArea(.container, edges: .top) }
            else if navigation.value == "memory" { MemoryView(model: model, working: $editorBusy) { navigate("assistant", sessionId: $0) }.ignoresSafeArea(.container, edges: .top) }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(TandemStyle.canvas)
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
            }
            .contentShape(Rectangle())
            .onTapGesture { composerFocused = false }
            GeometryReader { geometry in
                ConversationScrollView(position: $scrollPosition,
                                       messages: model.messages.filter { filterProject == "*" || ($0.projectId ?? "") == filterProject },
                                       lastSequence: model.messages.last.flatMap { timelineSequences.contains($0.sequence) ? $0.sequence : nil },
                                       ready: readingPositionReady && navigation.value == "assistant", sending: model.sending,
                                       navigationHeight: max(0, geometry.size.height - 24), savePosition: saveReadingPosition,
                                       onScrollSettled: { if !readingPositionReady { scrollSettled = true } }) {
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
                                if model.snapshot?.models.isEmpty == true { Button("配置第一个模型") { navigate("settings") }.buttonStyle(TandemButtonStyle(.primary)) }
                            }.padding(.top, 64)
                        } else if timelineSequences.isEmpty {
                            Text("此项目暂无消息").foregroundStyle(TandemStyle.secondary).padding(.top, 64)
                        }
                        // Lazy scroll lookup needs a stable outer view before a message has been measured.
                        ForEach(timelineSequences, id: \.self) { sequence in
                            VStack(spacing: 20) {
                                if let message = model.messages.first(where: { $0.sequence == sequence }) {
                                    if let boundary = boundaryTitle(for: message) {
                                        HStack(spacing: 12) {
                                            Rectangle().fill(TandemStyle.border).frame(height: 1)
                                            Text(boundary).font(.caption).foregroundStyle(TandemStyle.secondary).lineLimit(1)
                                                .fixedSize(horizontal: false, vertical: true)
                                            Rectangle().fill(TandemStyle.border).frame(height: 1)
                                        }.padding(.vertical, 4)
                                    }
                                    MessageView(message: message, model: model,
                                                maximumWidth: max(1, min(724, geometry.size.width - 64)) * 0.7) {
                                        detailMessageId = message.id
                                    }
                                } else if let pending = model.snapshot?.pendingInteractions.first(where: { $0.sequence == sequence }) {
                                    PendingInteractionView(interaction: pending, model: model)
                                }
                            }.conversationMessageTarget(sequence)
                        }
                        ApprovalCards(model: model)
                        ForEach(model.snapshot?.activity.runs.filter { $0.status == "paused" } ?? []) { run in
                            VStack(alignment: .leading, spacing: 8) {
                                Text("执行预算已用尽：\(run.steps)/\(run.step_limit) 步 · \(run.tokens)/\(run.token_limit) Token · \(run.active_ms / 1000)/\(run.time_limit / 1000) 秒")
                                Button("在 Activity 查看进度与追加预算") { navigate("activity") }
                            }
                        }
                        Color.clear.frame(height: 1).id("bottom")
                    }
                    .scrollTargetLayout()
                    .frame(maxWidth: 724, alignment: .leading)
                    .padding(.horizontal, 32).padding(.vertical, 24)
                    .frame(maxWidth: .infinity)
                }
                // Hidden until the saved reading position is restored; otherwise the list visibly jumps
                // as messages arrive and the initial scroll correction lands.
                .opacity(readingPositionReady ? 1 : 0)
                .overlay {
                    if !readingPositionReady {
                        VStack(spacing: 16) {
                            ProgressView(runtime.isConnected ? "正在载入对话…" : "正在启动本地运行环境…")
                            Text(runtime.status).font(.caption).foregroundStyle(TandemStyle.secondary)
                        }
                    }
                }
                .contentShape(Rectangle())
                .onTapGesture { composerFocused = false }
                .task(id: model.snapshot?.generation) {
                    guard let generation = model.snapshot?.generation else { return }
                    readingPositionReady = false
                    let saved = ConversationPositionStore.shared.position(for: surfaceId, generation: generation)
                    if let filter = saved?.projectFilter,
                       filter == "*" || filter.isEmpty || model.snapshot?.projects.contains(where: { $0.id == filter }) == true {
                        filterProject = filter
                    }
                    guard !Task.isCancelled, model.snapshot?.generation == generation else { return }
                    await Task.yield()
                    scrollSettled = false
                    // A cold launch (and a topic switch) starts at the live end of the conversation.
                    // Page switches keep the mounted scroll view exactly where it was.
                    scrollPosition.scrollTo(edge: .bottom)
                    let deadline = ContinuousClock.now.advanced(by: .milliseconds(1500))
                    while !scrollSettled, ContinuousClock.now < deadline {
                        try? await Task.sleep(for: .milliseconds(20))
                    }
                    guard !Task.isCancelled, model.snapshot?.generation == generation else { return }
                    readingPositionReady = true
                }
            }
            composer
        }
        .ignoresSafeArea(.container, edges: .top)
        .inspector(isPresented: Binding(get: { detailMessageId != nil }, set: { if !$0 { detailMessageId = nil } })) {
            if let message = model.messages.first(where: { $0.id == detailMessageId }) {
                MessageDetailsView(message: message, model: model) {
                    detailMessageId = nil
                }.id(message.id).inspectorColumnWidth(min: 300, ideal: 360, max: 460)
            }
        }
        .onChange(of: model.messages.map(\.id)) { _, ids in
            if let id = detailMessageId, !ids.contains(id) { detailMessageId = nil }
        }
    }

    private func saveReadingPosition(_ viewport: ConversationViewport) {
        guard readingPositionReady, navigation.value == "assistant",
              let generation = model.snapshot?.generation, let sequence = viewport.visibleSequence else { return }
        ConversationPositionStore.shared.save(.init(generation: generation, sequence: sequence,
                                                     atBottom: viewport.isNearBottom, projectFilter: filterProject), for: surfaceId)
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
            VStack(alignment: .leading, spacing: 16) {
                if model.createTask || model.newTopic || model.temporary {
                    HStack(spacing: 12) {
                        if model.createTask {
                            Button { model.createTask = false } label: { Label("持续任务", systemImage: "xmark.circle.fill") }
                                .help("取消持续任务，保留已填写的要求")
                        }
                        if model.newTopic || model.temporary {
                            Button { model.newTopic = false; model.temporary = false } label: {
                                Label(model.temporary ? "下条为临时插话" : "下条为新话题", systemImage: "xmark.circle.fill")
                            }
                        }
                    }.buttonStyle(TandemButtonStyle(.plain)).font(.caption).foregroundStyle(TandemStyle.accent)
                }
                if model.createTask {
                    VStack(alignment: .leading, spacing: 10) {
                        TextField("预期交付物", text: $model.taskDeliverable)
                            .accessibilityLabel("预期交付物")
                        TextField("完成标准，每行一条", text: $model.taskCriteria, axis: .vertical).lineLimit(2...5)
                            .accessibilityLabel("完成标准")
                    }.textFieldStyle(.roundedBorder).font(.callout)
                }
                TextField("输入消息…", text: $model.draft, axis: .vertical)
                    .font(.system(size: 15)).lineLimit(2...7).textFieldStyle(.plain)
                    .focused($composerFocused)
                    .onSubmit { Task { await model.send() } }
                    .accessibilityLabel("消息内容")
                HStack(alignment: .center, spacing: 10) {
                    Menu {
                        Toggle("持续任务", isOn: $model.createTask)
                        Divider()
                        topicActions
                    } label: { Image(systemName: "plus").frame(width: 32, height: 32) }
                        .menuStyle(.borderlessButton).menuIndicator(.hidden).fixedSize()
                        .help("添加持续任务或切换话题").accessibilityLabel("添加消息选项")
                    ContextControls(model: model)
                    Spacer(minLength: 0)
                    TandemPicker(title: "模型", value: composerModelTitle, selection: $model.selectedModel) {
                        Text(defaultModelTitle).tag("")
                        ForEach(model.snapshot?.models ?? []) { option in Text("\(option.modelName) · \(model.connectionTitle(option.connectionId))").tag(option.id) }
                        if !model.selectedModel.isEmpty && !(model.snapshot?.models.contains { $0.id == model.selectedModel } ?? false) { Text("所选模型已失效").tag(model.selectedModel) }
                    }.labelsHidden().frame(maxWidth: 240).accessibilityLabel("模型").help(selectedModelTitle)
                    Button { Task { await model.send() } } label: {
                        Image(systemName: "arrow.up").font(.system(size: 14, weight: .semibold)).frame(width: 16, height: 16)
                    }
                    .buttonStyle(TandemButtonStyle(.primary))
                    .disabled(model.sending || model.snapshot == nil || model.draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                    .keyboardShortcut(.return, modifiers: .command)
                    .help("发送消息（⌘Return）").accessibilityLabel("发送消息")
                }.controlSize(.small).padding(.top, 8)
            }
            .padding(.horizontal, 18).padding(.top, 18).padding(.bottom, 10)
            .background(TandemStyle.canvas, in: RoundedRectangle(cornerRadius: 14))
            .overlay { RoundedRectangle(cornerRadius: 14).stroke(TandemStyle.inputBorder, lineWidth: 1) }
        }
        .frame(maxWidth: 724).padding(.horizontal, 32).padding(.top, 12).padding(.bottom, 20)
        .frame(maxWidth: .infinity).background(TandemStyle.canvas)
    }

    @ViewBuilder private var appearanceSwitcher: some View {
        if #available(macOS 26.0, *) {
            HStack(spacing: 0) {
                ForEach(AppearanceOption.all, id: \.value) { option in
                    Button { appearance = option.value } label: {
                        Image(systemName: option.symbol)
                            .font(.system(size: 13, weight: .medium))
                            .frame(width: 42, height: 30)
                            .background {
                                RoundedRectangle(cornerRadius: 9)
                                    .fill(appearance == option.value ? Color.primary.opacity(0.14) : .clear)
                            }
                            .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .foregroundStyle(appearance == option.value ? TandemStyle.ink : TandemStyle.secondary)
                    .help(option.title)
                    .accessibilityLabel(option.title)
                    .accessibilityAddTraits(appearance == option.value ? .isSelected : [])
                }
            }
            .glassEffect(.regular.interactive(), in: .rect(cornerRadius: 9))
        } else {
            Picker("外观", selection: $appearance) {
                ForEach(AppearanceOption.all, id: \.value) { Text($0.title).tag($0.value) }
            }
            .pickerStyle(.segmented).labelsHidden().fixedSize()
            .accessibilityLabel("外观")
        }
    }

    private var composerModelTitle: String {
        if model.selectedModel.isEmpty { return model.snapshot?.defaultModel.map { "默认 · " + $0.modelName } ?? "请选择模型" }
        return model.snapshot?.models.first { $0.id == model.selectedModel }?.modelName ?? "所选模型已失效"
    }
    private func boundaryTitle(for message: TimelineMessage) -> String? {
        let previous = model.messages.last { $0.sequence < message.sequence && (filterProject == "*" || ($0.projectId ?? "") == filterProject) }
        let topicChanged = previous?.sessionId != message.sessionId
        let projectChanged = previous?.projectId != message.projectId
        guard topicChanged || projectChanged else { return nil }
        var labels: [String] = []
        if topicChanged { labels.append(model.snapshot?.sessions.first { $0.id == message.sessionId }?.title ?? "历史话题") }
        if projectChanged { labels.append(model.projectTitle(message.projectId)) }
        return labels.joined(separator: " · ")
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

struct MessageView: View {
    let message: TimelineMessage
    @ObservedObject var model: AssistantModel
    var maximumWidth: CGFloat
    var showDetails: () -> Void
    private var isUser: Bool { message.role == "user" }

    var body: some View {
        VStack(alignment: isUser ? .trailing : .leading, spacing: 6) {
            VStack(alignment: .leading, spacing: 14) {
                if !isUser {
                    HStack(alignment: .firstTextBaseline, spacing: 8) {
                        Image(systemName: "circle.lefthalf.filled").foregroundStyle(TandemStyle.accent)
                        Text("Tandem").font(.system(size: 14, weight: .semibold))
                        if let name = message.modelName {
                            Text(name).font(.caption).foregroundStyle(TandemStyle.secondary).lineLimit(1)
                                .help("\(name) · \(model.connectionTitle(message.connectionId))")
                        }
                    }
                }
                if !message.content.isEmpty {
                    if isUser {
                        Text(message.content).font(.system(size: 15)).textSelection(.enabled)
                            .lineSpacing(6).multilineTextAlignment(.leading)
                            .fixedSize(horizontal: false, vertical: true)
                            .accessibilityLabel("你：" + message.content)
                    } else { MarkdownView(message.content) }
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
                        } else if status == "waiting_approval" {
                            Text("等待目录授权，请在审批卡片中处理。")
                                .font(.callout).foregroundStyle(TandemStyle.secondary)
                        } else if status == "paused" {
                            Text("执行已暂停，请在 Activity 查看进度与预算。")
                                .font(.callout).foregroundStyle(TandemStyle.secondary)
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
            }
            .padding(isUser ? 16 : 0)
            .background(isUser ? TandemStyle.surface : .clear, in: RoundedRectangle(cornerRadius: 16))
            Menu {
                Button(isUser ? "复制消息" : "复制 Markdown") {
                    NSPasteboard.general.clearContents()
                    NSPasteboard.general.setString(message.content, forType: .string)
                }
                Button("消息详情与来源", action: showDetails)
                if message.interactionId != nil {
                    Menu("纠正项目归属") {
                        Button("未关联项目") { Task { await model.correct(message, projectId: "") } }
                        ForEach((model.snapshot?.projects ?? []).filter { $0.status == "open" }) { project in
                            Button(project.title) { Task { await model.correct(message, projectId: project.id) } }
                        }
                    }
                }
            } label: { Image(systemName: "ellipsis").frame(width: 24, height: 22) }
                .menuStyle(.borderlessButton).menuIndicator(.hidden).fixedSize()
                .foregroundStyle(TandemStyle.secondary).help("消息详情与项目归属").accessibilityLabel("消息操作")
        }
        .frame(maxWidth: isUser ? maximumWidth : .infinity, alignment: isUser ? .trailing : .leading)
        .frame(maxWidth: .infinity, alignment: isUser ? .trailing : .leading)
    }
}

private struct MessageDetailsView: View {
    let message: TimelineMessage
    @ObservedObject var model: AssistantModel
    var close: () -> Void
    @State private var context: RunContext?
    @State private var history: CorrectionHistory?
    @State private var contextError: String?
    @State private var historyError: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack {
                Text("消息详情").font(.headline)
                Spacer()
                Button(action: close) { Image(systemName: "xmark").frame(width: 24, height: 24) }
                    .buttonStyle(TandemButtonStyle(.plain)).help("关闭详情").accessibilityLabel("关闭消息详情")
            }.padding(20)
            Divider()
            ScrollView {
                VStack(alignment: .leading, spacing: 24) {
                    VStack(alignment: .leading, spacing: 8) {
                        Text(message.role == "user" ? "你的消息" : "Tandem 的回答").font(.headline)
                        Text(model.snapshot?.sessions.first { $0.id == message.sessionId }?.title ?? "历史话题")
                        if let name = message.modelName { Text("\(name) · \(model.connectionTitle(message.connectionId))").font(.caption).foregroundStyle(TandemStyle.secondary) }
                        Text(message.content).font(.callout).lineLimit(6).textSelection(.enabled)
                    }
                    VStack(alignment: .leading, spacing: 10) {
                        Text("项目归属").font(.headline)
                        Text(model.projectTitle(message.projectId)).font(.callout)
                        if message.interactionId != nil {
                            Menu("纠正项目归属") {
                                Button("未关联项目") { Task { await model.correct(message, projectId: "") } }
                                ForEach((model.snapshot?.projects ?? []).filter { $0.status == "open" }) { project in
                                    Button(project.title) { Task { await model.correct(message, projectId: project.id) } }
                                }
                            }.fixedSize()
                        }
                        if let reason = message.routeReason { Text("话题选择：" + reason).font(.caption).foregroundStyle(TandemStyle.secondary) }
                    }
                    if let id = message.snapshotId {
                        Divider()
                        VStack(alignment: .leading, spacing: 12) {
                            Text("执行上下文").font(.headline)
                            if let context {
                                Text("\(model.projectTitle(context.projectId)) · \(context.mode)").font(.caption).foregroundStyle(TandemStyle.secondary)
                                ContextFragmentsView(context: context, model: model)
                            } else if let contextError { Text(contextError).font(.callout).foregroundStyle(.red) }
                            else { ProgressView() }
                        }
                        .task(id: "\(id):\(model.snapshot?.focus.contextMode ?? "automatic"):\(model.snapshot?.focus.activeProjectId ?? "")") {
                            context = nil; contextError = nil
                            do {
                                let result = try await model.context(id)
                                if !Task.isCancelled { context = result }
                            } catch { if !Task.isCancelled { contextError = "当前范围无法查看此快照，请先切换项目或上下文模式。" } }
                        }
                    }
                    if message.interactionId != nil {
                        Divider()
                        VStack(alignment: .leading, spacing: 10) {
                            Text("归属纠正记录").font(.headline)
                            if let history {
                                if history.corrections.isEmpty { Text("尚无纠正记录").font(.caption).foregroundStyle(TandemStyle.secondary) }
                                ForEach(history.corrections) { record in
                                    Text("\(model.projectTitle(record.from_project)) → \(model.projectTitle(record.to_project))\n\(Date(timeIntervalSince1970: record.created_at / 1000).formatted())")
                                        .font(.caption).foregroundStyle(TandemStyle.secondary)
                                }
                            } else if let historyError { Text(historyError).font(.callout).foregroundStyle(.red) }
                            else { ProgressView() }
                        }
                        .task(id: message.interactionVersion) {
                            history = nil; historyError = nil
                            do {
                                let result = try await model.call("interaction.history", payload: ["interactionId": message.interactionId!], as: CorrectionHistory.self)
                                if !Task.isCancelled { history = result }
                            } catch { if !Task.isCancelled { historyError = "无法读取纠正记录，请关闭详情后重试。" } }
                        }
                    }
                }.padding(20).frame(maxWidth: .infinity, alignment: .leading)
            }
        }
        .background(TandemStyle.canvas).foregroundStyle(TandemStyle.ink)
    }
}
