//! 应用管理的本地 ComfyUI 启动配置，仅提供固定枚举与端口白名单。

use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU16, Ordering};
use std::sync::Mutex;
use tauri::Manager;

const SETTINGS_FILE: &str = "comfyui-launch.json";
const SETTINGS_TEMP_FILE: &str = "comfyui-launch.json.tmp";
const SETTINGS_BACKUP_FILE: &str = "comfyui-launch.json.bak";
const MAX_SETTINGS_BYTES: u64 = 16 * 1024;
static SETTINGS_LOCK: Mutex<()> = Mutex::new(());
// 运行时观测只保留端口；即使启动后保存了新配置，也不能遗漏仍运行的旧端口。
static LAST_LAUNCH_PORT: AtomicU16 = AtomicU16::new(0);

#[derive(Clone, Copy, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum VramMode {
    #[default]
    Auto,
    High,
    Normal,
    Low,
    No,
    Cpu,
}

#[derive(Clone, Copy, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Precision {
    #[default]
    Auto,
    Fp16,
    Bf16,
    Fp32,
}

#[derive(Clone, Copy, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Attention {
    #[default]
    Auto,
    Pytorch,
    Split,
    Quad,
}

#[derive(Clone, Copy, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum PreviewMethod {
    #[default]
    Auto,
    None,
    Latent2rgb,
    Taesd,
}

#[derive(Clone, Copy, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum MemorySwitch {
    #[default]
    Auto,
    Enabled,
    Disabled,
}

#[derive(Clone, Copy, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum H3MemoryPreset {
    #[default]
    Off,
    Safe12,
    Custom,
}

#[derive(Clone, Copy, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum TextEncoderDevice {
    Auto,
    #[default]
    Cpu,
}

/// 仅保存工作流执行策略；不作为任意命令行或模型路径传入 Python。
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
pub struct H3MemorySettings {
    pub preset: H3MemoryPreset,
    pub attention_head_chunks: u16,
    pub feed_forward_chunks: u16,
    pub feed_forward_threshold: u32,
    pub text_encoder_device: TextEncoderDevice,
    pub reference_image_max_size: u16,
    pub vae_tiling: bool,
    pub vae_tile_size: u16,
    pub vae_temporal_size: u16,
}

impl Default for H3MemorySettings {
    fn default() -> Self {
        Self {
            preset: H3MemoryPreset::Off,
            attention_head_chunks: 4,
            feed_forward_chunks: 2,
            feed_forward_threshold: 4096,
            text_encoder_device: TextEncoderDevice::Cpu,
            reference_image_max_size: 512,
            vae_tiling: true,
            vae_tile_size: 256,
            vae_temporal_size: 16,
        }
    }
}

impl H3MemorySettings {
    fn validate(&self) -> Result<(), String> {
        if !(1..=56).contains(&self.attention_head_chunks)
            || !(1..=64).contains(&self.feed_forward_chunks) {
            return Err("H3 注意力分块数必须在 1–56 之间，前馈分块数必须在 1–64 之间".into());
        }
        if !(256..=262_144).contains(&self.feed_forward_threshold) || self.feed_forward_threshold % 256 != 0 {
            return Err("H3 前馈分块阈值必须在 256–262144 之间，且为 256 的倍数".into());
        }
        if self.reference_image_max_size != 0 && (!(64..=2048).contains(&self.reference_image_max_size) || self.reference_image_max_size % 64 != 0) {
            return Err("H3 参考图片长边必须为 0，或在 64–2048 之间且为 64 的倍数".into());
        }
        if !(128..=2048).contains(&self.vae_tile_size) || self.vae_tile_size % 64 != 0 {
            return Err("H3 VAE 分块尺寸必须在 128–2048 之间，且为 64 的倍数".into());
        }
        if !(8..=128).contains(&self.vae_temporal_size) || self.vae_temporal_size % 4 != 0 {
            return Err("H3 VAE 时间分块必须在 8–128 之间，且为 4 的倍数".into());
        }
        Ok(())
    }
}

fn default_async_offload_streams() -> u8 { 2 }

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ComfyUILaunchSettings {
    pub port: u16,
    pub vram_mode: VramMode,
    pub precision: Precision,
    pub attention: Attention,
    pub preview_method: PreviewMethod,
    pub disable_smart_memory: bool,
    #[serde(default)]
    pub dynamic_vram: MemorySwitch,
    #[serde(default)]
    pub reserve_vram_gb: Option<u16>,
    #[serde(default)]
    pub async_offload: MemorySwitch,
    #[serde(default = "default_async_offload_streams")]
    pub async_offload_streams: u8,
    #[serde(default)]
    pub h3_memory: H3MemorySettings,
}

