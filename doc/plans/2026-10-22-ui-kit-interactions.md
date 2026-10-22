# UI Kit 交互完整性

## 目标与边界

补齐共享控件的草稿、键盘与输入法行为，让 UI Kit 预览可作为业务复用和桌面验收入口。沿用现有组件、`ui-*` 样式、主题令牌和六组分类；不新增依赖，不修改原生权限或业务持久化。

## 实施步骤

| 范围 | 源码与回归入口 | 实施内容 |
|---|---|---|
| 数字输入 | `src/components/shared/NumberStepper.tsx`；`tests/components/numberStepper.test.tsx` | Esc 丢弃草稿且不误关父弹窗；步进采用有效草稿并遵守范围和精度；可访问名称传给实际输入框 |
| 下拉选择 | `src/components/shared/Select.tsx`；`tests/components/select.test.tsx` | 打开后聚焦当前可用选项，否则聚焦首个可用项；消费同次 Esc 的按下、连按与释放，保留 Portal、视口避让和输入模式 |
| 媒体与文档 | `src/components/shared/VideoPlayer.tsx`、`MarkdownEditor.tsx`；对应组件回归 | 紧凑播放器提供键盘入口；Markdown 查找 Enter 避开中文输入法确认 |
| 预览样例 | `src/components/styleGuide/StyleGuideWindow.tsx`、`StyleGuideSections.tsx`、`StyleGuideDialogs.tsx` | 初始化真实 Tooltip；动作菜单补焦点、键盘、禁用和长名；分段控件独立状态与准确语义；字段状态对照和表单数字草稿样例 |

共享组件修复向现有调用方生效；样例只管理本窗口临时状态，不改主窗口配置或项目内容。仅补与本次缺陷有关的回归，不运行测试或应用。

## 状态

- 已实现数字草稿、下拉初始焦点与 Esc 配对释放保护、播放器键盘入口、Markdown 输入法保护及预览样例；已补对应定向回归用例。
- 已完成调用链、差异空白与严格 UTF-8 静态核对，不据此声明功能或自动回归通过。
- 提交时由既有 pre-commit 钩子执行本次暂存 TS/TSX 文件的定向 ESLint。本次未运行测试，待用户验收；未运行类型检查、构建或浏览器/Tauri 实机检查。

## 桌面验收

前置：使用包含本次改动的 Tauri 开发版本，从「关于 → 连点 logo 4 次」打开 UI Kit，无须配置模型或调用付费服务。

1. 数字输入：已提交值 40，键入 80 后按 Esc，显示和已提交值应回到 40；重新键入 80 后按 ↑ 应为 81。回归 Enter、失焦、滚轮、加减按钮、Shift 步进、上下限、负数和小数。在表单弹窗内按 Esc 应先取消数字草稿，再次按 Esc 才关闭弹窗。
2. 下拉选择：选中中间项后，用 Enter/空格/方向键打开；焦点应在当前可用项，方向键继续相邻项，Home/End 跳过禁用项。回归选中项禁用、空选项、容器内菜单、自定义输入、Tab 离开和 Esc 逐层关闭；菜单仍不受卡片裁剪。在使用按键释放关闭的业务全屏内，按住再松开 Esc 只收起下拉，下次独立 Esc 才关闭全屏；窗口切走再返回不得残留按键状态。
3. 动作菜单：Enter/空格/方向键打开，上下与 Home/End 导航，禁用项不可触发；Esc 关闭并还焦，Tab 正常离开，外部点击收起。长名称在窄窗口仍可读。
4. 视频：在视频播放器分区选择本地 MP4 并开启紧凑模式，仅用 Tab 进入；应显示控制栏，可用键盘播放、调整音量和打开菜单，移出焦点后按原规则收起。
5. Markdown：打开查找，在正文含有匹配内容时用中文输入法确认候选；候选确认不得触发查找或移焦，再按 Enter 才定位正文。回归普通 Enter 查找、无匹配、替换与只读显示。
6. 预览：标题栏和真实 Tooltip 样例在悬停/键盘聚焦时显示，靠近窗口边缘不裁剪；两组分段各自保留唯一选择。明暗主题与 720 × 480 窗口下复核菜单、焦点反馈和长内容，并回归 AI 输入框、数字参数字段与业务下拉。

如需运行自动回归，在仓库根目录执行：`npx vitest run tests/components/numberStepper.test.tsx tests/components/select.test.tsx tests/components/selectPortalBoundary.test.ts tests/components/videoPlayer.test.tsx tests/components/markdownEditor.test.tsx`。该命令仅提供给用户，本轮不执行。

## 回退

按控件回退本次源码、样例与对应回归即可，无数据迁移或用户文件清理。Select 保留既有 Portal 和父层边界，不单独取消安全与焦点保护。
