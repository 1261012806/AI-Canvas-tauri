# 通用助手与会话体验改进

**目标**：启动页和独立窗口无需打开画布即可进行有历史的通用对话，复用现有 Agent、文件授权、Skill、联网和厂商配置能力。
**架构**：增加应用级对话归属标识，沿用现有会话、消息、任务持久化；不创建 CanvasProject。主窗口仍为唯一写入源，通用工具由固定白名单与任务白名单共同约束，现有 Policy 保持生效。
**技术栈**：现有 React、Zustand、IndexedDB、Tauri、UI Kit，不新增依赖。
**状态**：通用助手与外部 MCP 改动已提交，提交钩子的定向 ESLint 通过；其他测试、类型检查、构建和桌面验收未执行。下述 Grok 风格展示调整已实现，本次未运行测试，待用户验收。

## GitHub 对照（2026-10-20）

| 项目 | 查询时星数 | 已读源码 | 采用的机制 |
|---|---:|---|---|
| [Cherry Studio](https://github.com/CherryHQ/cherry-studio) | 52,769 | [EmptyState](https://github.com/CherryHQ/cherry-studio/blob/5967cf357a4f619b6e01b4c21d8e0d024400989c/src/renderer/components/chat/primitives/EmptyState.tsx) | 欢迎信息、主要动作和建议入口各自清晰，使用统一组件 |
| [Open WebUI](https://github.com/open-webui/open-webui) | 156,209 | [Suggestions](https://github.com/open-webui/open-webui/blob/91ea4e3421d1d8069f13d4a463fcb5986d94ea60/src/lib/components/chat/Suggestions.svelte) | 建议带用途说明，点击预填输入，保持用户对发送的控制 |
| [LibreChat](https://github.com/LibreChat-AI/LibreChat) | 46,022 | [Thinking](https://github.com/LibreChat-AI/LibreChat/blob/e081b566a42d3a83b8102157bd7806cf4ff63b17/client/src/components/Chat/Messages/Content/Parts/Thinking.tsx) | 公开推理内容独立折叠，活动与完成状态可区分，支持键盘访问 |

上述内容仅作为交互与职责划分的参考，实现使用本项目组件、样式 token 和执行链。

## 范围与实施顺序

1. **归属与边界**：新增 `services/chat/assistantScope.ts`；通用会话使用固定应用级标识，工具列表仅含联网、已授权文本读写、Skill 读取和厂商配置。`toolRegistry.ts` 和 `agentRoundExecutor.ts` 在发现、准备、审批后执行三个边界复核；`agentTaskControl.ts` 适配通用任务恢复与活动会话审批，仍复核真实工具和任务白名单。通用对话不能执行画布、项目资产、媒体生成或其他项目工具。
2. **会话与入口**：调整 `store.chat.ts`、`store.projects.ts`、`ChatPanel.tsx`、`detachedChatSyncController.ts` 和 `ProjectLibraryModal.tsx`。启动页提供 AI 助手入口；通用历史与项目历史隔离，重启遗留任务恢复为暂停；异步加载不得清掉刚创建的会话或消息。图片附件复用受限项目文件基础设施的独立应用级归属目录，不创建项目记录。
3. **回答与工具**：调整 `assistantStream.ts`、`conversationExecutionController.ts`、`contextManager.ts`、`chatImageReferenceService.ts`。问答、写作与分析按任务内容充分回答；通用对话不注入其他项目节点摘要，不因无画布而拒绝普通任务。追问合并尚未落盘的当前会话消息，仍排除其他会话和当前轮次占位；现有 `agentPromptGuidance.ts` 继续根据实际工具刷新说明。
4. **界面**：整理 `EmptyChatState.tsx`、`ChatMessages.tsx`、`ChatHeader.tsx`、`ReasoningPanel.tsx`、`MessageBubble.tsx`，新增 `styles/assistant.css` 并由 `index.css` 聚合。复用 UI Kit，使用通用建议与可选画布建议、明确的范围标签、可折叠的公开推理与有界阅读宽度。主窗口和独立窗口一致，保留草稿、队列、停止、恢复及减少动态效果。

## 设计约束

- 通用对话和项目对话使用同一套组件；通用模式显示“通用对话”，项目模式显示项目名称。欢迎页以问答、写作、资料分析为主要建议，有画布时再提供画布操作建议。
- 输入区在空会话中仍可直接使用；首次发送创建对应归属的会话。示例只预填，不自动产生模型调用。
- 保持 `p-2/p-3`、`ui-btn/ui-card/ui-alert` 和 `canvas-*` token；不新增硬编码颜色或另一套输入框样式。
- 模型只显示接口返回的公开推理，不生成假的思考内容，不持久化原始推理；任务活动、工具结果和回答分开呈现。
- 文件授权按会话隔离；参考图限制和无路径引用沿用现状。没有有效画布时不提供媒体生成和画布写工具；打开项目后仍沿用原模式与权限。

## 验收（待用户执行）

前置：Tauri 桌面端已配置有效文本模型；联网和文件能力需要原生运行环境。

1. 在启动页点击 AI 助手，不打开项目，直接问答、润色一段文字、连续追问上一轮内容；应正常回复并保留历史，项目列表不新增虚拟项目。
2. 新建两个通用会话并切换；打开项目再返回启动页；项目会话与通用会话、草稿和附件互不混入。
3. 在通用对话上传文本与 PNG/JPEG/WebP 图片，要求总结或分析；文字按会话 grant 读取，图片沿用原有数量和大小限制，不写入画布。
4. 调用已有 Skill、读取 HTTPS 资料；B 模式保存文本或厂商配置应等待现有审批，Plan 拒绝写入，C 沿用现有自动策略。
5. 在通用对话要求删除节点或生成媒体，应说明需打开项目，不执行其他项目的操作。即使模型伪造工具名或 Skill 声明更多工具，也不能突破通用范围。
6. 主窗口与独立窗口分别进行上述步骤；切换窗口时草稿、附件、模型和活动状态一致。运行中切项目时，通用任务可以完成且不写入新项目。
7. 启动未完成任务后退出并重启，应显示暂停；历史可恢复，不自动重放工具或付费调用。
8. 深浅主题、320px 窄窗口与宽独立窗口：文字/代码可读，欢迎建议可用键盘操作，推理折叠和活动状态清晰；减少动态效果设置继续生效。

已补充回归用例：通用归属、工具白名单与 Skill 交集、审批后撤权、通用恢复与审批入口、持久化加载竞态、未落盘追问、无画布系统提示词、独立窗口首次发送和通用参考图。以下命令由用户在仓库根目录按需执行；尚未运行，不代表通过：

```powershell
npm run test -- tests/store/chat.test.ts tests/services/assistantStreamProtocol.test.ts tests/services/chat/toolRegistry.test.ts tests/services/chat/agentToolExecution.test.ts tests/services/chat/agentTaskControl.test.ts tests/services/chat/agentConversationContext.test.ts tests/services/chat/conversationExecutionController.test.ts tests/services/chat/detachedChatSyncController.test.ts tests/services/chat/chatImageReferenceService.test.ts tests/components/agentActivity.test.tsx
npm run typecheck
npm run test:typecheck
```

静态核对已完成：按调用链检查了模型分流、应用级会话持久化、主窗口写入、三处工具范围限制、审批与恢复、历史合并和附件归属；相关文本均为有效 UTF-8，无替换字符，差异空白检查无报错。真实模型、文件选择器、窗口切换和双主题布局均待桌面验收。

## 回滚

撤销本轮通用归属和界面改动；现有项目历史不迁移、不删除。新增通用记录保留在现有数据库，图片保留在独立归属目录；无原生权限、数据库 schema 或依赖变化。

## Grok 风格的消息与活动展示（2026-10-20）

参考 xAI 官方 [Grok 产品页](https://x.ai/grok)的简洁层级，以及 Apache-2.0 项目 [Grok Build](https://github.com/xai-org/grok-build) 中的[思考折叠实现](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-pager/src/scrollback/blocks/thinking.rs)。Grok Build 公开的是智能体运行时和终端界面，不能视作 grok.com 网页源码；本次使用本项目组件和主题变量实现展示，不复制其界面代码。

- **范围**：新增 `AssistantActivity.tsx` 统一连接、分析、压缩和工具执行的活动标记；调整 `ReasoningPanel.tsx`、`MessageBubble.tsx`、`AgentTaskTimeline.tsx`、`AgentStepCard.tsx` 与 `styles/assistant.css`。输入框本体保留当前尺寸、样式和发送行为；后续按用户要求将 MCP 移到顶部工具栏，并移除输入框下方的提示文字。
- **展示**：助手回答采用平整阅读区，用户气泡使用主题中性色；思考保留原生折叠、键盘访问与有界滚动，展开后使用细侧线区分正文。状态文字保持稳定，活动使用小型轨道标记；合并时间线内重复的活动提示，外部 MCP 显示对应发现/读取/执行状态。完成、暂停、停止和失败后不再旋转。
- **边界**：只展示真实消息、任务和模型接口返回的临时思考内容；不新增计时器、假思考、阶段进度或持久化字段。保持审批、恢复、工具权限和主窗口单点写入；减少动态效果时使用静态标记，性能模式关闭中心呼吸，只保留必要旋转。
- **验收**：待用户在 Tauri 桌面端分别检查主窗口和独立窗口的连接、思考、输出、上下文压缩、工具和媒体等待；完成/暂停/停止/失败后活动停止；折叠区可用键盘展开，长内容不撑开窄窗口。明暗主题、窄窗口、减少动态效果与性能模式下状态仍可读；输入区与修改前一致。无模型思考字段时不应出现思考内容，流式文字分片不应反复播放入场动画。
- **回滚**：只撤销本节展示组件和业务样式改动，无依赖、存储、协议或原生权限变化。

发送与流式更新的滚动边界：`ChatPanel.tsx` 原先对末尾元素调用 `scrollIntoView()`，可能滚动祖先容器，使顶部内容上移、底部出现额外留白。已改为从当前面板 ref 定位消息列表，并只调用该列表的 `scrollTo()`；保持既有面板尺寸和输入框样式，减少动态效果时直接定位。状态：已实现，本次未运行测试，待用户验收。桌面验收：在主窗口与独立窗口分别发送短消息、连续追问及长回复，流式更新和继续任务时顶部标题、输入框与外框位置应保持稳定；长消息只在消息区滚动。窄窗口、输入多行、切换会话和减少动态效果下重复检查，确认输入区仍使用原样式。

留白与提示调整：标题栏上下内边距由 10px 收紧至 8px；删除输入框下方“重要操作执行前会请求确认”的整行提示，保留 8px 底部内边距，输入框本体外观与尺寸不变。工具栏不再常驻显示发送快捷键，悬浮发送按钮时展示当前发送/换行快捷键及右键设置入口，快捷键行为和真实审批机制不变。此项同样待桌面验收：主窗口与独立窗口均不再显示底部提示，输入框与面板边缘保留间隔，发送、流式更新及切换会话后标题和底部位置稳定；输入文字后快捷键不占据工具栏，悬浮发送按钮可见说明，右键修改快捷键后提示随设置更新。
