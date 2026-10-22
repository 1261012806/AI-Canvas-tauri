# ComfyUI 第一批可靠性修复

## 2026-10-22 交付与管理体验优化

状态：以下七项代码已实现，待用户验收。本阶段未运行测试、类型检查、构建或桌面验收；提交时由既有钩子执行暂存前端文件的定向 ESLint。下文较早批次的验证不作为本阶段证据。

| 项目 | 实施入口与约束 | 桌面验收 |
|---|---|---|
| 图片／音频交付 | `comfyWorkflowService.ts`、`generationService.ts`、`pollManager.ts` 及实际结果消费者：结果保存并通过项目／节点派生守卫后才清理原任务，保存失败保留 promptId；进程内交付活动标记阻止重复续取，不作为写回授权 | 下载中退出／切项目不丢任务、不写错节点；真实保存中不能重复续取；过期交付结束后可“继续保存”，成功交付才移除恢复状态 |
| 短查询超时 | `comfyPolling.ts`、`comfyProgress.ts`、`comfyMemory.ts`：只对 history、queue、stats 的完整读取加独立超时；不改变生成 POST、上传及长流 | 服务连接后不返回也能结束本次查询，任务保留；正常长任务不误取消 |
| 明确服务器 | `comfyServers.ts` 及调用方：未绑定时沿默认配置，已绑定失效必须重新选择；不回落到另一台服务 | 删除绑定或清空其地址后，生成／编辑／批次预检明确报错，不向默认服务器发送素材 |
| 去重页状态 | `ComfyManagementWindow.tsx`、`ComfyModelDedupe.tsx`：窗口会话内保留扫描根与结果，不持久化原生授权；版本、插件或依赖写入开始时同步撤销旧扫描展示 | 扫描完成切换控制台再返回，结果、搜索与选择保留；管理写入后需重扫，失败也不使用已撤销 scanId；关闭窗口仍清理临时授权 |
| 手工角色编辑 | `MentionEditor.tsx`、`ComfyRefmodMentionSettings.tsx` 及资源写入入口：复用紧凑设置编辑槽位／强度，歧义可选择；原槽覆盖必须明确授权 | 资源库添加／拖入后可编辑；多加载节点可完成分配；生成中及切项目拒绝迟到写入 |
| 角色按需加载 | `useComfyRefmodMentionOptions.ts`、`comfyRefmodService.ts`：普通输入不读角色目录；手动刷新只强制本次请求，可选展示信息不阻塞核心加载器校验 | 输入分类无需角色请求；重开角色目录复用缓存；描述接口慢／不可用时仍能选择及生成 |
| 安装加速回退 | `media/comfyui/installer.rs`：HTTP 200 HTML 拦截页／长度异常允许一次镜像重试，保留白名单、固定大小与摘要校验 | 官方源拦截时切加速源；取消不重试，摘要不符拒绝解压 |

已补交付失败／跨项目及重建节点隔离、短查询完整读取预算、失效服务器、角色歧义映射与可选描述隔离、去重页保留及安装响应分类的回归源码；仅做差异、引用和 UTF-8 静态核对。用户后续明确授权时，才运行对应定向测试和桌面验收。

可手动执行的定向命令（本阶段未执行）：

- 仓库根目录：`npx vitest run tests/services/comfyTaskRecovery.test.ts tests/services/generationServiceReplicaLease.test.ts tests/services/comfyQuery.test.ts tests/services/comfyServerBinding.test.ts tests/services/videoBatchPlanning.test.ts tests/services/comfyRefmodNodeService.test.ts tests/services/comfyRefmodService.test.ts tests/services/comfyRefmodWorkflow.test.ts tests/components/comfyManagementWindow.test.tsx`。
- `src-tauri/`：`cargo test blocked_or_incomplete_download_headers_allow_source_fallback --lib`，然后 `cargo check --lib`。安装器实际下载回退仍需 Windows 桌面端，以官方源返回 HTML／错误响应长度、加速源正常及摘要不符分别验收；不得仅凭纯函数测试认定真实下载通过。
- 桌面前置：可用 ComfyUI 服务、图片／音频工作流、含 RefMod 加载器的 H3 工作流，以及可安全扫描的模型目录。按上表逐项操作，补充明暗主题、窄窗口、离线服务、保存失败、取消映射和关闭窗口后的回归。

