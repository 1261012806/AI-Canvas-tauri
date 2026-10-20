//! 只读的 ComfyUI 原生进度通道，不继承 Renderer 的 Origin、Cookie 或跨域限制。

use futures_util::StreamExt;
use serde::Serialize;
use serde_json::{Map, Value};
use std::{collections::HashMap, sync::{Arc, Mutex}, time::{Duration, Instant}};
use tauri::{ipc::Channel, AppHandle, Manager, Webview, Window, WindowEvent};
use tokio::sync::oneshot;
use tokio_tungstenite::{connect_async_with_config, tungstenite::{client::IntoClientRequest, handshake::client::Request, protocol::WebSocketConfig, Error, Message}};
use url::Url;

const MAX_CONNECTIONS: usize = 32;
const MAX_TEXT_BYTES: usize = 1024 * 1024;
// ComfyUI 同时推送二进制预览；允许有限的预览消息通过协议层，然后直接丢弃。
const MAX_MESSAGE_BYTES: usize = 16 * 1024 * 1024;
const MAX_NODE_COUNT: usize = 10_000;
const MAX_ID_BYTES: usize = 256;
const CONNECT_TIMEOUT: Duration = Duration::from_secs(5);
const SESSION_LIFETIME: Duration = Duration::from_secs(2 * 60 * 60);
const CANCEL_TTL: Duration = Duration::from_secs(30);
const MAX_EARLY_CANCELLATIONS: usize = 128;

struct Connection {
    owner: String,
    identity: Arc<()>,
    cancel: Option<oneshot::Sender<()>>,
}

#[derive(Default)]
struct Registry {
    active: HashMap<String, Connection>,
    // IPC 调度可能先处理取消，再启动对应的 async command。
    cancelled: HashMap<(String, String), Instant>,
}

#[derive(Default)]
pub struct ComfyProgressState {
    registry: Arc<Mutex<Registry>>,
}

struct Registration {
    registry: Arc<Mutex<Registry>>,
    request_id: String,
    identity: Arc<()>,
}

impl Drop for Registration {
    fn drop(&mut self) {
        let mut registry = self.registry.lock().unwrap_or_else(|error| error.into_inner());
        if registry.active.get(&self.request_id)
            .is_some_and(|connection| Arc::ptr_eq(&connection.identity, &self.identity))
        {
            registry.active.remove(&self.request_id);
        }
    }
}

impl ComfyProgressState {
    fn register(&self, owner: &str, request_id: String) -> Result<Option<(Registration, oneshot::Receiver<()>)>, String> {
        let mut registry = self.registry.lock().unwrap_or_else(|error| error.into_inner());
        registry.cancelled.retain(|_, created| created.elapsed() < CANCEL_TTL);
        if registry.cancelled.remove(&(owner.to_string(), request_id.clone())).is_some() {
            return Ok(None);
        }
        if registry.active.contains_key(&request_id) {
            return Err("ComfyUI 进度连接 ID 重复".into());
        }
        if registry.active.len() >= MAX_CONNECTIONS {
            return Err("ComfyUI 同时读取的进度过多，请稍后重试".into());
        }
        let (cancel, receiver) = oneshot::channel();
        let identity = Arc::new(());
        registry.active.insert(request_id.clone(), Connection {
            owner: owner.to_string(), identity: identity.clone(), cancel: Some(cancel),
        });
        Ok(Some((Registration { registry: self.registry.clone(), request_id, identity }, receiver)))
    }

    fn cancel(&self, owner: &str, request_id: &str) -> Result<(), String> {
        let mut registry = self.registry.lock().unwrap_or_else(|error| error.into_inner());
        if let Some(connection) = registry.active.get_mut(request_id) {
            if connection.owner != owner { return Err("不能取消其他窗口的 ComfyUI 进度连接".into()); }
            if let Some(cancel) = connection.cancel.take() { let _ = cancel.send(()); }
            return Ok(());
        }
        registry.cancelled.retain(|_, created| created.elapsed() < CANCEL_TTL);
        if registry.cancelled.len() >= MAX_EARLY_CANCELLATIONS {
            if let Some(oldest) = registry.cancelled.iter().min_by_key(|(_, created)| **created).map(|(key, _)| key.clone()) {
                registry.cancelled.remove(&oldest);
            }
        }
        registry.cancelled.insert((owner.to_string(), request_id.to_string()), Instant::now());
        Ok(())
    }

