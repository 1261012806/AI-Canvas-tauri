//! 上传参考图前的 PNG/JPEG 无损优化，只接收内存字节，不读取文件。

use std::ffi::{c_void, CStr};
use std::ptr::NonNull;
use std::sync::{Arc, LazyLock};
use std::time::Duration;
use tauri::ipc::{InvokeBody, Request, Response};
use tokio::sync::{OwnedSemaphorePermit, Semaphore};
use turbojpeg_sys as jpeg;

const MAX_INPUT_BYTES: usize = 32 * 1024 * 1024;
const MAX_PIXELS: u64 = 24_000_000;
const MAX_EDGE: u32 = 16_384;
const MAX_DECOMPRESSED_BYTES: usize = 128 * 1024 * 1024;
const PNG_SIGNATURE: &[u8] = b"\x89PNG\r\n\x1a\n";
const INVALID_PNG: &str = "参考图片不是有效的 PNG";
const INVALID_JPEG: &str = "参考 JPEG 无效或超过无损优化上限，请保留原图上传";
const MAX_JPEG_SCANS: usize = 100;
const MAX_JPEG_MARKERS: usize = 4096;
const MAX_PNG_CHUNKS: usize = 4096;
static OPTIMIZATION_SLOT: LazyLock<Arc<Semaphore>> =
    LazyLock::new(|| Arc::new(Semaphore::new(1)));

fn ensure_main_label(label: &str) -> Result<(), String> {
    if label != "main" {
        return Err("仅主窗口可以优化参考图片".into());
    }
    Ok(())
}

fn input_bytes(body: &InvokeBody) -> Result<&[u8], String> {
    match body {
        InvokeBody::Raw(bytes) if !bytes.is_empty() && bytes.len() <= MAX_INPUT_BYTES => Ok(bytes),
        _ => Err("参考图片须以二进制传入，且不能超过 32 MiB".into()),
    }
}

// 只检查分块边界；CRC 和像素解码交给 OxiPNG，不在这里另写解码器。
fn visit_chunks(bytes: &[u8], mut visit: impl FnMut(&[u8], &[u8])) -> Result<(), String> {
    if !bytes.starts_with(PNG_SIGNATURE) {
        return Err(INVALID_PNG.into());
    }
    let mut offset = PNG_SIGNATURE.len();
    let mut chunks = 0;
    while offset < bytes.len() {
        chunks += 1;
        if chunks > MAX_PNG_CHUNKS { return Err("参考 PNG 分块过多，请保留原图上传".into()); }
        let prefix = bytes.get(offset..offset + 8).ok_or(INVALID_PNG)?;
        let size = u32::from_be_bytes(prefix[..4].try_into().map_err(|_| INVALID_PNG)?) as usize;
        let end = offset.checked_add(size).and_then(|n| n.checked_add(12)).ok_or(INVALID_PNG)?;
        let chunk = bytes.get(offset..end).ok_or(INVALID_PNG)?;
        let name = &prefix[4..8];
        visit(name, chunk);
        if name == b"IEND" {
            return if size == 0 && end == bytes.len() { Ok(()) } else { Err(INVALID_PNG.into()) };
        }
        offset = end;
    }
    Err(INVALID_PNG.into())
}

fn inspect_png(bytes: &[u8]) -> Result<bool, String> {
    if bytes.len() < 33 || &bytes[8..16] != b"\0\0\0\rIHDR" {
        return Err(INVALID_PNG.into());
    }
    let width = u32::from_be_bytes(bytes[16..20].try_into().map_err(|_| INVALID_PNG)?);
    let height = u32::from_be_bytes(bytes[20..24].try_into().map_err(|_| INVALID_PNG)?);
    if width == 0 || height == 0 || width > MAX_EDGE || height > MAX_EDGE
        || u64::from(width) * u64::from(height) > MAX_PIXELS
    {
        return Err("参考 PNG 尺寸超过优化上限，请保留原图上传".into());
    }
    let mut preserve_original = false;
    let mut has_idat = false;
    visit_chunks(bytes, |name, chunk| {
        preserve_original |= matches!(name, b"acTL" | b"fcTL" | b"fdAT" | b"caBX" | b"iDOT" | b"dSIG");
        // 这些颜色块不依赖压缩布局；其余未知的 unsafe-to-copy 辅助块保守透传原图。
        let known_color_chunk = matches!(name,
            b"cHRM" | b"gAMA" | b"iCCP" | b"sBIT" | b"sRGB" | b"bKGD" | b"tRNS"
            | b"cICP" | b"mDCV" | b"cLLI"
        );
        preserve_original |= name[0] & 0x20 != 0 && name[3] & 0x20 == 0 && !known_color_chunk;
        // XMP 可以指向绑定原编码字节的外部 C2PA manifest，无需解析 XML 才能保守跳过。
        preserve_original |= matches!(name, b"iTXt" | b"tEXt" | b"zTXt")
            && chunk[8..chunk.len() - 4].starts_with(b"XML:com.adobe.xmp\0");
        has_idat |= name == b"IDAT";
    })?;
    if !has_idat { return Err(INVALID_PNG.into()); }
    Ok(preserve_original)
}

