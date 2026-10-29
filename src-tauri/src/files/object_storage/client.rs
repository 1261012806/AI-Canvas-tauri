//! Fixed-scope S3 capability probes. No credentials or remote error text leave this module.

use super::{
    BindingMode, CapabilityCheck, CapabilityReport, CheckKind, CheckStatus, ConnectionInput,
    Credentials, RemoteProjectScope, StorageError,
};
use futures_util::TryStreamExt;
use object_store::{
    aws::{AmazonS3, AmazonS3Builder, S3ConditionalPut},
    client::{HttpClient, HttpConnector, HttpError, HttpErrorKind, HttpRequest, HttpResponse, HttpResponseBody, HttpService},
    path::Path,
    ClientOptions, Error as ObjectError, ObjectMeta, ObjectStore, PutMode, PutOptions,
    RetryConfig, UpdateVersion,
};
use serde::{Deserialize, Serialize};
use std::{
    collections::hash_map::RandomState,
    future::Future,
    hash::{BuildHasher, Hash, Hasher},
    pin::Pin,
    sync::atomic::{AtomicU64, Ordering},
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tokio::time::Instant;
use tokio_util::sync::CancellationToken;

const DESCRIPTOR_FORMAT: &str = "ai-canvas-shared-project";
const DESCRIPTOR_VERSION: u32 = 1;
const DESCRIPTOR_LIMIT: usize = 16 * 1024;
const PROBE_RESPONSE_LIMIT: usize = 4 * 1024;
const HTTP_RESPONSE_LIMIT: usize = 64 * 1024;
const LIST_LIMIT: usize = 64;
const REQUEST_TIMEOUT: Duration = Duration::from_secs(20);
const PROBE_TIMEOUT: Duration = Duration::from_secs(120);
const CLEANUP_TIMEOUT: Duration = Duration::from_secs(10);
const PROBE_BYTES: &[u8] = b"\0ai-canvas-capability-probe\xff\r\n";
static NONCE_SEQUENCE: AtomicU64 = AtomicU64::new(0);

#[derive(Debug, Clone)]
struct RestrictedConnector(reqwest::Client, bool, usize);

impl HttpConnector for RestrictedConnector {
    fn connect(&self, _options: &ClientOptions) -> object_store::Result<HttpClient> {
        // All transport policy is fixed here, never inherited from remote configuration.
        Ok(HttpClient::new(RestrictedService(self.0.clone(), self.1, self.2)))
    }
}

#[derive(Debug, Clone)]
struct RestrictedService(reqwest::Client, bool, usize);

#[derive(Debug)]
struct ResponseTooLarge;

impl std::fmt::Display for ResponseTooLarge {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("response_too_large")
    }
}

impl std::error::Error for ResponseTooLarge {}

fn log_transport_failure(method: &str, elapsed: Duration, error: &HttpError) {
    use std::error::Error as _;
    let kind = match error.kind() {
        HttpErrorKind::Connect => "connect", HttpErrorKind::Request => "request",
        HttpErrorKind::Timeout => "timeout", HttpErrorKind::Interrupted => "interrupted",
        HttpErrorKind::Decode => "decode", _ => "unknown",
    };
    let mut io_kind = "none";
    let mut timeout = false; let mut connect = false; let mut request = false; let mut body = false;
    let mut source = error.source();
    while let Some(current) = source {
        if let Some(error) = current.downcast_ref::<reqwest::Error>() {
            timeout |= error.is_timeout(); connect |= error.is_connect();
            request |= error.is_request(); body |= error.is_body();
        }
        if let Some(error) = current.downcast_ref::<std::io::Error>() {
            io_kind = match error.kind() {
                std::io::ErrorKind::TimedOut => "timeout",
                std::io::ErrorKind::ConnectionReset => "connection_reset",
                std::io::ErrorKind::ConnectionAborted => "connection_aborted",
                std::io::ErrorKind::ConnectionRefused => "connection_refused",
                std::io::ErrorKind::BrokenPipe => "broken_pipe",
                std::io::ErrorKind::UnexpectedEof => "unexpected_eof",
                _ => "other",
            };
        }
        source = current.source();
    }
    eprintln!("[project-asset-sync] transport method={method} kind={kind} elapsed_ms={} io={io_kind} timeout={timeout} connect={connect} request={request} body={body}", elapsed.as_millis());
}

