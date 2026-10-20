//! 外部 MCP 的固定端点 HTTP 代理。SDK 协议在主窗口，凭据与网络请求留在原生侧。
use std::collections::{HashMap, HashSet};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use reqwest::{header, redirect::Policy, Client, Method, Url};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, State, Webview};
use tokio_util::sync::CancellationToken;

const MAX_BODY: usize = 1024 * 1024;
const MAX_INPUT: usize = 128 * 1024;
const MAX_REQUESTS: usize = 8;
static HTTP_CLIENT: OnceLock<Client> = OnceLock::new();

#[derive(Clone, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Connection {
    id: String,
    revision: String,
    url: String,
    auth_header: String,
    has_secret: bool,
    tool_names: Vec<String>,
}

#[derive(Default)]
pub struct McpClientState(Mutex<ClientState>);

#[derive(Default)]
struct ClientState {
    connections: HashMap<String, Connection>,
    requests: HashMap<String, (String, CancellationToken)>,
    cancelled: HashMap<String, Instant>,
}

#[derive(Serialize)]
pub struct HttpResponse {
    status: u16,
    headers: HashMap<String, String>,
    body: String,
}

fn main_caller(webview: &Webview) -> Result<(), String> {
    crate::path_policy::ensure_trusted_caller(webview)?;
    if webview.label() != "main" {
        return Err("外部 MCP 仅由主窗口执行".into());
    }
    Ok(())
}

fn valid_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 80
        && id.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_')
}

fn endpoint(value: &str) -> Result<Url, String> {
    let url = Url::parse(value).map_err(|_| "MCP 地址无效")?;
    let loopback = matches!(url.host_str(), Some("localhost" | "127.0.0.1" | "[::1]"));
    if value.len() > 2048 || url.host_str().is_none()
        || !(url.scheme() == "https" || (url.scheme() == "http" && loopback))
        || !url.username().is_empty() || url.password().is_some()
        || url.query().is_some() || url.fragment().is_some()
    {
        return Err("MCP 仅支持 HTTPS 或本机 HTTP，地址不能包含凭据、查询参数或片段".into());
    }
    Ok(url)
}

#[tauri::command]
pub fn mcp_client_configure(webview: Webview, state: State<'_, McpClientState>, connections: Vec<Connection>) -> Result<(), String> {
    main_caller(&webview)?;
    if connections.len() > 16 { return Err("最多配置 16 个 MCP 连接".into()); }
    let mut next = HashMap::new();
    for connection in connections {
        endpoint(&connection.url)?;
        if !valid_id(&connection.id) || !valid_id(&connection.revision)
            || !matches!(connection.auth_header.as_str(), "authorization" | "x-api-key")
            || connection.tool_names.len() > 256
            || connection.tool_names.iter().any(|name| name.is_empty() || name.len() > 256)
        { return Err("MCP 连接配置无效".into()); }
        if next.insert(connection.id.clone(), connection).is_some() { return Err("MCP 连接 ID 重复".into()); }
    }
    let mut guard = state.0.lock().map_err(|_| "MCP 状态不可用")?;
    if next.iter().any(|(id, value)| guard.connections.get(id).is_some_and(|old| old.revision == value.revision && old != value)) {
        return Err("MCP 配置变化必须更新连接修订".into());
    }
    for (id, token) in guard.requests.values() {
        if guard.connections.get(id) != next.get(id) { token.cancel(); }
    }
    guard.connections = next;
    Ok(())
}

#[tauri::command]
pub fn mcp_client_cancel(webview: Webview, state: State<'_, McpClientState>, request_id: String) -> Result<(), String> {
    main_caller(&webview)?;
    let mut guard = state.0.lock().map_err(|_| "MCP 状态不可用")?;
    if let Some((_, token)) = guard.requests.get(&request_id) { token.cancel(); }
    else if valid_id(&request_id) {
        guard.cancelled.retain(|_, time| time.elapsed() < Duration::from_secs(65));
        if guard.cancelled.len() >= 256 {
            if let Some(oldest) = guard.cancelled.iter().min_by_key(|(_, time)| **time).map(|(id, _)| id.clone()) { guard.cancelled.remove(&oldest); }
        }
        guard.cancelled.insert(request_id, Instant::now());
    }
    Ok(())
}

