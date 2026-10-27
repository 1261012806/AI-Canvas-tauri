//! Native execution material only. Business mappings/baselines live in the main-window outbox.
use super::{protocol::{self, Context, DownloadedMedia, Revision}, validate_id, StorageError};
use fs2::FileExt;
use serde::{Deserialize, Serialize};
use std::{collections::BTreeMap, fs::{self, File, OpenOptions}, io::{Read, Write}, path::{Component, Path, PathBuf}};
use tauri::{AppHandle, Manager};

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Root {
    pub anchor: String, pub relative: String, pub fingerprint: String,
}
impl Root {
    pub fn capture(app: &AppHandle, raw: &str) -> Result<(Self, PathBuf), StorageError> {
        let root = crate::path_policy::authorize_existing_plain_directory(app, raw).map_err(|_| protocol::invalid())?;
        let default = app.path().app_data_dir().map_err(|_| unavailable())?.join("data");
        let user = crate::path_policy::user_storage_root(app);
        let (anchor, base) = if let Some(base) = user.filter(|base| root.starts_with(base) && root != *base) { ("user", base) }
            else { ("app", default) };
        let base = crate::path_policy::authorize_existing_plain_directory(app, &base.to_string_lossy()).map_err(|_| protocol::invalid())?;
        let relative = root.strip_prefix(&base).map_err(|_| protocol::invalid())?;
        if !safe_relative(relative) { return Err(protocol::invalid()); }
        let relative = relative.components().map(|part| part.as_os_str().to_string_lossy()).collect::<Vec<_>>().join("/");
        let fingerprint = protocol::digest(root.to_string_lossy().as_bytes());
        Ok((Self { anchor: anchor.into(), relative, fingerprint }, root))
    }
    pub fn resolve(&self, app: &AppHandle) -> Result<PathBuf, StorageError> {
        if !safe_relative(Path::new(&self.relative)) || !protocol::valid_digest(&self.fingerprint) { return Err(protocol::invalid()); }
        let base = match self.anchor.as_str() {
            "user" => crate::path_policy::user_storage_root(app).ok_or_else(|| StorageError::new("conflict"))?,
            "app" => app.path().app_data_dir().map_err(|_| unavailable())?.join("data"),
            _ => return Err(protocol::invalid()),
        };
        let root = crate::path_policy::authorize_existing_plain_directory(app, &base.join(&self.relative).to_string_lossy()).map_err(|_| StorageError::new("conflict"))?;
        if protocol::digest(root.to_string_lossy().as_bytes()) != self.fingerprint { return Err(StorageError::new("conflict")); }
        Ok(root)
    }
}
pub(super) fn safe_relative(path: &Path) -> bool {
    !path.as_os_str().is_empty() && path.components().all(|component| matches!(component, Component::Normal(_)))
        && !path.to_string_lossy().contains(['\\', ':', '\0'])
}
fn unavailable() -> StorageError { StorageError::new("unavailable") }
pub(super) fn plain(path: &Path, directory: bool) -> Result<(), StorageError> {
    let meta = fs::symlink_metadata(path).map_err(|_| unavailable())?;
    #[cfg(windows)]
    { use std::os::windows::fs::MetadataExt; if meta.file_attributes() & 0x400 != 0 { return Err(unavailable()); } }
    if meta.file_type().is_symlink() || (directory && !meta.is_dir()) || (!directory && !meta.is_file()) { return Err(unavailable()); } Ok(())
}
pub(super) fn directory(path: &Path) -> Result<(), StorageError> {
    if path.exists() { for ancestor in path.ancestors() { plain(ancestor, true)?; } return Ok(()); }
    let parent = path.parent().ok_or_else(unavailable)?; directory(parent)?;
    match fs::create_dir(path) { Ok(()) => {}, Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}, Err(_) => return Err(unavailable()) }
    plain(path, true)
}
#[derive(Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Upload {
    pub id: String, pub parts: Vec<String>,
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Record {
    pub operation_id: String,
    pub context: Context, pub owner_revision: u64, pub root: Root,
    pub direction: String, pub revision: Revision, pub revision_digest: String,
    pub base_e_tag: Option<String>, pub phase: String,
    #[serde(default)] pub uploads: BTreeMap<String, Upload>,
    #[serde(default)] pub downloaded: Vec<DownloadedMedia>,
    #[serde(default)] pub cleanup_pending: bool,
    #[serde(default)] pub untracked_upload: bool,
    #[serde(default)] pub remote_mutation_attempted: bool,
    // Old records may already have issued a token; default conservatively.
    #[serde(default = "apply_may_have_started")] pub apply_issued: bool,
    #[serde(default)] pub conflict_released: bool,
}
fn apply_may_have_started() -> bool { true }
impl Record {
    pub fn validate(&self) -> Result<(), StorageError> {
        validate_id(&self.operation_id)?;
        self.context.validate()?; self.revision.validate(false)?;
        if !["upload", "download"].contains(&self.direction.as_str()) || !["prepared", "uploading", "checkingCommit", "published", "downloading", "awaitingApply", "completed", "paused"].contains(&self.phase.as_str())
            || (self.phase == "prepared" && self.remote_mutation_attempted)
            || (self.direction == "upload" && self.operation_id != self.revision.operation_id)
            || self.context.library_id != self.revision.library_id || self.context.shared_project_id != self.revision.shared_project_id
            || protocol::digest(&protocol::encode(&self.revision)?) != self.revision_digest || !safe_relative(Path::new(&self.root.relative)) || !protocol::valid_digest(&self.root.fingerprint)
            || self.uploads.len() > self.revision.media.len() || self.downloaded.len() > self.revision.media.len()
            || self.base_e_tag.as_ref().is_some_and(|etag| etag.is_empty() || etag.len() > 1024 || etag.chars().any(char::is_control)) { return Err(protocol::invalid()); }
        for (id, upload) in &self.uploads {
            if !self.revision.media.iter().any(|media| &media.id == id) || upload.id.is_empty() || upload.id.len() > 4096 || upload.parts.len() > 10_000
                || upload.parts.iter().any(|part| part.is_empty() || part.len() > 4096) { return Err(protocol::invalid()); }
        }
        for item in &self.downloaded {
            let media = self.revision.media.iter().find(|media| media.id == item.media_id).ok_or_else(protocol::invalid)?;
            if item.relative_path != media_destination(&self.revision, media) || item.sha256 != media.sha256 || item.bytes != media.bytes { return Err(protocol::invalid()); }
        } Ok(())
    }
}
pub(super) fn media_destination(revision: &Revision, media: &protocol::Media) -> String {
    format!(".shared-sync/files/{}/{}/{}.{}", revision.shared_asset_id, revision.revision_id, media.id, media.extension)
}
pub(super) struct Journal { _lock: File, path: PathBuf, pub staging: PathBuf }

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct ApplyLease {
    pub context: Context, pub owner_revision: u64, pub operation_id: String,
    pub revision_id: String, pub shared_asset_id: String, pub token_digest: String, pub expires_at: u64,
}