impl HttpService for RestrictedService {
    // Match the SDK's async_trait ABI without introducing another direct dependency.
    fn call<'life0, 'async_trait>(
        &'life0 self,
        request: HttpRequest,
    ) -> Pin<Box<dyn Future<Output = Result<HttpResponse, HttpError>> + Send + 'async_trait>>
    where
        'life0: 'async_trait,
        Self: 'async_trait,
    {
        Box::pin(async move {
            let content_read = self.1 && request.method().as_str() == "GET";
            let method = match request.method().as_str() {
                "GET" => "GET", "PUT" => "PUT", "POST" => "POST",
                "DELETE" => "DELETE", "HEAD" => "HEAD", _ => "OTHER",
            };
            let started = std::time::Instant::now();
            let response = match HttpService::call(&self.0, request).await {
                Ok(response) => response,
                Err(error) => {
                    log_transport_failure(method, started.elapsed(), &error);
                    return Err(error);
                }
            };
            // 404 and conditional failures may be expected during reconciliation.
            // Never log the URL, headers, response body, or SDK error text.
            eprintln!("[project-asset-sync] http method={method} status={}", response.status().as_u16());
            // Only the dedicated fixed-content client streams successful GETs. Its caller
            // checks declared length, incremental size, idle timeout and SHA-256.
            if content_read && response.status().is_success() { return Ok(response); }
            let (parts, body) = response.into_parts();
            let mut stream = body.bytes_stream();
            let mut bytes = Vec::new();
            while let Some(chunk) = stream.try_next().await? {
                if chunk.len() > self.2.saturating_sub(bytes.len()) {
                    return Err(HttpError::new(HttpErrorKind::Decode, ResponseTooLarge));
                }
                bytes.extend_from_slice(&chunk);
            }
            // Capability payloads are tiny; bound even chunked XML before the SDK parses it.
            Ok(HttpResponse::from_parts(parts, HttpResponseBody::from(bytes)))
        })
    }
}

fn client(connection: &ConnectionInput, credentials: Credentials) -> Result<AmazonS3, StorageError> {
    build_client(connection, credentials, false, HTTP_RESPONSE_LIMIT, Some(REQUEST_TIMEOUT))
}

pub(super) fn sync_client(connection: &ConnectionInput, credentials: Credentials, content: bool) -> Result<AmazonS3, StorageError> {
    build_client(connection, credentials, content, if content { HTTP_RESPONSE_LIMIT } else { super::protocol::MANIFEST_LIMIT }, if content { None } else { Some(Duration::from_secs(30)) })
}

fn build_client(connection: &ConnectionInput, credentials: Credentials, content: bool, response_limit: usize, timeout: Option<Duration>) -> Result<AmazonS3, StorageError> {
    if credentials.access_key_id.trim().is_empty() || credentials.secret_access_key.is_empty() {
        return Err(StorageError::new("credentials_missing"));
    }
    let endpoint = request_endpoint(connection)?;
    let allow_http = match url::Url::parse(&endpoint).map_err(|_| StorageError::new("invalid_input"))?.scheme() {
        "http" => true, "https" => false, _ => return Err(StorageError::new("invalid_input")),
    };
    let mut http = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .https_only(!allow_http)
        .danger_accept_invalid_certs(false)
        .no_proxy()
        .connect_timeout(Duration::from_secs(5));
    // Media PUTs use transfer::upload's 300-second deadline and cancellation. A
    // client read timeout also covers waiting for response headers, so it must
    // not cut that upload budget short. Media GETs retain request()'s 30-second
    // response deadline and each consumer's 30-second stream-idle deadline.
    if !content { http = http.read_timeout(Duration::from_secs(30)); }
    if let Some(timeout) = timeout { http = http.timeout(timeout); }
    let http = http.build()
        .map_err(|_| StorageError::new("unavailable"))?;
    let mut builder = AmazonS3Builder::new()
        .with_endpoint(endpoint)
        .with_region(connection.region.clone())
        .with_bucket_name(connection.bucket.clone())
        .with_virtual_hosted_style_request(!connection.path_style)
        .with_allow_http(allow_http)
        .with_access_key_id(credentials.access_key_id)
        .with_secret_access_key(credentials.secret_access_key)
        .with_conditional_put(S3ConditionalPut::ETagMatch)
        .with_retry(RetryConfig { max_retries: 0, ..Default::default() })
        .with_http_connector(RestrictedConnector(http, content, response_limit));
    if let Some(token) = credentials.session_token {
        builder = builder.with_token(token);
    }
    builder.build().map_err(|_| StorageError::new("invalid_input"))
}