impl Default for ComfyUILaunchSettings {
    fn default() -> Self {
        Self {
            port: 8188,
            vram_mode: VramMode::Auto,
            precision: Precision::Auto,
            attention: Attention::Auto,
            preview_method: PreviewMethod::Auto,
            disable_smart_memory: false,
            dynamic_vram: MemorySwitch::Auto,
            reserve_vram_gb: None,
            async_offload: MemorySwitch::Auto,
            async_offload_streams: default_async_offload_streams(),
            h3_memory: H3MemorySettings::default(),
        }
    }
}

impl ComfyUILaunchSettings {
    fn validate(&self) -> Result<(), String> {
        if self.port < 1024 {
            return Err("ComfyUI 端口必须在 1024–65535 之间".to_string());
        }
        if self.reserve_vram_gb.is_some_and(|value| value > 64) {
            return Err("ComfyUI 预留显存必须为 0–64 GB 的整数".into());
        }
        if !(1..=4).contains(&self.async_offload_streams) {
            return Err("ComfyUI 异步卸载流数必须在 1–4 之间".into());
        }
        if self.dynamic_vram == MemorySwitch::Enabled && matches!(self.vram_mode, VramMode::High | VramMode::No | VramMode::Cpu) {
            return Err("动态显存不能与高显存、无显存或 CPU 模式同时启用，请调整显存模式".into());
        }
        self.h3_memory.validate()
    }

    /// 只有启动参数保持默认时才可使用旧启动器；工作流策略不会改变启动方式。
    #[cfg(any(windows, test))]
    pub(super) fn requires_direct_launch(&self) -> bool {
        self.port != 8188 || self.vram_mode != VramMode::Auto
            || self.precision != Precision::Auto || self.attention != Attention::Auto
            || self.preview_method != PreviewMethod::Auto || self.disable_smart_memory
            || self.dynamic_vram != MemorySwitch::Auto || self.reserve_vram_gb.is_some()
            || self.async_offload != MemorySwitch::Auto
    }

    pub(super) fn append_args(
        &self,
        args: &mut Vec<String>,
        declared_args: &str,
    ) -> Result<(), String> {
        self.validate()?;
        append_supported_arg(args, declared_args, "--port", Some(&self.port.to_string()))?;

        let vram = match self.vram_mode {
            VramMode::Auto => None,
            VramMode::High => Some("--highvram"),
            VramMode::Normal => Some("--normalvram"),
            VramMode::Low => Some("--lowvram"),
            VramMode::No => Some("--novram"),
            VramMode::Cpu => Some("--cpu"),
        };
        let precision = match self.precision {
            Precision::Auto => None,
            Precision::Fp16 => Some("--fp16-unet"),
            Precision::Bf16 => Some("--bf16-unet"),
            Precision::Fp32 => Some("--fp32-unet"),
        };
        let attention = match self.attention {
            Attention::Auto => None,
            Attention::Pytorch => Some("--use-pytorch-cross-attention"),
            Attention::Split => Some("--use-split-cross-attention"),
            Attention::Quad => Some("--use-quad-cross-attention"),
        };
        for flag in [vram, precision, attention].into_iter().flatten() {
            append_supported_arg(args, declared_args, flag, None)?;
        }
        let preview = match self.preview_method {
            PreviewMethod::Auto => None,
            PreviewMethod::None => Some("none"),
            PreviewMethod::Latent2rgb => Some("latent2rgb"),
            PreviewMethod::Taesd => Some("taesd"),
        };
        if let Some(preview) = preview {
            append_supported_arg(args, declared_args, "--preview-method", Some(preview))?;
        }
        if self.disable_smart_memory {
            append_supported_arg(args, declared_args, "--disable-smart-memory", None)?;
        }
        let dynamic = match self.dynamic_vram {
            MemorySwitch::Auto => None,
            MemorySwitch::Enabled => Some("--enable-dynamic-vram"),
            MemorySwitch::Disabled => Some("--disable-dynamic-vram"),
        };
        if let Some(flag) = dynamic { append_supported_arg(args, declared_args, flag, None)?; }
        if let Some(reserve) = self.reserve_vram_gb {
            append_supported_arg(args, declared_args, "--reserve-vram", Some(&reserve.to_string()))?;
        }
        match self.async_offload {
            MemorySwitch::Auto => {},
            MemorySwitch::Disabled => append_supported_arg(args, declared_args, "--disable-async-offload", None)?,
            MemorySwitch::Enabled => {
                if !declares_async_streams(declared_args) {
                    return Err("当前 ComfyUI 版本未声明支持 --async-offload NUM_STREAMS，请将异步卸载恢复为自动或切换兼容版本".into());
                }
                append_supported_arg(args, declared_args, "--async-offload", Some(&self.async_offload_streams.to_string()))?;
            }
        }
        Ok(())
    }
}

