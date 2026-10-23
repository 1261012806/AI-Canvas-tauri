# GPT Image 生成质量

日期：2026-10-23。范围已获用户确认；源码和回归用例已补，待用户验收。提交按仓库钩子执行本批暂存文件的定向 ESLint；未运行测试、类型检查、构建、桌面验收或付费调用。

## 设计与边界

- 复用图片参数弹层与 UI Kit，分辨率和生成质量分别设置；底栏摘要显示选定的原始 quality 值。小窗口允许分段换行和弹层滚动。
- `BaseNodeData`、`AIImageGenParams` 使用可选 `imageQuality`；`ImageModelCapability` 使用 `qualities/defaultQuality`。没有声明时不发送，有选项但没有默认时沿用接口缺省行为。明确不支持的值在提交前报错。
- 能力绑定真实连接与精确型号。标准 JSON、multipart 参考图、APIMart 及 GRSAI 合同、ToAPIs 声明式协议均透传质量；分辨率、参考图和任务恢复机制保持原边界。
- 图片节点、批量、快捷生成和重新生成保存质量参数及历史；最近参数沿用现有按类型、模型与 Provider 绑定的本地缓存。切换不同模型时分辨率和生成质量采用新模型默认，用户已选比例及节点尺寸保持不变；重选同模型保留参数，工作流与清除模型移除旧质量。
- 自定义协议使用 `{{imageQuality}}`，不再把 quality 识别为分辨率。可调质量必须有动态映射；固定质量按固定值回显。未声明能力不继承同名内置渠道。
- ToAPIs 对整个规范化协议与已知旧内置模板比较，仅匹配者在内存中采用更新合同；不持久化迁移，不覆盖用户修改过的路径、轮询或请求字段。
- 用户补充确认 `ProviderConnectionDialog.tsx` 与 `providerConnectionTransfer.ts`：保存和导入使用真实厂商有效合同的临时副本进行能力校验，避免新质量目录与旧协议误冲突；原协议通用合法性仍校验，持久化和导出保留原配置。
- 提交前用户补充确认 `tests/services/apimartGen.test.ts`：同步已有 GPT Image 2.5 请求体断言的默认 `quality: "auto"`，未执行该测试。
- RunningHub 已有专属质量控件，本批不重复添加；普通对话与 MCP 不新增显式质量参数，仍使用渠道或用户声明的默认值。
- 不新增依赖、权限、数据库结构，不触碰其他任务的外观修改。

## 官方依据与支持范围

以下为本次只读核实结果，不代表付费调用已验证。默认值只有文档明确说明或既有应用值需要保留时才声明。

| 渠道与精确型号 | quality | 应用默认 |
|---|---|---|
| CCC `gpt-image-2.5-flare/sunburst` | auto / low / medium / high / xhigh / max | auto |
| APIMart `gpt-image-1-official`、`gpt-image-1.5-official`、`gpt-image-2-official` | auto / low / medium / high | auto |
| APIMart `gpt-image-2.5-flare/sunburst` | auto / low / medium / high / xhigh / max | auto |
| GRSAI `gpt-image-2`、`gpt-image-2.5` | 仅 auto | 保留 auto |
| GRSAI `gpt-image-2-vip` | 仅 medium | 保留 medium |
| GRSAI `gpt-image-2.5-flare` | low / medium / high | 保留应用 medium；厂商未声明省略默认 |
| GRSAI `gpt-image-2.5-sunburst` | low / medium / high / xhigh / max | 保留应用 medium；厂商未声明省略默认 |
| ToAPIs `gpt-image-2-vip` | low / medium / high | medium |
| ToAPIs `gpt-image-2-official` | low / medium / high | high |
| ToAPIs 普通 `gpt-image-2.5-flare/sunburst` | 固定 high | high |
| ToAPIs `gpt-image-2.5-flare/sunburst-vip`、`-official` | auto / low / medium / high / xhigh / max | high |

