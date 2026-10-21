//! 图形启动配置与 WebContent 异常恢复，不接受 Renderer 提交路径或浏览器参数。
use serde::Serialize;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Mutex,
};
use tauri::{Manager, Webview};

#[cfg(any(target_os = "macos", test))]
const LIFECYCLE_LOG_FILE: &str = "webview-lifecycle.jsonl";
#[cfg(any(target_os = "macos", test))]
const LIFECYCLE_LOG_LIMIT: u64 = 16 * 1024;

#[cfg(any(target_os = "macos", test))]
#[derive(Clone, Copy, Serialize)]
#[serde(rename_all = "snake_case")]
enum LifecycleEvent {
    AppStarted,
    PageStarted,
    PageFinished,
    MainWebContentTerminated,
}

#[cfg(any(target_os = "macos", test))]
fn append_lifecycle_record(
    directory: &std::path::Path,
    record: &serde_json::Value,
) -> std::io::Result<()> {
    use std::io::Write;
    let mut line = record.to_string().into_bytes();
    line.push(b'\n');
    if line.len() as u64 > LIFECYCLE_LOG_LIMIT {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "webview lifecycle record exceeds limit",
        ));
    }
    std::fs::create_dir_all(directory)?;
    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(directory.join(LIFECYCLE_LOG_FILE))?;
    // 只保留一小段近期记录；即使旧文件异常变大，也不把它读进内存。
    if file.metadata()?.len().saturating_add(line.len() as u64) > LIFECYCLE_LOG_LIMIT {
        file = std::fs::File::create(directory.join(LIFECYCLE_LOG_FILE))?;
    }
    file.write_all(&line)
}

#[cfg(target_os = "macos")]
fn record_lifecycle(app: &tauri::AppHandle, event: LifecycleEvent) {
    let record = serde_json::json!({
        "event": event,
        "timeMs": std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default().as_millis(),
        "processId": std::process::id(),
        "version": app.package_info().version.to_string(),
        "arch": std::env::consts::ARCH,
    });
    let Ok(directory) = app.path().app_log_dir() else {
        eprintln!("[webview] lifecycle log directory unavailable");
        return;
    };
    let state = app.state::<NativeRenderingState>();
    let _lock = state
        .write_lock
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    // 事件很少、写入最多 16 KiB；同步串行落盘，避免恢复导航先于终止记录。
    if append_lifecycle_record(&directory, &record).is_err() {
        eprintln!("[webview] lifecycle log write failed");
    }
    if matches!(event, LifecycleEvent::MainWebContentTerminated) {
        // 保留旧诊断入口，只在真正收到终止回调时生成；写入互不依赖。
        let result = std::fs::create_dir_all(&directory).and_then(|()| {
            std::fs::write(
                directory.join("last-webview-termination.json"),
                record.to_string(),
            )
        });
        if result.is_err() {
            eprintln!("[webview] termination log write failed");
        }
    }
}

#[cfg(target_os = "macos")]
pub fn record_app_started(app: &tauri::AppHandle) {
    record_lifecycle(app, LifecycleEvent::AppStarted);
}

#[cfg(target_os = "macos")]
pub fn record_main_page_load(webview: &Webview, payload: &tauri::webview::PageLoadPayload<'_>) {
    if webview.label() != "main" {
        return;
    }
    let event = match payload.event() {
        tauri::webview::PageLoadEvent::Started => LifecycleEvent::PageStarted,
        tauri::webview::PageLoadEvent::Finished => LifecycleEvent::PageFinished,
    };
    // 不记录页面地址、项目内容或点击位置。
    record_lifecycle(webview.app_handle(), event);
}

/// WebContent 终止与整个应用退出分开记录；主窗口回到安全启动页后再由用户选择恢复。
#[cfg(target_os = "macos")]
pub fn recover_web_content(webview: &Webview) {
    if webview.label() != "main" {
        let _ = webview.reload();
        return;
    }
    record_lifecycle(
        webview.app_handle(),
        LifecycleEvent::MainWebContentTerminated,
    );
    let recovered = webview.url().and_then(|mut url| {
        let mut pairs: Vec<(String, String)> = url
            .query_pairs()
            .filter(|(key, _)| key != "__canvas_webview_recovery")
            .map(|(key, value)| (key.into_owned(), value.into_owned()))
            .collect();
        pairs.push(("__canvas_webview_recovery".into(), "1".into()));
        url.query_pairs_mut().clear().extend_pairs(pairs);
        webview.navigate(url)
    });
    if recovered.is_err() {
        eprintln!("[webview] main WebContent recovery navigation failed");
        let _ = webview.reload();
    }
}

