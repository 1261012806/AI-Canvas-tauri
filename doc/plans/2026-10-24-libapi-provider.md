# LibAPI 内置厂商接入

日期：2026-10-24。任务类型：平台能力。状态：代码及回归源码已实现，待用户验收；本次未运行测试、lint、类型检查、构建、桌面生成或付费调用。

**目标**：在既有连接配置和通用模型菜单中内置 LibAPI，图片、视频和音频复用统一异步任务与交付恢复。

**实现**：共享厂商目录与精确型号合同，不增加依赖、原生命令、权限、数据库或凭据存储；不改其他厂商的执行合同。沿用 React／TypeScript、Zustand、声明式 v2 协议和现有 Tauri 网络／文件服务。

## 官方依据与接入边界

- [官方文档](https://libapi.cc/zh-CN/api-docs)、[OpenAPI](https://libapi.cc/openapi.json)、[逻辑模型与参数目录](https://libapi.cc/v1/logical-models)于本日只读核对。目录包含 126 个活跃型号；官方目录原含 55 个文本型号；按用户要求，仅保留此前主流清单中该平台已公布的 8 个文本型号，另接入 22 个图片、31 个视频和 6 个音频型号，其他专用任务未加入。参数为本日合同快照，后续变化需复核，不对任意新模型自动生成合同。
- 官方 `public_id` 与内部 `id` 均可调用；目录匹配去重并保留认证接口实际返回的请求 ID 与本地连接身份。公开模型列表仅排除退役，既不接收 Key，也不保证该 Key 的生成、上传权限或渠道供给。
- 文本白名单：`gemini-3.8-flash`、`gemini-4-argon`、`qwen3.8-flash`、`deepseek-v4.1-flash`、`gpt-6.1-sol`、`grok-4.7`、`claude-opus-5-5`、`glm-5.3-flash`，按平台实际内部 ID／公开别名匹配；原清单中的 `qwen3.8-27b` 未在该平台目录公布，不补造。缩减只影响本内置目录候选，不直接清理用户已保存的配置。
- 标准文本使用 `/v1/chat/completions`；图片、视频和音频使用 `POST /api/v1/model-runtime/invoke`，请求为 `{model_id, modality, params}`，图片／音乐带 `operation:generate`，语音带 `operation:speech`；图片／视频／音乐提示词在 `params.prompt`，语音正文在 `params.input`。提交读取顶层 `task_id`，查询 `GET /v1/tasks/{{submit.task_id}}`；`completed` 读取 `output_url`，`failed` 读取 `error`，其他状态继续查询。
- 每 3 秒查询，最长两小时，仅瞬时查询错误有限重试。生成 POST 不自动重试，不新增跨站重试；既有 PendingTask 保留原任务，保存和回填成功后清理。未拿到任务 ID 的中断仍显示提交状态未知，不能保证服务端未受理。
- 图片／视频请求固定一个结果，应用调度本地批量；音频单次提交取首个 `output_url`，不发送未公布的 `count`，不承诺 Suno 的服务端候选数可控。不使用未核实的多结果原图字段，不把首次响应或上游完成视为本地交付完成。

## 参数与素材

- 图片 `size` 分别可能表示像素串、比例或分辨率档位，按精确型号配置。已公布的 `quality/background` 独立映射；GT Image 2.5 质量为 `low/medium/high/xhigh/max`，背景为 `opaque/transparent`，不套其他厂商的 `auto`。
- 图片模式依据零张／一张／多张实际参考，选择该型号已公布的 `text-to-image/image-edit/multi-reference`；只修改本次临时合同，保留保存的协议。像素限定型号只展示合法尺寸对应的比例；非法参数或素材数量不改为另一个计费档位。
- 视频从实际引用角色选择 `text-to-video/first-frame/first-last/reference`。普通连接或 @ 图片不偷偷成为首帧；尾帧须有首帧，首尾帧不混用普通图、视频和音频参考。视频编辑、延长、数字人、对口型等未列为普通生成能力。
- Seedance 2.5 与 H3 在首尾帧模式下省略请求比例，输出跟随首帧；界面保留用户比例，以便换回其他模式继续使用。无公开音轨开关的型号保持接口默认，不宣称可静音。视频质量等暂无对应控件的字段沿用该型号公开默认值。
- `seedance-2-5-special` 的文字说明与音频参数表冲突，本批关闭其参考音频。只有已明确支持的 Seedance 2.5 开放纯音频参考；其他音频参考须满足型号组合规则。
- 本地图片／视频／音频使用当前 LibAPI 连接的 `POST /v1/files`，multipart 字段 `file`，成功响应取顶层 `url`。单文件不超过 50 MiB；仅允许官方声明的对应媒体格式。缺 Key、权限不足、上传失败或缺 URL 均明确失败，不借用其他连接或公共图床；支持已有排队、取消与缓存语义。
- 模型更严格的图片体积／边长要求未在当前图片能力类型中表达，仍由服务端校验。视频／音频已声明的时长限制交给既有输入探测。未实现厂商独立 `asset://` 素材库生命周期。
- 透明背景请求明确输出 PNG；异步任务文档未明确 `original_url`，最终落盘是否保留 alpha 需要实际验收，不据参数支持声称交付已验证。

## 音频补充

用户随后确认补齐音频及节点、对话／MCP 参数，共六个型号：

| 型号（内部 ID／公开 ID） | 音色 | 格式和语速 |
|---|---|---|
| `gpt-4o-mini-tts`／`gt-4o-mini-tts` | 六种预置，默认 `alloy` | MP3、WAV、Opus、AAC、FLAC；默认 MP3；0.25–4 倍速 |
| `gemini-3.1-flash-tts`／`gm-3.1-flash-tts` | 三十种预置，默认 `Zephyr` | 仅 WAV；不发送速度倍率 |
| `gemini-2.5-pro-tts`／`gm-2.5-pro-tts` | 三十种预置，默认 `Zephyr` | 仅 WAV；不发送速度倍率 |
| `speech-2.8` | 填写平台已有音色 ID，无默认 | 不发送未公布的格式字段；0.5／0.75／1／1.25／1.5／2 倍速 |
| `doubao-tts-2.0` | 填写平台已有音色 ID，无默认 | MP3／WAV，默认 MP3；上述六档倍速 |
| `music` | 普通 Suno 音乐生成 | 仅映射提示词、标题和歌词；模式与版本沿用平台默认 |

`AudioModelCapability` 的音色、格式、速度、音乐控件是运行期合同，不新增模型配置持久化字段。现有 `audioVoice` 接收平台音色 ID，`audioFormat` 补 MP3；其他厂商原有 PCM 类型保留，但 LibAPI 没有必要的采样率／声道／位深合同而不开放。切换本批音频模型时清理不适用的旧参数，不把 `alloy/wav/1` 强塞给其他型号。用户修改的高级协议不被内置参数转换覆盖。

本批语音和音乐均不接受参考素材即传即克隆。声音克隆应由用户先在平台创建音色，再填写已有音色 ID；`voice-design`、`voice-clone`、`whisper-1` 不列为生成音频的型号。音乐续写、翻唱、分轨、写词及 MP4 输出不属于普通生成。显式传入未声明的格式、速度、BPM 或时长会明确报错，不悄悄忽略。

对话／MCP 媒体生成工具可选 `audioVoice/audioFormat/audioSpeed/musicTitle/musicLyrics`，只允许用于音频；原工具 effect、审批和 RunningHub 参数边界不变。创建／更新音频节点保留真实连接身份，音色 ID 有界且拒绝控制字符；生成入口再次按精确型号验证。画布交付后节点保留显式声音、格式、速度、标题和歌词，重新生成不丢参数。

## 源码与回归

源码入口：`src/constants/api.ts`、`src/services/ai/providers/libapiModelManifest.ts`、`providerCatalogService.ts`、`src/store/store.config.ts`、`src/components/nodes/shared/defaultModels.ts`、`src/components/settings/ProviderConnectionDialog.tsx`、`src/services/uploadService.ts`、`src/services/ai/generateImage.ts`、`generateVideo.ts`、`generateAudio.ts`。音频参数经 `AudioParamSelector.tsx`／`PromptPanel.tsx`／`AINodeDialog.tsx` 展示；对话／MCP 经 `mediaTools.ts`、`canvasTools.ts`、`generationRuntime.ts` 和 `store.nodes.ts` 传递并保留。

回归源码：`tests/services/libapiModelManifest.test.ts`、`providerCatalogService.test.ts`、`modelRequestTransport.test.ts`、`generateVideo.test.ts`、`mediaReferenceMemoryGuards.test.ts`，以及 `tests/components/defaultModels.test.ts`、`providerConnectionModels.test.ts`。覆盖精确别名、退役过滤、Key 失败保留、用户协议不被覆盖、三类素材上传隔离、图片尺寸族与模式、视频组合拦截、原任务身份及结果凭据。

范围按用户确认实施，随后确认将不相关的 `mediaUploadService.test.ts` 替换为实际接线守卫 `mediaReferenceMemoryGuards.test.ts`。最初三个设置语言文件没有新增翻译调用而未修改；音频补充按再次确认的范围新增三个节点语言文案及音频参数／工具回归源码，没有修改 README。保留其他任务的已有改动。

## Tauri 桌面验收

前置：使用包含本批源码的桌面开发版或新构建，准备自己的 LibAPI Key，并确认具备所用模型生成与文件上传权限；生成步骤会按厂商规则计费，由用户主动执行。

1. 打开「设置 → API Key → 添加厂商 → LibAPI」。确认卡片名称、默认地址正确；点击厂商入口应打开 `https://libapi.cc/signup?ref=HVM4YNC85BR8R97K`。新连接不把本地快照显示成已验证列表。
2. 填写 Key，拉取模型，分别筛选文本、图片、视频、音频，确认文本仅主流八种、音频六种，没有退役或未适配专用型号。勾选要用的型号保存，各类节点／对话菜单应出现独立 LibAPI 分组。关闭重开或重启应保留勾选；导出连接不得携带 Key。
3. 将 Key 改为无效值并拉取，预期显示失败并保留旧列表／勾选，不回退假成功。恢复有效 Key 再拉取。复制同名模型到自定义厂商，不应被 LibAPI 字段转换影响。
4. 图片分别使用零张、一张和多张参考，确认生成请求采用正确模式；GT 质量／背景、GM 分辨率、Seedream 比例与档位分别生效。切换型号保留用户比例；不支持的值应明确提示调整。GT 透明背景产物另查真实文件格式和 alpha，不以界面缩略图白底作为判断。
5. 视频分别使用纯文本、显式首帧、首尾帧和普通多参考。Seedance 2.5 首尾帧输出跟随输入图，其他模式按支持的比例生成。用首帧混合普通参考、仅尾帧、超数量和不支持模式等，预期提交前明确拦截，厂商后台无新生成任务。
6. 引用本地图片、MP4 视频和 MP3 音频，确认由当前 LibAPI 连接上传；未开文件权限、超 50 MiB 或不支持格式应停止，不改走公共图床。公网有效直链无需重复上传。
7. 有任务 ID 后断网或暂停等待，再恢复查询，确认沿用同一任务、后台无第二次生成。原任务完成后检查本地文件与目标节点；模拟保存失败或切换项目，不应丢任务、重提生成或写错画布。回到原项目继续取回。
8. 回归已有 CCC、ToAPIs、自定义协议的生成、取消与恢复，确认原字段、上传策略和保存行为未改变。
9. 音频节点选择 GT TTS，应显示六种音色和支持的格式／速度；选择 GM TTS，应显示三十种音色、WAV，隐藏速度。MiniMax／豆包须填写有效音色 ID，留空应在提交前报错；从 GT／GM 切换后不得残留错误的音色或格式。关闭重开／重新生成保留显式参数，深浅主题、窄窗口和键盘输入正常。
10. 选择 Suno Music，只显示标题和歌词，不出现 BPM、时长或单独自动写词步骤。连接参考音频／图片再生成应提交前拒绝；普通音乐只提交一次任务。语音同样不得把参考音频悄悄当成克隆。PCM 或不支持速度的旧参数应明确提示调整，不能错误命名为 WAV。
11. 在对话／MCP 显式引用本批音频模型，传入声音、格式、速度或音乐标题／歌词。检查同一原任务查询、产物保存与画布交付；落到节点后重新生成应保留参数。对非音频模型传上述字段应失败；MiniMax／豆包未给有效音色 ID 也应在提交前失败。已有其他厂商音频节点、工作流和工具审批边界应保持原行为。

用户提交请求仅授权本批改动文件的定向 ESLint，由原提交钩子执行；自动化测试、类型检查和构建没有运行，仍待用户另行授权。未来定向检查可在仓库根目录运行 `npx vitest run tests/services/libapiModelManifest.test.ts tests/services/providerCatalogService.test.ts tests/services/modelRequestTransport.test.ts tests/services/generateVideo.test.ts tests/services/mediaReferenceMemoryGuards.test.ts tests/components/defaultModels.test.ts tests/components/providerConnectionModels.test.ts tests/components/audioParamSelector.test.tsx tests/services/generationRuntime.test.ts tests/services/chat/mediaTools.test.ts tests/services/chat/canvasTools.test.ts`，不能替代上面的桌面与厂商实测。

## 回滚

撤销本批源码和文档即可。无需降级数据库或迁移凭据；已保存连接、用户自定义协议和任务记录保留。回滚后的旧版若不认识 LibAPI，不应重新提交尚未确认的远端任务。