    fn shutdown(&self, owner: Option<&str>) {
        let mut registry = self.registry.lock().unwrap_or_else(|error| error.into_inner());
        registry.active.retain(|_, connection| {
            if owner.is_none_or(|owner| owner == connection.owner) {
                if let Some(cancel) = connection.cancel.take() { let _ = cancel.send(()); }
                false
            } else { true }
        });
        registry.cancelled.retain(|(label, _), _| owner.is_some_and(|owner| owner != label));
    }
}

#[derive(Clone, Serialize)]
#[serde(tag = "event", rename_all = "snake_case")]
pub enum ProgressEvent {
    Open,
    Message { data: Value },
    Error { #[serde(skip_serializing_if = "Option::is_none")] status: Option<u16> },
}

fn valid_connection_id(value: &str) -> bool {
    !value.is_empty() && value.len() <= MAX_ID_BYTES
        && value.bytes().all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
}

fn is_frontend_origin(current: &Url, dev_url: Option<&Url>) -> bool {
    if !matches!(current.path(), "/" | "/index.html") { return false; }
    let bundled = (current.scheme() == "tauri" && current.host_str() == Some("localhost"))
        || (matches!(current.scheme(), "http" | "https")
            && current.host_str() == Some("tauri.localhost") && current.port().is_none());
    bundled || dev_url.is_some_and(|expected| current.origin() == expected.origin())
}

fn ensure_caller(webview: &Webview) -> Result<(), String> {
    crate::path_policy::ensure_trusted_caller(webview)?;
    let current = webview.url().map_err(|_| "无法确认 ComfyUI 进度调用来源".to_string())?;
    let dev_url = if cfg!(debug_assertions) { webview.app_handle().config().build.dev_url.as_ref() } else { None };
    if webview.label() != "main" || !is_frontend_origin(&current, dev_url) {
        return Err("ComfyUI 进度只能由本地主窗口读取".into());
    }
    Ok(())
}

fn socket_request(base_url: &str, client_id: &str) -> Result<Request, String> {
    if base_url.len() > 4096 || base_url.trim().chars().any(char::is_control) || !valid_connection_id(client_id) {
        return Err("ComfyUI 进度地址或客户端 ID 无效".into());
    }
    let mut endpoint = Url::parse(base_url.trim()).map_err(|_| "ComfyUI 进度地址格式无效".to_string())?;
    if !matches!(endpoint.scheme(), "http" | "https") || endpoint.host_str().is_none()
        || !endpoint.username().is_empty() || endpoint.password().is_some()
        || endpoint.query().is_some() || endpoint.fragment().is_some()
    {
        return Err("ComfyUI 进度地址必须是不含凭据、查询参数和片段的 HTTP(S) 服务地址".into());
    }
    endpoint.set_path(&format!("{}/ws", endpoint.path().trim_end_matches('/')));
    let scheme = if endpoint.scheme() == "https" { "wss" } else { "ws" };
    endpoint.set_scheme(scheme).map_err(|_| "ComfyUI 进度地址协议无效".to_string())?;
    endpoint.query_pairs_mut().append_pair("clientId", client_id);
    // 标准客户端只生成协议所需头，不携带 Origin、Cookie 或 Renderer 请求头。
    endpoint.as_str().into_client_request().map_err(|_| "ComfyUI 进度连接请求无效".to_string())
}

fn socket_config() -> WebSocketConfig {
    WebSocketConfig::default().read_buffer_size(16 * 1024).write_buffer_size(1024)
        .max_write_buffer_size(16 * 1024).max_message_size(Some(MAX_MESSAGE_BYTES))
        .max_frame_size(Some(MAX_MESSAGE_BYTES))
}

fn safe_id(value: &Value) -> Option<Value> {
    value.as_str().filter(|text| !text.is_empty() && text.len() <= MAX_ID_BYTES && !text.chars().any(char::is_control))
        .map(|text| Value::String(text.to_string()))
}

fn copy_id(source: &Map<String, Value>, target: &mut Map<String, Value>, key: &str) {
    if let Some(value) = source.get(key).and_then(safe_id) { target.insert(key.to_string(), value); }
}

fn copy_numeric(source: &Map<String, Value>, target: &mut Map<String, Value>, key: &str) {
    if let Some(value) = source.get(key).filter(|value| value.as_f64().is_some_and(|number| number.is_finite() && number >= 0.0)) {
        target.insert(key.to_string(), value.clone());
    }
}

/// 不向 Renderer 交付日志、异常、输入参数或输出媒体；任务归属仍由前端 promptId 校验。
fn filter_progress(text: &str) -> Option<Value> {
    if text.len() > MAX_TEXT_BYTES { return None; }
    let packet: Value = serde_json::from_str(text).ok()?;
    let kind = packet.get("type")?.as_str()?;
    let source = packet.get("data")?.as_object()?;
    let mut data = Map::new();
    copy_id(source, &mut data, "prompt_id");
    match kind {
        "progress" => {
            copy_id(source, &mut data, "node");
            copy_numeric(source, &mut data, "value");
            copy_numeric(source, &mut data, "max");
        },
        "executing" => {
            let node = source.get("node")?;
            data.insert("node".into(), if node.is_null() { Value::Null } else { safe_id(node)? });
            copy_id(source, &mut data, "display_node");
        },
        "progress_state" => {
            let nodes = source.get("nodes")?.as_object()?;
            let mut filtered = Map::new();
            for (id, node) in nodes.iter().take(MAX_NODE_COUNT) {
                if id.is_empty() || id.len() > MAX_ID_BYTES || id.chars().any(char::is_control) { continue; }
                let Some(node) = node.as_object() else { continue; };
                let mut safe_node = Map::new();
                copy_id(node, &mut safe_node, "node_id");
                copy_id(node, &mut safe_node, "display_node_id");
                copy_numeric(node, &mut safe_node, "value");
                copy_numeric(node, &mut safe_node, "max");
                if let Some(state) = node.get("state").and_then(Value::as_str)
                    .filter(|state| matches!(*state, "running" | "finished" | "pending"))
                { safe_node.insert("state".into(), Value::String(state.to_string())); }
                filtered.insert(id.to_string(), Value::Object(safe_node));
            }
            data.insert("nodes".into(), Value::Object(filtered));
        },
        "execution_cached" => {
            let nodes = source.get("nodes")?.as_array()?;
            data.insert("nodes".into(), Value::Array(nodes.iter().take(MAX_NODE_COUNT).filter_map(safe_id).collect()));
        },
        "execution_start" | "execution_success" => {},
        _ => return None,
    }
    Some(serde_json::json!({ "type": kind, "data": data }))
}

fn report_error(channel: &Channel<ProgressEvent>, error: Option<&Error>) {
    let status = match error { Some(Error::Http(response)) => Some(response.status().as_u16()), _ => None };
    let _ = channel.send(ProgressEvent::Error { status });
}

#[tauri::command]
pub async fn stream_comfyui_progress(webview: Webview, app: AppHandle, base_url: String,
    client_id: String, request_id: String, on_event: Channel<ProgressEvent>) -> Result<(), String>
{
    ensure_caller(&webview)?;
    if !valid_connection_id(&request_id) { return Err("ComfyUI 进度连接 ID 无效".into()); }
    let request = socket_request(&base_url, &client_id)?;
    let state = app.state::<ComfyProgressState>();
    let Some((registration, mut cancelled)) = state.register(webview.label(), request_id)? else { return Ok(()); };
    let stream = async {
        // connect_async 不追随 HTTP 重定向；TLS 使用标准根证书校验。
        let (mut socket, _) = match tokio::time::timeout(CONNECT_TIMEOUT,
            connect_async_with_config(request, Some(socket_config()), false)).await
        {
            Ok(Ok(connection)) => connection,
            Ok(Err(error)) => {
                report_error(&on_event, Some(&error));
                return Err("ComfyUI 实时进度连接失败".into());
            },
            Err(_) => {
                report_error(&on_event, None);
                return Err("ComfyUI 实时进度连接超时".into());
            },
        };
        ensure_caller(&webview)?;
        on_event.send(ProgressEvent::Open).map_err(|_| "ComfyUI 进度接收通道已关闭".to_string())?;
        while let Some(message) = socket.next().await {
            match message {
                Ok(Message::Text(text)) => {
                    if let Some(data) = filter_progress(text.as_str()) {
                        ensure_caller(&webview)?;
                        on_event.send(ProgressEvent::Message { data }).map_err(|_| "ComfyUI 进度接收通道已关闭".to_string())?;
                    }
                },
                Ok(Message::Close(_)) => return Ok(()),
                Ok(_) => {}, // 二进制预览和协议帧不跨 IPC；库自动处理 Ping/Pong。
                Err(error) => {
                    report_error(&on_event, Some(&error));
                    return Err("ComfyUI 实时进度连接已断开".into());
                },
            }
        }
        Ok(())
    };
    let result = tokio::select! {
        biased;
        _ = &mut cancelled => Ok(()),
        _ = tokio::time::sleep(SESSION_LIFETIME) => {
            report_error(&on_event, None);
            Err("ComfyUI 实时进度连接已到时限".into())
        },
        result = stream => result,
    };
    // 先释放连接登记，再结束前端 Promise，允许立即发起下一次重连。
    drop(registration);
    result
}

#[tauri::command]
pub fn cancel_comfyui_progress(webview: Webview, app: AppHandle, request_id: String) -> Result<(), String> {
    ensure_caller(&webview)?;
    if !valid_connection_id(&request_id) { return Err("ComfyUI 进度连接 ID 无效".into()); }
    app.state::<ComfyProgressState>().cancel(webview.label(), &request_id)
}

pub(crate) fn on_window_event(window: &Window, event: &WindowEvent) {
    if matches!(event, WindowEvent::Destroyed) {
        if let Some(state) = window.app_handle().try_state::<ComfyProgressState>() {
            state.shutdown(Some(window.label()));
        }
    }
}

pub(crate) fn shutdown_progress(app: &AppHandle) {
    if let Some(state) = app.try_state::<ComfyProgressState>() { state.shutdown(None); }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn derives_only_the_fixed_socket_endpoint_without_browser_headers() {
        for (base, expected) in [("http://127.0.0.1:8188", "ws://127.0.0.1:8188/ws?clientId=ai-canvas-1"),
            ("https://comfy.example/comfy/", "wss://comfy.example/comfy/ws?clientId=ai-canvas-1"),
            ("http://[::1]:8188/", "ws://[::1]:8188/ws?clientId=ai-canvas-1")]
        {
            let request = socket_request(base, "ai-canvas-1").unwrap();
            assert_eq!(request.uri().to_string(), expected);
            assert_eq!(request.method(), "GET");
            for header in ["origin", "cookie", "authorization", "sec-websocket-protocol"] {
                assert!(request.headers().get(header).is_none());
            }
            assert_eq!(request.headers()["upgrade"], "websocket");
        }
    }

    #[test]
    fn rejects_non_http_credentials_and_url_parameters() {
        for url in ["", "ws://127.0.0.1:8188", "file:///models", "javascript:alert(1)",
            "https://user@example.com", "https://user:password@example.com", "https://example.com?token=secret",
            "https://example.com/#fragment", "https://example.com/?", "http://exam\nple.com/"]
        { assert!(socket_request(url, "client").is_err(), "{url}"); }
        assert!(socket_request(&"x".repeat(4097), "client").is_err());
        for id in ["", "client&token=secret", "client\nheader", "../x"] {
            assert!(socket_request("http://localhost:8188", id).is_err());
        }
    }

    #[test]
    fn accepts_only_the_main_frontend_origins_and_document() {
        let dev = Url::parse("http://localhost:1420").unwrap();
        assert!(is_frontend_origin(&Url::parse("http://localhost:1420/index.html").unwrap(), Some(&dev)));
        assert!(is_frontend_origin(&Url::parse("http://tauri.localhost/").unwrap(), None));
        assert!(is_frontend_origin(&Url::parse("tauri://localhost/").unwrap(), None));
        for url in ["http://localhost:8188/", "https://remote.example/", "file:///index.html", "http://tauri.localhost:8188/", "http://localhost:1420/remote.html"] {
            assert!(!is_frontend_origin(&Url::parse(url).unwrap(), Some(&dev)));
        }
    }

    #[test]
    fn forwards_only_whitelisted_progress_fields() {
        let raw = json!({"type":"progress", "extra":"private", "data":{"prompt_id":"p1", "node":"7", "value":2,
            "max":10, "inputs":{"secret":"private"}, "url":"private"}});
        assert_eq!(filter_progress(&raw.to_string()), Some(json!({"type":"progress", "data":{"prompt_id":"p1", "node":"7", "value":2, "max":10}})));
        for kind in ["status", "executed", "execution_error", "execution_interrupted", "unknown"] {
            assert!(filter_progress(&json!({"type":kind,"data":{"prompt_id":"p1"}}).to_string()).is_none());
        }
        assert_eq!(filter_progress(r#"{"type":"executing","data":{"node":null,"prompt_id":"p1"}}"#),
            Some(json!({"type":"executing","data":{"node":null,"prompt_id":"p1"}})));
    }

    #[test]
    fn sanitizes_node_snapshots_cached_ids_and_text_budgets() {
        let raw = json!({"type":"progress_state","data":{"nodes":{"7":{"node_id":"7","display_node_id":"3", "state":"running",
            "value":3,"max":8,"inputs":{"secret":"private"}}, "bad":"private"}}});
        assert_eq!(filter_progress(&raw.to_string()), Some(json!({"type":"progress_state","data":{"nodes":{"7":{"node_id":"7",
            "display_node_id":"3","state":"running","value":3,"max":8}}}})));
        assert_eq!(filter_progress(&json!({"type":"execution_cached","data":{"nodes":["7",null,1,"\n","8"]}}).to_string()),
            Some(json!({"type":"execution_cached","data":{"nodes":["7","8"]}})));
        assert!(filter_progress(&" ".repeat(MAX_TEXT_BYTES + 1)).is_none());
        assert!(filter_progress("invalid JSON").is_none());
        let config = socket_config();
        assert_eq!(config.max_message_size, Some(MAX_MESSAGE_BYTES));
        assert_eq!(config.max_frame_size, Some(MAX_MESSAGE_BYTES));
        assert!(config.max_message_size.unwrap() > MAX_TEXT_BYTES);
        assert!(config.max_write_buffer_size <= 16 * 1024);
    }

    #[test]
    fn registration_is_bounded_and_released_by_raii() {
        let state = ComfyProgressState::default();
        let mut guards = Vec::new();
        for index in 0..MAX_CONNECTIONS {
            guards.push(state.register("main", format!("request-{index}")).unwrap().unwrap());
        }
        assert!(state.register("main", "overflow".into()).is_err());
        assert!(state.register("main", "request-0".into()).is_err());
        drop(guards.pop());
        let registration = state.register("main", "replacement".into()).unwrap().unwrap();
        drop(registration);
        drop(guards);
        assert!(state.registry.lock().unwrap().active.is_empty());
    }

    #[test]
    fn cancellation_binds_owner_handles_early_cancel_and_shutdown() {
        let state = ComfyProgressState::default();
        let (guard, mut receiver) = state.register("main", "active".into()).unwrap().unwrap();
        assert!(state.cancel("other", "active").is_err());
        assert!(receiver.try_recv().is_err());
        state.cancel("main", "active").unwrap();
        assert_eq!(receiver.try_recv(), Ok(()));
        drop(guard);
        state.cancel("main", "early").unwrap();
        assert!(state.register("main", "early".into()).unwrap().is_none());
        let (guard, mut receiver) = state.register("main", "shutdown".into()).unwrap().unwrap();
        state.shutdown(Some("other"));
        assert!(receiver.try_recv().is_err());
        state.shutdown(Some("main"));
        assert_eq!(receiver.try_recv(), Ok(()));
        // 已销毁窗口的旧 guard 不能撤销同 ID 的新连接。
        let fresh = state.register("main", "shutdown".into()).unwrap().unwrap();
        drop(guard);
        assert!(state.registry.lock().unwrap().active.contains_key("shutdown"));
        drop(fresh);
    }
}
