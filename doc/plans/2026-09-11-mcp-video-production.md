# MCP 视频制作能力实施计划

## 职责与状态

已实施 MCP 剪辑时间轴、后期编辑、后台导出、媒体验片与开发热更新的任务缺失修复。主模块见[画布与项目模块](../画布与项目模块.md)，外部入口见[MCP 控制模块](../MCP控制模块.md)；复用既有剪辑、合成、混音、抽帧和文件能力，不另建引擎。

本文汇总 2026-09-11 专项的实施及历史验证。正式 ComfyUI 六镜和 24 秒宣传片尚未生成，属于后续创作制作，不能视为本专项已交付成片。

## 源码入口

- 注册与策略：`src/services/chat/tools/videoEditorTools.ts`、`src/services/chat/tools/index.ts`、`src/services/mcp/mcpToolCatalog.ts`。
- 工程与控制：`src/types/videoEditor.ts` / `videoEditorControl.ts`、`src/services/videoEditorService.ts` / `videoEditorControlService.ts`。
- 导出与验片：`src/services/videoEditorExportService.ts`、`videoEditorInspectionService.ts`；`videoEditorRenderBitmap.ts` 与现有剪辑窗口共享图片解码预算。
- 热更新：`src/store/useAppStore.ts`、`src/store/store.hotReload.ts`；对应 `tests/store/hotReload.test.ts`、`tests/services/videoEditorControl.test.ts` / `videoEditorExport.test.ts` / `videoEditorInspection.test.ts` 等回归。

## 已实施能力与边界

- 10 个工具：`video_editor_list`、`video_editor_create`、`video_editor_get`、`video_editor_update`、`video_editor_export`、`video_editor_export_status`、`video_editor_export_cancel`、`video_media_probe`、`video_media_extract_frames`、`video_editor_preview`。
- 工程支持主轨、文字、转场、音轨与原子编辑；新工程使用独立 ID。同一 IndexedDB 事务比较完整工程快照，后台编辑拒绝覆盖打开的人工作业窗口，旧窗口不能覆盖新版本。
- 工具 effect 经过同一 Policy，只接受当前项目节点/工程 ID，不接受任意媒体 URL、源码或路径，不扩大普通对话媒体模型选择权限。素材读取与保存仍由既有文件授权负责。
- 后台单任务导出提供状态、取消、保存和有界请求去重。回填前复核项目、来源和完整工程版本；若写盘后才发生变化，返回“已保存但未添加节点”，不擅自删除文件。
- 最近工程列表上限 50；工程最多 8 轨、120 片段；抽帧每次最多 6 张 JPEG、每张最多 512 KiB；导出任务只保留会话内最近 30 项，不承诺跨重启去重。
- 当前素材读取/编码库异步步骤返回后才能完成取消；不能重复提交来模拟重试。探测输出时长、尺寸、编码与可解码性；导出 frameRate 是设定值，抽帧返回真实样本时间和持续时间，不宣称完整统计可变帧率。
- 任务错误区分信号中止、记录缺失与终态。热更新首次载入即保留原 Store，刷新 action 仍绑定同一实例，避免静态监听器与动态执行模块各持一个 Store。
- 动态 ComfyUI 凭证跨 MCP 请求绑定的问题仍单列，不扩大本专项权限；已导入工作流沿用既有执行链。

## 历史验证与待验收

- 当时 20 个测试文件、331 项定向回归，源码/测试类型、26 份本批文件定向 lint（适用源码）、UTF-8 和差异检查通过；本次文档整理未重新运行这些检查。
- 真实 3 秒截图视频已编码、保存并回填；探测为 1920×1080 AVC、可解码、无音轨，0 / 1.5 / 2.9 秒抽帧返回对应实际时间与 1/30 秒样本持续时间。它是接口验收素材，不能代替正式宣传片。
- 最终重新载入后，真实 MCP 工具描述与 `app_get_state` 成功，宣传片项目及工作流可读。没有把此前失败重开或单元测试当作实机恢复证据。
- 待桌面验收：完整文字/混音/取消流程、重复热更新压力、项目或素材变化时的晚到导出，以及正式六镜生成与 24 秒成片的真实时长/尺寸/听感。模拟回归不代替实际编码或付费生成。

## 回滚

仅撤销本专项新增工具、领域服务与对应有界修改；保留已有工程、项目媒体和文件。没有 schema 升级或新增依赖，不重置用户数据，不调整安全配置。
