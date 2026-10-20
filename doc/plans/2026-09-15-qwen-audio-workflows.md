# Qwen3 三项音频工作流内置接入

## 职责与状态

2026-09-15 已内置三项 Qwen 音频工作流，并完成第二阶段参数面板、按工作流保存与提交注入。主入口见 [ComfyUI 工作流集成说明](../ComfyUI工作流集成说明.md)。沿用既有平台、文件与生成权限，不新增依赖、不安装节点或模型，不改本机 ComfyUI。

| 工作流 ID | 用途与默认输入 |
|---|---|
| `qwen3-voice-clone` | 原声1比1克隆；ai-audio，prompt 节点 3 → target_text，audio 节点 1 |
| `qwen3-voice-design` | 文生语音抽卡；prompt 节点 1 → text，保留 instruct 音色描述 |
| `qwen3-reference-voice-design` | 参考音频抽卡-支持方言；prompt 节点 3，audio 节点 1，保留两条合成链路 |

## 源码入口

- 三份 API 图位于 `src/assets/comfyWorkflows/`，同名原始编辑图位于其 `ui/` 子目录；文件名与上表 ID 一致。
- `src/services/builtinWorkflows.ts`、`src/services/comfyWorkflowService.ts`：增量注册、输入注入和提交副本。
- `src/services/ai/audioSpeechSettings.ts` / `qwenSpeechSettings.ts`、`src/types/aiTypes.ts`：AuK/Qwen 分派、能力/默认值、按字段映射与参数类型。
- `src/components/nodes/shared/AudioParamSelector.tsx` / `QwenSpeechControls.tsx`：参考音频、角色主声音、常用/高级参数和分组面板。
- 回归入口：`tests/services/builtinWorkflows.test.ts`、`audioSpeechSettings.test.ts`、`comfyWorkflowAudioIO.test.ts`。

## 已实施的图与参数边界

- 三项增量播种，旧八项不覆盖；三份 UI 图保留来源原文，API 图保留可执行连接。ASR 转写 ref_text、参考样本正文和目标 target_text 分开处理，显式引用优先。
- 第三图保留 ASR→Clone→SeedVC 与 VoiceDesign→SeedVC 原连线，Clone/SeedVC 固定种子与 VoiceDesign 抽卡种子独立。
- VoiceDesign 的 `control_after_generate=randomize` 是 UI 控件，不能提交成 API 输入或挤占 max_new_tokens。随机只修改每次提交副本，fixed、连线、旁路或无有效编辑图时保留原值，不修改库中原图。
- 参数按 workflowId 独立保存，未编辑字段保留图默认值；声音预设仅在用户选择后替换描述。覆盖只作用于提交副本，保留旧 AuK 行为，无需旧节点迁移。
- 克隆提供参考音频、语言、固定/随机种子、采样上限和参数、x_vector_only、ASR 设置；声音设计提供预设/自定义描述、描述式语速、语言、固定/抽卡及采样参数。
- 第三图分开参考音频与目标音色描述、两组 TTS 采样、ASR 和原图已有 SeedVC 转换设置，包括步数、CFG、参考长度、F0、移调、长度、种子、增益及峰值保护。
- 模型运行选项仅开放节点声明支持且原图已有的字段，不新增下载入口。VoiceDesign 实际加载拒绝 0.6B，面板只提供 1.7B；Clone 保留 0.6B / 1.7B。原图未提供的 instruct 等字段不默认添加。
- Qwen 生成长度是 max_new_tokens，不伪装成精确秒数；参考转写仍保留 ASR 连线，不开放无效正文输入。
- 本机未找到 SeedVCVoiceConversion 实现，不能由现有值猜合法范围或安装替代节点。服务端声明不可读时只拒绝新增转换参数覆盖，默认原图仍交给既有 ComfyUI 校验。

## 历史验证与待验收

- 首阶段两轮定向回归共 130 项、应用/测试类型、定向 ESLint、差异和 UTF-8 检查通过；三份 UI 图与来源逐字节一致，Qwen API 字段符合当时本机节点声明，原执行连线保留。
- 第二阶段 98 项定向测试、应用/测试类型及定向 ESLint 通过，覆盖能力、默认值、映射、引用缺失、显式样本优先、随机/固定、SeedVC 声明/范围、原图不变和旧 AuK。
- 真实组件独立浏览器预览检查浅/深主题、参考增删、预设、自定义描述、恢复默认、固定/抽卡、转换开关、折叠与滚动。本次文档整理未重新运行这些检查。
- 待 Tauri 桌面验证完整面板/保存/批量传递与实际提交；SeedVC 安装和完整第三图运行尚未验收，三项真实克隆、方言、抽卡听感也未验收。名称“1比1”沿用源工作流，不代表效果保证。

## 回滚

参数覆盖为可选字段，回退第二阶段可保留已内置三图；若移除三项内置，仅撤销本批资源与注册，已播种记录可单独删除，不重置用户工作流或覆盖旧八项。保留来源图，不迁移项目或更改运行环境。
