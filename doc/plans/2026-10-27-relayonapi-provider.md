# RelayOnAPI 图片与视频接入

状态：基础接入已提交（`63ec27a6`），普通 2.5 质量／透明背景及配置初始化保护已实现，待用户验收。2026-10-27 用户确认本次范围并要求提交；提交按仓库钩子执行改动文件的定向 ESLint，未运行测试、类型检查、构建或付费调用。

## 范围与依据

- 4 文本：Gemini 3.8 Flash、Gemini 4 Argon、GPT 6.1 Sol、Claude Opus 5.5。
- 9 图片：`image-2-01`、`Image-2.5-Flare`、`image-2.5-flare-01`、`Image-2.5-Sunburst`、`image-2.5-sunburst-01`、`nano-banana-2`、`nano-banana-2.1`、`nano-banana-pro`、`Seedream 5.0 Pro`。
- 8 视频：`doubao-seedance-2-0-260128`、`doubao-seedance-2-0-fast-260128`、`doubao-seedance-2-0-mini-260615`、`doubao-seedance-2-5-260628`、`sd-2.0-A`、`sd-2.5-A`、`sd-2.0-c1`、`sd-2.0-c2`。
- 未接 Midjourney 的一任务四候选，也未接未公开的音频生成、视频编辑或样片流程。未添加依赖、原生能力、安全权限或数据库迁移。

