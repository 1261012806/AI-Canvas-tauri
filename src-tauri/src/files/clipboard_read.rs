//! 主窗口显式读取剪贴板；图片/文本与授权目录使用独立命令。
use serde::Serialize;

#[cfg(any(target_os = "windows", test))]
const MAX_INPUT_BYTES: usize = 32 * 1024 * 1024;
#[cfg(any(target_os = "windows", test))]
const MAX_TEXT_UNITS: usize = 100_000;

#[derive(Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
#[cfg_attr(not(any(target_os = "windows", test)), allow(dead_code))]
pub enum ClipboardContent {
    Text {
        text: String,
    },
    Image {
        #[serde(rename = "dataUrl")]
        data_url: String,
    },
}

fn ensure_main_label(label: &str) -> Result<(), String> {
    if label == "main" {
        Ok(())
    } else {
        Err("剪贴板读取仅允许主窗口调用".into())
    }
}

#[cfg(any(target_os = "windows", test))]
fn decode_text(bytes: &[u8]) -> Result<ClipboardContent, String> {
    if bytes.len() > (MAX_TEXT_UNITS + 1) * 2 || bytes.len() % 2 != 0 {
        return Err("剪贴板文本超过上限或编码无效".into());
    }
    let units: Vec<u16> = bytes
        .chunks_exact(2)
        .map(|b| u16::from_le_bytes([b[0], b[1]]))
        .collect();
    let end = units
        .iter()
        .position(|unit| *unit == 0)
        .ok_or("剪贴板文本缺少终止符")?;
    if end > MAX_TEXT_UNITS {
        return Err("剪贴板文本超过 100000 字".into());
    }
    let text = String::from_utf16(&units[..end]).map_err(|_| "剪贴板文本编码无效")?;
    Ok(ClipboardContent::Text { text })
}

#[cfg(any(target_os = "windows", test))]
fn encode_image<D: image::ImageDecoder>(mut decoder: D) -> Result<ClipboardContent, String> {
    use base64::Engine;
    let (width, height) = decoder.dimensions();
    if width == 0
        || height == 0
        || width > 8192
        || height > 8192
        || decoder.total_bytes() > 128 * 1024 * 1024
    {
        return Err("剪贴板图像尺寸超过上限".into());
    }
    let mut limits = image::Limits::default();
    limits.max_image_width = Some(8192);
    limits.max_image_height = Some(8192);
    limits.max_alloc = Some(128 * 1024 * 1024);
    decoder
        .set_limits(limits)
        .map_err(|_| "剪贴板图像超过解码上限")?;
    let image = image::DynamicImage::from_decoder(decoder).map_err(|_| "剪贴板图像解码失败")?;
    let mut output = std::io::Cursor::new(Vec::new());
    image
        .write_to(&mut output, image::ImageFormat::Png)
        .map_err(|_| "剪贴板图像编码失败")?;
    let png = output.into_inner();
    if png.len() > MAX_INPUT_BYTES {
        return Err("剪贴板图像超过 32 MiB".into());
    }
    Ok(ClipboardContent::Image {
        data_url: format!(
            "data:image/png;base64,{}",
            base64::engine::general_purpose::STANDARD.encode(png)
        ),
    })
}

#[cfg(any(target_os = "windows", test))]
fn decode_image(bytes: Vec<u8>, dib: bool) -> Result<ClipboardContent, String> {
    if bytes.len() > MAX_INPUT_BYTES {
        return Err("剪贴板图像超过 32 MiB".into());
    }
    let cursor = std::io::Cursor::new(bytes);
    if dib {
        let decoder = image::codecs::bmp::BmpDecoder::new_without_file_header(cursor)
            .map_err(|_| "剪贴板位图无效")?;
        encode_image(decoder)
    } else {
        let decoder = image::codecs::png::PngDecoder::new(cursor).map_err(|_| "剪贴板 PNG 无效")?;
        encode_image(decoder)
    }
}

