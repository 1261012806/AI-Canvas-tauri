//! Bounded media streams using the existing disk publication/cancellation primitives.
use super::{client, journal::{Journal, Record, Upload}, protocol::{self, Context, Media, Progress}, ErrorStage, StorageError};
use futures_util::TryStreamExt;
use object_store::{aws::AmazonS3, multipart::{MultipartStore, PartId}, path::Path as ObjectPath, ObjectStore};
use sha2::{Digest, Sha256};
use std::{fs::File, future::Future, io::{Cursor, Read}, path::{Path, PathBuf}, sync::Arc, time::Duration};
use tauri::{AppHandle, Emitter};
use tokio_util::sync::CancellationToken;

type ProgressClocks = std::sync::Mutex<std::collections::HashMap<String, (std::time::Instant, u64, u64, &'static str)>>;
static PROGRESS_CLOCKS: std::sync::OnceLock<ProgressClocks> = std::sync::OnceLock::new();

const PART_SIZE: usize = 8 * 1024 * 1024;
const CHUNK_SIZE: usize = 1024 * 1024;
pub(super) type Verify = Arc<dyn Fn() -> Result<(), StorageError> + Send + Sync>;
pub(super) async fn request<T>(cancel: &CancellationToken, future: impl Future<Output = object_store::Result<T>>) -> Result<T, StorageError> {
    tokio::select! {
        biased;
        _ = cancel.cancelled() => Err(StorageError::new("cancelled")),
        result = tokio::time::timeout(Duration::from_secs(30), future) => result.map_err(|_| StorageError::new("network"))?.map_err(client::remote_error),
    }
}
pub(super) fn progress(app: &AppHandle, context: &Context, operation: &str, phase: &'static str, bytes: u64, total: u64) {
    let clocks = PROGRESS_CLOCKS.get_or_init(Default::default);
    let emit = if let Ok(mut clocks) = clocks.lock() {
        let now = std::time::Instant::now();
        let emit = clocks.get(&context.task_id).is_none_or(|(at, previous, previous_total, previous_phase)|
            *previous_phase != phase || now.duration_since(*at) >= Duration::from_millis(80) || (bytes >= total && previous < previous_total));
        if emit { if clocks.len() >= 256 && !clocks.contains_key(&context.task_id) { clocks.clear(); } clocks.insert(context.task_id.clone(), (now, bytes, total, phase)); }
        emit
    } else { false };
    if !emit { return; }
    let _ = app.emit_to("main", "project-asset-sync-progress", Progress { task_id: context.task_id.clone(), owner_id: context.owner_id.clone(), operation_id: operation.into(), phase, transferred_bytes: bytes, total_bytes: total });
}
pub(super) fn clear_progress(task: &str) {
    if let Some(clocks) = PROGRESS_CLOCKS.get() { if let Ok(mut clocks) = clocks.lock() { clocks.remove(task); } }
}
pub(super) fn verified_file(app: &AppHandle, file: &Path, media: &Media, cancel: &CancellationToken) -> Result<(), StorageError> {
    let real = crate::path_policy::authorize_existing_plain_file(app, &file.to_string_lossy()).map_err(|_| StorageError::new("conflict"))?;
    if real != file || std::fs::metadata(&real).map_err(|_| StorageError::new("unavailable"))?.len() != media.bytes
        || crate::file_transfer::file_digest(&real, || Ok(cancel.is_cancelled())).map_err(|_| StorageError::new(if cancel.is_cancelled() { "cancelled" } else { "unavailable" }))? != media.sha256 { return Err(StorageError::new("conflict")); } Ok(())
}
pub(super) fn ensure_target(app: &AppHandle, destination: &Path) -> Result<(), StorageError> {
    let current = crate::path_policy::authorize_path(app, &destination.to_string_lossy(), crate::path_policy::PathAccess::Write).map_err(|_| StorageError::new("conflict"))?;
    if current != destination { return Err(StorageError::new("conflict")); } Ok(())
}
pub(super) fn stage(app: &AppHandle, context: &Context, operation: &str, root: &Path, source: &str, destination: &Path, media: &mut Media, cancel: &CancellationToken, verify: &Verify) -> Result<(), StorageError> {
    verify()?;
    ensure_target(app, destination)?;
    let source = crate::path_policy::authorize_existing_plain_file(app, source).map_err(|_| protocol::invalid())?;
    if !source.starts_with(root) || source == root { return Err(protocol::invalid()); }
    let before = std::fs::metadata(&source).map_err(|_| StorageError::new("unavailable"))?;
    if before.len() == 0 || before.len() > protocol::MEDIA_LIMIT { return Err(protocol::invalid()); }
    if destination.exists() {
        media.bytes = before.len(); media.sha256 = crate::file_transfer::file_digest(&source, || Ok(cancel.is_cancelled())).map_err(|_| StorageError::new("unavailable"))?;
        verified_file(app, destination, media, cancel)?;
        let after = std::fs::metadata(&source).map_err(|_| StorageError::new("conflict"))?;
        if before.len() != after.len() || before.modified().ok() != after.modified().ok() { return Err(StorageError::new("conflict")); }
        verify()?; return Ok(());
    }
    let mut reader = File::open(&source).map_err(|_| StorageError::new("unavailable"))?;
    let result = crate::file_transfer::stream_to_file(&context.task_id, &mut reader, destination, Some(before.len()), Some(before.len()), Some(protocol::MEDIA_LIMIT),
        || Ok(cancel.is_cancelled()), |bytes| progress(app, context, operation, "preparing", bytes, before.len()),
        |_| { verify().map_err(|_| "sync scope changed".to_string())?; ensure_target(app, destination).map_err(|_| "target changed".to_string())?; let after = std::fs::metadata(&source).map_err(|_| "source missing".to_string())?;
            if before.len() != after.len() || before.modified().ok() != after.modified().ok() { return Err("source changed".into()); }
            let real = crate::path_policy::authorize_existing_plain_file(app, &source.to_string_lossy())?;
            if real != source { return Err("source changed".into()); } Ok(()) });
    result.map_err(|_| StorageError::new(if cancel.is_cancelled() { "cancelled" } else { "conflict" }))?;
    media.bytes = before.len(); media.sha256 = crate::file_transfer::file_digest(destination, || Ok(cancel.is_cancelled())).map_err(|_| StorageError::new("unavailable"))?;
    verify()?; Ok(())
}
pub(super) async fn matches_content(store: &AmazonS3, key: &ObjectPath, media: &Media, cancel: &CancellationToken) -> Result<bool, StorageError> {
    let result = match request(cancel, store.get(key)).await {
        Ok(result) => result, Err(error) if error.code == "project_not_found" => return Ok(false), Err(error) => return Err(error),
    };
    if result.meta.size != media.bytes { return Err(StorageError::new("conflict")); }
    let mut stream = result.into_stream(); let mut hasher = Sha256::new(); let mut bytes = 0_u64;
    loop {
        let chunk = tokio::select! { biased; _ = cancel.cancelled() => return Err(StorageError::new("cancelled")),
            result = tokio::time::timeout(Duration::from_secs(30), stream.try_next()) => result.map_err(|_| StorageError::new("network"))?.map_err(client::remote_error)? };
        let Some(chunk) = chunk else { break; };
        bytes = bytes.checked_add(chunk.len() as u64).ok_or_else(protocol::invalid)?;
        if bytes > media.bytes { return Err(StorageError::new("response_too_large")); } hasher.update(&chunk);
    }
    if bytes != media.bytes || format!("{:x}", hasher.finalize()) != media.sha256 { return Err(StorageError::new("conflict")); } Ok(true)
}
pub(super) async fn upload(app: &AppHandle, context: &Context, metadata: &AmazonS3, content: &AmazonS3, key: &ObjectPath, media: &Media, journal: &Journal, record: &mut Record, cancel: &CancellationToken, verify: &Verify) -> Result<(), StorageError> {
    verify().map_err(|error| error.at_stage(ErrorStage::StagingVerify))?;
    // If initiation's response lost the upload ID, this client cannot prove its
    // cleanup through the SDK. Keep the candidate and require operator cleanup.
    if record.untracked_upload { return Err(StorageError::new("cleanup_pending")); }
    if matches_content(content, key, media, cancel).await.map_err(|error| error.at_stage(ErrorStage::BlobCheck))? {
        if let Some(previous) = record.uploads.get(&media.id).cloned() {
            verify().map_err(|error| error.at_stage(ErrorStage::MultipartAbort))?;
            match request(cancel, metadata.abort_multipart(key, &previous.id)).await {
                Ok(()) => {}, Err(error) if error.code == "project_not_found" => {},
                Err(error) => { record.cleanup_pending = true; let _ = journal.save(record); return Err(error.at_stage(ErrorStage::MultipartAbort)); }
            }
            record.uploads.remove(&media.id); record.cleanup_pending = !record.uploads.is_empty(); journal.save(record)?;
        }
        return Ok(());
    }
    let file = journal.media(media); verified_file(app, &file, media, cancel).map_err(|error| error.at_stage(ErrorStage::StagingVerify))?;
    // A resumed part stream is never guessed. Abort its known upload before restarting
    // the same immutable bytes/revision; an unknown abort remains explicitly pending.
    if let Some(previous) = record.uploads.get(&media.id).cloned() {
        verify().map_err(|error| error.at_stage(ErrorStage::MultipartAbort))?;
        match request(cancel, metadata.abort_multipart(key, &previous.id)).await {
            Ok(()) => {}, Err(error) if error.code == "project_not_found" => {},
            Err(error) => { record.cleanup_pending = true; let _ = journal.save(record); return Err(error.at_stage(ErrorStage::MultipartAbort)); }
        }
        record.uploads.remove(&media.id); record.cleanup_pending = !record.uploads.is_empty(); journal.save(record)?;
    }
    verify().map_err(|error| error.at_stage(ErrorStage::MultipartCreate))?;
    // Persist uncertainty before the request, so a lost response or failed journal
    // write cannot turn an unknown initiation into a silently repeated upload.
    record.untracked_upload = true; record.cleanup_pending = true; journal.save(record)?;
    let upload_id = match request(cancel, metadata.create_multipart(key)).await {
        Ok(id) => id,
        Err(error) => {
            record.untracked_upload = !matches!(error.code, "access_denied" | "authentication_failed" | "conflict" | "unavailable");
            record.cleanup_pending |= record.untracked_upload; let _ = journal.save(record); return Err(error.at_stage(ErrorStage::MultipartCreate));
        }
    };
    record.untracked_upload = false; record.cleanup_pending = false;
    record.uploads.insert(media.id.clone(), Upload { id: upload_id.clone(), parts: Vec::new() });
    if let Err(error) = journal.save(record) {
        if verify().is_ok() { let _ = tokio::time::timeout(Duration::from_secs(10), metadata.abort_multipart(key, &upload_id)).await; }
        return Err(error);
    }
    let result = async {
        let mut file = File::open(&file).map_err(|_| StorageError::new("unavailable").at_stage(ErrorStage::StagingVerify))?;
        let mut hasher = Sha256::new(); let mut transferred = 0_u64; let mut index = 0;
        loop {
            verify().map_err(|error| error.at_stage(ErrorStage::StagingVerify))?;
            let (next_file, bytes) = tauri::async_runtime::spawn_blocking(move || {
                let mut bytes = vec![0; PART_SIZE]; let mut count = 0;
                while count < PART_SIZE { let read = file.read(&mut bytes[count..])?; if read == 0 { break; } count += read; }
                bytes.truncate(count); Ok::<_, std::io::Error>((file, bytes))
            }).await.map_err(|_| StorageError::new("unavailable").at_stage(ErrorStage::StagingVerify))?.map_err(|_| StorageError::new("unavailable").at_stage(ErrorStage::StagingVerify))?;
            file = next_file; if bytes.is_empty() { break; }
            transferred = transferred.checked_add(bytes.len() as u64).ok_or_else(protocol::invalid).map_err(|error| error.at_stage(ErrorStage::StagingVerify))?;
            if transferred > media.bytes || index >= 10_000 { return Err(protocol::invalid().at_stage(ErrorStage::StagingVerify)); }
            hasher.update(&bytes);
            let part = tokio::select! { biased; _ = cancel.cancelled() => Err(StorageError::new("cancelled")),
                result = tokio::time::timeout(Duration::from_secs(300), metadata.put_part(key, &upload_id, index, bytes.into())) => result.map_err(|_| {
                    eprintln!("[project-asset-sync] transport method=PUT kind=operation_timeout elapsed_ms=300000");
                    StorageError::new("network")
                }).and_then(|result| result.map_err(client::remote_error)) }
                .map_err(|error| error.at_stage(ErrorStage::PartUpload))?;
            record.uploads.get_mut(&media.id).ok_or_else(protocol::invalid)?.parts.push(part.content_id); journal.save(record)?;
            progress(app, context, &record.revision.operation_id, "uploading", transferred, media.bytes); index += 1;
        }
        if transferred != media.bytes || format!("{:x}", hasher.finalize()) != media.sha256 { return Err(StorageError::new("conflict").at_stage(ErrorStage::StagingVerify)); }
        verify().map_err(|error| error.at_stage(ErrorStage::MultipartComplete))?;
        let parts = record.uploads[&media.id].parts.iter().cloned().map(|content_id| PartId { content_id }).collect();
        request(cancel, metadata.complete_multipart(key, &upload_id, parts)).await.map_err(|error| error.at_stage(ErrorStage::MultipartComplete))?;
        verify().map_err(|error| error.at_stage(ErrorStage::BlobVerify))?;
        if !matches_content(content, key, media, cancel).await.map_err(|error| error.at_stage(ErrorStage::BlobVerify))? { return Err(StorageError::new("unknown").at_stage(ErrorStage::BlobVerify)); }
        record.uploads.remove(&media.id); journal.save(record)?; Ok(())
    }.await;
    if result.is_err() {
        // Cleanup has its own short budget and does not repeat a business write.
        if verify().is_ok() {
            match tokio::time::timeout(Duration::from_secs(10), metadata.abort_multipart(key, &upload_id)).await {
                Ok(Ok(())) | Ok(Err(object_store::Error::NotFound { .. })) => { record.uploads.remove(&media.id); },
                _ => record.cleanup_pending = true,
            }
        } else { record.cleanup_pending = true; }
        // Preserve the operation's first failure even if cleanup bookkeeping fails.
        // The earlier durable upload ID/uncertainty still governs explicit recovery.
        let _ = journal.save(record);
    } result
}
struct ChannelReader { receiver: tokio::sync::mpsc::Receiver<Vec<u8>>, current: Cursor<Vec<u8>>, failed: Arc<std::sync::atomic::AtomicBool> }
impl Read for ChannelReader {
    fn read(&mut self, target: &mut [u8]) -> std::io::Result<usize> {
        loop {
            let read = self.current.read(target)?; if read != 0 { return Ok(read); }
            match self.receiver.blocking_recv() {
                Some(chunk) => self.current = Cursor::new(chunk),
                None if self.failed.load(std::sync::atomic::Ordering::Acquire) => return Err(std::io::Error::other("media stream failed")),
                None => return Ok(0),
            }
        }
    }
}
pub(super) async fn download(app: &AppHandle, context: &Context, store: &AmazonS3, key: &ObjectPath, media: &Media, destination: PathBuf, operation: &str, cancel: &CancellationToken, verify: &Verify) -> Result<(), StorageError> {
    verify()?;
    if destination.exists() { return verified_file(app, &destination, media, cancel); }
    let response = request(cancel, store.get(key)).await?;
    if response.meta.size != media.bytes { return Err(StorageError::new("conflict")); }
    let mut stream = response.into_stream(); let (sender, receiver) = tokio::sync::mpsc::channel(2);
    let failed = Arc::new(std::sync::atomic::AtomicBool::new(false)); let worker_failed = Arc::clone(&failed);
    let worker_app = app.clone(); let worker_context = context.clone(); let worker_media = media.clone(); let worker_cancel = cancel.clone(); let worker_verify = Arc::clone(verify); let worker_operation = operation.to_string();
    let worker = tauri::async_runtime::spawn_blocking(move || {
        ensure_target(&worker_app, &destination)?;
        let mut reader = ChannelReader { receiver, current: Cursor::new(Vec::new()), failed: worker_failed };
        crate::file_transfer::stream_to_file(&worker_context.task_id, &mut reader, &destination, Some(worker_media.bytes), Some(worker_media.bytes), Some(worker_media.bytes),
            || Ok(worker_cancel.is_cancelled()), |bytes| progress(&worker_app, &worker_context, &worker_operation, "downloading", bytes, worker_media.bytes),
            |temporary| { worker_verify().map_err(|_| "sync scope changed".to_string())?;
                ensure_target(&worker_app, &destination).map_err(|_| "target changed".to_string())?;
                verified_file(&worker_app, temporary, &worker_media, &worker_cancel).map_err(|_| "media checksum mismatch".to_string()) })
            .map_err(|_| StorageError::new(if worker_cancel.is_cancelled() { "cancelled" } else { "conflict" }))
    });
    let producer = async {
        let mut received = 0_u64;
        loop {
            let chunk = tokio::select! { biased; _ = cancel.cancelled() => return Err(StorageError::new("cancelled")),
                result = tokio::time::timeout(Duration::from_secs(30), stream.try_next()) => result.map_err(|_| StorageError::new("network"))?.map_err(client::remote_error)? };
            let Some(chunk) = chunk else { break; };
            received = received.checked_add(chunk.len() as u64).ok_or_else(protocol::invalid)?;
            if received > media.bytes { return Err(StorageError::new("response_too_large")); }
            for part in chunk.chunks(CHUNK_SIZE) { sender.send(part.to_vec()).await.map_err(|_| StorageError::new("cancelled"))?; }
        }
        if received != media.bytes { return Err(StorageError::new("unknown")); } Ok(())
    }.await;
    failed.store(producer.is_err(), std::sync::atomic::Ordering::Release); drop(sender);
    let disk = worker.await.map_err(|_| StorageError::new("unavailable"))?;
    producer?; disk?; verify()?; Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn a_failed_producer_is_not_a_successful_end_of_file() {
        let (sender, receiver) = tokio::sync::mpsc::channel(1); drop(sender);
        let mut reader = ChannelReader { receiver, current:Cursor::new(Vec::new()), failed:Arc::new(std::sync::atomic::AtomicBool::new(true)) };
        assert!(reader.read(&mut [0; 8]).is_err());
    }
}
