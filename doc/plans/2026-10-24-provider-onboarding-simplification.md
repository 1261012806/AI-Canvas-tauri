# 厂商接入方式收敛

**目标**：减少普通中转站在 Store、菜单、设置和执行入口的重复接线；保留逐厂商、逐型号合同及异步恢复边界。

**架构**：新增纯 `providerPolicies.ts` 维护接线策略，现有 `ProviderDefinition` 继续维护名称、徽标、地址、凭据说明和模型清单。Store 只读取轻量策略，UI 和目录使用附带同一策略的定义；连接身份遵守显式 `catalogId` 优先。

**技术栈**：TypeScript、React、Zustand、Vitest；沿用现有声明式协议和 Provider Adapter，不新增依赖或存储字段。

## 范围与步骤

1. `providerPolicies.ts` 及其回归：声明通用模型同步、菜单分组范围、目录阶段行为和既有上传实现标识。默认规则维持未列入厂商的旧行为。
2. `providerCatalogService.ts`、`store.config.ts`、`defaultModels.ts`、`ProviderConnectionDialog.tsx`：消费策略，删除重复厂商白名单。名称和徽标仍取原定义；CCC 按厂商合组，其他已独立分组厂商按连接分组。
3. `helpers.ts`、`generateVideo.ts`、`generateAudio.ts`、`uploadService.ts`：共用连接身份，修复同名自定义连接被误套内置逻辑；上传仍调用原私有实现。
4. 补目录、模型菜单、连接编辑、Store 同步及视频／音频／上传回归；更新模型模块说明。
5. 按用户本轮授权在隔离源码快照运行定向 Vitest、两套类型检查和改动文件 ESLint。记录实际结果，不以静态阅读代替运行验证；不构建、不提交、不推送、不触发付费生成。

本批批准 20 个文件，实际修改 19 个；接线守卫 `mediaReferenceMemoryGuards.test.ts` 沿用既有回归而无需改动。具体生产和回归范围对应上述入口，包含已有 `providerConnectionModels.test.ts`、`toapisConnection.test.tsx`、`modelRequestTransport.test.ts`、`generateVideo.test.ts` 和 `tests/store/config.test.ts`。其他任务的发版及界面改动保留。

## 等价行为与边界

- 初始目录：CCC 新建为空、编辑沿用原本地候选；ToAPIs 保留预置候选。用户随后明确要求 LibAPI 同样展示默认型号，故新建／编辑改为直接展示已适配的 8 个文本、22 个图片、31 个视频、6 个音频型号，不自动勾选、不要求先拉取；预置候选不表示远端权限验证通过。
- 成功刷新：CCC、ToAPIs、LibAPI 按远端目录清理失效型号及勾选。失败：ToAPIs／LibAPI 禁止静态兜底，CCC 仅配置 Key 分组时禁止。Key 变化仅按既有规则取消旧目录请求。
- 同型号不等于同合同。用户修改的协议、完整旧模板匹配、参数约束和校验顺序均沿用原实现。
- ToAPIs 站点白名单、LibAPI 官方地址、每家上传格式／大小／响应校验、当前连接 Key 与缓存隔离保留；APIMart 的旧上传分支不扩大适用范围。
- 提交、查询、取消、暂停、落盘及目标回填继续使用现有 runtime；不改任务记录或自动重提规则。
- 第一阶段不搬完整厂商元数据、不修改模型清单、不合并不同异步响应结构。ApiKeySettings 的旧目录合并与界面专用音频合同留待后续按收益收敛。

## 验证与桌面验收

当前状态：第一阶段代码和回归已实现，纳入 v0.10.16 发布准备；定向检查通过，早期全仓类型基线错误已在后续获批的发版修复中解决。最终隔离全量门禁通过，具体证据和提交／发布状态见 [v0.10.16 计划](./2026-10-24-release-0.10.16.md)；桌面与真实厂商验收仍待完成。以下保留本专项初次检查的历史结果，不将其改写为当时通过。

2026-10-24 使用提交 `68c489d6` 及本批文件建立隔离快照，复用现有依赖，排除其他任务未提交改动。检查结果：

| 检查 | 实际结果 |
|---|---|
| 首轮定向 Vitest | 9 个文件、416 项通过 |
| LibAPI 默认目录补充回归 | 用户要求预置列表后重跑 2 个相关文件，37 项通过；对应 3 个 TS/TSX 文件 ESLint 通过 |
| 已批准 TS/TSX 文件的 `npx eslint --max-warnings=0` | 通过 |
| `npm run typecheck` | 失败，16 处诊断；同一提交未改动基线也是完全相同的 16 处，无新增／减少 |
| `npm run test:typecheck` | 失败，21 处诊断；未改动基线也是完全相同的 21 处，无新增／减少 |

基线问题涉及资产排序值、引用文案参数、外观设置旧标识符、LibAPI 音色类型收窄、预设枚举及资产测试夹具，均不在本批文件内；没有为本次收敛扩大修复范围。类型检查不能标记为通过。没有执行构建、完整测试套件、Tauri 实机验收或付费模型调用。

定向测试命令（仓库根目录）：`npx vitest run tests/services/providerPolicies.test.ts tests/services/providerCatalogService.test.ts tests/components/defaultModels.test.ts tests/components/providerConnectionModels.test.ts tests/components/toapisConnection.test.tsx tests/services/modelRequestTransport.test.ts tests/services/generateVideo.test.ts tests/store/config.test.ts tests/services/mediaReferenceMemoryGuards.test.ts`。覆盖策略、目录、Store、菜单、连接和媒体传输；不能替代下面的桌面与厂商验收。

桌面前置：加载包含本批源码的 Tauri 开发版，准备已有 CCC 分组、ToAPIs 双站、LibAPI 及自定义连接。无需发起付费生成即可完成前四项。

1. 编辑并重新保存连接，确认 Key、模型勾选、节点模型 ID 及参数保留；节点和对话菜单的分组名称／徽标和 CCC 合组不变。
2. 拉取目录成功时清理失效型号，失败时保留当前配置；按上面的厂商规则显示真实错误或旧候选，不能把静态清单显示成验证成功。
3. 切换 ToAPIs 站点或修改 Key，旧请求不覆盖新目录；国内／国际站及各站 Key 规则保持不变。
4. 新建、编辑名称恰好为 `libapi`／`toapis` 的自定义连接，确认以显式厂商类型为准；另用自定义名称保存真实内置厂商，确认菜单和目录策略仍生效。
5. 如由用户主动执行媒体验收，比较同一配置的生成请求和上传目标；验证取消、断网后续取同一任务、保存失败保留任务、切换项目不误回填，以及图片／音频既有入口回归。

## 回滚

撤销本批策略和接线改动即可；无数据库、凭据、连接或任务迁移。既有连接、用户自定义协议、节点模型身份及 PendingTask 记录保留。