/// 不执行安装目录中的 Python；只接受同一参数声明中明确的整数流数合同。
fn declares_async_streams(source: &str) -> bool {
    source.split(".add_argument(").skip(1).any(|arguments| {
        let declaration = arguments.trim_start();
        if !(declaration.starts_with("\"--async-offload\"") || declaration.starts_with("'--async-offload'")) {
            return false;
        }
        let fields = cli_declaration_fields(declaration);
        let compact: Vec<String> = fields.iter().map(|field| field.chars().filter(|ch| !ch.is_whitespace()).collect()).collect();
        compact.iter().any(|part| part == "type=int")
            && compact.iter().any(|part| part == "metavar=\"NUM_STREAMS\"" || part == "metavar='NUM_STREAMS'")
            && !compact.iter().any(|part| part.starts_with("action="))
    })
}

/// 按顶层逗号拆分声明，跳过字符串与括号，避免把 help 文案或后续声明当成合同。
fn cli_declaration_fields(declaration: &str) -> Vec<&str> {
    let mut fields = Vec::new();
    let mut start = 0;
    let mut quote = None;
    let mut escaped = false;
    let mut depth = 0_u32;
    for (index, ch) in declaration.char_indices() {
        if let Some(current) = quote {
            if escaped { escaped = false; }
            else if ch == '\\' { escaped = true; }
            else if ch == current { quote = None; }
            continue;
        }
        match ch {
            '\'' | '"' => quote = Some(ch),
            '(' | '[' | '{' => depth += 1,
            ')' if depth == 0 => {
                fields.push(declaration[start..index].trim());
                return fields;
            },
            ')' | ']' | '}' => depth = depth.saturating_sub(1),
            ',' if depth == 0 => { fields.push(declaration[start..index].trim()); start = index + 1; },
            _ => {},
        }
    }
    // 未闭合的声明不能证明该版本支持带数值的开关。
    Vec::new()
}

/// 读取实际安装源码中的参数声明，不执行第三方 Python 或 --help。
pub(super) fn declares_cli_flag(source: &str, flag: &str) -> bool {
    source.split(".add_argument(").skip(1).any(|arguments| {
        let declaration = arguments.trim_start();
        declaration.starts_with(format!("\"{flag}\"").as_str())
            || declaration.starts_with(format!("'{flag}'").as_str())
    })
}

pub(super) fn append_supported_arg(
    args: &mut Vec<String>,
    source: &str,
    flag: &str,
    value: Option<&str>,
) -> Result<(), String> {
    if !declares_cli_flag(source, flag) {
        return Err(format!(
            "当前 ComfyUI 版本不支持启动选项 {flag}，请将对应设置恢复为自动或切换兼容版本"
        ));
    }
    args.push(flag.to_string());
    if let Some(value) = value {
        args.push(value.to_string());
    }
    Ok(())
}

fn settings_directory(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_config_dir()
        .map_err(|_| "无法定位 ComfyUI 启动配置目录".to_string())
}