fn optimization_options() -> oxipng::Options {
    let mut options = oxipng::Options::from_preset(1);
    options.optimize_alpha = false;
    options.bit_depth_reduction = false;
    options.color_type_reduction = false;
    options.palette_reduction = false;
    options.grayscale_reduction = false;
    options.scale_16 = false;
    options.strip = oxipng::StripChunks::None;
    options.interlace = None;
    options.max_decompressed_size = Some(MAX_DECOMPRESSED_BYTES);
    // 这是协作式预算；正在运行的压缩步骤结束前仍持有并发槽。
    options.timeout = Some(Duration::from_secs(5));
    options
}

fn optimize_png(bytes: Vec<u8>) -> Result<Vec<u8>, String> {
    if bytes.is_empty() || bytes.len() > MAX_INPUT_BYTES { return Err(INVALID_PNG.into()); }
    if inspect_png(&bytes)? { return Ok(bytes); }
    let optimized = oxipng::optimize_from_memory(&bytes, &optimization_options())
        .map_err(|_| "参考 PNG 无损优化失败，请保留原图上传")?;
    if optimized.get(..33) != bytes.get(..33) { return Ok(bytes); }

    // OxiPNG 也会重压 ICC。只取它的 IDAT，原有 ICC、EXIF 与色彩块逐字节保留。
    let mut old_idat_size = 0;
    let mut new_idat_size = 0;
    visit_chunks(&bytes, |name, chunk| { if name == b"IDAT" { old_idat_size += chunk.len(); } })?;
    visit_chunks(&optimized, |name, chunk| { if name == b"IDAT" { new_idat_size += chunk.len(); } })?;
    if new_idat_size == 0 || new_idat_size >= old_idat_size { return Ok(bytes); }
    let mut output = Vec::with_capacity(bytes.len() - old_idat_size + new_idat_size);
    output.extend_from_slice(PNG_SIGNATURE);
    let mut copied = false;
    visit_chunks(&bytes, |name, chunk| {
        if name != b"IDAT" {
            output.extend_from_slice(chunk);
        } else if !copied {
            // 上一轮已验证优化结果的分块边界，这里不会再次失败。
            let _ = visit_chunks(&optimized, |name, chunk| {
                if name == b"IDAT" { output.extend_from_slice(chunk); }
            });
            copied = true;
        }
    })?;
    Ok(output)
}

struct JpegInfo<'a> {
    frame: &'a [u8],
    quantization: Vec<&'a [u8]>,
    metadata: Vec<(u8, &'a [u8])>,
    scans: usize,
}

// 跳过熵编码中的转义字节和重启标记，避免把压缩内容误认成 APP/COM。
fn visit_jpeg_segments<'a>(
    bytes: &'a [u8],
    mut visit: impl FnMut(u8, &'a [u8]) -> Result<(), String>,
) -> Result<(), String> {
    if !bytes.starts_with(&[0xff, 0xd8]) { return Err(INVALID_JPEG.into()); }
    let mut offset = 2;
    let mut in_scan = false;
    let mut markers = 0;
    while offset < bytes.len() {
        if in_scan {
            offset += bytes[offset..].iter().position(|b| *b == 0xff).ok_or(INVALID_JPEG)?;
        } else if bytes[offset] != 0xff {
            return Err(INVALID_JPEG.into());
        }
        while bytes.get(offset) == Some(&0xff) { offset += 1; }
        let marker = *bytes.get(offset).ok_or(INVALID_JPEG)?;
        offset += 1;
        if in_scan && (marker == 0 || (0xd0..=0xd7).contains(&marker)) { continue; }
        markers += 1;
        if markers > MAX_JPEG_MARKERS { return Err(INVALID_JPEG.into()); }
        if marker == 0xd9 {
            return if offset == bytes.len() { Ok(()) } else { Err(INVALID_JPEG.into()) };
        }
        if matches!(marker, 0 | 0x01 | 0xd0..=0xd8) { return Err(INVALID_JPEG.into()); }
        let length_bytes = bytes.get(offset..offset + 2).ok_or(INVALID_JPEG)?;
        let length = usize::from(u16::from_be_bytes([length_bytes[0], length_bytes[1]]));
        if length < 2 { return Err(INVALID_JPEG.into()); }
        let end = offset.checked_add(length).ok_or(INVALID_JPEG)?;
        visit(marker, bytes.get(offset + 2..end).ok_or(INVALID_JPEG)?)?;
        offset = end;
        in_scan = marker == 0xda;
    }
    Err(INVALID_JPEG.into())
}

