# 高级快捷指令顺序执行 Implementation Plan

> **For Codex:** 按本计划逐项实现，每一阶段完成后运行对应验证，不扩大到任意脚本、分支工作流或后台任务恢复。

**Goal:** 保留现有基础快捷指令体验，并为高级用户提供参数化模板和确定性的多节点顺序生成。

**Architecture:** `UserPreset` 以可选高级配置向后兼容旧数据；纯函数模板服务负责参数校验与插值，执行服务一次性创建引用节点与连线，并按顺序或参考依赖调度 `executeGeneration()`。高级编辑器和运行弹窗只负责采集配置与参数，所有共享画布写入仍通过 Zustand Store Action。

**Tech Stack:** React 19、TypeScript、Zustand、React Flow、IndexedDB、Framer Motion、现有 AI generation service。

---

## 范围与约束

- 旧预设缺少 `mode` 时按基础模式读取，不迁移、不丢字段。
- 基础模式继续支持“直接触发”和“加入提示词”。
- 高级模式默认按步骤顺序执行，也可显式选择按参考依赖并发（最多 3 步）。第一步引用触发节点；后续步骤可选择原始输入或上一步结果，缺省沿用上一步结果。
- 参数类型限定为单行文本、多行文本、数字、单选和开关。
- 步骤限定为文本、图像、视频和音频生成节点，不允许任意脚本、文件操作或删除操作。
- 启动时一次性创建节点和边，只提交一次画布创建历史；每个节点生成完成时沿用 `executeGeneration()` 的节点历史和输出历史记录。
- 任一步失败后不再启动新步骤，已开始的生成等待结束；保留已有结果和尚未执行的节点，不自动重试付费生成。
- 不新增依赖，不提升 IndexedDB schema 版本。

### Task 1: 数据模型与持久化兼容

**Files:**
- Modify: `src/types/index.ts`
- Modify: `src/services/indexedDbService.ts`
- Modify: `src/store/store.presets.ts`

**Steps:**
1. 定义高级预设参数、步骤、运行请求和执行模式类型。
2. 扩展 IndexedDB `PresetRecord` 的可选字段，不创建 object store 或索引。
3. 加载旧记录时回退为基础模式，加载高级记录时保留参数和步骤。
4. 运行 `npm run typecheck`，确认类型扩展不破坏旧调用方。

### Task 2: 原子节点链写入与模板解析

**Files:**
- Modify: `src/store/store.nodes.ts`
- Create: `src/services/presetTemplateService.ts`
- Create: `src/services/presetSequenceService.ts`

**Steps:**
1. 新增一次提交 nodes + edges 的 Store Action，并为每个节点分配 displayId 与项目默认设置。
2. 实现参数默认值、必填校验、模板变量提取和全量插值。
3. 根据源节点、参数和步骤构建线性节点链，使用 `@{nodeId:label}` 传递上一步结果。
4. 一次性写入节点链后逐步 `await executeGeneration()`，失败即停止。
5. 定向检查服务和 Store 文件。

### Task 3: 高级配置编辑器

**Files:**
- Modify: `src/components/nodes/shared/PresetManager.tsx`
- Create: `src/components/nodes/shared/PresetAdvancedEditor.tsx`
- Modify: `src/styles/preset-manager.css`

**Steps:**
1. 在详情区增加“基础 / 高级”模式切换，默认保持基础模式。
2. 高级模式提供参数列表，支持新增、删除、排序和类型配置。
3. 高级模式提供步骤列表，支持新增、删除、排序、节点类型、名称、模板和模型设置。
4. 保存前验证参数键唯一、必填信息完整、至少存在一个有效步骤。
5. 检查小尺寸窗口下的滚动、按钮文本和无内容状态。

### Task 4: 运行表单与触发入口

**Files:**
- Modify: `src/App.tsx`
- Create: `src/components/nodes/shared/PresetRunnerDialog.tsx`
- Modify: `src/components/nodes/shared/SlashCommandMenu.tsx`
- Modify: `src/components/nodes/shared/PromptPanel.tsx`
- Modify: `src/components/nodes/shared/TextNodeToolbar.tsx`
- Modify: `src/components/nodes/shared/AudioNodeToolbar.tsx`
- Modify: `src/components/nodes/shared/VideoNodeToolbar.tsx`
- Modify: `src/components/nodes/shared/image/ImageNodeToolbar.tsx`

**Steps:**
1. 在 preset slice 保存非持久化运行请求，只记录 presetId 和 sourceNodeId。
2. 全局挂载运行弹窗，按参数定义生成表单并展示步骤与生成次数摘要。
3. 斜杠菜单和四种节点 Toolbar 检测高级预设后打开运行弹窗；基础预设保持原路径。
4. 用户确认后启动顺序执行，关闭表单并在画布节点状态中展示进度。
5. 执行失败时展示出错步骤，后续节点保持 idle。

### Task 5: 验证

**Files:** 所有上述改动文件。

**Steps:**
1. 使用严格 UTF-8 解码并扫描常见乱码字符。
2. 运行 `npm run typecheck`。
3. 对改动的 TS/TSX 文件运行定向 ESLint；若命中已知 ESLint 10 兼容错误则如实记录。
4. 运行 `git diff --check`。
5. 使用系统临时目录运行 `npx vite build --outDir <temp>`。
6. 启动开发服务器，在桌面和窄窗口下检查基础模式、高级编辑、参数运行表单和顺序执行入口。

## 完成记录

### 2026-10-25：用途选择与文本胶囊