#[cfg(target_os = "windows")]
fn read_windows_clipboard() -> Result<ClipboardContent, String> {
    use windows::Win32::Foundation::HGLOBAL;
    use windows::Win32::System::DataExchange::{
        CloseClipboard, GetClipboardData, IsClipboardFormatAvailable, OpenClipboard,
        RegisterClipboardFormatW,
    };
    use windows::Win32::System::Memory::{GlobalLock, GlobalSize, GlobalUnlock};

    struct ClipboardLease;
    impl Drop for ClipboardLease {
        fn drop(&mut self) {
            unsafe {
                let _ = CloseClipboard();
            }
        }
    }
    struct MemoryLease(HGLOBAL);
    impl Drop for MemoryLease {
        fn drop(&mut self) {
            unsafe {
                let _ = GlobalUnlock(self.0);
            }
        }
    }

    // 只在占用剪贴板期间复制有界字节；昂贵的图像解码在关闭剪贴板后执行。
    let (format, bytes) = unsafe {
        OpenClipboard(None).map_err(|_| "剪贴板暂时被占用，请稍后重新调用")?;
        let _lease = ClipboardLease;
        let png = RegisterClipboardFormatW(windows::core::w!("PNG"));
        let formats = [png, 17, 8, 13]; // PNG、CF_DIBV5、CF_DIB、CF_UNICODETEXT
        let format = formats
            .into_iter()
            .find(|f| *f != 0 && IsClipboardFormatAvailable(*f).is_ok())
            .ok_or("剪贴板没有可读取的图片或文本；文件请使用媒体导入")?;
        let handle = GetClipboardData(format).map_err(|_| "剪贴板读取失败")?;
        let memory = HGLOBAL(handle.0);
        let size = GlobalSize(memory);
        let limit = if format == 13 {
            (MAX_TEXT_UNITS + 1) * 2
        } else {
            MAX_INPUT_BYTES
        };
        if size == 0 || size > limit {
            return Err("剪贴板内容为空或超过大小上限".into());
        }
        let pointer = GlobalLock(memory);
        if pointer.is_null() {
            return Err("剪贴板内存不可读取".into());
        }
        let _memory = MemoryLease(memory);
        (
            format,
            std::slice::from_raw_parts(pointer as *const u8, size).to_vec(),
        )
    };
    if format == 13 {
        decode_text(&bytes)
    } else {
        decode_image(bytes, format == 17 || format == 8)
    }
}

#[tauri::command]
pub async fn read_canvas_clipboard(webview: tauri::Webview) -> Result<ClipboardContent, String> {
    crate::path_policy::ensure_trusted_caller(&webview)?;
    ensure_main_label(webview.label())?;
    #[cfg(target_os = "windows")]
    {
        tauri::async_runtime::spawn_blocking(read_windows_clipboard)
            .await
            .map_err(|_| "剪贴板读取任务失败")?
    }
    #[cfg(not(target_os = "windows"))]
    {
        Err("当前平台使用浏览器剪贴板接口".into())
    }
}

#[cfg(any(target_os = "windows", test))]
fn decode_drop_folders(bytes: &[u8]) -> Result<Vec<String>, String> {
    if bytes.len() < 24 || bytes.len() > 1024 * 1024 {
        return Err("剪贴板文件列表无效或过大".into());
    }
    let offset = u32::from_le_bytes(bytes[0..4].try_into().unwrap()) as usize;
    let wide = u32::from_le_bytes(bytes[16..20].try_into().unwrap());
    if wide != 1 || offset < 20 || offset >= bytes.len() || (bytes.len() - offset) % 2 != 0 {
        return Err("剪贴板文件列表编码无效".into());
    }
    let units: Vec<u16> = bytes[offset..]
        .chunks_exact(2)
        .map(|pair| u16::from_le_bytes([pair[0], pair[1]]))
        .collect();
    let mut paths = Vec::new();
    let mut start = 0;
    for end in 0..units.len() {
        if units[end] != 0 {
            continue;
        }
        if end == start {
            if paths.is_empty() {
                return Err("剪贴板中没有文件夹".into());
            }
            return Ok(paths);
        }
        if end - start > 32_768 || paths.len() >= 128 {
            return Err("剪贴板文件列表超过上限".into());
        }
        paths.push(String::from_utf16(&units[start..end]).map_err(|_| "剪贴板路径编码无效")?);
        start = end + 1;
    }
    Err("剪贴板文件列表缺少终止符".into())
}

#[cfg(target_os = "windows")]
fn read_folder_paths() -> Result<Vec<String>, String> {
    use windows::Win32::Foundation::HGLOBAL;
    use windows::Win32::System::DataExchange::{CloseClipboard, GetClipboardData, OpenClipboard};
    use windows::Win32::System::Memory::{GlobalLock, GlobalSize, GlobalUnlock};
    struct ClipboardLease;
    impl Drop for ClipboardLease {
        fn drop(&mut self) {
            unsafe {
                let _ = CloseClipboard();
            }
        }
    }
    unsafe {
        OpenClipboard(None).map_err(|_| "剪贴板暂时被占用，请稍后重试")?;
        let _lease = ClipboardLease;
        let handle = GetClipboardData(15).map_err(|_| "剪贴板中没有可粘贴的文件夹")?;
        let memory = HGLOBAL(handle.0);
        let size = GlobalSize(memory);
        if size == 0 || size > 1024 * 1024 {
            return Err("剪贴板文件列表无效或过大".into());
        }
        let pointer = GlobalLock(memory);
        if pointer.is_null() {
            return Err("无法读取剪贴板文件列表".into());
        }
        let bytes = std::slice::from_raw_parts(pointer as *const u8, size).to_vec();
        let _ = GlobalUnlock(memory);
        decode_drop_folders(&bytes)
    }
}

