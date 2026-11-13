# Tandem

Personal Agent 的 M1 开发版本：原生 SwiftUI 聊天、多个模型接入、SQLite 连续历史与话题恢复。SwiftUI App 管理 Node Runtime，通过受保护的 Unix Domain Socket 通信。产品基线见 [产品与技术设计规范](docs/Personal_Agent_产品与技术设计规范_v1.0.md)。

## 开发环境

- Apple Silicon Mac；最低部署目标 macOS 14.0。本机验证环境为 macOS 27.2，未在 macOS 14 实机运行。
- Xcode 27.2 / Swift 6.4.2（SPM 使用 Swift 5 语言兼容模式）。
- Node **24.22.2**，pnpm **11.22.0**；TypeScript 和类型依赖已锁定。

```sh
pnpm install --frozen-lockfile
pnpm run build
pnpm run typecheck
pnpm run test
pnpm run dev
```

`build` 生成 `dist/Tandem.app`，内含当前已验证的 arm64 Node 可执行文件和编译后的 JavaScript；运行应用包不依赖 pnpm、工作目录或全局 Node。`dev` 构建后打开应用；也可直接打开该 `.app`。这是未做正式签名、公证的本地开发包。

## 使用 M1

1. 打开“模型设置”，添加接入项，选择协议和 API 类型，填写 API Base URL、Key 及模型名（每行一个）。
2. 选择并保存全局默认模型，或在输入框上方手动选择已配置模型。未设置默认时不会自动选用列表第一项。
3. 在 Assistant 输入消息。支持普通与流式文本响应，同话题的消息按顺序排队；失败后可使用原模型重试，或手动换模型再重试。
4. 使用“新话题 / 临时插话”标记下一条输入；临时讨论后可点击“恢复原话题”。最近话题侧栏可恢复历史讨论。Assistant 展示一份全局历史，话题标签说明每条消息的归属；发给模型的内容只包含当前话题的因果历史。

远程地址使用 HTTPS，HTTP 仅允许本机回环地址测试。Base URL 原样保留路径前缀，再追加 `/chat/completions`、`/responses` 或 `/messages`；需要 `/v1` 的服务，请在 Base URL 中填写它。不自动探测或切换 API 类型，不跟随 HTTP 重定向。

数据存放在 `~/.tandem/`：配置文件 `config.json` 权限 0600，目录 0700；Key 按产品基线明文保存，正常退出后保留，不写入业务 SQLite、聊天上下文或日志。聊天与话题使用 `tandem.sqlite`（WAL）。手工修改配置后重启或在设置中“重新加载”；保存遇到外部修改会拒绝覆盖。请勿提交本机配置文件。

关闭最后一个窗口后 Node 继续处理已接收的请求，点击 Dock 图标重新打开；使用 ⌘Q 完整退出会中断未完成请求。重新打开不会自动续跑，保留部分输出并提供手动重试。多窗口共享消息身份与顺序，各窗口焦点独立。

侧栏“运行状态”保留 M0 诊断入口，展示 Node PID、Ping/Pong、连接和重启次数，可手动断开重连或模拟 Runtime 崩溃。

## 检查

`pnpm run test` 包含配置冲突与权限、三种模型 API 的普通/流式契约、安全边界、队列/重试/历史恢复、SQLite 与 Swift 帧检查，以及真实 AssistantModel → Swift RPC → Node → 本机模拟模型端点的无窗口联调。测试使用隔离目录，不读取真实 Key，不调用付费模型。需要允许本机 Unix Socket 和 HTTP listen；受限执行环境可能需要常规本地执行权限。

`pnpm run test:lifecycle` 构建后启动真实应用包，用应用内自检关闭最后一个窗口、验证持续心跳、重开窗口并完整退出，检查内嵌 Node 已结束。需可用的 macOS 图形登录会话；该检查会短暂显示窗口。

日志输出到标准错误；App 窗口保留最近 100 条 Host 日志。需保存日志时可直接运行：

```sh
dist/Tandem.app/Contents/MacOS/Tandem 2> /tmp/tandem-m0.log
```

当前不包含 M2 的 Project、Interaction、语义路由与正式 Snapshot，也不执行工具。实现与验证记录：[M0](docs/M0_开发与验收.md) / [M1](docs/M1_开发与验收.md)。