fn inspect_jpeg(bytes: &[u8]) -> Result<JpegInfo<'_>, String> {
    if bytes.is_empty() || bytes.len() > MAX_INPUT_BYTES { return Err(INVALID_JPEG.into()); }
    let mut info = JpegInfo { frame: &[], quantization: Vec::new(), metadata: Vec::new(), scans: 0 };
    visit_jpeg_segments(bytes, |marker, data| {
        match marker {
            0xc0..=0xc3 | 0xc5..=0xc7 | 0xc9..=0xcb | 0xcd..=0xcf => {
                if !info.frame.is_empty() || data.len() < 6 { return Err(INVALID_JPEG.into()); }
                let height = u32::from(u16::from_be_bytes([data[1], data[2]]));
                let width = u32::from(u16::from_be_bytes([data[3], data[4]]));
                let components = usize::from(data[5]);
                if width == 0 || height == 0 || width > MAX_EDGE || height > MAX_EDGE
                    || u64::from(width) * u64::from(height) > MAX_PIXELS
                    || !(1..=4).contains(&components) || data.len() != 6 + components * 3
                { return Err(INVALID_JPEG.into()); }
                info.frame = data;
            },
            0xdb => info.quantization.push(data),
            0xe0..=0xef | 0xfe => info.metadata.push((marker, data)),
            0xda => {
                info.scans += 1;
                if info.scans > MAX_JPEG_SCANS { return Err(INVALID_JPEG.into()); }
            },
            _ => {},
        }
        Ok(())
    })?;
    if info.frame.is_empty() || info.quantization.is_empty() || info.scans == 0 {
        return Err(INVALID_JPEG.into());
    }
    Ok(info)
}

struct JpegTransformHandle(NonNull<c_void>);

extern "C" {
    // sys 1.2.0 的预生成 size_t 使用 c_ulong；Win64 的 c_ulong 只有 32 位。
    // 这里只补正在使用的 ABI，usize 才与各平台 C size_t 的指针宽度一致。
    #[link_name = "tj3Transform"]
    fn transform_jpeg_coefficients(
        handle: jpeg::tjhandle,
        input: *const u8,
        input_size: usize,
        count: i32,
        outputs: *mut *mut u8,
        output_sizes: *mut usize,
        transforms: *mut jpeg::tjtransform,
    ) -> i32;
}

impl JpegTransformHandle {
    fn new() -> Result<Self, String> {
        // 句柄只在当前阻塞线程内使用，Drop 负责唯一一次释放。
        let pointer = unsafe { jpeg::tj3Init(jpeg::TJINIT_TJINIT_TRANSFORM as i32) };
        let mut handle = Self(NonNull::new(pointer).ok_or(INVALID_JPEG)?);
        for (parameter, value) in [
            (jpeg::TJPARAM_TJPARAM_MAXMEMORY, 128),
            (jpeg::TJPARAM_TJPARAM_MAXPIXELS, MAX_PIXELS as i32),
            (jpeg::TJPARAM_TJPARAM_SCANLIMIT, MAX_JPEG_SCANS as i32),
            (jpeg::TJPARAM_TJPARAM_STOPONWARNING, 1),
            (jpeg::TJPARAM_TJPARAM_NOREALLOC, 1),
            (jpeg::TJPARAM_TJPARAM_SAVEMARKERS, 2),
        ] { handle.set(parameter, value)?; }
        Ok(handle)
    }

    fn set(&mut self, parameter: jpeg::TJPARAM, value: i32) -> Result<(), String> {
        // 参数来自上面的固定白名单；不会接受 Renderer 提交的原生参数。
        if unsafe { jpeg::tj3Set(self.0.as_ptr(), parameter as i32, value) } != 0 {
            return Err(INVALID_JPEG.into());
        }
        Ok(())
    }

    fn optimize(&mut self, input: &[u8]) -> Result<Option<Vec<u8>>, String> {
        let mut output = vec![0; input.len()];
        let mut output_pointer = output.as_mut_ptr();
        let mut output_size = output.len();
        let mut transform = jpeg::tjtransform {
            r: jpeg::tjregion { x: 0, y: 0, w: 0, h: 0 },
            op: jpeg::TJXOP_TJXOP_NONE as i32,
            options: jpeg::TJXOPT_OPTIMIZE as i32,
            data: std::ptr::null_mut(),
            customFilter: None,
        };
        // 输入切片与输出 Vec 在调用期间都有效；NOREALLOC 禁止 C 替换 Rust 缓冲区。
        let result = unsafe { transform_jpeg_coefficients(
            self.0.as_ptr(), input.as_ptr(), input.len(),
            1, &mut output_pointer, &mut output_size, &mut transform,
        ) };
        if result != 0 {
            // 锁定版本的这个错误只表示输出装不下；其余错误一律用固定文案拒绝。
            let error = unsafe { jpeg::tj3GetErrorStr(self.0.as_ptr()) };
            if !error.is_null() && unsafe { CStr::from_ptr(error) }.to_bytes()
                == b"Buffer passed to JPEG library is too small"
            { return Ok(None); }
            return Err(INVALID_JPEG.into());
        }
        let length = output_size;
        if output_pointer != output.as_mut_ptr() || length > output.len() {
            return Err(INVALID_JPEG.into());
        }
        output.truncate(length);
        Ok(Some(output))
    }
}