fn request_endpoint(connection: &ConnectionInput) -> Result<String, StorageError> {
    if connection.path_style { return Ok(connection.endpoint.clone()); }
    let mut endpoint = url::Url::parse(&connection.endpoint).map_err(|_| StorageError::new("invalid_input"))?;
    let host = match endpoint.host() {
        Some(url::Host::Domain(host)) if host.contains('.') && host.split('.').all(|part| !part.is_empty()) => host.to_string(),
        _ => return Err(StorageError::new("invalid_input")),
    };
    // Public configuration is always a service origin, never a pre-expanded bucket origin.
    endpoint.set_host(Some(&format!("{}.{}", connection.bucket, host))).map_err(|_| StorageError::new("invalid_input"))?;
    Ok(endpoint.origin().ascii_serialization())
}

struct Io<'a> {
    cancel: &'a CancellationToken,
    deadline: Instant,
}

impl<'a> Io<'a> {
    fn new(cancel: &'a CancellationToken) -> Self {
        Self { cancel, deadline: Instant::now() + PROBE_TIMEOUT }
    }

    fn ensure_current(&self) -> Result<(), StorageError> {
        if self.cancel.is_cancelled() {
            Err(StorageError::new("cancelled"))
        } else if Instant::now() >= self.deadline {
            Err(StorageError::new("network"))
        } else {
            Ok(())
        }
    }

    async fn run<T>(&self, future: impl Future<Output = T>) -> Result<T, StorageError> {
        self.ensure_current()?;
        let deadline = self.deadline.min(Instant::now() + REQUEST_TIMEOUT);
        tokio::select! {
            biased;
            _ = self.cancel.cancelled() => Err(StorageError::new("cancelled")),
            result = tokio::time::timeout_at(deadline, future) => {
                result.map_err(|_| StorageError::new("network"))
            }
        }
    }

    async fn request<T>(
        &self,
        future: impl Future<Output = object_store::Result<T>>,
    ) -> Result<T, StorageError> {
        self.run(future).await?.map_err(remote_error)
    }
}