fn ensure_plain_settings_file(path: &Path) -> Result<bool, String> {
    match fs::symlink_metadata(path) {
        Ok(metadata) => {
            #[cfg(windows)]
            let is_reparse = {
                use std::os::windows::fs::MetadataExt;
                metadata.file_attributes() & 0x400 != 0
            };
            #[cfg(not(windows))]
            let is_reparse = false;
            if !metadata.is_file() || metadata.file_type().is_symlink() || is_reparse {
                return Err("ComfyUI 启动配置必须为普通文件".to_string());
            }
            Ok(true)
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(_) => Err("无法访问 ComfyUI 启动配置".to_string()),
    }
}

fn read_settings_file(path: &Path) -> Result<ComfyUILaunchSettings, String> {
    let size = fs::metadata(path)
        .map_err(|_| "无法读取 ComfyUI 启动配置".to_string())?
        .len();
    if size > MAX_SETTINGS_BYTES {
        return Err("ComfyUI 启动配置超过大小限制".to_string());
    }
    let bytes = fs::read(path).map_err(|_| "无法读取 ComfyUI 启动配置".to_string())?;
    if bytes.len() as u64 > MAX_SETTINGS_BYTES {
        return Err("ComfyUI 启动配置超过大小限制".to_string());
    }
    let settings: ComfyUILaunchSettings = serde_json::from_slice(&bytes)
        .map_err(|_| "ComfyUI 启动配置损坏，请在管理窗口重新保存设置".to_string())?;
    settings.validate()?;
    Ok(settings)
}

pub(super) fn load_settings(app: &tauri::AppHandle) -> Result<ComfyUILaunchSettings, String> {
    let _guard = SETTINGS_LOCK
        .lock()
        .map_err(|_| "ComfyUI 启动配置锁异常".to_string())?;
    let directory = settings_directory(app)?;
    let file = directory.join(SETTINGS_FILE);
    if ensure_plain_settings_file(&file)? {
        return read_settings_file(&file);
    }
    // 恢复保存中断前的旧版本；不把损坏配置静默当成默认值。
    let backup = directory.join(SETTINGS_BACKUP_FILE);
    if ensure_plain_settings_file(&backup)? {
        return read_settings_file(&backup);
    }
    Ok(ComfyUILaunchSettings::default())
}

pub(super) fn configured_port(app: &tauri::AppHandle) -> Result<u16, String> {
    Ok(load_settings(app)?.port)
}

pub(super) fn last_launch_port() -> Option<u16> {
    match LAST_LAUNCH_PORT.load(Ordering::Acquire) {
        0 => None,
        port => Some(port),
    }
}

pub(super) fn record_launch_port(port: u16) {
    LAST_LAUNCH_PORT.store(port, Ordering::Release);
}

#[tauri::command]
pub fn get_comfyui_launch_settings(
    webview: tauri::Webview,
    app: tauri::AppHandle,
) -> Result<ComfyUILaunchSettings, String> {
    if webview.label() == "main" {
        crate::path_policy::ensure_trusted_caller(&webview)?;
    } else {
        super::management::ensure_management_caller(&webview, &app)?;
    }
    load_settings(&app)
}

#[tauri::command]
pub fn save_comfyui_launch_settings(
    webview: tauri::Webview,
    app: tauri::AppHandle,
    settings: ComfyUILaunchSettings,
) -> Result<ComfyUILaunchSettings, String> {
    super::management::ensure_management_caller(&webview, &app)?;
    save_settings(&app, settings)
}

pub(super) fn save_settings(app: &tauri::AppHandle, settings: ComfyUILaunchSettings) -> Result<ComfyUILaunchSettings, String> {
    settings.validate()?;
    let _guard = SETTINGS_LOCK
        .lock()
        .map_err(|_| "ComfyUI 启动配置锁异常".to_string())?;
    let directory = settings_directory(&app)?;
    fs::create_dir_all(&directory)
        .map_err(|_| "无法创建 ComfyUI 启动配置目录".to_string())?;
    let file = directory.join(SETTINGS_FILE);
    let temporary = directory.join(SETTINGS_TEMP_FILE);
    let backup = directory.join(SETTINGS_BACKUP_FILE);
    let had_file = ensure_plain_settings_file(&file)?;
    ensure_plain_settings_file(&temporary)?;
    ensure_plain_settings_file(&backup)?;
    let bytes = serde_json::to_vec_pretty(&settings)
        .map_err(|_| "无法序列化 ComfyUI 启动配置".to_string())?;
    fs::write(&temporary, bytes).map_err(|_| "无法写入 ComfyUI 启动配置".to_string())?;
    if had_file {
        if backup.exists() {
            fs::remove_file(&backup)
                .map_err(|_| "无法准备 ComfyUI 启动配置备份".to_string())?;
        }
        fs::rename(&file, &backup)
            .map_err(|_| "无法备份 ComfyUI 启动配置".to_string())?;
    }
    if fs::rename(&temporary, &file).is_err() {
        if had_file {
            let _ = fs::rename(&backup, &file);
        }
        let _ = fs::remove_file(&temporary);
        return Err("无法保存 ComfyUI 启动配置，已保留上一份配置".to_string());
    }
    let _ = fs::remove_file(&backup);
    Ok(settings)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_zero_port_unknown_enum_and_arbitrary_fields() {
        let mut settings = ComfyUILaunchSettings::default();
        settings.port = 0;
        assert!(settings.validate().is_err());
        let mut value = serde_json::to_value(ComfyUILaunchSettings::default()).unwrap();
        value["vramMode"] = serde_json::json!("--listen=0.0.0.0");
        assert!(serde_json::from_value::<ComfyUILaunchSettings>(value).is_err());
        let mut value = serde_json::to_value(ComfyUILaunchSettings::default()).unwrap();
        value["args"] = serde_json::json!(["--listen", "0.0.0.0"]);
        assert!(serde_json::from_value::<ComfyUILaunchSettings>(value).is_err());
    }

    #[test]
    fn selected_options_fail_when_installation_does_not_declare_them() {
        let settings = ComfyUILaunchSettings {
            vram_mode: VramMode::Normal,
            ..Default::default()
        };
        let mut args = Vec::new();
        let source = "parser.add_argument('--port', type=int)";
        assert!(settings
            .append_args(&mut args, source)
            .unwrap_err()
            .contains("--normalvram"));
        assert!(!declares_cli_flag(
            "parser.add_argument('--highvram-extra')", "--highvram"
        ));
    }

    #[test]
    fn maps_explicit_options_without_shell_or_network_arguments() {
        let settings = ComfyUILaunchSettings {
            port: 8199,
            vram_mode: VramMode::Low,
            precision: Precision::Bf16,
            attention: Attention::Pytorch,
            preview_method: PreviewMethod::Latent2rgb,
            disable_smart_memory: true,
            ..Default::default()
        };
        let source = [
            "--port", "--lowvram", "--bf16-unet", "--use-pytorch-cross-attention",
            "--preview-method", "--disable-smart-memory",
        ]
        .map(|flag| format!("parser.add_argument(\"{flag}\")"))
        .join("\n");
        let mut args = Vec::new();
        settings.append_args(&mut args, &source).unwrap();
        assert_eq!(args, [
            "--port", "8199", "--lowvram", "--bf16-unet", "--use-pytorch-cross-attention",
            "--preview-method", "latent2rgb", "--disable-smart-memory",
        ]);
        assert!(settings.requires_direct_launch());
        assert!(!ComfyUILaunchSettings::default().requires_direct_launch());
    }

    #[test]
    fn legacy_settings_get_safe_defaults_without_requiring_a_direct_launcher() {
        let settings: ComfyUILaunchSettings = serde_json::from_value(serde_json::json!({
            "port": 8188, "vramMode": "auto", "precision": "auto", "attention": "auto",
            "previewMethod": "auto", "disableSmartMemory": false,
        })).unwrap();
        assert_eq!(settings, ComfyUILaunchSettings::default());
        let mut settings = settings;
        settings.h3_memory.preset = H3MemoryPreset::Safe12;
        settings.async_offload_streams = 4;
        assert!(settings.validate().is_ok());
        assert!(!settings.requires_direct_launch());
        let mut args = Vec::new();
        settings.append_args(&mut args, "parser.add_argument('--port', type=int)").unwrap();
        assert_eq!(args, ["--port", "8188"]);
    }

    #[test]
    fn serializes_the_frontend_memory_contract_and_rejects_unknown_nested_values() {
        let value = serde_json::to_value(ComfyUILaunchSettings::default()).unwrap();
        assert_eq!(value["dynamicVram"], "auto");
        assert_eq!(value["reserveVramGb"], serde_json::Value::Null);
        assert_eq!(value["asyncOffloadStreams"], 2);
        assert_eq!(value["h3Memory"], serde_json::json!({
            "preset": "off", "attentionHeadChunks": 4, "feedForwardChunks": 2,
            "feedForwardThreshold": 4096, "textEncoderDevice": "cpu", "referenceImageMaxSize": 512,
            "vaeTiling": true, "vaeTileSize": 256, "vaeTemporalSize": 16,
        }));
        for (field, invalid) in [
            ("dynamicVram", serde_json::json!("--cpu")),
            ("reserveVramGb", serde_json::json!(-1)),
            ("reserveVramGb", serde_json::json!(1.5)),
            ("asyncOffloadStreams", serde_json::json!(2.5)),
            ("h3Memory", serde_json::json!({ "preset": "off", "command": "python" })),
            ("h3Memory", serde_json::json!({ "textEncoderDevice": "cuda:0" })),
        ] {
            let mut invalid_value = value.clone();
            invalid_value[field] = invalid;
            assert!(serde_json::from_value::<ComfyUILaunchSettings>(invalid_value).is_err(), "accepted invalid {field}");
        }
    }

    #[test]
    fn validates_numeric_limits_and_incompatible_dynamic_vram_modes() {
        for mode in [VramMode::High, VramMode::No, VramMode::Cpu] {
            let settings = ComfyUILaunchSettings { dynamic_vram: MemorySwitch::Enabled, vram_mode: mode, ..Default::default() };
            assert!(settings.validate().is_err());
        }
        for mode in [VramMode::Auto, VramMode::Normal, VramMode::Low] {
            let settings = ComfyUILaunchSettings { dynamic_vram: MemorySwitch::Enabled, vram_mode: mode, ..Default::default() };
            assert!(settings.validate().is_ok());
        }
        for value in [0, 64] {
            assert!(ComfyUILaunchSettings { reserve_vram_gb: Some(value), ..Default::default() }.validate().is_ok());
        }
        assert!(ComfyUILaunchSettings { reserve_vram_gb: Some(65), ..Default::default() }.validate().is_err());
        for streams in [0, 5] {
            assert!(ComfyUILaunchSettings { async_offload_streams: streams, ..Default::default() }.validate().is_err());
        }
        for (field, invalid) in [
            ("attentionHeadChunks", 0), ("attentionHeadChunks", 57), ("feedForwardChunks", 65),
            ("feedForwardThreshold", 255), ("feedForwardThreshold", 257), ("feedForwardThreshold", 262400),
            ("referenceImageMaxSize", 63), ("referenceImageMaxSize", 513), ("referenceImageMaxSize", 2112),
            ("vaeTileSize", 64), ("vaeTileSize", 129), ("vaeTemporalSize", 4), ("vaeTemporalSize", 9),
        ] {
            let mut value = serde_json::to_value(ComfyUILaunchSettings::default()).unwrap();
            value["h3Memory"][field] = serde_json::json!(invalid);
            assert!(serde_json::from_value::<ComfyUILaunchSettings>(value).unwrap().validate().is_err(), "accepted invalid {field}");
        }
    }

    #[test]
    fn maps_explicit_memory_options_only_when_the_installed_cli_declares_them() {
        let source = "parser.add_argument('--port', type=int)\nparser.add_argument('--enable-dynamic-vram', action='store_true')\nparser.add_argument('--reserve-vram', type=float)\nparser.add_argument('--async-offload', type=int, nargs='?', const=2, metavar='NUM_STREAMS')";
        let settings = ComfyUILaunchSettings {
            dynamic_vram: MemorySwitch::Enabled, reserve_vram_gb: Some(1),
            async_offload: MemorySwitch::Enabled, async_offload_streams: 3, ..Default::default()
        };
        let mut args = Vec::new();
        settings.append_args(&mut args, source).unwrap();
        assert_eq!(args, ["--port", "8188", "--enable-dynamic-vram", "--reserve-vram", "1", "--async-offload", "3"]);
        assert!(settings.requires_direct_launch());
        let disabled = ComfyUILaunchSettings { dynamic_vram: MemorySwitch::Disabled, async_offload: MemorySwitch::Disabled, ..Default::default() };
        let source = "parser.add_argument('--port')\nparser.add_argument('--disable-dynamic-vram')\nparser.add_argument('--disable-async-offload')";
        let mut args = Vec::new();
        disabled.append_args(&mut args, source).unwrap();
        assert_eq!(args, ["--port", "8188", "--disable-dynamic-vram", "--disable-async-offload"]);
        for settings in [settings, disabled, ComfyUILaunchSettings { reserve_vram_gb: Some(0), ..Default::default() }] {
            assert!(settings.append_args(&mut Vec::new(), "parser.add_argument('--port')").is_err());
        }
    }

    #[test]
    fn async_stream_contract_cannot_be_borrowed_from_help_or_the_next_flag() {
        assert!(declares_async_streams("parser.add_argument('--async-offload', help='Example (two streams)', type = int, metavar = \"NUM_STREAMS\")"));
        for source in [
            "parser.add_argument('--async-offload', action='store_true')",
            "parser.add_argument('--async-offload', action='store_true', help='x,type=int,metavar=\"NUM_STREAMS\",x')",
            "parser.add_argument('--async-offload')\nparser.add_argument('--another', type=int, metavar='NUM_STREAMS')",
            "parser.add_argument('--async-offload-extra', type=int, metavar='NUM_STREAMS')",
            "parser.add_argument('--async-offload', type=str, metavar='NUM_STREAMS')",
            "parser.add_argument('--async-offload', type=int, metavar='NUM_STREAMS'",
        ] { assert!(!declares_async_streams(source), "accepted unsupported async declaration"); }
    }
}
