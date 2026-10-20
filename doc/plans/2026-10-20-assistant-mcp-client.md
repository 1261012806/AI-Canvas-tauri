# 助手 MCP URL 连接实施计划

目标：让通用对话、画布会话与独立助手窗口使用用户配置的外部 MCP 工具。

状态：核心功能已提交，提交钩子的定向 ESLint 通过；其他测试、类型检查、构建与桌面验收未执行。MCP 入口已按用户要求移到助手上方工具栏，位于智能体中心与任务中心之间，主窗口和独立窗口共用；本次入口调整未运行测试，待用户验收。

## 架构与边界

- 复用已安装的 TypeScript MCP SDK 的 Client 与 Streamable HTTP Transport。Rust `reqwest` 只向用户配置的固定端点转发受限 MCP 请求；不向 Agent 暴露任意 HTTP 工具，不新增 Node/Python 或另一版网络运行时。
- 全局配置保存连接 ID、名称、URL、修订与逐工具授权；认证只通过 `providerSecretService` 保存到原生 `secret_store`。URL 禁止嵌入凭据、查询参数和片段；HTTP 仅支持本机回环地址。主窗口为唯一连接与执行入口。
- 会话显式选择连接，默认不启用。工具发现、完整参数与执行分开，最多按需读取少量定义。远端描述、标注与结果均是不可信资料，不能作为权限或系统指令。
- 新增 `external_write` effect：Plan 拒绝，B 确认，C 自动执行。只读授权由用户明确选择，远端 readOnlyHint 不自动授予权限；外部写操作不自动重试。
- 授权绑定工具名称、说明及 schema 摘要；连接或授权修订、停用、删除、目录变化与会话撤销后，旧提案执行前重新校验。连接变化取消在途请求。
- 首期仅 Streamable HTTP、Bearer Token / X-API-Key；不支持 OAuth、旧 HTTP+SSE 端点、stdio、MCP Apps、sampling、roots、elicitation、资源和提示词。远端不响应时有超时，取消不承诺撤销远端已发生的副作用。

## 实施步骤

1. `src/types/mcpClient.ts`、`types/index.ts`、`types/chat.ts`：连接配置、授权及脱敏选项；`store.chat.ts` 增加会话选择 Action。
2. `src-tauri/src/mcp/client.rs`、`secret_store.rs`、`lib.rs` 与命令 ACL：固定端点代理、请求体/响应体/并发/超时限制、取消和凭据脱敏。使用现有 reqwest，禁止重定向与任意 URL 请求。
3. `src/services/mcp/mcpClientService.ts`：SDK 生命周期、取消、分页发现、内容预算、工具摘要及修订校验。工具通过 `chat/tools/externalMcpTools.ts` 注册，沿用 Registry、Policy、任务审计。
4. `src/components/settings/McpClientSettings.tsx`：连接增删改、发现、逐工具禁用/只读/写操作；设置页与助手工具栏复用 UI Kit。`McpConnectionPicker.tsx` 经 `ChatPanel.tsx` 装配到 `ChatHeader.tsx`，保留原选择弹窗和启用数量，输入区移除该入口，其他输入样式与布局保持不变。连接选择通过 `ChatAction` 回主窗口、名称投影通过快照/补丁同步，不下发 URL 或凭据。
5. 补充定向回归用例与模块文档；只进行允许的源码、引用、UTF-8 与差异空白核对。

## 桌面验收（待用户执行）

前置：Tauri 桌面端、已配置支持工具调用的文本模型，以及可信 Streamable HTTP MCP 测试服务。

1. 设置 → MCP → 外部 MCP 连接，添加 HTTPS 或本机 HTTP `/mcp` 地址，保存认证，读取工具；应显示真实目录，默认工具禁用，认证不回显。重开设置应保留连接与授权。
2. 选一个查询工具为只读、一个修改工具为写操作；启动页 AI 助手上方工具栏应显示 MCP，输入区不再显示 MCP，其他输入控件与样式保持原样。点击 MCP，在新会话选择连接后应显示启用数量；查询应返回服务的真实结果，未选择连接的新会话不能调用。无连接时仍能从该入口打开管理设置；列表、任务中心和设置专用会话不显示会话连接入口。
3. Plan 仅能查询，B 写操作等待确认，拒绝不调用，C 可执行明确启用的工具；确认期间停用连接、撤销会话选择或更改工具权限，旧提案不得执行。
4. 独立窗口选择连接并发送，再收回，选择保持一致；切换会话和项目不串用授权或消息。独立窗口快照不含 URL、认证或完整远端 schema。
5. 验收 401/403、错误地址、HTTP 非回环地址、超时、手动停止、超大响应、工具 schema 变化、分页工具目录与远端 isError。写请求失败或状态不确定不能自动重投。
6. 回归原有「外部客户端控制 AI Canvas」MCP 服务、通用对话、上传参考图、Skill 与画布操作，以及浅色/深色、小窗口与键盘交互。

运行目录为仓库根目录；后续获用户授权后可执行 `npx vitest run tests/services/mcpClientService.test.ts tests/services/chat/policyEngine.test.ts tests/services/chat/detachedChatSyncController.test.ts`。原生检查目录为 `src-tauri`，命令为 `cargo check --lib`；原生定向测试为 `cargo test --lib mcp_client::tests`。这些命令均未运行。实际增量体积须在相同构建配置下对比安装包，不把估算作为实测。

## 已实施内容与剩余缺口

连接管理、认证保存、逐工具授权、按需目录、实际调用、独立窗口选择投影、取消与权限复核已写入源码，并添加前端边界用例、Policy 矩阵用例和 Rust 端点/RPC/SSE 用例。会话选择变化轮换授权版本，重新勾选不能恢复旧审批；独立窗口空草稿快速多次选择复用新会话。动态参数通过有界 JSON 对象字符串传给本地封套，再交给远端工具，兼容不接受开放 object schema 的模型协议。仅进行源码、引用、UTF-8 和差异空白静态核对，不表示功能验收通过。

复用现有 TS SDK 和 reqwest，无 package/Cargo 依赖变更；SDK 使用 Zod 协议校验，不编译远端输出 schema，避免放松 CSP。OAuth、stdio、MCP Tasks、服务器发起请求和非文本结果暂不支持；实际协议互通、浅/深主题和双窗口 UI 待桌面验收。

## 回退

用户可停用连接、将工具设为禁用或取消会话勾选，立即撤销调用资格。代码回退只移除此功能入口和注册，不回滚此前通用助手改动；原有 inbound MCP bridge 不变。

参考：[MCP 官方架构](https://modelcontextprotocol.io/docs/learn/architecture)、[工具标注信任边界](https://blog.modelcontextprotocol.io/posts/2026-03-16-tool-annotations/)。