impl Drop for JpegTransformHandle {
    fn drop(&mut self) {
        // 本结构没有 Clone，也不暴露句柄，因此不会重复释放。
        unsafe { jpeg::tj3Destroy(self.0.as_ptr()); }
    }
}

fn optimize_jpeg(bytes: Vec<u8>) -> Result<Vec<u8>, String> {
    let original = inspect_jpeg(&bytes)?;
    // MPF 偏移、JUMBF 和 XMP 外部 manifest 都可能绑定原编码字节，不能只保留 marker。
    if original.metadata.iter().any(|(marker, data)|
        *marker == 0xeb
        || *marker == 0xe2 && data.starts_with(b"MPF\0")
        || *marker == 0xe1 && (data.starts_with(b"http://ns.adobe.com/xap/1.0/\0")
            || data.starts_with(b"http://ns.adobe.com/xmp/extension/\0"))
    ) {
        return Ok(bytes);
    }
    let Some(output) = JpegTransformHandle::new()?.optimize(&bytes)? else { return Ok(bytes); };
    if output.len() >= bytes.len() { return Ok(bytes); }
    let optimized = inspect_jpeg(&output)?;
    // JFIF/Adobe 标记可能被编码器重建；任何元数据或采样变化都保留原图。
    if optimized.metadata != original.metadata || optimized.frame != original.frame
        || optimized.quantization != original.quantization
    { return Ok(bytes); }
    Ok(output)
}

async fn run_image_task(
    permit: OwnedSemaphorePermit,
    task: impl FnOnce() -> Result<Vec<u8>, String> + Send + 'static,
) -> Result<Vec<u8>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        // 调用方停止等待不会停止 spawn_blocking，槽必须跟着实际工作一起释放。
        let _permit = permit;
        task()
    }).await.map_err(|_| "参考图片优化任务失败")?
}

#[tauri::command]
pub async fn optimize_reference_png(webview: tauri::Webview, request: Request<'_>) -> Result<Response, String> {
    ensure_main_label(webview.label())?;
    crate::path_policy::ensure_trusted_caller(&webview)?;
    let bytes = input_bytes(request.body())?;
    let permit = OPTIMIZATION_SLOT.clone().try_acquire_owned()
        .map_err(|_| "参考 PNG 优化正忙，请保留原图上传")?;
    let bytes = bytes.to_vec();
    run_image_task(permit, move || optimize_png(bytes)).await.map(Response::new)
}

#[tauri::command]
pub async fn optimize_reference_jpeg(webview: tauri::Webview, request: Request<'_>) -> Result<Response, String> {
    ensure_main_label(webview.label())?;
    crate::path_policy::ensure_trusted_caller(&webview)?;
    let bytes = input_bytes(request.body())?;
    let permit = OPTIMIZATION_SLOT.clone().try_acquire_owned()
        .map_err(|_| "参考 JPEG 优化正忙，请保留原图上传")?;
    let bytes = bytes.to_vec();
    run_image_task(permit, move || optimize_jpeg(bytes)).await.map(Response::new)
}

#[cfg(test)]
mod reference_image_upload_tests {
    use super::*;
    use image::codecs::png::{CompressionType, FilterType, PngEncoder};
    use image::ImageEncoder;
    use std::io::Write;

    extern "C" {
        #[link_name = "tj3Compress8"]
        fn encode_fixture_jpeg(
            handle: jpeg::tjhandle, pixels: *const u8, width: i32, pitch: i32, height: i32,
            pixel_format: i32, output: *mut *mut u8, size: *mut usize,
        ) -> i32;
    }