#[derive(Default)]
pub struct NativeRenderingState {
    active: AtomicBool,
    write_lock: Mutex<()>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RenderingStatus {
    supported: bool,
    active: bool,
    restart_required: bool,
}

#[derive(Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg(any(windows, test))]
struct Preference {
    version: u8,
    performance_mode: bool,
}

#[cfg(any(windows, test))]
const PREFERENCE_FILE: &str = "native-rendering.json";
#[cfg(any(windows, test))]
const GPU_MEMORY_ARGUMENT: &str = "--force-gpu-mem-available-mb=4096";

#[cfg(any(windows, test))]
fn read_preference(path: &std::path::Path) -> Result<bool, String> {
    use std::io::Read;
    let file = match std::fs::File::open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(_) => return Err("无法读取图形启动设置".into()),
    };
    let mut bytes = Vec::new();
    file.take(1025)
        .read_to_end(&mut bytes)
        .map_err(|_| "无法读取图形启动设置")?;
    if bytes.len() > 1024 {
        return Err("图形启动设置已损坏".into());
    }
    let preference: Preference =
        serde_json::from_slice(&bytes).map_err(|_| "图形启动设置已损坏")?;
    if preference.version != 1 {
        return Err("图形启动设置版本不支持".into());
    }
    Ok(preference.performance_mode)
}

#[cfg(any(windows, test))]
fn write_preference(directory: &std::path::Path, enabled: bool) -> Result<(), String> {
    use std::io::Write;
    let path = directory.join(PREFERENCE_FILE);
    if path.exists() && read_preference(&path) == Ok(enabled) {
        return Ok(());
    }
    std::fs::create_dir_all(directory).map_err(|_| "无法保存图形启动设置")?;
    let temporary = directory.join(format!("native-rendering.{}.tmp", std::process::id()));
    let result = (|| -> std::io::Result<()> {
        let mut file = std::fs::File::create(&temporary)?;
        let bytes = serde_json::to_vec(&Preference {
            version: 1,
            performance_mode: enabled,
        })?;
        file.write_all(&bytes)?;
        file.sync_all()?;
        drop(file);
        std::fs::rename(&temporary, &path)?;
        Ok(())
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&temporary);
    }
    result.map_err(|_| "无法保存图形启动设置".into())
}

#[cfg(any(windows, test))]
fn apply_window_preference(config: &mut tauri::utils::config::WindowConfig, enabled: bool) {
    if !enabled {
        return;
    }
    config.transparent = false;
    // 同一 profile 的 WebView2 必须使用相同的 EnvironmentOptions。
    // GPU 参数统一通过进程环境设置，不能只覆盖主窗口的 Wry 默认参数。
}

/// Tauri 自动窗口早于 app.setup 创建；只延后 Windows 主窗口，确保先读启动开关。
#[cfg(windows)]
pub fn defer_main_window(
    config: &mut tauri::utils::config::Config,
) -> Option<tauri::utils::config::WindowConfig> {
    let main = config
        .app
        .windows
        .iter_mut()
        .find(|window| window.label == "main" && window.create)?;
    let original = main.clone();
    main.create = false;
    Some(original)
}

#[cfg(windows)]
pub fn create_main_window(
    app: &tauri::App,
    config: Option<tauri::utils::config::WindowConfig>,
) -> Result<(), Box<dyn std::error::Error>> {
    let Some(mut config) = config else {
        return Ok(());
    };
    let enabled = app
        .path()
        .app_config_dir()
        .ok()
        .and_then(|directory| read_preference(&directory.join(PREFERENCE_FILE)).ok())
        .unwrap_or(false);
    apply_window_preference(&mut config, enabled);
    if enabled {
        // 所有自有窗口沿用 Wry 的默认 EnvironmentOptions，共享这一固定参数。
        let mut arguments =
            std::env::var("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS").unwrap_or_default();
        arguments.push(' ');
        arguments.push_str(GPU_MEMORY_ARGUMENT);
        std::env::set_var("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS", arguments);
    }
    app.state::<NativeRenderingState>()
        .active
        .store(enabled, Ordering::Release);
    tauri::WebviewWindowBuilder::from_config(app, &config)?.build()?;
    Ok(())
}

