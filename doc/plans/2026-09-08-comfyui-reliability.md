# ComfyUI 第一批可靠性修复

## 2026-10-27 宿主媒体全链路原生读取

状态：源码已实现，待用户 Tauri 桌面验收；本轮没有运行测试、类型检查、Rust 编译、构建、应用或真实服务请求，提交时由既有钩子执行本次前端文件的定向 ESLint。此前 `937f870c` 的检查仅对应前一批图片改动，不作为本轮验证证据。

| 链路 | 本轮处理与边界 |
|---|---|
| 服务 API、上传、进度与管理 | 静态确认 API／上传／目录／连接探测沿 `comfyFetch → corsSafeFetch` 原生 HTTP；桌面 WebSocket 沿专用原生命令，失败只保留 HTTP 查询；启动、安装、去重和本地管理使用既有原生命令。没有新增浏览器重试或重复提交生成 |
| 视频与音频展示 | `comfyMediaSource.ts` 与 `media/comfyui/media_source.rs` 提供窗口私有的 `comfy-media` 不透明临时地址。支持 HEAD、单 Range、后缀 Range，单次最多 8 MiB，16 个并发读取、64 个活动租约，每请求 20 秒；不把整段视频放进 JS Blob，不保存临时地址 |
| 展示与引用消费者 | 接入视频／音频节点、视口播放器、输出历史、资源与引用预览、角色试听、全景、动画、分组、笔记、镜头表、宫格与视频编辑器。图片和海报仍走有界图片 Blob 通道；编辑器引用胶囊由根观察器统一申请／回收，Markdown 中的取件图先延迟挂载，避免 HTML 插入时抢先裸请求 |
| 数据处理与交付 | 素材转 Data URL、图片加载／可达性检查、角色参考拼图、音频波形／转录、参考媒体元数据和视频编辑器探测／Range／整包回退经原生读取。波形保留 15 秒／32 MiB 边界；元数据在卸载元素前捕获。另存 Comfy 结果复用原生流下载的进度、取消和临时提交保护，已有目标明确提示换名，不覆盖或删除原文件 |
| 生命周期与隔离 | 默认本机或已配置服务器精确匹配协议／端口／反代前缀；已进入原生分支的操作失败不切回 WebView 或另一台服务器。256 位随机标识绑定真实本地窗口及页面，关闭／换源／取消／导航／销毁／退出回收；取帧／元数据结束即归还。闲置卡片按实际激活与播放意图申请，不长期占用媒体租约 |

原生协议只接受 HTTP(S) `/view?filename=...` 取件，禁止内嵌账号与片段；只读、不转发浏览器 Origin／Referer／Cookie／Authorization，重定向保持同源，媒体类型与 Content-Range／长度／内容版本校验失败即结束。CORS 仅回当前应用页的精确来源；新命令只允许既有受信本地窗口和固定视频编辑器页面，ACL 与 CSP 只增加这个原生媒体通道，不给 ComfyUI 远程编辑页或插件窗口通用 IPC。第三方 ComfyUI 编辑页自身的网页资源仍由该站点同源管理，不纳入宿主代理或凭据上下文。

兼容边界：普通 asset／data／blob、非 Comfy 网址和 Web 演示保留原行为。未知远程历史服务器需先恢复对应配置；不识别任意网站的 `/view` 为受信 ComfyUI。大媒体预览要求上游支持合法 Range；忽略 Range 的完整响应仅在不超过 8 MiB 时接受，不能把大 200 响应截成假成功。若网关不支持分段，请先通过原生另存为下载到本地再播放。

桌面验收（待用户执行）：

1. 前置：可用的本机 ComfyUI 与自定义端口／反代前缀服务，保留旧 `/view` 图片、视频与音频节点及历史。无需重提生成，依次检查缩略图／原图／全屏、视频拖动与截帧、音频播放／波形／试听、角色与 @ 引用、宫格／全景／动画、剪辑主轨／叠加轨／音频轨。主应用网络中不应有发向原 ComfyUI 地址的裸媒体请求；原生协议出现 `comfy-media` 本地虚拟地址是正常行为。
2. 多于 64 个未激活音视频卡片，检查闲置不占满授权、首次点击可播放、暂停／结束／滚出视口／关闭预览／换项目后释放；快速切换引用、撤销胶囊、关闭角色窗口、元数据读取中取消、原生申请迟到均不能播放旧源或写回临时地址。普通本地和公网素材、深浅主题的控件继续工作。
3. 验证原服务 403／404、断线、非法或超大分段、长度不符、内容版本改变和不支持 Range 的网关。失败应保持可理解错误，不切回原 URL／默认服务器，不重复生成或上传；恢复后重新打开可重试。另存新文件检查进度与取消；选择已有文件必须提示换名且原文件不变。
4. 用户授权执行检查时，仓库根目录可运行 `npx vitest run tests/services/comfyMediaSource.test.ts tests/services/comfyDomImageSource.test.ts tests/services/comfyReferenceMetadata.test.ts tests/services/comfyImageUtilityReads.test.ts tests/services/transcribeAudioNativeComfy.test.ts tests/services/fileServiceDataUrlLimits.test.ts tests/services/fileServiceSaveAs.test.ts tests/services/videoEditorMediaService.test.ts tests/hooks/useComfyImageSource.test.ts tests/components/canvasVideoPreviewCache.test.ts tests/components/videoPlayer.test.tsx tests/utils/renderMarkdown.test.ts`；在 `src-tauri/` 可运行 `cargo test comfyui::media_source::tests --lib` 和 `cargo check --lib`。相关组件既有测试已补依赖替身与回归源码，均未执行；自动化替身不能代替 Windows／macOS／Linux 原生协议、拖动、频谱和桌面 CORS 验收。