fn apply_path(app: &AppHandle, owner: &str) -> Result<PathBuf, StorageError> {
    validate_id(owner)?;
    let directory_path = app.path().app_data_dir().map_err(|_| unavailable())?.join("project-asset-sync").join(owner);
    directory(&directory_path)?; Ok(directory_path.join(".apply-lease.json"))
}
// All callers hold catalog::access's existing cross-process OS lock. This closes
// the native binding-mutation window while the main window commits IndexedDB.
pub(super) fn read_apply(app: &AppHandle, owner: &str) -> Result<Option<ApplyLease>, StorageError> {
    let path = apply_path(app, owner)?; if !path.exists() { return Ok(None); } plain(&path, false)?;
    let mut bytes = Vec::new(); File::open(&path).map_err(|_| unavailable())?.take(16 * 1024 + 1).read_to_end(&mut bytes).map_err(|_| unavailable())?;
    if bytes.len() > 16 * 1024 { return Err(unavailable()); }
    let lease: ApplyLease = serde_json::from_slice(&bytes).map_err(|_| unavailable())?;
    lease.context.validate()?;
    if lease.context.owner_id != owner || !protocol::valid_digest(&lease.token_digest) { return Err(unavailable()); }
    Ok(Some(lease))
}
pub(super) fn write_apply(app: &AppHandle, lease: &ApplyLease) -> Result<(), StorageError> {
    let path = apply_path(app, &lease.context.owner_id)?; let temporary = path.with_extension("new");
    if path.exists() { plain(&path, false)?; }
    if temporary.exists() { plain(&temporary, false)?; fs::remove_file(&temporary).map_err(|_| unavailable())?; }
    let bytes = serde_json::to_vec(lease).map_err(|_| unavailable())?;
    let mut file = OpenOptions::new().create_new(true).write(true).open(&temporary).map_err(|_| unavailable())?;
    file.write_all(&bytes).and_then(|_| file.sync_all()).map_err(|_| unavailable())?; drop(file);
    fs::rename(temporary, path).map_err(|_| unavailable())?; Ok(())
}
pub(super) fn clear_apply(app: &AppHandle, owner: &str) -> Result<(), StorageError> {
    let path = apply_path(app, owner)?; if path.exists() { plain(&path, false)?; fs::remove_file(path).map_err(|_| unavailable())?; } Ok(())
}
pub(super) fn lock_apply(app: &AppHandle, owner: &str) -> Result<File, StorageError> {
    let path = apply_path(app, owner)?.with_file_name(".apply-active.lock");
    if path.exists() { plain(&path, false)?; }
    let file = OpenOptions::new().create(true).read(true).write(true).truncate(false).open(path).map_err(|_| unavailable())?;
    FileExt::try_lock_exclusive(&file).map_err(|error| {
        if error.kind() == std::io::ErrorKind::WouldBlock || error.raw_os_error() == fs2::lock_contended_error().raw_os_error() { StorageError::new("busy") } else { unavailable() }
    })?;
    Ok(file)
}
pub(super) fn ensure_not_applying(app: &AppHandle, owner: &str) -> Result<(), StorageError> {
    // Expiry tells the renderer to abort. It does not release a live owner's lock
    // while an already-started database commit may still be flushing to disk.
    let _lock = lock_apply(app, owner)?; Ok(())
}
impl Journal {
    pub fn open(app: &AppHandle, owner: &str, operation: &str) -> Result<Self, StorageError> {
        validate_id(owner)?; validate_id(operation)?;
        let directory_path = app.path().app_data_dir().map_err(|_| unavailable())?.join("project-asset-sync").join(owner);
        directory(&directory_path)?;
        let lock_path = directory_path.join(format!("{operation}.lock"));
        if lock_path.exists() { plain(&lock_path, false)?; }
        let lock = OpenOptions::new().create(true).read(true).write(true).truncate(false).open(lock_path).map_err(|_| unavailable())?;
        FileExt::try_lock_exclusive(&lock).map_err(|_| StorageError::new("busy"))?;
        let staging = app.path().app_cache_dir().map_err(|_| unavailable())?.join("project-asset-sync").join(owner).join(operation);
        directory(&staging)?;
        Ok(Self { _lock: lock, path: directory_path.join(format!("{operation}.json")), staging })
    }
    pub fn load(&self) -> Result<Option<Record>, StorageError> {
        if !self.path.exists() { return Ok(None); }
        plain(&self.path, false)?;
        let mut bytes = Vec::new(); File::open(&self.path).map_err(|_| unavailable())?.take((protocol::MANIFEST_LIMIT * 3 + 1) as u64).read_to_end(&mut bytes).map_err(|_| unavailable())?;
        if bytes.len() > protocol::MANIFEST_LIMIT * 3 { return Err(StorageError::new("response_too_large")); }
        let record: Record = serde_json::from_slice(&bytes).map_err(|_| unavailable())?; record.validate()?; Ok(Some(record))
    }
    pub fn save(&self, record: &Record) -> Result<(), StorageError> {
        record.validate()?; let bytes = serde_json::to_vec(record).map_err(|_| unavailable())?;
        if bytes.len() > protocol::MANIFEST_LIMIT * 3 { return Err(StorageError::new("response_too_large")); }
        if self.path.exists() { plain(&self.path, false)?; }
        let temporary = self.path.with_extension("json.new");
        if temporary.exists() { plain(&temporary, false)?; fs::remove_file(&temporary).map_err(|_| unavailable())?; }
        let mut options = OpenOptions::new(); options.write(true).create_new(true);
        #[cfg(unix)] { use std::os::unix::fs::OpenOptionsExt; options.mode(0o600); }
        let mut file = options.open(&temporary).map_err(|_| unavailable())?;
        file.write_all(&bytes).and_then(|_| file.sync_all()).map_err(|_| unavailable())?; drop(file);
        fs::rename(&temporary, &self.path).map_err(|_| unavailable())?;
        #[cfg(unix)] File::open(self.path.parent().ok_or_else(unavailable)?).and_then(|file| file.sync_all()).map_err(|_| unavailable())?;
        Ok(())
    }
    pub fn media(&self, media: &protocol::Media) -> PathBuf { self.staging.join(format!("{}.{}", media.id, media.extension)) }
    pub fn clean(&self, app: &AppHandle, record: &Record, cancel: &tokio_util::sync::CancellationToken) -> Result<(), StorageError> {
        // Never recurse, follow remote names, or delete published project files.
        plain(&self.staging, true)?;
        for media in &record.revision.media {
            super::assert_current(cancel)?;
            let file = self.media(media); if !file.exists() { continue; }
            plain(&file, false)?;
            let current = crate::path_policy::authorize_existing_plain_file(app, &file.to_string_lossy()).map_err(|_| unavailable())?;
            if current != file { return Err(StorageError::new("conflict")); }
            if crate::file_transfer::file_digest(&file, || Ok(cancel.is_cancelled())).map_err(|_| StorageError::new(if cancel.is_cancelled() { "cancelled" } else { "unavailable" }))? != media.sha256 { return Err(StorageError::new("conflict")); }
            super::assert_current(cancel)?;
            fs::remove_file(file).map_err(|_| unavailable())?;
        } Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn relative_material_cannot_select_a_host_path() {
        for path in ["../other", "/private", "C:/private", "a\\b", ""] { assert!(!safe_relative(Path::new(path))); }
        assert!(safe_relative(Path::new("project-name/files")));
    }
    #[test]
    fn download_operation_is_independent_from_the_publishers_operation() {
        let revision: Revision = serde_json::from_value(serde_json::json!({"format":"ai-canvas-shared-asset","version":1,"libraryId":"l","sharedProjectId":"p","sharedAssetId":"a","revisionId":"r","operationId":"publisher","createdAt":1,
            "payload":{"kind":"file","name":"a.png","displayRelativePath":"a.png","mediaId":"m","tags":[]},"media":[{"id":"m","kind":"image","extension":"png","sha256":"a".repeat(64),"bytes":1}]})).unwrap();
        let mut record = Record { operation_id:"downloader".into(), context:Context { task_id:"task".into(), owner_id:"owner".into(), connection_id:"connection".into(), connection_revision:"1".into(), library_id:"l".into(), shared_project_id:"p".into(), generation:"legacy".into() }, owner_revision:1,
            root:Root { anchor:"app".into(), relative:"project".into(), fingerprint:"a".repeat(64) }, direction:"download".into(), revision_digest:protocol::digest(&protocol::encode(&revision).unwrap()), revision,
            base_e_tag:None, phase:"downloading".into(), uploads:Default::default(), downloaded:Vec::new(), cleanup_pending:false, untracked_upload:false, remote_mutation_attempted:false, apply_issued:false, conflict_released:false };
        assert!(record.validate().is_ok());
        record.direction = "upload".into(); record.phase = "prepared".into(); assert!(record.validate().is_err());
    }
}