#[tauri::command]
pub fn sync_native_performance_mode(
    app: tauri::AppHandle,
    webview: Webview,
    enabled: bool,
) -> Result<RenderingStatus, String> {
    crate::path_policy::ensure_trusted_caller(&webview)?;
    if webview.label() != "main" {
        return Err("仅主窗口可修改图形启动设置".into());
    }
    let state = app.state::<NativeRenderingState>();
    let _lock = state
        .write_lock
        .lock()
        .map_err(|_| "图形启动设置暂不可用")?;
    #[cfg(windows)]
    write_preference(
        &app.path()
            .app_config_dir()
            .map_err(|_| "无法定位图形启动设置")?,
        enabled,
    )?;
    let active = state.active.load(Ordering::Acquire);
    Ok(RenderingStatus {
        supported: cfg!(windows),
        active,
        restart_required: cfg!(windows) && active != enabled,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn lifecycle_log_creates_early_and_bounds_complete_records() {
        let directory = std::env::temp_dir().join(format!(
            "ai-canvas-lifecycle-test-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let path = directory.join(LIFECYCLE_LOG_FILE);
        let events = [
            LifecycleEvent::AppStarted,
            LifecycleEvent::PageStarted,
            LifecycleEvent::PageFinished,
            LifecycleEvent::MainWebContentTerminated,
        ];
        for event in events {
            append_lifecycle_record(&directory, &serde_json::json!({ "event": event })).unwrap();
        }
        let records: Vec<serde_json::Value> = std::fs::read_to_string(&path)
            .unwrap()
            .lines()
            .map(|line| serde_json::from_str(line).unwrap())
            .collect();
        assert_eq!(
            records
                .iter()
                .map(|record| record["event"].as_str().unwrap())
                .collect::<Vec<_>>(),
            [
                "app_started",
                "page_started",
                "page_finished",
                "main_web_content_terminated",
            ]
        );
        assert!(!directory.join("last-webview-termination.json").exists());

        // 旧文件再大也只看大小，下一条记录会直接开始新的有界文件。
        std::fs::write(&path, vec![b'x'; LIFECYCLE_LOG_LIMIT as usize + 1]).unwrap();
        append_lifecycle_record(&directory, &serde_json::json!({ "event": "page_finished" }))
            .unwrap();
        assert_eq!(
            std::fs::read_to_string(&path).unwrap(),
            "{\"event\":\"page_finished\"}\n"
        );
        let oversized = serde_json::json!({ "event": "x".repeat(LIFECYCLE_LOG_LIMIT as usize) });
        assert!(append_lifecycle_record(&directory, &oversized).is_err());
        for time in 0..1000 {
            append_lifecycle_record(
                &directory,
                &serde_json::json!({
                    "event": LifecycleEvent::PageFinished,
                    "timeMs": time,
                }),
            )
            .unwrap();
        }
        let contents = std::fs::read_to_string(&path).unwrap();
        assert!(contents.len() as u64 <= LIFECYCLE_LOG_LIMIT);
        let records: Vec<serde_json::Value> = contents
            .lines()
            .map(|line| serde_json::from_str(line).unwrap())
            .collect();
        assert!(records.len() < 1000);
        assert_eq!(records.last().unwrap()["timeMs"], 999);
        std::fs::remove_file(path).unwrap();
        std::fs::remove_dir(directory).unwrap();
    }

    #[test]
    fn normal_window_is_unchanged_and_performance_preserves_other_options() {
        let mut normal = tauri::utils::config::WindowConfig::default();
        normal.transparent = true;
        normal.additional_browser_args = Some("--test-existing".into());
        let before = serde_json::to_value(&normal).unwrap();
        apply_window_preference(&mut normal, false);
        assert_eq!(serde_json::to_value(&normal).unwrap(), before);
        apply_window_preference(&mut normal, true);
        assert!(!normal.transparent);
        assert_eq!(
            normal.additional_browser_args.as_deref(),
            Some("--test-existing")
        );
        normal.transparent = true;
        normal.additional_browser_args = Some("--test-existing".into());
        assert_eq!(serde_json::to_value(&normal).unwrap(), before);
    }
    #[test]
    fn performance_keeps_default_webview_environment_options() {
        let mut config = tauri::utils::config::WindowConfig::default();
        apply_window_preference(&mut config, true);
        assert!(config.additional_browser_args.is_none());
        assert!(!config.transparent);
    }
    #[test]
    fn preference_round_trip_missing_corrupt_and_bounded_read() {
        let directory = std::env::temp_dir().join(format!(
            "ai-canvas-rendering-test-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let file = directory.join(PREFERENCE_FILE);
        assert!(!read_preference(&file).unwrap());
        write_preference(&directory, true).unwrap();
        assert!(read_preference(&file).unwrap());
        write_preference(&directory, false).unwrap();
        assert!(!read_preference(&file).unwrap());
        for invalid in [
            "broken".to_string(),
            "{\"version\":2,\"performanceMode\":true}".to_string(),
            " ".repeat(1025),
        ] {
            std::fs::write(&file, invalid).unwrap();
            assert!(read_preference(&file).is_err());
        }
        write_preference(&directory, true).unwrap();
        assert!(read_preference(&file).unwrap());
        assert!(!directory
            .join(format!("native-rendering.{}.tmp", std::process::id()))
            .exists());
        std::fs::remove_file(file).unwrap();
        std::fs::remove_dir(directory).unwrap();
    }
    #[cfg(windows)]
    #[test]
    fn defers_only_the_main_window_and_retains_its_original_config() {
        let mut config = tauri::utils::config::Config::default();
        config.app.windows = vec![tauri::utils::config::WindowConfig::default()];
        let original = serde_json::to_value(&config.app.windows[0]).unwrap();
        let deferred = defer_main_window(&mut config).unwrap();
        assert_eq!(serde_json::to_value(deferred).unwrap(), original);
        assert!(!config.app.windows[0].create);
        assert!(defer_main_window(&mut config).is_none());
    }
}
