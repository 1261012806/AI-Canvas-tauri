# 武器分类与角色多武器绑定

状态：用户确认的 33 文件已实现。2026-10-28 经发版授权完成隔离完整前端门禁（567 文件／9524 项测试、ESLint、两套类型及生产构建），Rust check 和协议定向 3 项测试通过；修复与证据见 [v0.10.19 发布计划](./2026-10-28-release-0.10.19.md)。Tauri 桌面、真实云同步与 MCP 操作仍待用户验收。

## 交付行为

- 创作资产在人物、场景、道具后增加独立的「武器」分类；项目、全局以及现有 @ 分类入口保持一致。
- 普通道具与武器分开展示和计数，「全部」只计一次。武器可以上传图片、新建、编辑、搜索、导入和导出。
- 角色库工具栏增加武器入口，通过 UI Kit 通用弹窗搜索、多选并保存绑定；可绑定无图武器。同一武器允许绑定多个角色。
- 项目角色只绑定所属项目／剧集资产库中的武器，全局角色只绑定全局武器。不按名称猜测目标，也不隐式跨库复制。
- 解绑只移除关联，删除角色保留武器；删除武器清理所属库中的角色绑定，保留角色与本地媒体。仍有绑定的武器改为普通道具前，要求先解除绑定。
- 角色的武器关联用于资产管理。只有用户显式插入武器 @ 引用时才进入生成输入，不自动追加参考图或改写原有角色参考逻辑。

## 数据与统一处理

保留现有三种领域 kind 与存储表。武器仍是 `DramaProp`，新增固定判别 `propType?: 'weapon'`；现有 `category` 是自由文本，继续保留原义。人物新增可选的 `weaponIds: string[]`，保存同库业务卡片 ID，去重并校验，不使用媒体 ID 或全局引用前缀。旧资料无需数据库升级。

分类判别和筛选集中在现有资产搜索模块；绑定、删除和持久化经 Store Action。跨卡片依赖闭包及 ID 重映射集中在一个小型领域服务，包导入导出与跨库复制共用；不为每个界面另建存储逻辑。

- 导出／复制角色时带上绑定武器并去重；导入角色时也纳入其武器依赖，先分配整批目标 ID，再恢复关联。不按同名覆盖目标库既有武器。
- 资产包与 OSS 的前后端白名单接受新增字段；OSS 复用现有本地／共享顶层卡片映射，单卡校验不要求依赖和角色处于同一修订文档。
- OSS 预览检查武器依赖是否可发布或下载，正常发布／下载优先处理武器，再提交角色；武器缺失或冲突未解决时阻止悬空绑定。单卡解析保留合法依赖 ID，待整批映射与落地校验，不因远端记录顺序不同就静默裁剪绑定。
- 全局删除在 IndexedDB 同一事务中移除武器及角色关联；使用位置查询识别角色武器绑定。
- MCP 沿用 `prop` 和已有 `asset_write`，只补字段校验与查询显示，不增加工具、原生命令、依赖或权限。
- 包格式／共享协议的新增字段为可选，兼容既有资料；旧版严格白名单客户端不能处理新增字段，团队共享该类资产时需使用支持此功能的版本。

## 实施文件范围（33 个）

