//! HuggingFace 模型下载源择优。
//!
//! 国内直连 HuggingFace 时好时坏，第三方镜像也不是永远可用，所以不在代码里写死某个源：
//! 首次下载时并发读取目标资源的有界前缀，选择可用的较快源；
//! 只有完整下载并通过校验才缓存实际成功源，网络失败最多翻转一次。
//!
//! 旧镜像会把下载重定向回官方；域名可连通并不代表权重 CDN 可下载。
//! 探测跟随完整跳转并读取真实资源前缀，不用小词表速度代表大权重可达性。
//!
//! 缓存故意不放进持久化配置：镜像站随时可能失效，每次启动重新探测一次（约 1–6 秒）
//! 比留下一个过期偏好更稳妥。

use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use url::Url;

/// HuggingFace 官方域名
const OFFICIAL_HOST: &str = "huggingface.co";
/// 第三方国内镜像。失效时改这一个常量即可，其余逻辑不用动。
const MIRROR_HOST: &str = "hf-mirror.net";

/// 只改写这些域名，其余地址一律原样返回——绝不能把任意下载重定向到镜像。
const REWRITABLE_HOSTS: [&str; 2] = [OFFICIAL_HOST, "cdn-lfs.huggingface.co"];

/// 每个源只取前 256 KB，够算吞吐又不会拖慢首次下载
const PROBE_BYTES: usize = 256 * 1024;
/// 单源探测超时；超时即视为不可用
const PROBE_TIMEOUT: Duration = Duration::from_secs(6);
/// 官方源需要快过这个倍率才继续用官方。留一点余量，避免网络抖动时来回切换。
const OFFICIAL_BIAS: f64 = 1.15;

/// 下载源
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Source {
    /// 非 HuggingFace 地址：原样放行，不做改写也不做重试
    Passthrough,
    Official,
    Mirror,
}

impl Source {
    fn host(self) -> &'static str {
        match self {
            Source::Passthrough => OFFICIAL_HOST,
            Source::Official => OFFICIAL_HOST,
            Source::Mirror => MIRROR_HOST,
        }
    }

    pub fn label(self) -> &'static str {
        match self {
            Source::Passthrough => "original",
            Source::Official => "official",
            Source::Mirror => "mirror",
        }
    }
}

/// 解析结果
pub struct Resolved {
    pub url: String,
    pub source: Source,
}

fn cache_slot() -> &'static Mutex<Option<Source>> {
    static CACHE: OnceLock<Mutex<Option<Source>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(None))
}

fn read_cache() -> Option<Source> {
    let guard = cache_slot()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    *guard
}

/// 只有正式下载和内容校验成功后才能确认源；失败的重试源不能污染缓存。
pub fn record_success(source: Source) {
    if source == Source::Passthrough { return; }
    let mut guard = cache_slot()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    *guard = Some(source);
}

/// 决定一个下载地址该走哪个源。
///
/// `prefer` 显式指定源时只跳过探测，用于下载失败后翻转重试。
pub async fn resolve(raw_url: &str, prefer: Option<Source>) -> Resolved {
    let managed = Url::parse(raw_url).ok().is_some_and(|parsed| public_managed_url(&parsed));
    if !managed {
        return rewrite_for(raw_url, Source::Passthrough);
    }

    let source = match prefer {
        Some(Source::Passthrough) | None => match read_cache() {
            Some(cached) => cached,
            None => select_source(raw_url).await,
        },
        Some(forced) => forced,
    };

    rewrite_for(raw_url, source)
}

/// 镜像只处理公开、无认证的固定 HTTPS 地址；其余保留原始直连，不把令牌转交第三方。
fn public_managed_url(parsed: &Url) -> bool {
    let host = parsed.host_str().unwrap_or_default().to_ascii_lowercase();
    parsed.scheme() == "https" && REWRITABLE_HOSTS.contains(&host.as_str())
        && parsed.username().is_empty() && parsed.password().is_none()
        && parsed.port().is_none() && parsed.query().is_none() && parsed.fragment().is_none()
}