/// POST 中的 SSE 可带进度通知；拿到本次 RPC 的最终响应后停止读取，避免服务保持流不关闭。
fn has_rpc_result(body: &str, id: &Value) -> bool {
    let normalized = body.replace("\r\n", "\n");
    let mut complete = normalized.split("\n\n").collect::<Vec<_>>();
    complete.pop(); // 未以空行结束的 SSE 帧不可提前截断交给 SDK。
    complete.into_iter().filter_map(|event| {
        let data = event.lines().filter_map(|line| line.strip_prefix("data:").map(str::trim_start)).collect::<Vec<_>>().join("\n");
        serde_json::from_str::<Value>(&data).ok()
    }).any(|message| message.get("id") == Some(id) && (message.get("result").is_some() || message.get("error").is_some()))
}

fn validate_rpc(body: &str, connection: &Connection) -> Result<Value, String> {
    if body.len() > MAX_INPUT { return Err("MCP 请求超过 128 KiB".into()); }
    let message: Value = serde_json::from_str(body).map_err(|_| "MCP 请求格式无效")?;
    let method = message.get("method").and_then(Value::as_str).ok_or("MCP 请求缺少方法")?;
    if message.get("jsonrpc").and_then(Value::as_str) != Some("2.0")
        || !matches!(method, "initialize" | "ping" | "notifications/initialized" | "notifications/cancelled" | "tools/list" | "tools/call")
    { return Err("不支持此 MCP 方法".into()); }
    if method == "tools/call" {
        let name = message.pointer("/params/name").and_then(Value::as_str).ok_or("MCP 工具名称无效")?;
        if !connection.tool_names.iter().any(|allowed| allowed == name) { return Err("MCP 工具未授权".into()); }
    }
    Ok(message)
}

async fn send_request(app: &AppHandle, connection: &Connection, method: &str, headers: HashMap<String, String>, body: &str) -> Result<HttpResponse, String> {
    // 首期按需刷新目录，不开后台订阅流，不重连或重投工具调用。
    if method == "GET" { return Ok(HttpResponse { status: 405, headers: HashMap::new(), body: String::new() }); }
    if !matches!(method, "POST" | "DELETE") { return Err("不支持此 HTTP 方法".into()); }
    let rpc = if method == "POST" { Some(validate_rpc(body, connection)?) } else { None };
    let secret = if connection.has_secret {
        Some(crate::secret_store::read_internal_secret(app.clone(), format!("mcp-client/{}", connection.id)).await
            .map_err(|_| "无法读取 MCP 凭据")?.ok_or("MCP 凭据缺失，请重新保存")?)
    } else { None };
    if HTTP_CLIENT.get().is_none() {
        let client = Client::builder().redirect(Policy::none()).connect_timeout(Duration::from_secs(15))
            .pool_max_idle_per_host(2).timeout(Duration::from_secs(60)).build().map_err(|_| "无法创建 MCP 连接")?;
        let _ = HTTP_CLIENT.set(client);
    }
    let client = HTTP_CLIENT.get().ok_or("无法创建 MCP 连接")?;
    let mut request = client.request(Method::from_bytes(method.as_bytes()).map_err(|_| "HTTP 方法无效")?, endpoint(&connection.url)?);
    let allowed: HashSet<&str> = ["accept", "content-type", "mcp-session-id", "mcp-protocol-version", "last-event-id"].into_iter().collect();
    if headers.len() > 8 { return Err("MCP 请求头过多".into()); }
    for (name, value) in headers {
        if !allowed.contains(name.as_str()) || value.len() > 2048 { return Err("MCP 请求头无效".into()); }
        request = request.header(header::HeaderName::from_bytes(name.as_bytes()).map_err(|_| "MCP 请求头无效")?, value);
    }
    if let Some(token) = &secret {
        request = if connection.auth_header == "authorization" { request.bearer_auth(token) } else { request.header("x-api-key", token) };
    }
    if method == "POST" { request = request.body(body.to_owned()); }
    let mut response = request.send().await.map_err(|_| "MCP 网络连接失败，请检查地址与服务状态")?;
    let status = response.status().as_u16();
    let mut projected_headers = HashMap::new();
    for key in ["content-type", "mcp-session-id", "mcp-protocol-version"] {
        if let Some(value) = response.headers().get(key).and_then(|value| value.to_str().ok()) {
            if value.len() > 2048 || secret.as_ref().is_some_and(|token| value.contains(token.as_str())) { return Err("MCP 响应头无效".into()); }
            projected_headers.insert(key.to_string(), value.to_string());
        }
    }
    // 不把远端错误页、重定向地址或认证挑战送入日志与模型上下文。
    if !(200..300).contains(&status) { return Ok(HttpResponse { status, headers: HashMap::new(), body: String::new() }); }
    let sse = projected_headers.get("content-type").is_some_and(|value| value.starts_with("text/event-stream"));
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| "MCP 响应读取失败")? {
        if bytes.len() + chunk.len() > MAX_BODY { return Err("MCP 响应超过 1 MiB".into()); }
        bytes.extend_from_slice(&chunk);
        if sse {
            if let (Ok(text), Some(id)) = (std::str::from_utf8(&bytes), rpc.as_ref().and_then(|value| value.get("id"))) {
                if has_rpc_result(text, id) { break; }
            }
        }
    }
    let mut text = String::from_utf8(bytes).map_err(|_| "MCP 响应不是 UTF-8")?;
    if let Some(token) = secret { text = text.replace(&token, "[已脱敏凭据]"); }
    Ok(HttpResponse { status, headers: projected_headers, body: text })
}