    fn jpeg_fixture(progressive: bool, cmyk: bool, edge: usize) -> Vec<u8> {
        let pointer = unsafe { jpeg::tj3Init(jpeg::TJINIT_TJINIT_COMPRESS as i32) };
        let mut handle = JpegTransformHandle(NonNull::new(pointer).unwrap());
        handle.set(jpeg::TJPARAM_TJPARAM_QUALITY, 87).unwrap();
        handle.set(jpeg::TJPARAM_TJPARAM_SUBSAMP, jpeg::TJSAMP_TJSAMP_444 as i32).unwrap();
        handle.set(jpeg::TJPARAM_TJPARAM_PROGRESSIVE, i32::from(progressive)).unwrap();
        handle.set(jpeg::TJPARAM_TJPARAM_NOREALLOC, 1).unwrap();
        if cmyk { handle.set(jpeg::TJPARAM_TJPARAM_COLORSPACE, jpeg::TJCS_TJCS_CMYK as i32).unwrap(); }
        let pixels: Vec<u8> = (0..edge * edge).flat_map(|n| {
            let values = if n % 2 == 0 { [17, 29, 43, 53] } else { [71, 101, 137, 151] };
            values[..if cmyk { 4 } else { 3 }].to_vec()
        }).collect();
        let mut output = vec![0; edge * edge * 8 + 65536];
        let mut output_pointer = output.as_mut_ptr();
        let mut size = output.len();
        let result = unsafe { encode_fixture_jpeg(
            handle.0.as_ptr(), pixels.as_ptr(), edge as i32, 0, edge as i32,
            if cmyk { jpeg::TJPF_TJPF_CMYK } else { jpeg::TJPF_TJPF_RGB } as i32,
            &mut output_pointer, &mut size,
        ) };
        assert_eq!(result, 0);
        assert_eq!(output_pointer, output.as_mut_ptr());
        assert!(size <= output.len());
        output.truncate(size);
        output
    }

    fn jpeg_segment(marker: u8, data: &[u8]) -> Vec<u8> {
        let mut bytes = vec![0xff, marker];
        bytes.extend_from_slice(&((data.len() + 2) as u16).to_be_bytes());
        bytes.extend_from_slice(data);
        bytes
    }

    #[test]
    fn jpeg_optimization_keeps_pixels_quantization_sampling_and_all_metadata() {
        let mut input = jpeg_fixture(false, false, 64);
        let mut extra = jpeg_segment(0xe1, b"Exif\0\0II*\0\x08\0\0\0\x01\0\x12\x01\x03\0\x01\0\0\0\x06\0\0\0\0\0\0\0");
        let mut icc = b"ICC_PROFILE\0\x01\x01".to_vec();
        let mut profile = vec![0; 128];
        profile[..4].copy_from_slice(&128u32.to_be_bytes());
        profile[16..20].copy_from_slice(b"RGB ");
        profile[36..40].copy_from_slice(b"acsp");
        icc.extend(profile);
        extra.extend(jpeg_segment(0xe2, &icc));
        extra.extend(jpeg_segment(0xe3, b"retained APP3"));
        extra.extend(jpeg_segment(0xfe, b"retained comment"));
        let after_jfif = 4 + usize::from(u16::from_be_bytes([input[4], input[5]]));
        input.splice(after_jfif..after_jfif, extra);
        let before = image::load_from_memory(&input).unwrap().to_rgb8();
        let output = optimize_jpeg(input.clone()).unwrap();
        assert!(output.len() < input.len());
        assert_eq!(image::load_from_memory(&output).unwrap().to_rgb8(), before);
        let original = inspect_jpeg(&input).unwrap();
        let optimized = inspect_jpeg(&output).unwrap();
        assert_eq!(optimized.frame, original.frame);
        assert_eq!(optimized.quantization, original.quantization);
        assert_eq!(optimized.metadata, original.metadata);
        assert_eq!(optimize_jpeg(output.clone()).unwrap(), output);
    }

    #[test]
    fn progressive_and_cmyk_jpeg_keep_the_same_decoded_pixels() {
        for (progressive, cmyk) in [(true, false), (false, true), (true, true)] {
            let input = jpeg_fixture(progressive, cmyk, 64);
            let before = image::load_from_memory(&input).unwrap().to_rgb8();
            let output = optimize_jpeg(input.clone()).unwrap();
            assert!(output.len() <= input.len());
            assert_eq!(image::load_from_memory(&output).unwrap().to_rgb8(), before);
            let original = inspect_jpeg(&input).unwrap();
            let optimized = inspect_jpeg(&output).unwrap();
            assert_eq!(optimized.frame, original.frame);
            assert_eq!(optimized.quantization, original.quantization);
            assert_eq!(optimized.metadata, original.metadata);
        }
    }

    #[test]
    fn jpeg_metadata_changes_and_multi_picture_offsets_keep_original_bytes() {
        let input = jpeg_fixture(false, false, 64);
        let first_end = 4 + usize::from(u16::from_be_bytes([input[4], input[5]]));
        let mut jfif_thumbnail = input[6..first_end].to_vec();
        jfif_thumbnail[12] = 1;
        jfif_thumbnail[13] = 1;
        jfif_thumbnail.extend([17, 29, 43]);
        let mut thumbnail = input.clone();
        thumbnail.splice(2..first_end, jpeg_segment(0xe0, &jfif_thumbnail));
        assert_eq!(optimize_jpeg(thumbnail.clone()).unwrap(), thumbnail);
        let mut mpf = input.clone();
        mpf.splice(first_end..first_end, jpeg_segment(0xe2, b"MPF\0fixed-offset-data"));
        assert_eq!(optimize_jpeg(mpf.clone()).unwrap(), mpf);
        for (marker, data) in [
            (0xeb, b"JP\0\x01\0\0\0\x01JUMBF manifest".as_slice()),
            (0xe1, b"http://ns.adobe.com/xap/1.0/\0<x:xmpmeta>external provenance</x:xmpmeta>".as_slice()),
            (0xe1, b"http://ns.adobe.com/xmp/extension/\0extended XMP provenance".as_slice()),
        ] {
            let mut protected = input.clone();
            protected.splice(first_end..first_end, jpeg_segment(marker, data));
            assert_eq!(optimize_jpeg(protected.clone()).unwrap(), protected);
        }
    }

