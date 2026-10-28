# 图片摄影棚

归属：[画布与项目](../画布与项目模块.md)。本计划迁自 `docs/plans/2026-07-22-xiaoluo-camera-studio.md`，保留 2026-07-22 的相机/灯光合同；2026-10-28 对照源码整理入口，不把原计划中的待执行步骤当作测试通过记录。

## 范围与边界

图片节点通过摄影棚设置视角与灯光，再使用既有模型链创建关联的图片生成节点。沿用上游交互思路，未接入未发布的软件包或演示 API；确定性提示词构建留在纯模块，React/Three.js 全屏面板按需加载，宿主负责画布与生成。

| 源码入口 | 职责 |
|---|---|
| [cameraStudio.ts](../../src/components/nodes/shared/image/cameraStudio.ts) | 相机/灯光状态、预设、默认值、角度归一化与英文提示词构建 |
| [CameraStudioPanel.tsx](../../src/components/nodes/shared/image/CameraStudioPanel.tsx) | 模式切换、球体拖拽、滑杆、预设、提示词预览/复制、重置及生成回调 |
| [ImageNode.tsx](../../src/components/nodes/ImageNode.tsx) | 懒加载面板、复核源节点、创建关联节点及调用生成服务 |
| [toolbarRegistry.ts](../../src/components/nodes/shared/toolbar/toolbarRegistry.ts) / [ImageNodeToolbar.tsx](../../src/components/nodes/shared/image/ImageNodeToolbar.tsx) | `cameraStudio` 入口及旧 `multiAngle` 布局兼容 |
| [camera-studio.css](../../src/styles/camera-studio.css) | 面板、舞台和窄视口样式 |

## 相机与灯光合同

- 模式为 `camera`、`lighting`、`dual`；`CameraStudioResult` 返回模式、相机状态、灯光状态与生成提示词。
- 相机状态包括 yaw/pitch/roll、景别距离、镜头和提示词增强；灯光包括 yaw/pitch、强度、色温、轮廓光和补光。默认值、有效预设及归一化规则统一由纯模块提供，组件不另建第二套提示词规则。
- 相机模式只输出视角描述，灯光模式只输出灯光描述，双模式组合两者。面板可预览、复制和重置；球体拖动使用自身实例与事件，卸载释放渲染资源、监听及动画帧。
- 当前宿主从 Store 读取源节点，通过既有 `createPresetNode` 构造 `ai-image` 与源引用，沿用模型偏好；一次 Store 操作插入节点和连线，再收起摄影棚并调用 `executeGeneration`。返回提示词不直接改写原图或在通用面板内写 Store。

## 历史与验收边界

2026-07-22 的计划要求替换旧视角工具、覆盖三种模式的确定性输出、角度归一化和重置默认值，并检查桌面/窄视口的面板、拖动、关闭及关联生成节点。原文没有可归档的完成命令结果，本次不补写“已验证”。现有源码入口已接通，不代表当前安装包已完成桌面验收。

自动回归入口为 [cameraStudio.test.ts](../../tests/components/cameraStudio.test.ts)；测试、类型检查、构建及启动应用仍需按当前仓库授权执行。Tauri 桌面验收时准备带图片的源节点，依次切换三种模式、调整预设/角度/灯光、复制和重置提示词，再确认生成：应新增一个保留源引用的图片生成节点并发起既有生成流程。取消只关闭面板；删除源节点后确认应显示错误，不能写入错误节点。另查深浅主题、窄窗口与反复开关后的资源释放。