#[tauri::command]
pub async fn mcp_client_fetch(app: AppHandle, webview: Webview, state: State<'_, McpClientState>, connection_id: String, revision: String, request_id: String, method: String, headers: HashMap<String, String>, body: String) -> Result<HttpResponse, String> {
    main_caller(&webview)?;
    if !valid_id(&request_id) { return Err("MCP 请求 ID 无效".into()); }
    let token = CancellationToken::new();
    let connection = {
        let mut guard = state.0.lock().map_err(|_| "MCP 状态不可用")?;
        if guard.cancelled.remove(&request_id).is_some() { return Err("MCP 请求已取消".into()); }
        let connection = guard.connections.get(&connection_id).filter(|item| item.revision == revision).cloned().ok_or("MCP 连接已停用或修改")?;
        if guard.requests.len() >= MAX_REQUESTS || guard.requests.contains_key(&request_id) { return Err("MCP 请求繁忙，请稍后重试".into()); }
        guard.requests.insert(request_id.clone(), (connection_id.clone(), token.clone()));
        connection
    };
    let result = tokio::select! {
        _ = token.cancelled() => Err("MCP 请求已取消；远端已执行的操作可能无法撤销".into()),
        result = tokio::time::timeout(Duration::from_secs(65), send_request(&app, &connection, &method, headers, &body)) => result.unwrap_or_else(|_| Err("MCP 请求超时；请先核实远端执行状态".into())),
    };
    let mut guard = state.0.lock().map_err(|_| "MCP 状态不可用")?;
    guard.requests.remove(&request_id);
    if token.is_cancelled() || guard.connections.get(&connection_id) != Some(&connection) { return Err("MCP 连接已变更或请求已取消；请先核实远端执行状态".into()); }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_explicit_secure_or_loopback_endpoints() {
        assert!(endpoint("https://example.com/mcp").is_ok());
        assert!(endpoint("http://127.0.0.1:8080/mcp").is_ok());
        for value in ["file:///etc/passwd", "http://example.com/mcp", "https://user:password@example.com/mcp", "https://example.com/mcp?token=secret", "https://example.com/mcp#fragment"] {
            assert!(endpoint(value).is_err());
        }
    }

    #[test]
    fn sse_requires_complete_final_response_for_the_same_request() {
        let id = serde_json::json!(7);
        assert!(!has_rpc_result("data: {\"id\":7,\"result\":{}}", &id));
        assert!(!has_rpc_result("data: {\"id\":8,\"result\":{}}\n\n", &id));
        assert!(has_rpc_result("event: message\r\ndata: {\"jsonrpc\":\"2.0\",\"id\":7,\"result\":{}}\r\n\r\n", &id));
    }

    #[test]
    fn rpc_cannot_invoke_ungranted_tools_or_arbitrary_http_methods() {
        let connection = Connection { id: "test".into(), revision: "rev".into(), url: "https://example.com/mcp".into(), auth_header: "authorization".into(), has_secret: false, tool_names: vec!["lookup".into()] };
        assert!(validate_rpc(r#"{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"lookup"}}"#, &connection).is_ok());
        assert!(validate_rpc(r#"{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"delete"}}"#, &connection).is_err());
        assert!(validate_rpc(r#"{"jsonrpc":"2.0","id":3,"method":"proxy_fetch"}"#, &connection).is_err());
    }
}
