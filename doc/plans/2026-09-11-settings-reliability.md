# 设置持久化可靠性优化方案

## 职责与状态

渠道凭据、MCP 固定令牌、普通设置、工具栏布局、多实例冲突和退出保存的三个阶段均已实施，另补齐配置列表纯删除的并发合并。保留既有存储介质，不新增依赖、迁移 schema 或放松权限。主入口见[文件与存储模块](../文件与存储模块.md)，相关边界见[桌面运行时与安全模块](../桌面运行时与安全模块.md)和[MCP 控制模块](../MCP控制模块.md)。

本文汇总 2026-09-11 专项的实施与历史验证；真实桌面重开、多实例、Unix 和断电验收仍待完成。

## 源码入口

- 普通配置：`src/store/store.config.ts` → `src/services/storageService.ts` → `configPersistenceQueue.ts` / `configPatch.ts` → `indexedDb/catalogRepository.ts`。
- 凭据与令牌：`src/services/providerSecretService.ts`、`src/services/mcp/mcpSessionConfig.ts`、`src-tauri/src/secret_store.rs`；私有路径由 `src-tauri/src/path_policy.rs` 等入口拒绝访问。
- 工具栏与退出：`src/store/store.toolbar.ts`、`src/hooks/useToolbarEdit.ts`、`src/hooks/useMainWindowSize.ts`、`src/App.tsx`；错误分类复用 `src/services/storageDiagnostics.ts`。
- 回归入口：`tests/services/configSecretStorage.test.ts`、`configPatch.test.ts`、`mcpSessionConfig.test.ts`、`settingsClose.test.ts`、`tests/store/config.test.ts`、`toolbarPersistence.test.ts`、`tests/hooks/useToolbarEdit.test.ts` 及原生凭据/路径测试。

## 已实施的保存边界

- 普通配置留在 IndexedDB；API Key 和固定令牌只由 Rust 私有凭据存储保存。主题、尺寸、语言等无关修改不重新核对或写入全部 Key，不新增长期明文缓存。
- 普通配置携带读取基线，在同一事务内按字段三方比较；providers 按连接/字段，工具栏按节点类型局部提交。独立修改合并，其他同字段冲突拒绝，不能以旧整份快照覆盖新值。
- 数组默认作为完整字段；仅稳定 ID 对象列表或唯一字符串/数字列表的纯删除可按删除目标合并，保留同期其他条目编辑和新增。
- 缺失、未加载、读取失败、保存失败、冲突与已保存分别表达。初始配置/工具栏读取失败不能保存默认值；保存失败拒绝 Promise，保留旧数据、编辑模式和草稿，重试不误报成功。
- 保存序号和基线保护后续编辑，迟到的保存/重读不能清除新草稿或恢复旧版缓存 Key。旧模型先归一化再迁移凭据，失败保留原记录。
- 仅对可信分类的瞬时读取故障最多尝试 3 次；写入、权限、容量、损坏、版本不兼容及冲突不自动重试。诊断不含凭据、路径或配置正文。
- MCP 仅在确认不存在时创建固定令牌；读取或格式错误不能触发覆盖。原生按预期旧值条件创建/更新，并发创建读取胜出值；显式轮换失败保留活动 bridge 和令牌。
- 原生存储确实不可用或首次写入结果未确认时使用有明确提示的稳定会话内存令牌，不在同一会话中反复变化；不能自动恢复已撤销的旧令牌。
- 原生凭据使用有界跨进程文件锁，在线程池中覆盖读、比较、写和删；临时文件同步后替换主文件并同步，Unix 额外同步父目录。临时、主和锁文件都留在现有私有目录。
- 删除渠道先在同一数据库事务提交配置与不含明文的清理指纹，再条件删除旧凭据；部分成功推进基线并可重试收敛，值已更新则取消旧清理。两个存储介质不假装是一个事务。
- 配置与布局低频事务请求 strict durability，仅明确不支持参数时兼容回退，权限/容量错误不得降级；不改变画布历史与媒体的写入策略。
- 工具栏同类型冲突保留原基线和草稿；用户确认重新加载才丢弃。退出先收集尺寸防抖及本地布局草稿，再冻结新设置写入并等待真实终态；失败可重试、取消退出或明确放弃。

## 历史验证与待验收

- 当时最终前端定向回归 21 文件、307 项通过；应用/测试类型、34 份改动源码/测试的定向 ESLint、UTF-8 和差异检查通过。
- 原生凭据 10 项、路径边界 7 项定向测试通过，包含隔离目录的真实子进程竞争和退出释放锁；使用 `--no-default-features` 排除无关 ONNX 链接。默认特性 `cargo check --lib` 通过，默认特性测试受既有 ONNX/MSVC 链接问题阻断，未更换依赖或工具链。
- 上述为历史隔离数据与故障注入结果，不代表本次文档整理重新运行检查。现场读取失败的系统原因仍未证实。
- 待桌面验收：修改后立即退出/重开，保存失败的重试与取消退出，真实多实例独立字段/同字段/列表删除，工具栏草稿冲突、明暗主题提示；另需 Unix 与断电/文件故障验证。
- 跨实例保证仅适用于遵守该协议且访问同一存储源的客户端。Windows 文件替换仍可能失败，strict 和同步落盘不承诺断电零丢失。

## 回滚与依据

回滚仅撤销本专项代码差异，保留用户数据、旧配置兼容读取和私有目录限制；停止新写入后使用兼容读取，不自动删除凭据、恢复旧令牌或迁移存储后端。

保留现有介质的依据：[IndexedDB 标准](https://www.w3.org/TR/IndexedDB/)、[Chromium 持久性说明](https://developer.chrome.com/blog/indexeddb-durability-mode-now-defaults-to-relaxed)、[事务参数](https://developer.mozilla.org/en-US/docs/Web/API/IDBDatabase/transaction)及 [fs2 文件锁](https://docs.rs/fs2/latest/fs2/trait.FileExt.html)。[Tauri Store](https://v2.tauri.app/plugin/store/)、[SQL](https://v2.tauri.app/plugin/sql/)和 [Stronghold](https://v2.tauri.app/plugin/stronghold/)均不能单靠替换介质消除保存时序、并发和失败恢复问题，本专项未接入这些替代后端。
