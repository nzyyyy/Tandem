# Tandem

Personal Agent 的 M0 开发版本：SwiftUI App 管理 Node Runtime，通过受保护的 Unix Domain Socket 验证进程通信与生命周期。产品基线见 [产品与技术设计规范](docs/Personal_Agent_产品与技术设计规范_v1.0.md)。

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

诊断窗口展示连接状态、Node PID、Ping/Pong、连接与重启次数。可点击“断开并重连”与“模拟 Runtime 崩溃”验证恢复。关闭最后一个窗口后进程继续运行，点击 Dock 图标重新打开，使用 ⌘Q 完整退出。

## 检查

`pnpm run test` 包含 Node 协议/安全边界/SQLite 检查、Swift 帧与对端 PID 检查，以及真实 Swift → Node 的无窗口进程联调。需要允许本机 Unix Socket；受限执行环境可能需要常规本地执行权限。

`pnpm run test:lifecycle` 构建后启动真实应用包，用应用内自检关闭最后一个窗口、验证持续心跳、重开窗口并完整退出，检查内嵌 Node 已结束。需可用的 macOS 图形登录会话；该检查会短暂显示窗口。

日志输出到标准错误；App 窗口保留最近 100 条 Host 日志。需保存日志时可直接运行：

```sh
dist/Tandem.app/Contents/MacOS/Tandem 2> /tmp/tandem-m0.log
```

M0 不保存业务数据或模型凭据。实现范围、IPC 约定与实际验证结果见 [M0 开发与验收](docs/M0_开发与验收.md)。