#[cfg(any(target_os = "linux", target_os = "macos"))]
fn read_folder_paths() -> Result<Vec<String>, String> {
    use std::process::Command;
    #[cfg(target_os = "macos")]
    let mut command = {
        let mut cmd = Command::new("osascript");
        cmd.args(["-e", "set copiedItems to the clipboard as list\nset resultText to \"\"\nrepeat with copiedItem in copiedItems\nset resultText to resultText & (POSIX path of copiedItem) & linefeed\nend repeat\nreturn resultText"]);
        cmd
    };
    #[cfg(target_os = "linux")]
    let mut command = if std::env::var("XDG_SESSION_TYPE").unwrap_or_default() == "wayland" {
        let mut cmd = Command::new("wl-paste");
        cmd.args(["--no-newline", "--type", "text/uri-list"]);
        cmd
    } else {
        let mut cmd = Command::new("xclip");
        cmd.args([
            "-o",
            "-selection",
            "clipboard",
            "-target",
            "x-special/gnome-copied-files",
        ]);
        cmd
    };
    let bytes = crate::clipboard::run_clipboard_command(&mut command, 1024 * 1024)?;
    let text = String::from_utf8(bytes).map_err(|_| "剪贴板路径编码无效")?;
    let mut paths = Vec::new();
    for line in text.lines().filter(|line| !line.is_empty()) {
        #[cfg(target_os = "linux")]
        let path = {
            if line == "copy" || line == "cut" || line.starts_with('#') {
                continue;
            }
            url::Url::parse(line)
                .map_err(|_| "剪贴板文件地址无效")?
                .to_file_path()
                .map_err(|_| "剪贴板中包含非本地文件")?
                .to_string_lossy()
                .into_owned()
        };
        #[cfg(target_os = "macos")]
        let path = line.to_string();
        if paths.len() >= 128 {
            return Err("剪贴板文件夹数量超过上限".into());
        }
        paths.push(path);
    }
    if paths.is_empty() {
        return Err("剪贴板中没有可粘贴的文件夹".into());
    }
    Ok(paths)
}

#[tauri::command]
pub async fn read_asset_folder_clipboard(
    app: tauri::AppHandle,
    webview: tauri::Webview,
) -> Result<Vec<String>, String> {
    crate::path_policy::ensure_trusted_caller(&webview)?;
    ensure_main_label(webview.label())?;
    tauri::async_runtime::spawn_blocking(move || {
        let mut paths = Vec::new();
        for raw in read_folder_paths()? {
            let directory = crate::path_policy::authorize_existing_plain_directory(&app, &raw)
                .map_err(|_| "剪贴板中包含非文件夹或未授权目录；请先将源目录添加到资产库")?;
            let path = directory.to_string_lossy().into_owned();
            if !paths.contains(&path) {
                paths.push(path);
            }
        }
        Ok(paths)
    })
    .await
    .map_err(|_| "读取文件夹剪贴板失败")?
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn decodes_bounded_drop_files_and_rejects_malformed_lists() {
        let mut bytes = vec![0_u8; 20];
        bytes[0..4].copy_from_slice(&20_u32.to_le_bytes());
        bytes[16..20].copy_from_slice(&1_u32.to_le_bytes());
        bytes.extend(
            "D:\\素材\\人物\0D:\\素材\\场景\0\0"
                .encode_utf16()
                .flat_map(u16::to_le_bytes),
        );
        assert_eq!(
            decode_drop_folders(&bytes).unwrap(),
            vec!["D:\\素材\\人物", "D:\\素材\\场景"]
        );
        assert!(decode_drop_folders(&bytes[..bytes.len() - 2]).is_err());
        bytes[0..4].copy_from_slice(&u32::MAX.to_le_bytes());
        assert!(decode_drop_folders(&bytes).is_err());
        assert!(decode_drop_folders(&vec![0; 1024 * 1024 + 1]).is_err());
    }
    #[test]
    fn restricts_window_and_decodes_bounded_unicode() {
        assert!(ensure_main_label("main").is_ok());
        for label in ["chat-assistant", "plugin-1", "comfyui", ""] {
            assert!(ensure_main_label(label).is_err());
        }
        let bytes: Vec<u8> = "中文 test\0"
            .encode_utf16()
            .flat_map(u16::to_le_bytes)
            .collect();
        assert!(
            matches!(decode_text(&bytes).unwrap(), ClipboardContent::Text { text } if text == "中文 test")
        );
        assert!(decode_text(&[0]).is_err());
        assert!(decode_text(&[1, 0]).is_err());
        assert!(decode_text(&vec![1; 200004]).is_err());
    }
    #[test]
    fn decodes_png_and_windows_dib_without_a_bitmap_file_header() {
        let image = image::DynamicImage::new_rgb8(2, 3);
        for format in [image::ImageFormat::Png, image::ImageFormat::Bmp] {
            let mut output = std::io::Cursor::new(Vec::new());
            image.write_to(&mut output, format).unwrap();
            let mut bytes = output.into_inner();
            if format == image::ImageFormat::Bmp {
                bytes = bytes[14..].to_vec();
            }
            assert!(
                matches!(decode_image(bytes, format == image::ImageFormat::Bmp).unwrap(), ClipboardContent::Image { data_url } if data_url.starts_with("data:image/png;base64,"))
            );
        }
        assert!(decode_image(vec![0; 40], true).is_err());
        assert!(decode_image(vec![0; 40], false).is_err());
    }
}