- 用户确认：运行参数按“产品信息、已确认卖点、统一风格、人物设定、自定义内容”选择用途，不向普通用户展示英文变量名。名称仍可自定义，每行提供用途说明。
- 数据：用途仅映射已有参数 key；切换用途时同步改写所有步骤中的对应模板占位符，参数 ID、类型、默认值、顺序和必填设置保持原语义，不增加数据库字段。已有自定义 key 归入自定义用途。
- 自定义输入：复用 `Select.customInput`，可在用途框内直接编辑名称并同步胶囊，不把「自定义内容」作为无法修改的固定展示。单选项列表逐行或逗号输入，编辑草稿保留空行和光标，失焦后显示归一列表；空项/重复项不落入选项，删除已选默认项后清空默认值。中英日韩文案同步。
- 编辑：`PresetTemplateEditor.tsx` 复用现有占位胶囊样式和编辑历史基础，在 DOM 中显示名称，保存仍使用原来的 `{{key}}` 字符串。支持文字/换行/IME、光标插入、删除和纯文本剪贴板，不接受粘贴 HTML。
- 多语言：内置用途、说明、插入按钮、胶囊及运行表单标签使用中英日韩词条；自定义名称、默认内容和提示词保留用户文本，不随界面语言改写持久化记录。
- 范围：参数展示工具、`PresetAdvancedEditor.tsx`、胶囊编辑器与 DOM 工具、`PresetRunnerDialog.tsx`、相关三语词条、必要业务样式及定向回归源码。执行、权限、分享格式和媒体生成流程不变。
- 状态：源码与定向回归用例已实现，完成调用链、UTF-8 与差异静态核对；提交时由既有 pre-commit 钩子执行暂存 TS/TSX 的定向 ESLint。未运行自动化测试、类型检查、构建或桌面验收，待用户验收。

#### 桌面验收

1. 在 Tauri「快捷指令 → 图像预设 → 高级」打开已有 18 步产品系列指令，预期上方显示用途下拉与说明，下方显示名称胶囊，不再直接显示英文占位符；默认内容、类型、必填和步骤顺序保留。
2. 将某一用途切成自定义内容，再切回原用途，检查所有步骤的胶囊与预览同步，未使用的用途可选，已由其他参数使用的用途不可重复选择。新建/删除参数后继续添加，自定义参数内部 key 不重复。
3. 新增自定义参数，在用途框直接输入「背景要求」，再修改/清空名称，预期名称框和胶囊同步且可正常编辑；保存重开后名称保留。切成单选，逐行或用逗号添加选项，预期输入末尾换行不被吞掉；选择默认项，再删除该项，预期默认内容清空。
4. 在一段文字中间放置光标并点击内容按钮，预期在该位置插入胶囊；输入中文、换行，逐个删除胶囊，再用 Ctrl+Z / Ctrl+Shift+Z 撤销重做。复制或剪切含胶囊的内容后粘贴，预期引用仍可识别，HTML 标签不作为页面执行。
5. 把参数名称改成自定义名称，检查对应胶囊及运行表单跟随；切换中文、英文、日文、韩文，内置名称和说明翻译，自定义文字保持不变。语言切换和标签刷新不应丢失编辑光标或把新语言写入模板 key。
6. 保存重开、复制 JSON、导出再导入，预期胶囊与实际填入内容一致，旧模板及 `{{文章内容}}` 兼容。回归数字/单选/开关、保存期间禁用、空名称校验、未知旧占位符、深浅主题、长名称和窄窗口。

用户可在仓库根目录运行 `npx vitest run tests/utils/presetParameterPresentation.test.ts tests/components/presetTemplateEditorDom.test.ts --exclude ".planning/**"`；交互与 IME 仍需上述桌面验收。回滚仅撤销本批展示/编辑组件、词条与工具，不需要数据迁移，已保存模板仍是普通字符串。

### 2026-10-24：步骤参考来源与依赖并发

- 目标：同一张产品图可作为多个主题生成步骤的共同参考，也可与参考上一步结果的步骤混合。
- 数据与执行：`PresetSequenceStep.referenceSource` 使用可选的 `source / previous`；缺省兼容旧顺序链，首步始终回到触发节点。提示词引用与连线使用同一个参考节点；模型与尺寸的已有继承规则保留。
- 调度：`PresetAdvancedConfig.executionMode` 缺省 `sequential`；显式 `parallel` 时最多 3 步并发，`source` 步骤可独立启动，`previous` 步骤必须等待前一步成功。失败、项目切换或待执行节点/参考节点删除后停止新任务，等待已启动任务收尾；不重投付费调用。
- 编辑与工具：编辑器、运行确认和管理页脚同步显示执行方式与来源。旧的 `{{previousResult}}` 槽位替换为该步骤选定的参考节点。Agent/MCP 配置工具保留两个字段；已有分步运行协议继续按 `nextStep` 串行，返回实际执行方式，不扩大工具并发权限。
- 持久化：沿用已有 `advanced` 读写，不新增数据库版本或迁移。定向回归源码覆盖来源引用、调度与工具配置往返；源码已实现并完成静态核对，功能验收仍待用户完成。
- 验收入口与回滚见[模型与生成模块](../模型与生成模块.md#高级快捷指令生成流程)。本次未运行测试、lint、类型检查、构建或实际生成。

2026-07-19 完成参数化高级快捷指令与顺序执行链：

- `npm run typecheck` 通过。
- 新增及相关改动文件的定向 ESLint 通过；`ImageNodeToolbar.tsx` 全文件检查仍命中既有的 Effect 状态更新与依赖告警，本次新增分流未扩大该问题。
- `git diff --check` 通过。
- 所有改动文本严格 UTF-8 解码通过，常见乱码字符扫描为 0。
- `npx vite build --outDir %TEMP%/ai-canvas-preset-build-20260719` 通过。
- 在 Tauri 1420×900 实际窗口验证基础/高级模式、参数行、双步骤卡片、内部滚动和固定操作栏；未保存测试数据。
