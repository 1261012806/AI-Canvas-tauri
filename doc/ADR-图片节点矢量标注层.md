# ADR：图片节点使用独立矢量标注层

## 状态

已确认，2026-07-22。

归属：[画布与项目](./画布与项目模块.md)。本 ADR 合并已完成的 PointEdit 包迁移记录；2026-10-28 仅整理文档，未重新执行迁移或验收。

## 背景

旧标注编辑器把笔画和文字导出为透明 PNG，虽然没有改写原图，但保存后失去对象级编辑能力，坐标也依赖当次编辑器显示尺寸。PointEdit 提供了基于图片原始坐标的 SVG 标注模型，包含选择、矩形、画笔、箭头、序号、文字和橡皮擦。

## 决策

- 节点持久化版本化的 `ImageAnnotationLayer`，标注坐标、线宽和字号均使用图片原始坐标。
- 节点预览使用独立 SVG 覆盖层，不把标注合并进原图。
- 编辑器通用内核只接收图片、标注和回调，不依赖 Zustand、Tauri 或 AI Canvas 主题状态。
- AI Canvas 适配层负责项目主题、节点写入和旧透明 PNG 的兼容显示。
- 保留旧 `annotation` 字段读取能力；新编辑结果写入 `annotationLayer`。
- 不引入 PointEdit 的完整应用壳、Tailwind 4 或 Lucide 依赖，避免样式和包体积耦合。

## 包合同与宿主入口

- 通用内核来自 `Tenney95/XiaoLuo-PointEdit`，AI Canvas 通过 npm registry 消费 `@tenney95/xiaoluo-image-editor`；实际版本及完整性摘要以 [package.json](../package.json) 和 lockfile 为准，不保留平行的本地编辑器实现。
- 包公开 `PointEditEditor`、`AnnotationLayer`、版本化 `ImageAnnotationLayer`、运行时校验、尺寸映射和透明标注层导出；原有 `Annotation`、`Canvas`、`ImageEditor` 导出继续兼容。受控编辑器包含历史、快捷键、缩放和工具栏，不依赖宿主 Zustand 或 Tauri。
- 包级 `--point-edit-*` 变量承接宿主 `data-theme`；透明层栅格化只绘制标注，不绘制或修改原图。
- [ImageNode.tsx](../src/components/nodes/ImageNode.tsx) 负责按需加载编辑器、节点覆盖层和 Store 写入；[promptResolver.ts](../src/services/ai/promptResolver.ts) 负责模型引用适配，领域字段仍放在 [types/index.ts](../src/types/index.ts)。持久化格式和旧 PNG 回退不因换用包而改变，无须新建数据库表或升级版本。

## 影响与权衡

- 优点：标注可再次编辑，可随节点尺寸无损缩放，原图始终保持不变，通用内核可单独回馈上游。
- 代价：节点 JSON 比单张 PNG 包含更多结构化数据；自由画笔点数需要保持合理。
- 兼容性：可选字段不要求 IndexedDB 升级，旧项目仍可读取。旧 PNG 无法恢复为矢量对象，只能作为只读回退层显示。

## 失败模式与处理

- 持久化数据格式无效：运行时校验失败后忽略矢量层，继续尝试旧 PNG。
- 原图尺寸变化：编辑时按新旧图片尺寸等比映射全部标注。
- 图片采用裁切填充：节点 SVG 使用与 `object-fit: cover` 对应的 `slice` 对齐规则。
- 编辑中取消：所有改动留在编辑器本地，不写入 Store。

## 迁移与历史验收（2026-07-22）

当时迁移已完成：功能 PR 合入上游及 Fork，`@tenney95/xiaoluo-image-editor@1.1.0` 公开发布，宿主改用 `^1.1.0` registry 依赖并移除重复实现。

原迁移记录确认：Fork 的 lint、library build 与 pack dry-run 通过；宿主前端/测试类型检查、PointEdit 定向 ESLint、标注层定向测试、生产构建、UTF-8 与差异检查通过，全量测试为 223/223。浏览器验证覆盖双胶囊工具栏、深浅主题、独立 SVG 透明层、保存后重新编辑及原图 URL 不变。当时 `ImageNode.tsx` 另有迁移前已存在的 6 个 ESLint 错误和 6 个警告，没有纳入该迁移修复。

以上是 2026-07-22 的历史证据，不代表当前分支重测通过。后续改动应在 Tauri 桌面端复核编辑/取消、保存重开、原图不变、旧 PNG 与非法矢量层回退、尺寸映射和深浅主题；自动回归入口为 [annotationLayer.test.tsx](../tests/components/annotationLayer.test.tsx)。

## 回滚

撤销包迁移时需从 Git 恢复对应的旧编辑器及宿主适配，再调整依赖与 SVG 渲染，不能只卸载依赖。旧 `annotation` 字段仍保留读取回退；旧 PNG 不会自动变成可编辑矢量对象，回滚不需要数据库迁移。
