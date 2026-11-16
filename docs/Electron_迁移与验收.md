# Electron 迁移与验收

2026-11-16。迁移分支：`codex/electron-react-migration`，基于 `feat/electron-ui` 的 `98b6909`。

## 实现边界

SwiftUI 页面与 Swift 宿主迁为 Electron + React + TypeScript，首版仍支持 Apple Silicon / macOS 15+。旧 Swift 源码与测试由 Git 历史保留，默认开发、类型检查、测试、打包均不再调用 Swift 或 Xcode；图标移到 `resources/`。业务运行时、pi SDK、SQLite Schema、配置 revision、备份格式与 `~/.tandem` 数据目录保持原有契约。

Electron 主进程守护独立的 Node 24.22.2，保留带长度前缀的 RPC、私有 Socket 目录、stdin 引导密钥、内核 UID/PID 对端校验、心跳、重连、退避重启和退出清理。关闭最后一个窗口继续处理已接收工作，Dock 激活重开窗口，Cmd+N 新建独立窗口，Cmd+Q 完整退出。业务不会搬到 renderer 或 Electron 的 Node 版本上运行。

renderer 开启 context isolation 与 sandbox，关闭 Node integration，只经受限 preload API 访问宿主。主进程校验 IPC 来源窗口及主 frame，并绑定窗口自己的 surfaceId。目录与备份路径只来自系统文件对话框；renderer 不可直接注册路径、读取文件或提交原生工具结果。目录授权通过 Koffi 的预编译 arm64 绑定使用系统 `openat`、`O_NOFOLLOW` 和 `F_GETPATH`，保留目录身份、读取前后版本、UTF-8、行数、大小、时限与撤销检查。

## 页面与视觉

基准是迁移前 SwiftUI 的实际代码和灰阶主题，仓库早期绿色设计图只作为历史参考。React 页面使用系统字体；浅色和深色色值、默认 238 pt 侧栏、724 pt 对话列、用户气泡最多 70%、编辑页主从布局、窄窗单列、圆角、边框、阴影、焦点与轻微悬停反馈沿用原实现的规则。Radix 提供菜单、选择器、弹层、对话框、开关及键盘行为，Tailwind/CSS 负责样式；没有加入额外动效框架或通用组件目录。

| 页面 | 迁移内容 |
| --- | --- |
| 对话 | 全局时间线、流式输出、模型选择、新话题/临时插话、上下文范围、归属确认、项目筛选、消息导航、详情与来源、纠正与重试、审批、持续任务输入 |
| Activity | 目录授权/续授权/撤销、共享审批、持续任务修订与历史交付、执行/步骤/来源、预算追加、继续/取消/重试、Markdown 报告 |
| 项目 | 创建/编辑、版本冲突、归档/恢复、删除影响预览及独立确认、未保存修改保护 |
| 长期记忆 | 搜索、分组、状态、用户证据、确认/修正、来源话题、手动保存、遗忘确认与允许重新记住 |
| 模型设置 | 供应商身份与名称、协议/API、URL/Key、逐项模型管理、默认模型、revision 保存/重新加载、备份导出/预览/恢复 |

聊天和报告共用安全 Markdown：表格、列表、引用、代码高亮与复制；不执行原始 HTML，不加载图片，HTTP(S) 链接仅主动点击时交给系统打开。减少动态效果设置生效。

界面偏好单独保存在 Electron userData 的 `ui-preferences.json`。首次运行从旧应用的 plist 导入外观、侧栏、最后活动窗口和阅读锚点；各窗口保持独立 surface 与阅读位置，外观和侧栏宽度在窗口间同步。恢复备份后的新 generation 不复用旧消息锚点或目录授权。

## 验证方式

本次已通过类型检查、构建、94 项运行时/宿主测试与 8 项 React 交互测试；独立应用包的完整业务联调、打包后的窗口生命周期和 Vite 开发页面的 React/preload 初始化也已通过。检查均使用临时数据与本机模拟模型。

- `pnpm run typecheck`：运行时、Electron、preload、共享类型和 React。
- `pnpm run test:unit`：既有运行时回归、macOS 目录与 Socket 身份、偏好迁移、消息合并/代次、React 配置/编辑/删除/Markdown/中文输入/幂等交互。
- `pnpm run test:smoke`：真实 Electron → Node 的三 API、重连/崩溃、路由、任务、目录读取、记忆和备份恢复链路，使用本机模拟服务及临时数据。
- `pnpm run build` 与 `pnpm run test:bundle`：独立 `.app`、内部相对依赖链接、最小 PATH 运行和子进程清理。
- `pnpm run test:lifecycle`：真实 React/preload 初始化、关窗后台执行、重开及退出；需要图形会话，会短暂显示窗口。

未进行人工逐像素视觉比对、macOS 15 实机验证、正式签名/公证、Windows/Linux 适配。Electron 的字体栅格化与控件渲染仍可能与 SwiftUI 存在细节差异，视觉一致性需在实际窗口中最终核对。