    #[test]
    fn jpeg_rejects_corruption_dimensions_marker_floods_and_native_resource_limits() {
        let input = jpeg_fixture(true, false, 64);
        for malformed in [Vec::new(), b"not JPEG".to_vec(), input[..input.len() - 1].to_vec()] {
            assert!(optimize_jpeg(malformed).is_err());
        }
        let mut bad_entropy = input.clone();
        bad_entropy.truncate(bad_entropy.len() - 10);
        bad_entropy.extend([0xff, 0xd9]);
        assert_eq!(optimize_jpeg(bad_entropy).unwrap_err(), INVALID_JPEG);
        let info = inspect_jpeg(&input).unwrap();
        let mut oversized_frame = info.frame.to_vec();
        oversized_frame[1..3].copy_from_slice(&4001u16.to_be_bytes());
        oversized_frame[3..5].copy_from_slice(&6000u16.to_be_bytes());
        let mut oversized = vec![0xff, 0xd8];
        oversized.extend(jpeg_segment(0xc2, &oversized_frame));
        oversized.extend([0xff, 0xd9]);
        assert!(inspect_jpeg(&oversized).is_err());
        let mut flood = vec![0xff, 0xd8];
        for _ in 0..MAX_JPEG_MARKERS { flood.extend(jpeg_segment(0xfe, b"")); }
        flood.extend_from_slice(&input[2..]);
        assert!(inspect_jpeg(&flood).is_err());
        let mut handle = JpegTransformHandle::new().unwrap();
        for (parameter, value) in [
            (jpeg::TJPARAM_TJPARAM_MAXMEMORY, 128),
            (jpeg::TJPARAM_TJPARAM_MAXPIXELS, MAX_PIXELS as i32),
            (jpeg::TJPARAM_TJPARAM_SCANLIMIT, MAX_JPEG_SCANS as i32),
            (jpeg::TJPARAM_TJPARAM_STOPONWARNING, 1),
            (jpeg::TJPARAM_TJPARAM_NOREALLOC, 1),
            (jpeg::TJPARAM_TJPARAM_SAVEMARKERS, 2),
        ] { assert_eq!(unsafe { jpeg::tj3Get(handle.0.as_ptr(), parameter as i32) }, value); }
        handle.set(jpeg::TJPARAM_TJPARAM_SCANLIMIT, 1).unwrap();
        assert_eq!(handle.optimize(&input).unwrap_err(), INVALID_JPEG);
        let mut handle = JpegTransformHandle::new().unwrap();
        handle.set(jpeg::TJPARAM_TJPARAM_MAXPIXELS, 100).unwrap();
        assert_eq!(handle.optimize(&input).unwrap_err(), INVALID_JPEG);
        let mut handle = JpegTransformHandle::new().unwrap();
        handle.set(jpeg::TJPARAM_TJPARAM_MAXMEMORY, 1).unwrap();
        assert_eq!(handle.optimize(&jpeg_fixture(false, false, 512)).unwrap_err(), INVALID_JPEG);
    }

    fn chunk(name: &[u8; 4], data: &[u8]) -> Vec<u8> {
        let mut result = (data.len() as u32).to_be_bytes().to_vec();
        result.extend_from_slice(name);
        result.extend_from_slice(data);
        let mut crc = !0u32;
        for byte in &result[4..] {
            crc ^= u32::from(*byte);
            for _ in 0..8 { crc = (crc >> 1) ^ (0xedb88320 & (0u32.wrapping_sub(crc & 1))); }
        }
        result.extend_from_slice(&(!crc).to_be_bytes());
        result
    }

    fn png_rgba8() -> (Vec<u8>, Vec<u8>) {
        let pixels: Vec<u8> = (0..64 * 32).flat_map(|n| {
            if n % 2 == 0 { [17, 29, 43, 0] } else { [71, 101, 137, 255] }
        }).collect();
        let mut bytes = Vec::new();
        PngEncoder::new_with_quality(&mut bytes, CompressionType::Uncompressed, FilterType::NoFilter)
            .write_image(&pixels, 64, 32, image::ExtendedColorType::Rgba8).unwrap();
        (bytes, pixels)
    }

