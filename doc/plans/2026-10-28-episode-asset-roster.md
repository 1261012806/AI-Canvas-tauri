# 本集角色、道具与资产库绑定

类型：产品能力。用户已确认工作台增加本集清单、AI 提取后审阅、显式入库／绑定、分镜引用，以及全剧提取改为预览后入库。无新增依赖、数据库表、原生权限或云同步协议。

## 实施范围

- 数据：新增 `src/types/episodeAssets.ts`；修改 `src/types/index.ts`、`src/services/storageService.ts`、`src/services/indexedDb/projectSummary.ts`、`src/store/store.projects.ts`、`src/services/projectTransferService.ts`。分集保存可选 `episodeAssetRoster`，旧记录视为空；正式资产仍归 `seriesOwnerId`，绑定业务卡片 ID。
- 业务：新增 `src/services/episodeAssetService.ts`；修改 `src/services/seriesAssetExtractionService.ts`。提取只返回待审结果，入本集清单和入正式库分别显式提交；无图资产可绑定，全局资产通过既有迁移服务复制至本剧再绑定。
- 界面：新增 `src/components/series/EpisodeAssetPanel.tsx`、`EpisodeAssetPicker.tsx`、`AssetExtractionPreviewDialog.tsx`；修改 `src/components/ScriptWorkbench.tsx`。统一使用 UI Kit 与 MentionPicker，提供搜索、手动编辑、多选、失效绑定提示及预览确认。
- 分镜：修改 `src/services/shotlistService.ts`，仅为有效绑定生成真实 `@drama` 引用，未绑定项保留文字，不生成资产 ID 或画布连线。
- 多语言：修改 `src/i18n/locales/{en-US,ja-JP,ko-KR}/series.ts`。
- 回归用例：新增 `tests/services/episodeAssetRoster.test.ts`、`episodeAssetService.test.ts`；修改 `tests/services/seriesAssetExtractionService.test.ts`、`shotlistService.test.ts`。仅编写，不自动运行。
- 文档：本计划及 `doc/角色与短剧资产模块.md`。其他任务的 ComfyUI 变更不在范围。

## 数据与交互边界

本集条目有独立 ID、名称、说明、外观、本集备注及可选剧本依据／出现场次。`boundDramaAssetId` 只指正式 `DramaAsset.id`，不用本地媒体的 `assetId`；所属库由分集所属剧集推导。本集备注不回写正式资产，删除条目或解绑不会删除正式资产或文件。

同名仅提示，不自动绑定／覆盖。重提取先预览，保留已存在条目的人工修改与绑定；入库使用稳定候选身份，等待保存成功才建立绑定，失败可重试。同剧的新入库与复制请求互斥，避免使用另一轮尚未落盘的乐观卡片。全局选用明确标为“复制到本剧并绑定”，不遗留跨作用域媒体引用。

异步提交复核精确分集、所属剧集、正文指纹、清单版本与加载状态。切集再切回、正文变化或其他编辑均阻止旧结果覆盖。全剧预览独立于本集清单，不把全剧条目自动塞进当前集。关闭未确认的预览不写入；确认后的保存期间禁用正常关闭操作，已接受的保存保留。外部强制关闭工作台不等同于取消已发起的复制／保存。

项目保存、改名、重载、摘要及整剧归档保留并归一化清单；外部导入使用字段白名单和大小上限。独立资产包及当前 OSS 资产同步不携带本集编剧清单，不扩展现有云协议。

## 状态与验收

当前：本集页签、预览提取、编辑保存、资产绑定／入库、全剧预览及分镜引用已实现；中英日韩文案与四组定向回归用例已补齐。完成调用链、差异、严格 UTF-8 与词条引用的静态核对。提交按仓库钩子执行本批 20 个 TypeScript／TSX 文件的定向 ESLint，通过后才完成提交；未运行功能测试、类型检查、构建、桌面验收或真实模型调用，待用户验证。

由用户在 Tauri 桌面验收：

1. 在两集分别新增、编辑角色／道具清单，保存、改名、重开和整剧导出导入后清单及绑定仍正确，旧项目正常打开。
2. 本集正文未保存时点击提取，先保存再调用配置文本模型；结果只出现在预览，关闭不入库。确认所选后才加入本集清单；全剧提取同样先预览。
3. 重提取同名条目，检查人工备注、既有绑定保留。空结果、错误 JSON、网络失败不清空旧内容。提取期间修改正文、切集或切走再切回，旧结果不得写回。
4. 分别绑定无图／有图本剧资产、从全局复制并绑定、新建入库；检查声音、动作和参考图仍归正式角色，双击或重试不重复建库。同名要求明确处理。
5. 解绑、移出本集不删除正式资产；正式资产被删后显示失效，可重新绑定。生成本集分镜携带有效真实引用及本集文字信息，不产生角色连线。
6. 检查中英日韩、明暗主题、小窗口、长名称、搜索无匹配、键盘选择，以及关闭预览、保存失败和批量部分成功的提示。

可由用户在仓库根目录执行：`npx vitest run tests/services/episodeAssetRoster.test.ts tests/services/episodeAssetService.test.ts tests/services/seriesAssetExtractionService.test.ts tests/services/shotlistService.test.ts`；类型检查为 `npm run typecheck` 与 `npm run test:typecheck`。这些命令尚未执行。

回滚仅撤销本批源码与文档；没有 schema 升级。旧版忽略新字段，但旧版重新保存可能丢失本集清单，回滚前先导出项目归档。
