import SwiftUI
import TandemCore

struct AssistantView: View {
    @StateObject private var model: AssistantModel
    @SceneStorage("tandem.surfaceId") private var surfaceId = UUID().uuidString
    @State private var section = "assistant"
    @State private var showDiagnostics = false

    init(runtime: RuntimeSupervisor) { _model = StateObject(wrappedValue: AssistantModel(runtime: runtime)) }

    var body: some View {
        NavigationSplitView {
            List {
                Section {
                    Button { section = "assistant" } label: { Label("Assistant", systemImage: "bubble.left.and.bubble.right") }
                    Button { section = "settings" } label: { Label("模型设置", systemImage: "slider.horizontal.3") }
                }
                Section("最近话题") {
                    ForEach(model.snapshot?.sessions ?? []) { session in
                        Button {
                            section = "assistant"
                            Task { await model.focus(session.id) }
                        } label: {
                            HStack {
                                Image(systemName: session.temporary == 1 ? "bubble.left" : "text.bubble")
                                Text(session.title).lineLimit(2)
                                Spacer(minLength: 0)
                                if session.id == model.snapshot?.focus.activeSessionId { Image(systemName: "checkmark").foregroundStyle(.tint) }
                            }
                        }
                        .buttonStyle(.plain)
                        .padding(.vertical, 4)
                    }
                }
            }
            .navigationTitle("Tandem")
            .listStyle(.sidebar)
            .safeAreaInset(edge: .bottom) {
                Button { showDiagnostics = true } label: { Label("运行状态", systemImage: "network") }
                    .buttonStyle(.plain).padding()
            }
            .navigationSplitViewColumnWidth(min: 200, ideal: 240)
        } detail: {
            if section == "settings" { ModelSettingsView(model: model) }
            else { conversation }
        }
        .frame(minWidth: 860, minHeight: 600)
        .task { await model.poll(surfaceId: surfaceId) }
        .sheet(isPresented: $showDiagnostics) {
            VStack {
                DiagnosticsView(runtime: model.runtime)
                Button("关闭") { showDiagnostics = false }.keyboardShortcut(.cancelAction).padding(.bottom)
            }
        }
    }

