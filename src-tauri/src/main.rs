//! AI Canvas 桌面进程入口；按 CLI 参数进入隔离的 ONNX Worker 或启动 Tauri 主应用。

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // 提升分支仅准备插件固定目录，不加载 Tauri、ONNX 或任何插件代码。
    let native_args: Vec<std::ffi::OsString> = std::env::args_os().collect();
    if let Some(exit_code) = ai_canvas_tauri_lib::plugin_install_permissions::dispatch_helper(&native_args) {
        std::process::exit(exit_code);
    }
    // --onnx-worker 模式：独立的推理子进程
    let args: Vec<String> = std::env::args().collect();
    if args.len() > 1 && args[1] == "--onnx-worker" {
        #[cfg(feature = "local-onnx")]
        ai_canvas_tauri_lib::onnx::worker::run();
        #[cfg(not(feature = "local-onnx"))]
        eprintln!("x64-legacy 版本未包含本地 ONNX Runtime");
        return;
    }

    ai_canvas_tauri_lib::run();
}