/// 下载失败后取另一个源重试；源不可切换（非 HuggingFace 地址）时返回 None。
pub fn alternate(used: Source) -> Option<Source> {
    match used {
        Source::Passthrough => None,
        Source::Official => Some(Source::Mirror),
        Source::Mirror => Some(Source::Official),
    }
}

/// 纯改写，不读写缓存。非受管地址直接返回原文。
fn rewrite_for(raw_url: &str, source: Source) -> Resolved {
    let parsed = match Url::parse(raw_url) {
        Ok(parsed) => parsed,
        Err(_) => {
            return Resolved {
                url: raw_url.to_string(),
                source: Source::Passthrough,
            }
        }
    };
    if !public_managed_url(&parsed) {
        return Resolved {
            url: raw_url.to_string(),
            source: Source::Passthrough,
        };
    }
    Resolved {
        url: rewrite(&parsed, source.host()),
        source,
    }
}

/// 并发探测两个源，返回吞吐更高的那个；都失败时回退官方。
async fn select_source(raw_url: &str) -> Source {
    let (official, mirror) = tokio::join!(measure(raw_url, Source::Official), measure(raw_url, Source::Mirror));
    eprintln!(
        "[model-mirror] 探测 官方={:?} 镜像={:?}",
        official.map(|(_, elapsed)| elapsed),
        mirror.map(|(_, elapsed)| elapsed)
    );

    let chosen = choose_source(official, mirror);
    eprintln!("[model-mirror] 选用 {:?}（{}）", chosen, chosen.label());
    chosen
}

fn choose_source(official: Option<(usize, Duration)>, mirror: Option<(usize, Duration)>) -> Source {
    match (official, mirror) {
        (Some(official), Some(mirror)) => {
            if throughput(official) >= throughput(mirror) * OFFICIAL_BIAS {
                Source::Official
            } else {
                Source::Mirror
            }
        }
        (Some(_), None) => Source::Official,
        (None, Some(_)) => Source::Mirror,
        (None, None) => Source::Official,
    }
}

fn throughput(sample: (usize, Duration)) -> f64 {
    let (bytes, elapsed) = sample;
    bytes as f64 / elapsed.as_secs_f64().max(1e-6)
}

/// 对单个源发一个分片 GET，返回 (收到字节数, 耗时)。不可用返回 None。
async fn measure(raw_url: &str, source: Source) -> Option<(usize, Duration)> {
    let client = reqwest::Client::builder()
        .user_agent("AI-Canvas/0.4")
        .connect_timeout(PROBE_TIMEOUT)
        .timeout(PROBE_TIMEOUT)
        .redirect(reqwest::redirect::Policy::limited(5))
        .build()
        .ok()?;

    let started = Instant::now();
    let mut response = client
        .get(rewrite_for(raw_url, source).url)
        .header(
            reqwest::header::RANGE,
            format!("bytes=0-{}", PROBE_BYTES - 1),
        )
        .send()
        .await
        .ok()?;
    let status = response.status();
    if !(status.is_success() || status == reqwest::StatusCode::PARTIAL_CONTENT) {
        eprintln!("[model-mirror] {} 探测返回 {status}", source.label());
        return None;
    }
    if response.headers().get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .is_some_and(|value| {
            let mime = value.split(';').next().unwrap_or_default().trim().to_ascii_lowercase();
            matches!(mime.as_str(), "text/html" | "application/json" | "application/xml" | "text/xml")
        }) {
        return None;
    }
    let mut received = 0;
    let mut prefix = Vec::with_capacity(256);
    // 即使服务器忽略 Range，也绝不把整个权重读入内存；达到窗口即丢弃响应。
    while received < PROBE_BYTES {
        let Some(chunk) = response.chunk().await.ok()? else { break; };
        let take = chunk.len().min(PROBE_BYTES - received);
        let prefix_take = take.min(256 - prefix.len());
        prefix.extend_from_slice(&chunk[..prefix_take]);
        received += take;
    }
    if received == 0 || invalid_probe_prefix(&prefix) { return None; }
    Some((received, started.elapsed()))
}