来源为 [官网目录](https://relayonapi.com/api/pricing)与[型号文档](https://relayonapi.com/docs)，关键示例见 [Image 01](https://relayonapi.com/docs?model=image-2-01)、[Flare](https://relayonapi.com/docs?model=Image-2.5-Flare)、[Nano Banana](https://relayonapi.com/docs?model=nano-banana-2)、[Seedream](https://relayonapi.com/docs?model=Seedream%205.0%20Pro)、[官转 2.5](https://relayonapi.com/docs?model=doubao-seedance-2-5-260628)、[A](https://relayonapi.com/docs?model=sd-2.0-A)、[C1](https://relayonapi.com/docs?model=sd-2.0-c1)、[C2](https://relayonapi.com/docs?model=sd-2.0-c2)。

官网只标明兼容协议，缺少该站完整实际响应样例。用户确认先采用 [OpenAI Images 标准返回](https://developers.openai.com/api/reference/resources/images/methods/generate)及 [Videos 标准状态](https://developers.openai.com/api/reference/resources/videos/methods/retrieve)，辅以官网明确列出的三个视频 URL 字段。此为兼容实现依据，尚不是本站端到端验证结论；不借用其他部署的响应、尺寸或权限合同。

## 执行边界

厂商定义、模型 manifest 和策略表仍是主要接线入口。默认展示候选，不自动勾选；远端刷新以当前 Key 的实际目录求交，错误不变成本地验证成功。文本、图片、视频共用节点和对话菜单同步。

图片为同步生成及 JSON 编辑，参考图保留顺序并通过现有内联通道处理，不经公共图床。厂商上限为 8／10／16 张，但当前应用内联通道只支持 6 张、单张 8 MiB、合计 24 MiB，本批能力和提交前检查采用这一有效上限，不静默截断，也不放宽内存保护。当前内置合同完整匹配时才切换生成／编辑路径，用户改过的协议保持原值。尺寸采用该型号公布的精确像素表；Seedream 首批只开放完整矩阵的共同六比例。单请求 `n=1`，批量沿用应用调度；不以异步返回不足为理由补交生成。

普通 `Image-2.5-Flare` 和 `Image-2.5-Sunburst` 是本次唯一补充质量和背景的型号。官网明确这些字段原值透传；用户确认先提供当前 OpenAI Images 2.5 的兼容候选 `auto/low/medium/high/xhigh/max` 和背景 `auto/opaque/transparent`，不把它们标为该平台已实测枚举。两项默认均不新增请求字段；只有用户选择时发送 `quality`／`background`，透明额外要求 PNG。`-01`、Nano、Seedream 不套用；比例、分辨率及其他请求字段不因选择质量或背景改变。

针对旧保存的普通两型号，识别完整旧模板或完整新模板后，以临时有效副本补齐参数映射与能力；参数 UI、生成及保存／导入校验使用同一副本。原始保存、导出配置不自动改写。修改过的协议不因名称匹配而被覆盖，原安全校验依旧先执行。编辑初始化只为 RelayOnAPI 启用“缓存／已选配置优先”的合并选项，不更改其他厂商或常规目录刷新优先级。

视频四种官转合同使用字符串 `seconds` 与 `metadata`；A 使用字符串 `seconds`、`output` 和普通 `references`；C1／C2 使用顶层 `duration`、`resolution`、`aspect_ratio` 与普通 `references`。不把其他渠道的同名参数套过来。C2 不接视频参考；未公布的首尾帧、比例或纯音频素材组合不开放，角色与组合错误在上传前拦截。本地视频参考沿用已有公共上传，最终 JSON 仅接受 HTTPS 素材；不制造专用 Files API，也不向公共图床传递 RelayOnAPI Key。

共享执行器的幂等身份只进入新媒体提交的固定 `Idempotency-Key`，不进入持久化协议、轮询、结果下载或凭据。请求构建两次仍复用同一键；新调用用新键，不自动重试 POST。视频复用 `PendingTask`、取消、暂停、原任务恢复、保存和回填确认；只在真实厂商且完整匹配内置视频合同的查询描述中补入明确的 URL 备用路径，其他厂商和用户协议保持原行为。

## 验收

本次质量／背景补充完成源码、引用、差异空白与 UTF-8 静态复核；提交按仓库钩子执行改动文件的定向 ESLint。测试、类型检查、构建、Tauri 实机及真实厂商调用均未运行。

不付费：新建厂商确认 21 个默认候选均未勾选；填 Key 后拉目录，勾选各类模型并保存，确认节点和对话按正确类别显示、重启保持勾选。错误 Key／断网时旧目录和选择保留，不能提示远端验证成功；显式自定义且同名的连接不继承本厂商白名单、上传或幂等策略。切换模型保留用户比例，不支持的值应明确拦截。

质量／背景的无付费回归：已有旧连接无需重建或重新拉取，普通 Flare／Sunburst 的图片参数弹层应显示六档质量和背景选择；原 9:16、1K 保持不变，未选参数仍沿用接口默认。选 `high` 与透明后，摘要及节点参数应保留选择，关闭重开、重新生成和批量通路仍传同一参数；切换到 `-01`／Nano 不显示不支持的控件。编辑用户自定义过的普通两型号时，缓存和保存配置优先于新模板，取消无写入、保存和分享保留原协议；非法路径仍在配置校验时拒绝。UI Kit 的品牌色样式不另造分支。

以下真实生成由用户自行决定执行，会产生厂商计费：

1. 选择 Image 01，16:9、2K，无参考生成一次；预期请求像素为 2048×1152，返回后保存并展示。单张参考编辑应切换到编辑端点，内联参考不经公共图床；超过上限在提交前拒绝。
2. 选择一款 Nano Banana 与 Seedream，核对各自像素及参考数量；Seedream 不应把不存在的 1K／2:3 规格发送给平台。
3. 官转视频生成 4 秒、480p、16:9，确认只提交一次并保存任务 ID，完成后从官方 URL 保存、回填并结束加载。A 与 C1 分别核对参数层级；C1 参考编号与最终图片／视频／音频顺序一致，C2 接视频参考应在上传和生成前拒绝。
4. 任务取得 ID 后断网或暂停，再继续查询；应复用原 ID、不出现新 POST。查询返回三种已公布 URL 字段任一种均应取回；返回陌生结构不能伪称成功，任务应保留。结果保存或回填失败后继续取回，不能重新扣费生成。
5. 更换 Key、切换项目、手动取消和重启后恢复，核对连接身份和目标守卫；临时链接过期应明确报错。提交响应丢失且无 ID 时到平台核对，不换幂等键自动重发。
6. 仅在用户决定付费验收时，对普通 Flare／Sunburst 各检查无参考文生和单图编辑：选择 `high`、透明，预期请求含相同值及 PNG 输出要求，产物原图应为保留 alpha 的 PNG。未选两项时不应额外发送字段；自动／不透明背景不强制附加 PNG。平台若拒绝某兼容档位，应保留真实错误，不伪称成功或自动换档重投。

本次补充的回归源码：`relayonModelManifest.test.ts`、`mediaModelCapabilities.test.ts`、`modelRequestTransport.test.ts`、`providerCatalogService.test.ts`、`providerConnectionModels.test.ts`；覆盖完整旧模板、缺字段的模型缓存、用户自定义协议、默认省略和透明 PNG。基础接入另有 `providerPolicies.test.ts`、`defaultModels.test.ts`、`generateVideo.test.ts`、`modelProtocol.test.ts`。有相应授权后可在仓库根目录运行对应文件的定向 Vitest，本轮未执行。

## 回滚

撤销本批代码即可移除本轮媒体候选及公共执行器的新增可选字段，不删除已有连接或任务记录。旧记录不包含新增字段时沿用原轮询行为；不得为回滚清空任务、凭据或其他任务改动。