pub(super) fn remote_error(error: ObjectError) -> StorageError {
    let mut source: &(dyn std::error::Error + 'static) = &error;
    let mut network = false;
    loop {
        if source.is::<ResponseTooLarge>() {
            eprintln!("[project-asset-sync] remote_error code=response_too_large");
            return StorageError::new("response_too_large");
        }
        // Classify only public typed evidence; SDK-private wrappers and error text
        // do not prove a transport kind or an HTTP response status.
        if let Some(error) = source.downcast_ref::<HttpError>() {
            network |= matches!(error.kind(), HttpErrorKind::Timeout | HttpErrorKind::Connect | HttpErrorKind::Request | HttpErrorKind::Interrupted);
        }
        // A transparent SDK wrapper may expose reqwest directly instead of HttpError.
        if let Some(error) = source.downcast_ref::<reqwest::Error>() {
            network |= error.is_timeout() || error.is_connect();
        }
        match source.source() { Some(next) => source = next, None => break }
    }
    if network {
        eprintln!("[project-asset-sync] remote_error code=network");
        return StorageError::new("network");
    }
    let code = match &error {
        ObjectError::PermissionDenied { .. } => "access_denied",
        ObjectError::Unauthenticated { .. } => "authentication_failed",
        ObjectError::AlreadyExists { .. } | ObjectError::Precondition { .. } | ObjectError::NotModified { .. } => "conflict",
        ObjectError::NotFound { .. } => "project_not_found",
        ObjectError::NotSupported { .. } | ObjectError::NotImplemented => "unavailable",
        _ => "unknown",
    };
    if code != "project_not_found" {
        let kind = match &error {
            ObjectError::Generic { .. } => "generic",
            ObjectError::PermissionDenied { .. } => "permission_denied",
            ObjectError::Unauthenticated { .. } => "unauthenticated",
            ObjectError::AlreadyExists { .. } => "already_exists",
            ObjectError::Precondition { .. } => "precondition",
            ObjectError::NotModified { .. } => "not_modified",
            ObjectError::NotSupported { .. } | ObjectError::NotImplemented => "not_supported",
            _ => "other",
        };
        eprintln!("[project-asset-sync] remote_error kind={kind} code={code}");
    }
    StorageError::new(code)
}

fn unknown_mutation(error: &StorageError) -> bool {
    matches!(error.code, "cancelled" | "network" | "unknown")
}

fn key(scope: &RemoteProjectScope, suffix: &str) -> Result<Path, StorageError> {
    Path::parse(format!("{}/{}", scope.project_prefix.trim_end_matches('/'), suffix))
        .map_err(|_| StorageError::new("invalid_input"))
}

fn nonce() -> String {
    let mut hasher = RandomState::new().build_hasher();
    let elapsed = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default();
    let sequence = NONCE_SEQUENCE.fetch_add(1, Ordering::Relaxed);
    (elapsed.as_nanos(), sequence).hash(&mut hasher);
    format!("{:016x}-{sequence:016x}", hasher.finish())
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct ProjectDescriptor {
    format: String,
    version: u32,
    library_id: String,
    shared_project_id: String,
    #[serde(skip_serializing_if = "Option::is_none")] pub generation: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")] pub status: Option<ProjectStatus>,
    #[serde(skip_serializing_if = "Option::is_none")] pub sequence: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")] pub lock: Option<ProjectLock>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(super) enum ProjectStatus { Active, Locked, Deleted }

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct ProjectLock {
    pub operation_id: String,
    pub token_digest: String,
}

impl ProjectDescriptor {
    pub(super) fn generation(&self) -> &str { self.generation.as_deref().unwrap_or("legacy") }
}

pub(super) fn parse_descriptor(bytes: &[u8], scope: &RemoteProjectScope) -> Result<ProjectDescriptor, StorageError> {
    if bytes.len() > DESCRIPTOR_LIMIT {
        return Err(StorageError::new("response_too_large"));
    }
    let descriptor: ProjectDescriptor = serde_json::from_slice(bytes)
        .map_err(|_| StorageError::new("project_mismatch"))?;
    if descriptor.format != DESCRIPTOR_FORMAT || ![1, 2].contains(&descriptor.version)
        || descriptor.library_id != scope.library_id
        || descriptor.shared_project_id != scope.shared_project_id
    {
        return Err(StorageError::new("project_mismatch"));
    }
    match descriptor.version {
        1 if descriptor.generation.is_none() && descriptor.status.is_none() && descriptor.sequence.is_none() && descriptor.lock.is_none() => {},
        2 if descriptor.generation.as_deref().is_some_and(|generation| generation == "legacy" || super::protocol::valid_digest(generation))
            && descriptor.sequence.is_some_and(|sequence| sequence <= 9_007_199_254_740_991)
            && matches!((&descriptor.status, &descriptor.lock), (Some(ProjectStatus::Active | ProjectStatus::Deleted), None) | (Some(ProjectStatus::Locked | ProjectStatus::Deleted), Some(_))) => {
                if let Some(lock) = &descriptor.lock {
                    super::validate_id(&lock.operation_id)?;
                    if !super::protocol::valid_digest(&lock.token_digest) { return Err(StorageError::new("project_mismatch")); }
                }
            },
        _ => return Err(StorageError::new("project_mismatch")),
    }
    Ok(descriptor)
}

pub(super) fn validate_descriptor(bytes: &[u8], scope: &RemoteProjectScope) -> Result<(), StorageError> {
    let descriptor = parse_descriptor(bytes, scope)?;
    match descriptor.status {
        Some(ProjectStatus::Locked) => return Err(StorageError::new("busy")),
        Some(ProjectStatus::Deleted) => return Err(StorageError::new("project_not_found")),
        _ => {},
    }
    Ok(())
}

async fn read_small(
    store: &dyn ObjectStore,
    location: &Path,
    limit: usize,
    io: &Io<'_>,
) -> Result<(Vec<u8>, ObjectMeta), StorageError> {
    io.run(async {
        let result = store.get(location).await.map_err(remote_error)?;
        if result.meta.size > limit as u64 {
            return Err(StorageError::new("response_too_large"));
        }
        let meta = result.meta.clone();
        let mut stream = result.into_stream();
        let mut bytes = Vec::new();
        while let Some(chunk) = stream.try_next().await.map_err(remote_error)? {
            if chunk.len() > limit.saturating_sub(bytes.len()) {
                return Err(StorageError::new("response_too_large"));
            }
            bytes.extend_from_slice(&chunk);
        }
        if bytes.len() as u64 != meta.size {
            return Err(StorageError::new("unknown"));
        }
        Ok((bytes, meta))
    }).await?
}

async fn read_descriptor(store: &AmazonS3, scope: &RemoteProjectScope, io: &Io<'_>) -> Result<(), StorageError> {
    let (bytes, _) = read_small(store, &key(scope, "project.json")?, DESCRIPTOR_LIMIT, io).await?;
    validate_descriptor(&bytes, scope)
}

#[derive(Default)]
struct Cleanup {
    created: Vec<Path>,
    pending: bool,
    deadline: Option<Instant>,
}

impl Cleanup {
    fn deadline(&mut self) -> Instant {
        *self.deadline.get_or_insert_with(|| Instant::now() + CLEANUP_TIMEOUT)
    }

    async fn abort(&mut self, upload: &mut dyn object_store::MultipartUpload) -> bool {
        let deadline = self.deadline();
        let succeeded = matches!(tokio::time::timeout_at(deadline, upload.abort()).await, Ok(Ok(())));
        self.pending |= !succeeded;
        succeeded
    }

    async fn create(&mut self, store: &AmazonS3, location: &Path, bytes: &[u8], io: &Io<'_>) -> Result<(), StorageError> {
        match io.request(store.put_opts(location, bytes.to_vec().into(), PutOptions::from(PutMode::Create))).await {
            Ok(_) => { self.created.push(location.clone()); Ok(()) }
            Err(error) => { self.pending |= unknown_mutation(&error); Err(error) }
        }
    }

    async fn finish(&mut self, store: &AmazonS3) {
        // Start the final deletion budget here, after all business capability checks finish.
        let deadline = Instant::now() + CLEANUP_TIMEOUT;
        for location in &self.created {
            if !matches!(tokio::time::timeout_at(deadline, store.delete(location)).await, Ok(Ok(()))) {
                self.pending = true;
            }
        }
    }
}

async fn check(
    kind: CheckKind,
    io: &Io<'_>,
    future: impl Future<Output = Result<(), StorageError>>,
) -> CapabilityCheck {
    if let Err(error) = io.ensure_current() {
        return CapabilityCheck { kind, status: CheckStatus::NotChecked, code: Some(error.code.to_string()) };
    }
    match future.await {
        Ok(()) => CapabilityCheck { kind, status: CheckStatus::Passed, code: None },
        Err(error) => CapabilityCheck { kind, status: CheckStatus::Failed, code: Some(error.code.to_string()) },
    }
}

async fn probe_list(store: &AmazonS3, prefix: &Path, cleanup: &mut Cleanup, io: &Io<'_>) -> Result<(), StorageError> {
    let sentinel = prefix.child("list-sentinel.bin");
    cleanup.create(store, &sentinel, PROBE_BYTES, io).await?;
    io.run(async {
        let mut entries = store.list(Some(prefix));
        let required_prefix = format!("{prefix}/");
        let mut count = 0;
        let mut found = false;
        while let Some(entry) = entries.try_next().await.map_err(remote_error)? {
            count += 1;
            if count > LIST_LIMIT { return Err(StorageError::new("response_too_large")); }
            if !entry.location.as_ref().starts_with(&required_prefix) {
                return Err(StorageError::new("project_mismatch"));
            }
            found |= entry.location == sentinel;
        }
        if found { Ok(()) } else { Err(StorageError::new("unknown")) }
    }).await?
}

async fn probe_read_write(store: &AmazonS3, location: &Path, cleanup: &mut Cleanup, io: &Io<'_>) -> Result<(), StorageError> {
    cleanup.create(store, location, PROBE_BYTES, io).await?;
    let (bytes, _) = read_small(store, location, PROBE_RESPONSE_LIMIT, io).await?;
    if bytes != PROBE_BYTES { return Err(StorageError::new("unknown")); }
    Ok(())
}

async fn probe_multipart(store: &AmazonS3, complete_key: &Path, abort_key: &Path, cleanup: &mut Cleanup, io: &Io<'_>) -> Result<(), StorageError> {
    let mut complete_upload = match io.request(store.put_multipart(complete_key)).await {
        Ok(upload) => upload,
        Err(error) => { cleanup.pending |= unknown_mutation(&error); return Err(error); }
    };
    // One small final part exercises the multipart protocol without a large capability upload.
    let complete_result = async {
        io.request(complete_upload.put_part(PROBE_BYTES.to_vec().into())).await?;
        io.request(complete_upload.complete()).await
    }.await;
    match complete_result {
        Ok(_) => cleanup.created.push(complete_key.clone()),
        Err(error) => {
            cleanup.pending |= unknown_mutation(&error);
            cleanup.abort(complete_upload.as_mut()).await;
            return Err(error);
        }
    }
    let (bytes, _) = read_small(store, complete_key, PROBE_RESPONSE_LIMIT, io).await?;
    if bytes != PROBE_BYTES { return Err(StorageError::new("unknown")); }

    let mut abort_upload = match io.request(store.put_multipart(abort_key)).await {
        Ok(upload) => upload,
        Err(error) => { cleanup.pending |= unknown_mutation(&error); return Err(error); }
    };
    let part = io.request(abort_upload.put_part(PROBE_BYTES.to_vec().into())).await;
    if let Err(error) = io.request(abort_upload.abort()).await {
        cleanup.abort(abort_upload.as_mut()).await;
        return Err(error);
    }
    part?;
    match io.run(store.head(abort_key)).await? {
        Err(ObjectError::NotFound { .. }) => Ok(()),
        Err(error) => Err(remote_error(error)),
        Ok(_) => Err(StorageError::new("unknown")),
    }
}

async fn probe_condition(
    store: &AmazonS3,
    location: &Path,
    update: bool,
    cleanup: &mut Cleanup,
    io: &Io<'_>,
) -> Result<(), StorageError> {
    let mode = if update {
        cleanup.create(store, location, b"base", io).await?;
        let (bytes, meta) = read_small(store, location, PROBE_RESPONSE_LIMIT, io).await?;
        if bytes != b"base" || meta.e_tag.as_deref().is_none_or(str::is_empty) {
            return Err(StorageError::new("conditional_write_unsupported"));
        }
        PutMode::Update(UpdateVersion { e_tag: meta.e_tag, version: meta.version })
    } else {
        PutMode::Create
    };
    let results = io.run(async {
        tokio::join!(
            store.put_opts(location, b"winner-a".to_vec().into(), PutOptions::from(mode.clone())),
            store.put_opts(location, b"winner-b".to_vec().into(), PutOptions::from(mode.clone())),
        )
    }).await;
    let (first, second) = match results {
        Ok(results) => results,
        Err(error) => { cleanup.pending |= unknown_mutation(&error); return Err(error); }
    };
    if !update && (first.is_ok() || second.is_ok()) { cleanup.created.push(location.clone()); }
    let expected_failure = |error: &ObjectError| {
        if update { matches!(error, ObjectError::Precondition { .. } | ObjectError::AlreadyExists { .. }) }
        else { matches!(error, ObjectError::AlreadyExists { .. }) }
    };
    let expected: &[u8] = match (&first, &second) {
        (Ok(_), Err(error)) if expected_failure(error) => b"winner-a",
        (Err(error), Ok(_)) if expected_failure(error) => b"winner-b",
        _ => {
            cleanup.pending |= [&first, &second].iter().any(|result| result.as_ref().is_err_and(|error| {
                !matches!(error, ObjectError::AlreadyExists { .. } | ObjectError::Precondition { .. } | ObjectError::PermissionDenied { .. } | ObjectError::Unauthenticated { .. })
            }));
            return Err(StorageError::new("conditional_write_unsupported"));
        }
    };
    // A concurrent 409 is valid, but alone does not prove that a stale ETag is enforced.
    let stale = match io.run(store.put_opts(location, b"stale-write".to_vec().into(), PutOptions::from(mode))).await {
        Ok(result) => result,
        Err(error) => { cleanup.pending |= unknown_mutation(&error); return Err(error); }
    };
    match stale {
        Err(ObjectError::Precondition { .. }) if update => {}
        Err(ObjectError::AlreadyExists { .. }) if !update => {}
        Err(error) => {
            let error = remote_error(error);
            cleanup.pending |= unknown_mutation(&error);
            return Err(if error.code == "conflict" { StorageError::new("conditional_write_unsupported") } else { error });
        }
        Ok(_) => return Err(StorageError::new("conditional_write_unsupported")),
    }
    let (bytes, _) = read_small(store, location, PROBE_RESPONSE_LIMIT, io).await?;
    if bytes != expected { return Err(StorageError::new("conditional_write_unsupported")); }
    Ok(())
}

fn checks_passed(checks: &[CapabilityCheck]) -> bool {
    checks.len() == 5 && checks.iter().all(|check| matches!(check.status, CheckStatus::Passed))
}

async fn probe(store: &AmazonS3, scope: &RemoteProjectScope, io: &Io<'_>) -> Result<CapabilityReport, StorageError> {
    let prefix = key(scope, &format!(".capabilities/{}", nonce()))?;
    let mut cleanup = Cleanup::default();
    let read_write = prefix.child("read-write.bin");
    let complete = prefix.child("multipart-complete.bin");
    let abort = prefix.child("multipart-abort.bin");
    let create = prefix.child("conditional-create.bin");
    let update = prefix.child("conditional-update.bin");
    let mut checks = Vec::with_capacity(5);
    checks.push(check(CheckKind::List, io, probe_list(store, &prefix, &mut cleanup, io)).await);
    checks.push(check(CheckKind::ReadWrite, io, probe_read_write(store, &read_write, &mut cleanup, io)).await);
    checks.push(check(CheckKind::Multipart, io, probe_multipart(store, &complete, &abort, &mut cleanup, io)).await);
    checks.push(check(CheckKind::ConditionalCreate, io, probe_condition(store, &create, false, &mut cleanup, io)).await);
    checks.push(check(CheckKind::ConditionalUpdate, io, probe_condition(store, &update, true, &mut cleanup, io)).await);
    cleanup.finish(store).await;
    if io.cancel.is_cancelled() { return Err(StorageError::new("cancelled")); }
    Ok(CapabilityReport {
        multiplayer_writable: checks_passed(&checks) && !cleanup.pending,
        checks,
        checked_at: SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis().min(u64::MAX as u128) as u64,
        cleanup_pending: cleanup.pending,
    })
}

pub(super) async fn prepare_project(
    connection: &ConnectionInput,
    scope: &RemoteProjectScope,
    mode: BindingMode,
    credentials: Credentials,
    cancel: CancellationToken,
) -> Result<CapabilityReport, StorageError> {
    let store = client(connection, credentials)?;
    let io = Io::new(&cancel);
    if matches!(mode, BindingMode::Join) { read_descriptor(&store, scope, &io).await?; }
    let mut report = probe(&store, scope, &io).await?;
    if matches!(mode, BindingMode::Create) {
        if !report.multiplayer_writable { return Ok(report); }
        let bytes = serde_json::to_vec(&ProjectDescriptor {
            format: DESCRIPTOR_FORMAT.to_string(), version: DESCRIPTOR_VERSION,
            library_id: scope.library_id.clone(), shared_project_id: scope.shared_project_id.clone(),
            generation: None, status: None, sequence: None, lock: None,
        }).map_err(|_| StorageError::new("invalid_input"))?;
        let location = key(scope, "project.json")?;
        match io.run(store.put_opts(&location, bytes.into(), PutOptions::from(PutMode::Create))).await? {
            Ok(_) | Err(ObjectError::AlreadyExists { .. }) => {}
            // An unknown write result is not proof that this descriptor was committed.
            Err(error) => return Err(remote_error(error)),
        }
        read_descriptor(&store, scope, &io).await?;
    }
    io.ensure_current()?;
    report.multiplayer_writable &= checks_passed(&report.checks);
    Ok(report)
}

pub(super) async fn probe_project(
    connection: &ConnectionInput,
    scope: &RemoteProjectScope,
    credentials: Credentials,
    cancel: CancellationToken,
) -> Result<CapabilityReport, StorageError> {
    let store = client(connection, credentials)?;
    let io = Io::new(&cancel);
    read_descriptor(&store, scope, &io).await?;
    probe(&store, scope, &io).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn remote_transport_failures_are_classified_without_exposing_the_source() {
        for kind in [HttpErrorKind::Timeout, HttpErrorKind::Connect, HttpErrorKind::Request, HttpErrorKind::Interrupted] {
            let error = ObjectError::Generic { store: "S3", source: Box::new(HttpError::new(kind, std::io::Error::other("private response and signed URL"))) };
            assert_eq!(serde_json::to_value(remote_error(error)).unwrap(), serde_json::json!({ "code": "network" }));
        }
        for kind in [HttpErrorKind::Decode, HttpErrorKind::Unknown] {
            let error = ObjectError::Generic { store: "S3", source: Box::new(HttpError::new(kind, std::io::Error::other("private response"))) };
            assert_eq!(remote_error(error).code, "unknown");
        }
        let too_large = ObjectError::Generic { store: "S3", source: Box::new(HttpError::new(HttpErrorKind::Timeout, ResponseTooLarge)) };
        assert_eq!(remote_error(too_large).code, "response_too_large");
        let opaque = ObjectError::Generic { store: "S3", source: Box::new(std::io::Error::other("request timed out: private response")) };
        assert_eq!(remote_error(opaque).code, "unknown");
        let invalid_request = reqwest::Client::new().get("invalid URL").build().unwrap_err();
        let builder_error = ObjectError::Generic { store: "S3", source: Box::new(invalid_request) };
        assert_eq!(serde_json::to_value(remote_error(builder_error)).unwrap(), serde_json::json!({ "code": "unknown" }));
    }

    fn scope() -> RemoteProjectScope {
        RemoteProjectScope { library_id: "library-a".into(), shared_project_id: "project-a".into(), project_prefix: "libraries/library-a/projects/project-a".into() }
    }

    #[test]
    fn descriptor_rejects_other_projects_versions_and_extra_fields() {
        let valid = br#"{"format":"ai-canvas-shared-project","version":1,"libraryId":"library-a","sharedProjectId":"project-a"}"#;
        assert!(validate_descriptor(valid, &scope()).is_ok());
        for invalid in [
            br#"{"format":"ai-canvas-shared-project","version":2,"libraryId":"library-a","sharedProjectId":"project-a"}"#.as_slice(),
            br#"{"format":"ai-canvas-shared-project","version":1,"libraryId":"library-a","sharedProjectId":"project-b"}"#.as_slice(),
            br#"{"format":"ai-canvas-shared-project","version":1,"libraryId":"library-a","sharedProjectId":"project-a","endpoint":"https://elsewhere.invalid"}"#.as_slice(),
        ] {
            assert!(validate_descriptor(invalid, &scope()).is_err());
        }
        assert!(validate_descriptor(&vec![b' '; DESCRIPTOR_LIMIT + 1], &scope()).is_err());
    }

    #[test]
    fn cancelled_request_never_polls_the_remote_operation() {
        let cancel = CancellationToken::new();
        cancel.cancel();
        let io = Io::new(&cancel);
        let result: Result<(), StorageError> = tauri::async_runtime::block_on(io.run(async { panic!("cancelled operation must not start") }));
        assert!(matches!(result, Err(error) if error.code == "cancelled"));
    }

    #[test]
    fn virtual_hosting_expands_only_a_service_domain_and_retains_the_port() {
        let mut connection = ConnectionInput {
            id: "connection".into(), name: "S3".into(), endpoint: "https://s3.example.com:9443".into(),
            region: "us-east-1".into(), bucket: "example".into(), root_prefix: String::new(), path_style: false,
        };
        assert_eq!(request_endpoint(&connection).unwrap(), "https://example.s3.example.com:9443");
        connection.endpoint = "https://127.0.0.1:9443".into();
        assert!(request_endpoint(&connection).is_err());
        connection.path_style = true;
        assert_eq!(request_endpoint(&connection).unwrap(), "https://127.0.0.1:9443");
        connection.endpoint = "http://127.0.0.1:9000".into();
        assert_eq!(request_endpoint(&connection).unwrap(), "http://127.0.0.1:9000");
        connection.path_style = false;
        assert!(request_endpoint(&connection).is_err());
        connection.endpoint = "http://s3.example.com:9000".into();
        assert_eq!(request_endpoint(&connection).unwrap(), "http://example.s3.example.com:9000");
    }
}