    fn insert_before_idat(bytes: &[u8], extra: &[u8]) -> Vec<u8> {
        let mut result = PNG_SIGNATURE.to_vec();
        let mut inserted = false;
        visit_chunks(bytes, |name, part| {
            if !inserted && name == b"IDAT" {
                result.extend_from_slice(extra);
                inserted = true;
            }
            result.extend_from_slice(part);
        }).unwrap();
        result
    }

    fn metadata(bytes: &[u8]) -> Vec<Vec<u8>> {
        let mut result = Vec::new();
        visit_chunks(bytes, |name, part| {
            if name != b"IDAT" { result.push(part.to_vec()); }
        }).unwrap();
        result
    }

    #[test]
    fn compresses_rgba_without_changing_transparent_rgb_or_any_metadata() {
        let (bytes, pixels) = png_rgba8();
        let mut profile = vec![0; 256];
        profile[..4].copy_from_slice(&256u32.to_be_bytes());
        profile[16..20].copy_from_slice(b"RGB ");
        profile[36..40].copy_from_slice(b"acsp");
        let mut compressed_profile = flate2::write::ZlibEncoder::new(Vec::new(), flate2::Compression::none());
        compressed_profile.write_all(&profile).unwrap();
        let mut iccp = b"original-profile\0\0".to_vec();
        iccp.extend(compressed_profile.finish().unwrap());
        let exif = b"II*\0\x08\0\0\0\x01\0\x12\x01\x03\0\x01\0\0\0\x06\0\0\0\0\0\0\0";
        let mut extra = chunk(b"iCCP", &iccp);
        extra.extend(chunk(b"eXIf", exif));
        extra.extend(chunk(b"gAMA", &45455u32.to_be_bytes()));
        extra.extend(chunk(b"tEXt", b"Comment\0keep exact metadata"));
        let input = insert_before_idat(&bytes, &extra);
        let output = optimize_png(input.clone()).unwrap();
        assert!(output.len() < input.len());
        let decoded = image::load_from_memory(&output).unwrap().to_rgba8();
        assert_eq!(decoded.dimensions(), (64, 32));
        assert_eq!(decoded.into_raw(), pixels);
        assert_eq!(metadata(&output), metadata(&input));
        assert_eq!(optimize_png(output.clone()).unwrap(), output);
    }

    #[test]
    fn preserves_sixteen_bit_rgba_samples_and_header() {
        let samples: Vec<u16> = (0..64 * 32).flat_map(|n| {
            if n % 2 == 0 { [257, 513, 769, 0] } else { [4097, 8193, 16385, 65535] }
        }).collect();
        let pixels: Vec<u8> = samples.iter().flat_map(|v| v.to_ne_bytes()).collect();
        let mut input = Vec::new();
        PngEncoder::new_with_quality(&mut input, CompressionType::Uncompressed, FilterType::NoFilter)
            .write_image(&pixels, 64, 32, image::ExtendedColorType::Rgba16).unwrap();
        let output = optimize_png(input.clone()).unwrap();
        assert!(output.len() < input.len());
        assert_eq!(&output[..33], &input[..33]);
        assert_eq!(image::load_from_memory(&output).unwrap().to_rgba16().into_raw(), samples);
    }

    #[test]
    fn animation_is_returned_unchanged_and_options_keep_lossless_budgets() {
        let (bytes, _) = png_rgba8();
        let animated = insert_before_idat(&bytes, &chunk(b"acTL", &[0, 0, 0, 2, 0, 0, 0, 0]));
        assert_eq!(optimize_png(animated.clone()).unwrap(), animated);
        let options = optimization_options();
        assert!(!options.optimize_alpha && !options.scale_16);
        assert!(!options.bit_depth_reduction && !options.color_type_reduction);
        assert!(!options.palette_reduction && !options.grayscale_reduction);
        assert_eq!(options.interlace, None);
        assert_eq!(options.strip, oxipng::StripChunks::None);
        assert_eq!(options.timeout, Some(Duration::from_secs(5)));
        assert_eq!(options.max_decompressed_size, Some(MAX_DECOMPRESSED_BYTES));
    }