回滚本阶段相关差异即可，保留工作流、模型文件和其他任务改动；回滚前先交付尚未保存的已完成任务。

## 范围与状态

用户确认先实施保存一致性、显式输入映射与任务恢复。本批属于一次性修复，代码已实现，自动化检查通过；真实桌面与生成验收待完成。主文档为 [ComfyUI 工作流集成说明](../ComfyUI工作流集成说明.md)。

| 范围 | 行为 |
|---|---|
| 编辑保存 | 按真实标签对象绑定目标，异步导出前后复核身份；同名外部标签新建，提供另存入口；MCP 创建的记录可原地回写 |
| 显式输入 | prompt 默认/显式规则一致，保留连线；显式视频支持 video/file 上传字段；无法映射时阻止提交并解释原因 |
| 取消与续查 | 未确认取消、连接中断和查询超时保留 promptId；节点提供继续查询、再次终止；不重复提交，旧请求不清理新任务 |
| 恢复回填 | 下载后复核任务、项目与画布版本；终态明确时清理，未知状态保留 |

## 验证

- ComfyUI、工作流、节点交互、共享轮询及 APIMart/即梦/统一生成入口：23 个测试文件，214 项通过。
- 前端类型检查、测试类型检查、定向 ESLint、桥接 JavaScript 语法检查、严格 UTF-8 解码、文档相对链接与差异检查均通过。
- 回归包含 A/B 标签切换、同名标签、导出中切换、另存与延迟回执、MCP ID、显式文本和视频、取消失败重试、断线续查、超时与任务消失区分、项目切换防回写。
- 未启动桌面应用或 ComfyUI，未实际生成媒体；ComfyUI 前端版本差异与真实桌面明暗主题仍需现场验收。

## 边界与剩余项

- 无新增依赖、删除文件、数据库升级、Rust 源码或 Tauri 权限修改。
- 参数面板、运行前体检、多输出管理、任务中心和助手多服务器能力留待后续阶段。
- 提交响应丢失且尚未记录 promptId 的任务无法保证找回；本批不自动重试生成。
- 远程编辑桥接仍不开放；恢复任务尚未恢复 WebSocket 进度。

## 回滚

仅撤销本批桥接、ComfyUI 服务、pollManager、节点恢复入口及相应测试/文档差异，保留其他工作区改动。新增恢复状态为可选 localStorage 字段，不涉及 IndexedDB schema。回滚前先处理仍未确认结束的任务，旧版本可能清理这些记录；工作流和生成文件不随代码回滚删除。

## 2026-09-22 终态判定与显存策略

本阶段属于一次性修复与小型产品能力补齐，不改 Tauri 权限、数据库或 ComfyUI 启动参数。

- history 带状态时必须到达成功终态才交付；兼容不返回状态的旧服务。
- 视频恢复与实时执行只接受视频扩展名，仍兼容 `SaveVideo` 把 MP4 放在 `images` 键下，不接受 PreviewImage PNG。
- 新增 `/system_stats` 显存展示及 `/free` 手动“卸载模型／完全释放”。默认保留智能缓存；自动策略需显式选择，只对回环服务生效，并在 `/queue` 非空时跳过。
- history 数据与显存释放分开处理；未增加自动 history 删除，也不要求每次生成后清显存。
- 离线定向验证覆盖终态等待、旧服务兼容、视频扩展识别、官方 `/free` 请求体、回环限制、繁忙队列保护和设置界面入口；前端与测试类型检查通过，全量 347 个测试文件、4417 项通过。全仓 ESLint 仍被既有 ESLint 10 兼容错误 `scopeManager.addGlobals is not a function` 阻断，本批改动文件的定向 ESLint 通过。真实 ComfyUI 显存变化、共享服务器影响和桌面明暗主题仍需现场验收。

回滚时撤销 `comfyMemory`、配置字段、设置面板及三条执行入口的策略调用，并恢复视频输出类型；不涉及用户数据迁移。旧配置缺少策略字段时本就回落为默认智能缓存。