来源：[CCC](https://cccapi.cn/legal/api-docs#img-gpt-image-2-5)、[APIMart 1/1.5](https://docs.apimart.ai/cn/api-reference/images/gpt-image-1/generation)、[APIMart 2 official](https://docs.apimart.ai/cn/api-reference/images/gpt-image-2/official)、[APIMart 2.5](https://docs.apimart.ai/cn/api-reference/images/gpt-image-2.5/generation)、[GRSAI](https://qmy27nhsd9.apifox.cn/452409160e0.md)、[ToAPIs 2 VIP](https://docs.toapis.com/docs/cn/api-reference/images/gpt-image-2-vip/generation)、[ToAPIs 2 official](https://docs.toapis.com/docs/cn/api-reference/images/gpt-image-2/official)、[ToAPIs 普通 2.5](https://docs.toapis.com/docs/cn/api-reference/images/gpt-image-2.5/generation)、[ToAPIs 2.5 VIP](https://docs.toapis.com/docs/cn/api-reference/images/gpt-image-2.5-vip/generation)、[ToAPIs 2.5 official](https://docs.toapis.com/docs/cn/api-reference/images/gpt-image-2.5-official/generation)。OpenAI 快速适配模板依据[官方图片生成说明](https://developers.openai.com/api/docs/guides/image-generation)和[Images API](https://developers.openai.com/api/reference/resources/images/methods/generate)。未知 JSON 中转模板不自动声明质量。

CCC 旧 `gpt-image-2.5` 别名、APIMart 无后缀 `gpt-image-1/1.5`、普通 `gpt-image-2`、`gpt-image-2.5-ext`、ToAPIs 普通 `gpt-image-2` 未取得质量合同，不展示推测的选择项。Sora2U、火山方舟、Google、xAI、Dreamina 的现有目录没有本批 GPT 质量合同，不扩大声明。

## Tauri 桌面验收

前置条件：当前开发版或包含本批代码的桌面包；设置中启用上述渠道的对应图片模型。以下前四项无需发起生成。

1. 打开图片节点底部参数，选择 CCC／APIMart 2.5 Flare 或 Sunburst，预期出现独立「分辨率」「生成质量」区域，六档完整可选；选 max 后底栏仍保留原比例和 2K，同时显示 max。深浅主题、窄窗口、键盘操作均可用。
2. 切换 GRSAI Flare，预期只有 low/medium/high 且回到 medium；Sunburst 有五档且没有 auto。切换 ToAPIs 普通 2.5 只有 high，VIP／official 才显示六档。未确认质量合同的型号不显示质量区域；RunningHub 仍只有原专属参数。
3. 重选相同模型保留质量；切模型采用新质量默认值，已选比例和节点尺寸保持不变；清除模型和选择工作流不残留旧质量。同模型新建节点继承最近参数，不同 Provider 不继承另一渠道质量；重启后仍能恢复同模型最近参数。
4. 自定义图片模型声明 low/high，在协议 body 配置 `"quality":"{{imageQuality}}"`，本地请求预览应将质量和像素尺寸分开。没有默认值时预览省略 quality；改成固定 high 同时仍声明多档应报映射冲突；清空能力或只声明固定 high 后保持相应省略／固定行为。
5. 如用户选择实际调用，用同一模型分别生成无参考图和带参考图图片，核对请求质量、厂商任务及产物；同样检查批量、快捷生成和重新生成，历史参数应记录选定质量。该步骤可能计费，本次未代为调用。
6. 已保存 ToAPIs 旧内置 VIP／official 模板选择 max 后应提交 max；用户修改过的自定义路径或固定质量协议保持原样。取消、超时或结果待保存仍使用原任务恢复，不因调质量重投。
7. 图片节点先手动设置 9:16，再依次选择 CCC Flare／Sunburst、APIMart 及其他图片模型，预期比例始终保留 9:16，节点不会因选择模型缩放。新模型不支持当前比例时仍保留原选择，提交前报出可选比例且不发生成请求；切回支持的模型即可按 9:16 提交。未设置比例的源图片切模型不自动填比例或改变尺寸，界面和请求沿用相同基础默认值；手动调整比例仍正常更新节点布局。

回归源码覆盖渠道隔离、非法档位、默认省略、旧模板识别、JSON/multipart 传输、质量与尺寸独立、历史、模型切换及弹层选项。本次仅静态核对，没有执行通过结论。

## 回滚

撤销本批代码即可；可选节点字段和本地缓存能被旧版忽略，连接及任务存储不迁移，原有固定协议仍保留。回滚时需保留同时进行的其他任务修改。