    #[test]
    fn png_signatures_offsets_unknown_unsafe_chunks_and_xmp_keep_original_bytes() {
        let (bytes, _) = png_rgba8();
        for name in [b"caBX", b"iDOT", b"dSIG", b"vpAG"] {
            let protected = insert_before_idat(&bytes, &chunk(name, b"bound to original encoding"));
            assert_eq!(optimize_png(protected.clone()).unwrap(), protected);
        }
        let mut encoder = flate2::write::ZlibEncoder::new(Vec::new(), flate2::Compression::default());
        encoder.write_all(b"<x:xmpmeta>external provenance</x:xmpmeta>").unwrap();
        let mut compressed_xmp = vec![0];
        compressed_xmp.extend(encoder.finish().unwrap());
        for (name, tail) in [
            (b"iTXt", b"\0\0\0\0<x:xmpmeta>external provenance</x:xmpmeta>".to_vec()),
            (b"tEXt", b"<x:xmpmeta>external provenance</x:xmpmeta>".to_vec()),
            (b"zTXt", compressed_xmp),
        ] {
            let mut packet = b"XML:com.adobe.xmp\0".to_vec();
            packet.extend(tail);
            let protected = insert_before_idat(&bytes, &chunk(name, &packet));
            assert_eq!(optimize_png(protected.clone()).unwrap(), protected);
        }
        let safe_unknown = insert_before_idat(&bytes, &chunk(b"vpAg", b"safe to copy"));
        let optimized = optimize_png(safe_unknown.clone()).unwrap();
        assert!(optimized.len() < safe_unknown.len());
        assert_eq!(metadata(&optimized), metadata(&safe_unknown));
    }

    #[test]
    fn png_chunk_count_is_bounded_before_decoding() {
        let (bytes, _) = png_rgba8();
        let mut existing = 0;
        visit_chunks(&bytes, |_, _| existing += 1).unwrap();
        let extra = chunk(b"tEXt", b"Comment\0").repeat(MAX_PNG_CHUNKS - existing);
        let at_limit = insert_before_idat(&bytes, &extra);
        assert!(inspect_png(&at_limit).is_ok());
        let over_limit = insert_before_idat(&at_limit, &chunk(b"tEXt", b"Comment\0"));
        assert_eq!(optimize_png(over_limit).unwrap_err(), "参考 PNG 分块过多，请保留原图上传");
    }

    #[test]
    fn rejects_untrusted_labels_nonbinary_oversize_and_malformed_headers() {
        assert!(ensure_main_label("main").is_ok());
        for label in ["chat-assistant", "asset-search", "plugin-ui", "dreamina-login", "main-child"] {
            assert!(ensure_main_label(label).is_err());
        }
        assert!(input_bytes(&InvokeBody::Json(serde_json::json!({}))).is_err());
        assert!(input_bytes(&InvokeBody::Raw(Vec::new())).is_err());
        assert!(input_bytes(&InvokeBody::Raw(vec![0; MAX_INPUT_BYTES])).is_ok());
        assert!(input_bytes(&InvokeBody::Raw(vec![0; MAX_INPUT_BYTES + 1])).is_err());
        assert!(inspect_png(b"not a PNG").is_err());
        let (mut bytes, _) = png_rgba8();
        bytes[16..20].copy_from_slice(&(MAX_EDGE + 1).to_be_bytes());
        assert!(inspect_png(&bytes).is_err());
        bytes[16..20].copy_from_slice(&6000u32.to_be_bytes());
        bytes[20..24].copy_from_slice(&4001u32.to_be_bytes());
        assert!(inspect_png(&bytes).is_err());
        bytes[20..24].copy_from_slice(&4000u32.to_be_bytes());
        bytes[24] = 16;
        let header = chunk(b"IHDR", &bytes[16..29]);
        bytes[8..33].copy_from_slice(&header);
        assert!(inspect_png(&bytes).is_ok());
        let error = oxipng::optimize_from_memory(&bytes, &optimization_options()).unwrap_err();
        assert!(matches!(error, oxipng::PngError::InflatedDataTooLong(MAX_DECOMPRESSED_BYTES)));
        let (mut bytes, _) = png_rgba8();
        bytes.truncate(bytes.len() - 1);
        assert!(inspect_png(&bytes).is_err());
        assert!(optimize_png(bytes).is_err());
    }

    #[tokio::test]
    async fn cancelled_observer_keeps_slot_until_blocking_worker_really_finishes() {
        let slots = Arc::new(Semaphore::new(1));
        let permit = slots.clone().try_acquire_owned().unwrap();
        let (started_tx, started_rx) = tokio::sync::oneshot::channel();
        let (finish_tx, finish_rx) = std::sync::mpsc::channel();
        let observer = tokio::spawn(run_image_task(permit, move || {
            let _ = started_tx.send(());
            finish_rx.recv_timeout(Duration::from_secs(2)).unwrap();
            Ok(Vec::new())
        }));
        started_rx.await.unwrap();
        observer.abort();
        let _ = observer.await;
        assert!(slots.clone().try_acquire_owned().is_err());
        finish_tx.send(()).unwrap();
        tokio::time::timeout(Duration::from_secs(2), async {
            while slots.available_permits() == 0 { tokio::task::yield_now().await; }
        }).await.unwrap();
        let permit = slots.clone().try_acquire_owned().unwrap();
        assert!(run_image_task(permit, || Err("fixture failure".into())).await.is_err());
        assert_eq!(slots.available_permits(), 1);
    }
}