回滚：撤销本节新增原生媒体租约、协议注册、准确 ACL／CSP 和对应宿主接入即可，保留前一批图片取件修复。无数据库迁移、模型文件变更、自动下载或自动提交；保留其他任务的生成权限清单与资产同步改动。

## 2026-10-27 图片取件 403 与预览通道

状态：源码已实现，待用户 Tauri 桌面验收。本阶段未运行测试、类型检查、构建、应用或真实服务请求；已做源码、UTF-8 与差异静态核对，提交时由既有钩子执行本次前端文件的定向 ESLint。原有阶段的检查结果不作为本次证据。

- `comfyImageSource.ts` 复用已有原生 HTTP 流，将默认本机和已配置 ComfyUI 的 `/view?filename=...` 取件内容转为本窗口临时 Blob URL。按协议、端口、主机和反代子路径精确匹配，本机 `localhost/127.0.0.1/::1` 可同端口识别；保留原目标与完整查询，不改投其他服务器，不借用连接凭据，不新增 IPC、权限或 CORS 放行。
- 取件读取包含响应体的 15 秒超时与 32 MiB 编码字节上限，支持取消；非法响应类型、真实 HTTP 拒绝、超限或取消不回落浏览器直连。原有缩略图的尺寸、像素、内存、队列和超时预算继续生效。裁剪沿用既有原生图片读取及其上限，已识别 ComfyUI 来源失败时只返回脱敏错误。
- 覆盖画布预览的缩略图和原图档、视口图片、输出历史缩略图、图片历史放大查看。小图／动图即使不生成静态缩略图，也使用读取所得 Blob，不再把原始 HTTP 地址交给 `<img>`。临时地址只在本 WebView 的租约中持有，来源变化、卸载、取消和解码失败均按现有生命周期释放，不写入节点、历史、数据库或窗口快照；正式生成仍先保存项目文件并显示 asset 地址。
- 同一组件来源的原生读取决定在加载期间保持，配置变化不能重新启用裸链接回退。普通图片网址、asset、data、blob 和 Web 演示沿用原行为；未配置的远程历史服务器需先恢复对应服务器配置，不能把任意 `/view` 网站认作已信任的 ComfyUI。既有进度原生通道保持独立。

桌面验收（待用户执行，无需重新发起付费生成）：

1. 准备带跨站保护的可用本机 ComfyUI，打开含原始 `/view` 图片地址的旧节点／输出历史。检查画布缩略图、放大后的原图档、历史缩略图及全屏图片均可显示；开发者工具中不应再出现这些组件直接发出的 Comfy `/view` 图片请求。已落盘的 asset 图片继续正常显示。
2. 打开小 PNG、动画 PNG/WebP 及大图，分别确认显示、动画和缩略图质量；缩放画布、滚出／返回历史列表、关闭全屏及切项目后不应显示旧图片。反复开关不应持续累积临时 Blob；普通公网图片和已有项目缩略图缓存保持原逻辑。
3. 配置自定义端口或 `/comfy` 反代前缀的远程服务，核对按原服务器读取。断网、真实 403/404、超过读取上限、取消或加载中删除服务器时应进入错误态，不能自动改投默认服务器或重走裸 HTTP。服务恢复后重新打开可重试；裁剪读取失败给出可理解的错误，不再触发第二次直连。
4. 核对请求不会携带其他厂商的 API Key／Cookie／Origin 等浏览器来源头；普通网页演示不被当作桌面原生环境，插件独立窗口和 ComfyUI 编辑窗口不增加通用代理权限。回归新生成图片的保存与继续保存、历史应用到节点，以及深浅主题下的错误占位。

回归源码入口：`comfyImageSource.test.ts`、`useComfyImageSource.test.ts`、`canvasImageDisplay.test.ts`、`canvasImagePreviewCache.test.ts`、`viewportImage.test.tsx`、`zoomableImageInteractions.test.tsx`、`fileServiceDownload.test.ts`，本阶段均未执行。用户授权后可在仓库根目录执行对应 `npx vitest run` 定向命令，再做桌面验收。

回滚：撤销本阶段原生图片展示源、Hook、显示接入和裁剪回退补丁即可；保留原有生成持久化及进度通道。无数据库迁移、原生权限、ComfyUI 服务配置或用户文件变更，保留工作区其他任务改动。

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