    private var conversation: some View {
        VStack(spacing: 0) {
            HStack(alignment: .center) {
                VStack(alignment: .leading, spacing: 4) {
                    Text("Assistant").font(.title2.weight(.semibold))
                    Text(activeTitle).font(.callout).foregroundStyle(.secondary).lineLimit(1)
                }
                Spacer()
                if let interrupted = model.snapshot?.focus.interruptedSessionId {
                    Button("恢复原话题") { Task { await model.focus(interrupted) } }
                }
                Menu {
                    Button("新话题") { model.newTopic = true; model.temporary = false }
                    Button("临时插话") { model.temporary = true; model.newTopic = false }
                } label: { Label("新话题", systemImage: "square.and.pencil") }
            }
            .padding(20)
            Divider()
            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 24) {
                        if model.hasMore { Button("加载更早的消息") { Task { await model.loadEarlier() } }.frame(maxWidth: .infinity) }
                        if model.messages.isEmpty {
                            VStack(alignment: .leading, spacing: 12) {
                                Text("从一个想法开始").font(.title.weight(.medium))
                                Text("直接输入，话题与历史保存在本机。\n首次使用，请先在模型设置中添加接入项。").foregroundStyle(.secondary)
                            }
                            .padding(.top, 72)
                        }
                        ForEach(model.messages) { message in MessageView(message: message, model: model) }
                        Color.clear.frame(height: 1).id("bottom")
                    }
                    .padding(24)
                    .frame(maxWidth: 820, alignment: .leading)
                    .frame(maxWidth: .infinity)
                }
                .onChange(of: model.messages.last?.id) { _, _ in proxy.scrollTo("bottom", anchor: .bottom) }
            }
            Divider()
            VStack(alignment: .leading, spacing: 10) {
                if let error = model.error { Text(error).font(.callout).foregroundStyle(.red).textSelection(.enabled) }
                if let error = model.snapshot?.configError {
                    Button(userFacingError(error) + " 打开模型设置") { section = "settings" }.foregroundStyle(.red)
                }
                HStack {
                    Picker("模型", selection: $model.selectedModel) {
                        Text(defaultModelTitle).tag("")
                        ForEach(model.snapshot?.models ?? []) { option in
                            Text("\(option.modelName) · \(option.connectionId)").tag(option.id)
                        }
                        if !model.selectedModel.isEmpty && !(model.snapshot?.models.contains { $0.id == model.selectedModel } ?? false) {
                            Text("所选模型已失效").tag(model.selectedModel)
                        }
                    }
                    .labelsHidden().frame(maxWidth: 360)
                    Spacer()
                    if model.newTopic || model.temporary {
                        Button(model.temporary ? "下条为临时插话 ×" : "下条为新话题 ×") { model.newTopic = false; model.temporary = false }
                            .buttonStyle(.borderless)
                    }
                }
                HStack(alignment: .bottom, spacing: 12) {
                    TextField("输入消息…", text: $model.draft, axis: .vertical)
                        .lineLimit(2...7).textFieldStyle(.plain)
                        .onSubmit { Task { await model.send() } }
                    Button { Task { await model.send() } } label: { Image(systemName: "arrow.up").font(.headline).padding(6) }
                        .buttonStyle(.borderedProminent)
                        .disabled(model.sending || model.snapshot == nil || model.draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                        .keyboardShortcut(.return, modifiers: .command)
                        .help("发送消息（⌘Return）").accessibilityLabel("发送消息")
                }
                .padding(12)
                .background(.background, in: RoundedRectangle(cornerRadius: 12))
                .overlay(RoundedRectangle(cornerRadius: 12).stroke(.quaternary))
                Text("全局连续历史 · 模型仅接收当前话题的相关消息").font(.caption).foregroundStyle(.secondary)
            }
            .padding(20)
            .background(.bar)
        }
    }

    private var activeTitle: String {
        model.snapshot?.sessions.first { $0.id == model.snapshot?.focus.activeSessionId }?.title ?? "准备开始新话题"
    }
    private var defaultModelTitle: String {
        if let selected = model.snapshot?.defaultModel { return "默认：\(selected.modelName) · \(selected.connectionId)" }
        return "使用全局默认（尚未设置）"
    }
}

private struct MessageView: View {
    let message: TimelineMessage
    @ObservedObject var model: AssistantModel

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Text(message.role == "user" ? "你" : "Tandem").font(.callout.weight(.semibold))
                if let name = message.modelName {
                    Text("\(name) · \(message.connectionId ?? "")").font(.caption).foregroundStyle(.secondary)
                }
                Spacer()
                Text(model.snapshot?.sessions.first { $0.id == message.sessionId }?.title ?? "历史话题")
                    .font(.caption).foregroundStyle(.tertiary).lineLimit(1).frame(maxWidth: 180, alignment: .trailing)
            }
            if !message.content.isEmpty {
                Text(message.content).textSelection(.enabled).lineSpacing(5).frame(maxWidth: .infinity, alignment: .leading)
            }
            if let status = message.status, status != "completed" {
                HStack(alignment: .top) {
                    if status == "queued" || status == "running" {
                        ProgressView().controlSize(.small)
                        Text(status == "queued" ? "排队中" : "正在生成…").font(.callout).foregroundStyle(.secondary)
                        if let id = message.runId { Button("停止") { Task { await model.cancel(id) } }.buttonStyle(.borderless) }
                    } else {
                        VStack(alignment: .leading, spacing: 6) {
                            Text(userFacingError(message.errorCode ?? "INTERRUPTED")).font(.callout).foregroundStyle(status == "cancelled" ? Color.secondary : Color.red)
                            if let id = message.runId {
                                Button(model.selectedModel.isEmpty ? "使用原模型重试" : "使用所选模型重试") { Task { await model.retry(id) } }
                                    .disabled(model.sending)
                            }
                        }
                    }
                }
            }
        }
        .padding(message.role == "user" ? 14 : 0)
        .background(message.role == "user" ? Color.primary.opacity(0.045) : .clear, in: RoundedRectangle(cornerRadius: 10))
    }
}