fn invalid_probe_prefix(prefix: &[u8]) -> bool {
    let prefix = String::from_utf8_lossy(prefix).trim_start().to_ascii_lowercase();
    prefix.starts_with("<!doctype html") || prefix.starts_with("<html")
        || prefix.starts_with("<?xml") || prefix.starts_with("{\"")
        || prefix.starts_with("version https://git-lfs.github.com/spec/")
}

/// 只替换域名，路径与查询串原样保留。
fn rewrite(original: &Url, host: &str) -> String {
    let mut rewritten = original.clone();
    // 受管地址进来时已经是 https，这里的失败只会被忽略并保持原样
    let _ = rewritten.set_host(Some(host));
    rewritten.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rewrites_only_pinned_huggingface_hosts() {
        let mirrored = rewrite_for(
            "https://huggingface.co/briaai/RMBG-1.4/resolve/main/onnx/model.onnx",
            Source::Mirror,
        );
        assert_eq!(mirrored.source, Source::Mirror);
        assert_eq!(
            mirrored.url,
            "https://hf-mirror.net/briaai/RMBG-1.4/resolve/main/onnx/model.onnx"
        );

        let lfs = rewrite_for(
            "https://cdn-lfs.huggingface.co/repos/xx/yy/model.onnx",
            Source::Mirror,
        );
        assert_eq!(lfs.source, Source::Mirror);
        assert!(lfs.url.starts_with("https://hf-mirror.net/"));

        // 同一个地址选官方源时应保持不变
        let official = rewrite_for(
            "https://huggingface.co/briaai/RMBG-1.4/resolve/main/onnx/model.onnx",
            Source::Official,
        );
        assert_eq!(official.source, Source::Official);
        assert_eq!(
            official.url,
            "https://huggingface.co/briaai/RMBG-1.4/resolve/main/onnx/model.onnx"
        );
    }

    #[test]
    fn leaves_everything_else_untouched() {
        // 非 HF 域名、HF 的子域与伪装的父域、非 https、非 http(s) 协议，都不能被改写
        let untouched = [
            "https://example.com/model.onnx",
            "https://hf.huggingface.co/x/model.onnx",
            "https://huggingface.co.evil.test/x/model.onnx",
            "http://huggingface.co/x/model.onnx",
            "javascript:alert(1)",
            "file:///C:/secret/token",
            "https://user@huggingface.co/x/model.onnx",
            "https://user:password@huggingface.co/x/model.onnx",
            "https://huggingface.co:8443/x/model.onnx",
            "https://huggingface.co/x/model.onnx?token=private",
            "https://huggingface.co/x/model.onnx?download=1",
            "https://huggingface.co/x/model.onnx#private",
        ];
        for raw in untouched {
            let resolved = rewrite_for(raw, Source::Mirror);
            assert_eq!(resolved.source, Source::Passthrough, "不应改写 {raw}");
            assert_eq!(resolved.url, raw, "URL 应原样返回: {raw}");
        }
    }

    #[test]
    fn keeps_public_path_and_normalizes_host_case() {
        let resolved = rewrite_for(
            "https://HuggingFace.co/OpenVoiceOS/sensevoice-small-onnx/resolve/main/vocab.txt",
            Source::Official,
        );
        assert_eq!(resolved.source, Source::Official);
        assert_eq!(
            resolved.url,
            "https://huggingface.co/OpenVoiceOS/sensevoice-small-onnx/resolve/main/vocab.txt"
        );
    }

    #[test]
    fn invalid_urls_are_passed_through_instead_of_rejected() {
        let resolved = rewrite_for("not a url at all", Source::Mirror);
        assert_eq!(resolved.source, Source::Passthrough);
        assert_eq!(resolved.url, "not a url at all");
    }

    #[test]
    fn alternate_only_flips_managed_sources() {
        assert_eq!(alternate(Source::Official), Some(Source::Mirror));
        assert_eq!(alternate(Source::Mirror), Some(Source::Official));
        assert_eq!(alternate(Source::Passthrough), None);
    }

    #[test]
    fn throughput_prefers_faster_sample() {
        let fast = (256 * 1024, Duration::from_millis(200));
        let slow = (256 * 1024, Duration::from_millis(2000));
        assert!(throughput(fast) > throughput(slow) * OFFICIAL_BIAS);
    }

    #[test]
    fn failed_probes_and_error_pages_cannot_win_source_selection() {
        let available = Some((PROBE_BYTES, Duration::from_millis(500)));
        assert_eq!(choose_source(None, available), Source::Mirror);
        assert_eq!(choose_source(available, None), Source::Official);
        assert_eq!(choose_source(None, None), Source::Official);
        assert!(invalid_probe_prefix(b" <!doctype html><html>challenge</html>"));
        assert!(invalid_probe_prefix(b"version https://git-lfs.github.com/spec/v1"));
        assert!(invalid_probe_prefix(b"{\"error\":\"offline\"}"));
        assert!(!invalid_probe_prefix(b"\x08\x08\x12\x07pytorch"));
    }

    #[tokio::test]
    async fn probe_stops_at_the_window_when_server_ignores_range() {
        use std::{io::{Read, Write}, net::TcpListener};
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let address = listener.local_addr().unwrap();
        let server = std::thread::spawn(move || {
            let deadline = Instant::now() + Duration::from_secs(3);
            loop {
                if let Ok((mut stream, _)) = listener.accept() {
                    stream.set_read_timeout(Some(Duration::from_secs(3))).unwrap();
                    let mut request = [0_u8; 4096];
                    let read = stream.read(&mut request).unwrap();
                    assert!(String::from_utf8_lossy(&request[..read]).to_ascii_lowercase()
                        .contains(&format!("range: bytes=0-{}", PROBE_BYTES - 1)));
                    stream.write_all(b"HTTP/1.1 200 OK\r\nContent-Type: application/octet-stream\r\nContent-Length: 1048576\r\nConnection: close\r\n\r\n").unwrap();
                    // 声明 1 MiB，却只发送略大于探测窗口；整包读取会因截断失败。
                    let _ = stream.write_all(&vec![7_u8; PROBE_BYTES + 8192]);
                    return;
                }
                assert!(Instant::now() < deadline, "local probe did not arrive");
                std::thread::sleep(Duration::from_millis(10));
            }
        });
        let sample = measure(&format!("http://{address}/model.onnx"), Source::Official).await;
        assert_eq!(sample.map(|(bytes, _)| bytes), Some(PROBE_BYTES));
        server.join().unwrap();
    }

    /// 唯一触碰全局缓存的用例：失败尝试不更新，只有已完成校验的源才能缓存。
    /// 其余用例走 `rewrite_for`，不读写缓存，避免并行测试互相干扰。
    #[tokio::test]
    async fn resolve_caches_only_confirmed_success_without_live_network() {
        let runtime_url =
            "https://huggingface.co/OpenVoiceOS/sensevoice-small-onnx/resolve/main/vocab.txt";
        let before = read_cache();
        let retry = resolve(runtime_url, Some(Source::Mirror)).await;
        assert_eq!(retry.source, Source::Mirror);
        assert_eq!(read_cache(), before);
        record_success(Source::Official);
        let confirmed = resolve(runtime_url, None).await;
        assert_eq!(confirmed.source, Source::Official);
        record_success(Source::Passthrough);
        assert_eq!(read_cache(), Some(Source::Official));
        *cache_slot().lock().unwrap() = before;
    }

    #[tokio::test]
    async fn resolve_leaves_foreign_urls_alone_even_without_cache() {
        let resolved = resolve("https://example.com/model.onnx", None).await;
        assert_eq!(resolved.source, Source::Passthrough);
        assert_eq!(resolved.url, "https://example.com/model.onnx");
    }
}
