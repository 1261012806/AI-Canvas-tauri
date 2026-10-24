# Mac / Linux 平台兼容性修复

主归属：[桌面运行时与安全](../桌面运行时与安全模块.md)。媒体剪辑沿用[视频编辑器方案](./2026-07-31-video-editor-window.md)，文件授权沿用[文件与存储](../文件与存储模块.md)。

## 本批范围

用户已确认 11 个文件的修复范围，无新增依赖，不调整鼠标 / 触控板、安全配置和路径权限。代码与回归用例已实现，待用户验证；源码、差异空白和 UTF-8 静态核对已完成，提交钩子对本批 7 个 TypeScript 文件的定向 ESLint 已通过。本次未运行测试、类型检查、构建或桌面验收。

| 范围 | 源码与回归入口 | 目标行为 |
|---|---|---|
| 合成音轨与编码能力 | `src/services/videoEditorMediaService.ts`、`tests/services/videoEditorComposite.test.ts` | 按实际 AAC 编码能力选择编码、兼容音轨直通或 PCM；第一段无声、后续有声仍能正确启动输出；不能解码或保留的音轨明确报错，不静默丢音。 |
| 媒体整包回退 | 同上媒体服务、`tests/services/videoEditorMediaService.test.ts` | 正常 Range 继续按需读取；整包回退限制单文件 64 MiB、当前 WebView 并存缓存 128 MiB；释放 Input 时取消读取并归还预算。 |
| 插件视频预览 | `src/services/plugins/pluginVideoPlaybackService.ts`、`tests/services/pluginVideoPlaybackService.test.ts` | 检查 AAC 编码能力；不支持时尝试保留容器兼容的原音轨，不能保留时明确报错。 |
| Mac 外部编辑器 | `src/services/fs/externalEditors.ts`、`src-tauri/src/lib.rs`、`tests/services/externalEditors.test.ts` | 自动候选和手动路径复用已授权的原生启动入口；检查系统启动器的退出状态，失败后继续下一个自动候选。 |
| Linux 文件剪贴板 | `src-tauri/src/files/clipboard.rs`、`src-tauri/src/files/clipboard_read.rs` 内联测试 | 用标准文件 URI 编码保留特殊字符；X11 私有格式读取失败后尝试 `text/uri-list`，保留既有超时、大小与路径授权。 |

第 11 个文件为本专项计划。

## 边界与风险

- 64 / 128 MiB 是沿用项目既有媒体读取限额的保守策略，未经实机性能标定；它限制保留的原始整包缓存，不代表整个进程的峰值内存。正常 Range 文件不受整包文件大小上限限制。超过上限时提示读取失败，不继续无界下载。
- 整包下载按实际流式字节数计量；没有流式读取能力时明确拒绝，不因服务端声明了较小的 Content-Length 就退回无界 `arrayBuffer()`。
- 本批只接通 Input 释放时的取消；其余调用方尚未统一把任务取消信号传到媒体打开阶段，不能据此宣称所有取消按钮都会立即中止初始化。
- PCM 音轨比 AAC 大，目标播放器的兼容性需要实机验收；源音轨不能解码时不生成缺声的成功结果。
- 外部编辑器的启动成功表示系统启动器接受了请求，不保证编辑器已经完成文件加载。
- 本批修复源码中已确认的逻辑缺口，不代表已经定位或修复用户设备上 ComfyUI 视频生成后回首页、点击编辑退出的问题。该事故仍需要匹配版本和时间的生命周期记录及系统崩溃报告。

## Tauri 桌面验收（待用户执行）

前置：使用包含本批 Rust 和前端改动的桌面构建，先备份测试项目；Mac 与 Linux 分别验收，Web 结果不能替代桌面结果。

1. **合成导出**：时间轴先放无声视频，再放带 AAC 音轨的视频，增加画面变换以进入合成导出；分别在支持与不支持 AAC 编码的系统执行。预期导出完成、首段静音、后段声音和时间位置正确。回归全无声、重叠音轨、音量调整和不同音频参数；需要解码但系统不支持时应显示错误，不输出缺声的成功结果。
2. **插件连续预览**：分别准备带声和无声视频，生成连续预览并播放。支持 AAC 时应保留声音；不支持编码但原音轨能进入 MP4 时仍应有声，不能保留时显示错误。准备中关闭窗口 / 取消任务，确认后续不交付过期预览。
3. **读取退化**：用可控制的测试媒体服务分别返回正常 Range、忽略 Range、持续失败的 Range；小文件应能回退读取，超过 64 MiB 的整包应明确拒绝，正常 Range 的大文件仍可按需读取。打开多个回退素材至预算上限应拒绝新增缓存；关闭对应素材后可再次打开。释放仍在读取的 Input 后不应继续整包下载。未知长度和虚假 Content-Length 同样要受实际字节数限制。
4. **Mac 编辑器**：只安装非首选候选版本的 Photoshop / 视频编辑器，执行“在外部编辑器打开”。预期继续探测并打开实际安装版本；手动选择已安装 `.app` 也应可打开。全部候选不存在、路径无权访问或应用无效时应显示失败，不假报成功。
5. **Linux 剪贴板**：在 X11 桌面复制和粘贴文件 / 目录，覆盖 GNOME 私有格式与只提供 `text/uri-list` 的文件管理器；另在 Wayland 回归原入口。名称包含中文、空格、`#`、`?`、`%` 和换行时路径应保持原样。回归空剪贴板、工具缺失、读取超时、超大输出及未授权目录；失败不能扩大路径访问范围。
6. **输入回归**：Mac 普通鼠标滚轮缩放；触控板双指上下、左右和斜向平移，捏合缩放。此次没有改输入逻辑，仍需避免把其他平台修改误归因于输入修复。

可选自动化入口（本次未运行）：

```sh
# 仓库根目录
npx vitest run tests/services/videoEditorMediaService.test.ts tests/services/videoEditorComposite.test.ts tests/services/pluginVideoPlaybackService.test.ts tests/services/externalEditors.test.ts

# src-tauri/，Linux 剪贴板用例需在 Linux 执行
cargo test --lib clipboard::tests
cargo test --lib clipboard_read::tests
cargo check --lib
```

## 后续适配（未实施）

| 方向 | 后续边界 |
|---|---|
| Linux 打包与 CI | 固定最低支持发行版的构建基线；按发行格式准备 GStreamer 媒体依赖；增加 Mac / Linux Rust 检查及有效的原生启动验收。 |
| Wayland 独立窗口 | 根据真实窗口后端降级位置锁；不能只以位置 getter 成功判断可定位。精确识别需要单独批准 Linux 原生依赖。 |
| Linux WebProcess 与输入 | GTK 终止信号与触控板来源识别需要直接原生绑定；保持固定日志、插件会话撤销与不重放生成任务的边界，不能用滚轮步幅猜设备。 |
| GUI 进程 PATH | 区分固定系统候选和已授权安装环境，保留 venv 优先，不读 shell 配置或扩大目录授权；ComfyUI 与插件运行时分别复核。 |
| Mac 副窗诊断 | 增加有限的窗口类别与生命周期事件，仍不记录 URL、文件路径或工作流正文。诊断不等于崩溃修复。 |

## 回退

本批无数据迁移。媒体、外部编辑器、剪贴板三组可按对应源码与测试成组回退；不回退项目数据、应用权限或其他任务的改动。回退整包限额会重新暴露无界读取风险，应优先保留限额并修复具体兼容问题。