| 文件 | 改动 |
|---|---|
| `src/types/dramaAssets.ts` | 新增固定子分类、角色绑定字段及归一化 |
| `src/services/dramaAssetSearch.ts` | 共用分类、筛选与搜索 |
| `src/services/characterWeapons.ts`（新增） | 跨卡片依赖与 ID 映射的共用函数 |
| `src/store/store.dramaAssets.ts` | 同库绑定、保存、删除清理及分类转换保护 |
| `src/services/indexedDbService.ts` | 全局武器删除与角色解绑的原子持久化 |
| `src/components/DramaAssetsPanel.tsx` | 项目分类、上传、编辑和计数 |
| `src/components/AssetsPanel.tsx` | 全局分类状态与计数接入 |
| `src/components/assets/AssetFolderNavigation.tsx` | 共用侧栏新增武器 |
| `src/components/assets/GlobalCreativeAssetsPanel.tsx` | 全局武器管理与分类筛选 |
| `src/components/CharacterLibraryPanel.tsx` | 角色工具栏入口与绑定数量 |
| `src/components/character/CharacterWeaponDialog.tsx`（新增） | UI Kit 多选绑定弹窗 |
| `src/components/nodes/shared/mentionEditorSources.ts` | 候选分类信息与武器筛选 |
| `src/components/nodes/shared/MentionEditor.tsx` | 节点 @ 分类和全局侧栏接入 |
| `src/components/chat/ChatInput.tsx` | 对话 @ 分类与计数 |
| `src/components/assets/DramaAssetImportDialog.tsx` | 导入关联依赖的选择说明与展示 |
| `src/services/dramaAssetTransferFormat.ts` | 包字段校验、依赖选择及整批 ID 重映射 |
| `src/services/dramaAssetTransferService.ts` | 单个角色导出／复制纳入武器依赖 |
| `src/services/dramaAssetBatchCopy.ts` | 项目与全局批量复制保留关联 |
| `src/services/episodeAssetService.ts` | 本集绑定全局角色时接收其武器依赖，保留稳定角色身份与重试语义 |
| `src/services/sharedAssetSyncFormat.ts` | 共享字段白名单、序列化与恢复 |
| `src/services/fs/sharedAssetSync.ts` | 复用共享 ID 映射并检查武器依赖 |
| `src-tauri/src/files/object_storage/protocol.rs` | 原生共享字段校验 |
| `src/services/assetUsageService.ts` | 识别角色绑定使用位置 |
| `src/services/dramaAssetPrompt.ts` | 武器简介显示正确分类，保留原参考协议 |
| `src/services/chat/tools/dramaAssetTools.ts` | 既有资产工具的字段校验与显示 |
| `src/i18n/locales/en-US/character.ts` | 英文新增文案 |
| `src/i18n/locales/ja-JP/character.ts` | 日文新增文案 |
| `src/i18n/locales/ko-KR/character.ts` | 韩文新增文案 |
| `tests/services/characterWeapons.test.ts`（新增） | 分类、作用域、关联与依赖映射回归 |
| `tests/services/dramaAssetTransferFormat.test.ts` | 单角色包依赖与新 ID 回归 |
| `tests/services/sharedAssetSyncFormat.test.ts` | 共享跨卡片身份与字段校验回归 |
| `doc/角色与短剧资产模块.md` | 行为边界与桌面验收入口 |
| 本计划 | 实际实施状态与剩余验收缺口 |

## 验收（实施完成后由用户执行）

已做的静态核对：武器单独分类、既有候选消费方兼容、整批复制／导入的 ID 映射、全局删除原子解绑、无武器旧复制动作时序、云端武器先于角色提交，以及冲突依赖阻塞与恢复前存在性检查。差异空白与严格 UTF-8 核对完成；这些不代表运行或验收通过。

1. Tauri 桌面端创建项目武器和普通道具，确认两个分类独立计数、全部不重复；搜索、上传、编辑、分类清空只影响目标子集。全局库与两处 @ 入口检查相同行为和深浅主题。
2. 同一项目创建两个角色和三把武器，其中一把无图；为角色分别多选并共享一把。保存、重开与切换分集后绑定保留；编辑角色其他资料不丢绑定。取消选择不写入，切换项目后旧弹窗不能回写。
3. 项目与全局不互相混入候选；失效绑定明确显示并允许移除，不按同名补绑。武器解绑不删武器，删角色不删武器；删除武器后相关角色保留且解绑，重启后仍一致。
4. 单角色导出后导入另一项目、项目／全局双向复制及批量复制，确认包含武器且新角色只绑定目标库新 ID；只导入角色时仍包含必需武器。旧资产包继续可读。
5. 两台支持此功能的客户端同步角色和武器，确认分类、媒体和绑定恢复；检查阻塞依赖、取消、重试以及角色先于武器下载的情况。
6. 显式 @ 武器继续使用既有资产协议；单独引用角色不会自动增加武器参考。检查 MCP 现有资产 CRUD 的作用域、字段验证与无效 ID 拒绝。

相关前端回归已包含在上述完整门禁中；可在仓库根目录定向复验：

```powershell
npx vitest run tests/services/characterWeapons.test.ts tests/services/dramaAssetTransferFormat.test.ts tests/services/sharedAssetSyncFormat.test.ts
```

Rust 原生字段校验的同文件回归已运行，3 项通过。在 `src-tauri/` 目录可执行 `cargo test project_asset_storage::protocol::tests --lib --locked` 复验；桌面或真实云同步结果不能由这些自动检查代替。
